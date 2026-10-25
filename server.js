require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const multer = require("multer");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const VIDEO_DIR = path.join(DATA_DIR, "recordings");
const DB_PATH = path.join(DATA_DIR, "proctor.sqlite");
const MAX_MB = Number(process.env.MAX_RECORDING_MB || 500);

// Ensure directories exist
fs.mkdirSync(VIDEO_DIR, { recursive: true });

if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 8) {
  console.warn("WARNING: Set ADMIN_PASSWORD in .env before using this system.");
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY, candidate_name TEXT NOT NULL, candidate_email TEXT NOT NULL,
  candidate_ref TEXT, status TEXT NOT NULL DEFAULT 'started',
  consent_at TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
  violation_count INTEGER NOT NULL DEFAULT 0, review_status TEXT NOT NULL DEFAULT 'pending',
  admin_note TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT NOT NULL,
  event_type TEXT NOT NULL, details TEXT, occurred_at TEXT NOT NULL,
  FOREIGN KEY(attempt_id) REFERENCES attempts(id)
);
CREATE TABLE IF NOT EXISTS recordings (
  id INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT NOT NULL,
  filename TEXT NOT NULL, bytes INTEGER NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY(attempt_id) REFERENCES attempts(id)
);
`);

const insertEvent = db.prepare("INSERT INTO events(attempt_id,event_type,details,occurred_at) VALUES(?,?,?,?)");
const getAttempt = db.prepare("SELECT * FROM attempts WHERE id=?");
const adminSessions = new Set();
const participantTokens = new Map();

// Enable reverse proxy support for cloud deployments (Render, Railway, Fly, Heroku, Nginx)
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
      mediaSrc: ["'self'", "blob:"],
      frameSrc: ["https://docs.google.com", "https://forms.gle"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: null
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

function adminAuth(req, res, next) {
  const token = req.get("x-admin-token") || req.query.token;
  if (!token || !adminSessions.has(token)) return res.status(401).json({ error: "Admin authentication required" });
  next();
}

function participantAuth(req, res, next) {
  const token = req.get("x-participant-token");
  const attemptId = req.params.id || req.body.attemptId;
  const stored = participantTokens.get(attemptId);
  if (!stored || stored !== token) return res.status(401).json({ error: "Invalid or expired participant session" });
  next();
}

function cleanText(v, max = 200) { return String(v || "").trim().slice(0, max); }
function iso() { return new Date().toISOString(); }

function formatFormUrl(rawUrl) {
  if (!rawUrl) return "";
  let url = rawUrl.trim();
  if (url.includes("docs.google.com/forms") && !url.includes("embedded=true")) {
    if (url.includes("?")) {
      url = url.replace(/\?(.*)$/, (match, query) => {
        const params = new URLSearchParams(query);
        params.set("embedded", "true");
        return "?" + params.toString();
      });
    } else {
      url += "?embedded=true";
    }
  }
  return url;
}

// Stream video with full HTTP 206 Partial Content (Range request) support
function streamVideoFile(fullPath, req, res) {
  if (!fs.existsSync(fullPath)) return res.status(404).send("Recording file missing on disk");
  const stat = fs.statSync(fullPath);
  const fileSize = stat.size;
  if (fileSize === 0) return res.status(204).send();

  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (start >= fileSize || end >= fileSize) {
      res.status(416).setHeader("Content-Range", `bytes */${fileSize}`);
      return res.end();
    }

    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(fullPath, { start, end });
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunksize,
      "Content-Type": "video/webm"
    });
    file.pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type": "video/webm",
      "Accept-Ranges": "bytes",
      "Content-Disposition": `inline; filename="${path.basename(fullPath)}"`
    });
    fs.createReadStream(fullPath).pipe(res);
  }
}

// Public configuration endpoint
app.get("/api/config", (req, res) => {
  const url = process.env.GOOGLE_FORM_EMBED_URL || "";
  res.json({
    title: "Nexus 2k26 Technical-Quiz",
    formUrl: formatFormUrl(url),
    maxRecordingMb: MAX_MB
  });
});

// Admin login
app.post("/api/admin/login", (req, res) => {
  const password = cleanText(req.body.password, 500);
  const configured = String(process.env.ADMIN_PASSWORD || "");
  if (!configured || !crypto.timingSafeEqual(
    Buffer.from(password.padEnd(512, "\0").slice(0, 512)),
    Buffer.from(configured.padEnd(512, "\0").slice(0, 512))
  ) || password.length !== configured.length) {
    return res.status(401).json({ error: "Invalid admin password" });
  }
  const token = crypto.randomBytes(32).toString("hex");
  adminSessions.add(token);
  res.json({ token, message: "Authentication successful" });
});

// Admin logout
app.post("/api/admin/logout", adminAuth, (req, res) => {
  const token = req.get("x-admin-token");
  if (token) adminSessions.delete(token);
  res.json({ ok: true });
});

// Admin get attempts list
app.get("/api/admin/attempts", adminAuth, (req, res) => {
  const attempts = db.prepare(`
    SELECT a.id, a.candidate_name, a.candidate_email, a.candidate_ref, a.status,
           a.consent_at, a.started_at, a.ended_at, a.violation_count, a.review_status, a.admin_note,
           r.id as recording_id, r.bytes as recording_bytes, r.filename as recording_filename
    FROM attempts a
    LEFT JOIN (
      SELECT attempt_id, id, bytes, filename FROM recordings GROUP BY attempt_id
    ) r ON r.attempt_id = a.id
    ORDER BY a.started_at DESC
  `).all();
  res.json(attempts);
});

// Admin get single attempt detail with events and recording
app.get("/api/admin/attempts/:id", adminAuth, (req, res) => {
  const attempt = getAttempt.get(req.params.id);
  if (!attempt) return res.status(404).json({ error: "Attempt not found" });
  
  const events = db.prepare("SELECT id, event_type, details, occurred_at FROM events WHERE attempt_id=? ORDER BY occurred_at ASC").all(req.params.id);
  const recording = db.prepare("SELECT id, filename, bytes, created_at FROM recordings WHERE attempt_id=? ORDER BY id DESC LIMIT 1").get(req.params.id);
  
  res.json({
    attempt,
    events,
    recording: recording || null,
    recordings: recording ? [recording] : []
  });
});

// Admin update review status & notes
app.patch("/api/admin/attempts/:id/review", adminAuth, (req, res) => {
  const valid = ["pending", "reviewed", "cleared", "flagged", "disqualified"];
  const status = valid.includes(req.body.reviewStatus) ? req.body.reviewStatus : null;
  if (!status) return res.status(400).json({ error: "Invalid review status" });
  db.prepare("UPDATE attempts SET review_status=?, admin_note=? WHERE id=?")
    .run(status, cleanText(req.body.note, 2000), req.params.id);
  res.json({ ok: true });
});

// Admin stream single video recording by recording ID
app.get("/api/admin/recordings/:recordingId", adminAuth, (req, res) => {
  const row = db.prepare("SELECT filename FROM recordings WHERE id=?").get(Number(req.params.recordingId));
  if (!row) return res.status(404).send("Recording not found in database");
  const fullPath = path.join(VIDEO_DIR, row.filename);
  streamVideoFile(fullPath, req, res);
});

// Admin stream video by attempt ID
app.get("/api/admin/attempts/:id/video", adminAuth, (req, res) => {
  const row = db.prepare("SELECT filename FROM recordings WHERE attempt_id=? ORDER BY id DESC LIMIT 1").get(req.params.id);
  const filename = row ? row.filename : `${req.params.id}.webm`;
  const fullPath = path.join(VIDEO_DIR, filename);
  streamVideoFile(fullPath, req, res);
});

// Admin CSV Export
app.get("/api/admin/export.csv", adminAuth, (req, res) => {
  const attempts = db.prepare(`
    SELECT id, candidate_name, candidate_email, candidate_ref, status,
           started_at, ended_at, violation_count, review_status, admin_note
    FROM attempts
    ORDER BY started_at DESC
  `).all();

  const headers = ["ID", "Candidate Name", "Email", "Candidate Ref", "Status", "Started At", "Ended At", "Violations Count", "Review Status", "Admin Note"];
  const escapeCsv = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  
  const rows = attempts.map(a => [
    escapeCsv(a.id),
    escapeCsv(a.candidate_name),
    escapeCsv(a.candidate_email),
    escapeCsv(a.candidate_ref),
    escapeCsv(a.status),
    escapeCsv(a.started_at),
    escapeCsv(a.ended_at),
    escapeCsv(a.violation_count),
    escapeCsv(a.review_status),
    escapeCsv(a.admin_note)
  ].join(","));

  const csvContent = "\uFEFF" + [headers.join(","), ...rows].join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="nexus-2k26-quiz-attempts.csv"');
  res.send(csvContent);
});

// Participant create attempt
app.post("/api/attempts", (req, res) => {
  const name = cleanText(req.body.name, 120);
  const email = cleanText(req.body.email, 200).toLowerCase();
  const ref = cleanText(req.body.candidateRef, 100);
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Please enter your full name and a valid email address." });
  }
  if (req.body.consent !== true) {
    return res.status(400).json({ error: "Webcam recording consent is required to participate." });
  }
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString("hex");
  const now = iso();
  db.prepare("INSERT INTO attempts(id,candidate_name,candidate_email,candidate_ref,consent_at,started_at) VALUES(?,?,?,?,?,?)")
    .run(id, name, email, ref, now, now);
  participantTokens.set(id, token);
  insertEvent.run(id, "attempt_started", "Candidate accepted recording and proctoring notice", now);
  res.json({ id, token });
});

// Participant log proctoring event
app.post("/api/attempts/:id/events", participantAuth, (req, res) => {
  const attempt = getAttempt.get(req.params.id);
  if (!attempt || attempt.ended_at) return res.status(400).json({ error: "Attempt is already finished." });
  const allowed = new Set([
    "tab_hidden", "tab_visible", "window_blur", "window_focus",
    "fullscreen_exit", "camera_stopped", "recording_error",
    "form_opened", "candidate_reported_submitted"
  ]);
  const type = cleanText(req.body.type, 60);
  if (!allowed.has(type)) return res.status(400).json({ error: "Unsupported event type" });
  const details = cleanText(req.body.details, 500);
  insertEvent.run(req.params.id, type, details, iso());
  
  // Increment violation count for cheating indicator events
  if (["tab_hidden", "window_blur", "fullscreen_exit", "camera_stopped"].includes(type)) {
    db.prepare("UPDATE attempts SET violation_count=violation_count+1 WHERE id=?").run(req.params.id);
  }
  res.json({ ok: true });
});

// Single recording upload: append incoming chunks sequentially into single attempt file
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype === "video/webm" || file.mimetype === "application/octet-stream")
});

app.post("/api/attempts/:id/recordings", participantAuth, upload.single("chunk"), (req, res) => {
  if (!req.file || !req.file.buffer) return res.status(400).json({ error: "No recording data received" });
  
  const finalFilename = `${req.params.id}.webm`;
  const finalPath = path.join(VIDEO_DIR, finalFilename);
  
  try {
    // Append chunk to the single candidate video file
    fs.appendFileSync(finalPath, req.file.buffer);
    const totalBytes = fs.statSync(finalPath).size;
    
    // Ensure only one row exists in recordings table per attempt
    const existing = db.prepare("SELECT id FROM recordings WHERE attempt_id=? ORDER BY id ASC LIMIT 1").get(req.params.id);
    let recId;
    if (existing) {
      db.prepare("UPDATE recordings SET bytes=?, filename=? WHERE id=?").run(totalBytes, finalFilename, existing.id);
      recId = existing.id;
    } else {
      const info = db.prepare("INSERT INTO recordings(attempt_id, filename, bytes, created_at) VALUES(?,?,?,?)")
        .run(req.params.id, finalFilename, totalBytes, iso());
      recId = info.lastInsertRowid;
    }
    
    res.json({ ok: true, bytes: totalBytes, recordingId: recId });
  } catch (err) {
    console.error("Failed to append recording chunk", err);
    res.status(500).json({ error: "Failed to save video chunk on server." });
  }
});

// Participant finish session
app.post("/api/attempts/:id/finish", participantAuth, (req, res) => {
  const attempt = getAttempt.get(req.params.id);
  if (!attempt) return res.status(404).json({ error: "Attempt not found" });
  
  try {
    const now = iso();
    const status = req.body.submitted === true ? "candidate_reported_submitted" : "finished";
    db.prepare("UPDATE attempts SET status=?, ended_at=? WHERE id=?").run(status, now, req.params.id);
    insertEvent.run(req.params.id, "attempt_finished", status, now);
    participantTokens.delete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to finalize attempt", err);
    res.status(500).json({ error: "Could not finalize attempt." });
  }
});

// Health check
app.get("/health", (req, res) => res.json({ status: "healthy", timestamp: iso() }));

// Error handling
app.use((err, req, res, next) => {
  console.error("Server error:", err);
  if (err instanceof multer.MulterError) {
    return res.status(413).json({ error: `Upload size limit exceeded: ${err.message}` });
  }
  res.status(500).json({ error: "Internal server error" });
});

// Graceful shutdown
function gracefulShutdown() {
  console.log("Nexus 2k26 Portal: Gracefully closing database and exiting...");
  try { db.close(); } catch {}
  process.exit(0);
}
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

app.listen(PORT, () => console.log(`Nexus 2k26 Technical-Quiz portal running on http://localhost:${PORT}`));
