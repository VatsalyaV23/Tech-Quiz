let token = sessionStorage.getItem("nexus_admin_token") || "";
let allAttempts = [];
let currentAttemptId = null;

const $ = (id) => document.getElementById(id);
const hide = (id) => $(id)?.classList.add("hidden");
const show = (id) => $(id)?.classList.remove("hidden");

async function request(url, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };
  if (token) headers["x-admin-token"] = token;
  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) {
      sessionStorage.removeItem("nexus_admin_token");
      token = "";
      show("login");
      hide("dashboard");
      hide("logoutBtn");
    }
    throw new Error(data.error || "Request failed");
  }
  return data;
}

function formatDate(isoStr) {
  if (!isoStr) return "—";
  try {
    const d = new Date(isoStr);
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true
    });
  } catch {
    return isoStr.slice(0, 19).replace("T", " ");
  }
}

function formatDuration(startStr, endStr) {
  if (!startStr) return "";
  try {
    const start = new Date(startStr);
    const end = endStr ? new Date(endStr) : new Date();
    const diffSec = Math.max(0, Math.floor((end - start) / 1000));
    const m = Math.floor(diffSec / 60);
    const s = diffSec % 60;
    return `${m}m ${s}s`;
  } catch {
    return "";
  }
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Authentication
$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("loginError").textContent = "";
  const password = new FormData(e.currentTarget).get("password");

  try {
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Login failed");

    token = data.token;
    sessionStorage.setItem("nexus_admin_token", token);
    hide("login");
    show("dashboard");
    show("logoutBtn");
    await loadAttempts();
  } catch (err) {
    $("loginError").textContent = err.message;
  }
});

$("logoutBtn").addEventListener("click", async () => {
  try {
    await request("/api/admin/logout", { method: "POST" });
  } catch {}
  sessionStorage.removeItem("nexus_admin_token");
  token = "";
  hide("dashboard");
  hide("logoutBtn");
  show("login");
});

$("refreshBtn").addEventListener("click", () => {
  const btn = $("refreshBtn");
  btn.innerHTML = '<svg class="icon icon-sm icon-spin" viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg> Refreshing…';
  btn.disabled = true;
  loadAttempts().finally(() => {
    btn.innerHTML = '<svg class="icon icon-sm" viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg> Refresh';
    btn.disabled = false;
  });
});

$("exportCsvBtn").addEventListener("click", () => {
  if (!token) return;
  window.location.href = `/api/admin/export.csv?token=${encodeURIComponent(token)}`;
});

// Load Attempts
async function loadAttempts() {
  try {
    allAttempts = await request("/api/admin/attempts");
    updateMetrics(allAttempts);
    applyFilters();
  } catch (err) {
    console.error("Failed to load attempts:", err);
  }
}

function updateMetrics(attempts) {
  $("metricTotal").textContent = attempts.length;
  $("metricActive").textContent = attempts.filter(a => a.status === "started").length;
  $("metricFlagged").textContent = attempts.filter(a => Number(a.violation_count) >= 3).length;
  $("metricPending").textContent = attempts.filter(a => a.review_status === "pending").length;
}

// Filtering & Sorting
function applyFilters() {
  const query = $("searchInput").value.trim().toLowerCase();
  const reviewFilter = $("reviewFilter").value;
  const statusFilter = $("statusFilter").value;
  const violationFilter = $("violationFilter").value;
  const sortOrder = $("sortOrder").value;

  let filtered = allAttempts.filter(a => {
    // Search query
    if (query) {
      const name = (a.candidate_name || "").toLowerCase();
      const email = (a.candidate_email || "").toLowerCase();
      const ref = (a.candidate_ref || "").toLowerCase();
      if (!name.includes(query) && !email.includes(query) && !ref.includes(query)) {
        return false;
      }
    }

    // Review status
    if (reviewFilter !== "all" && a.review_status !== reviewFilter) {
      return false;
    }

    // Session status
    if (statusFilter !== "all" && a.status !== statusFilter) {
      return false;
    }

    // Violation severity
    if (violationFilter === "clean" && Number(a.violation_count) !== 0) return false;
    if (violationFilter === "moderate" && (Number(a.violation_count) < 1 || Number(a.violation_count) > 2)) return false;
    if (violationFilter === "high" && Number(a.violation_count) < 3) return false;

    return true;
  });

  // Sorting
  filtered.sort((a, b) => {
    if (sortOrder === "newest") {
      return new Date(b.started_at) - new Date(a.started_at);
    } else if (sortOrder === "oldest") {
      return new Date(a.started_at) - new Date(b.started_at);
    } else if (sortOrder === "violations") {
      return Number(b.violation_count) - Number(a.violation_count);
    } else if (sortOrder === "name") {
      return (a.candidate_name || "").localeCompare(b.candidate_name || "");
    }
    return 0;
  });

  renderTable(filtered);
}

// Event Listeners for Filters
$("searchInput").addEventListener("input", applyFilters);
$("reviewFilter").addEventListener("change", applyFilters);
$("statusFilter").addEventListener("change", applyFilters);
$("violationFilter").addEventListener("change", applyFilters);
$("sortOrder").addEventListener("change", applyFilters);

// Render Table with SEPARATE, CLEAR COLUMNS
function renderTable(attempts) {
  const tbody = $("attemptTableBody");
  tbody.replaceChildren();

  if (attempts.length === 0) {
    show("emptyState");
    return;
  }
  hide("emptyState");

  attempts.forEach(a => {
    const tr = document.createElement("tr");

    // Column 1: Candidate (Name + Email + Ref ID)
    const tdCand = document.createElement("td");
    tdCand.innerHTML = `
      <div class="cand-name">${escapeHtml(a.candidate_name)}</div>
      <div class="cand-email">${escapeHtml(a.candidate_email)}</div>
      ${a.candidate_ref ? `<div class="cand-ref">Roll ID: ${escapeHtml(a.candidate_ref)}</div>` : ""}
    `;
    tr.append(tdCand);

    // Column 2: Started At & Duration
    const tdStarted = document.createElement("td");
    const duration = formatDuration(a.started_at, a.ended_at);
    tdStarted.innerHTML = `
      <div style="font-weight: 600; font-size: 13.5px;">${formatDate(a.started_at)}</div>
      ${duration ? `<div style="font-size: 12px; color: #64748b;">Duration: ${duration}</div>` : ""}
    `;
    tr.append(tdStarted);

    // Column 3: Violations Badge
    const tdEvents = document.createElement("td");
    const count = Number(a.violation_count || 0);
    let violBadge = "";
    if (count === 0) {
      violBadge = `<span class="badge badge-clean"><svg class="icon icon-sm" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg> 0 Clean</span>`;
    } else if (count <= 2) {
      violBadge = `<span class="badge badge-warning"><svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg> ${count} Events</span>`;
    } else {
      violBadge = `<span class="badge badge-danger"><svg class="icon icon-sm" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg> ${count} Violations</span>`;
    }
    tdEvents.innerHTML = violBadge;
    tr.append(tdEvents);

    // Column 4: Session Status
    const tdStatus = document.createElement("td");
    let statusBadge = "";
    if (a.status === "started") {
      statusBadge = `<span class="badge badge-info"><span class="dot green"></span> In Progress</span>`;
    } else if (a.status === "candidate_reported_submitted") {
      statusBadge = `<span class="badge badge-purple"><svg class="icon icon-sm" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg> Submitted</span>`;
    } else {
      statusBadge = `<span class="badge badge-clean"><svg class="icon icon-sm" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg> Finished</span>`;
    }
    tdStatus.innerHTML = statusBadge;
    tr.append(tdStatus);

    // Column 5: Review Decision
    const tdReview = document.createElement("td");
    const rev = (a.review_status || "pending").toLowerCase();
    let revBadge = "";
    if (rev === "cleared") revBadge = `<span class="badge badge-clean"><svg class="icon icon-sm" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg> Cleared</span>`;
    else if (rev === "flagged") revBadge = `<span class="badge badge-danger"><svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path><line x1="4" y1="22" x2="4" y2="15"></line></svg> Flagged</span>`;
    else if (rev === "disqualified") revBadge = `<span class="badge badge-dark"><svg class="icon icon-sm" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line></svg> Disqualified</span>`;
    else if (rev === "reviewed") revBadge = `<span class="badge badge-info"><svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg> Reviewed</span>`;
    else revBadge = `<span class="badge badge-warning"><svg class="icon icon-sm" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg> Pending</span>`;
    tdReview.innerHTML = revBadge;
    tr.append(tdReview);

    // Column 6: Action
    const tdAction = document.createElement("td");
    tdAction.style.textAlign = "center";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-sm";
    btn.textContent = "Review Session";
    btn.addEventListener("click", () => openDetailModal(a.id));
    tdAction.append(btn);
    tr.append(tdAction);

    tbody.append(tr);
  });
}

// Open Detail Modal (Admin sees everything)
async function openDetailModal(id) {
  currentAttemptId = id;
  $("reviewSaveStatus").textContent = "";

  try {
    const data = await request(`/api/admin/attempts/${id}`);
    const a = data.attempt;

    // Header info
    $("modalCandidateName").textContent = `${a.candidate_name}`;
    const duration = formatDuration(a.started_at, a.ended_at);
    $("modalCandidateSub").textContent = `${a.candidate_email} • ${a.candidate_ref ? "ID: " + a.candidate_ref + " • " : ""}Started: ${formatDate(a.started_at)} • Duration: ${duration || "Active"}`;

    // Single Video Player Setup
    const videoElem = $("reviewVideo");
    const downloadBtn = $("downloadVideoBtn");
    const videoMeta = $("videoMeta");

    if (data.recording && data.recording.bytes > 0) {
      show("videoContainer");
      hide("noVideoMsg");
      const videoUrl = `/api/admin/attempts/${id}/video?token=${encodeURIComponent(token)}`;
      videoElem.src = videoUrl;
      videoElem.load();

      const sizeMb = (data.recording.bytes / (1024 * 1024)).toFixed(2);
      videoMeta.textContent = `Size: ${sizeMb} MB`;
      downloadBtn.href = videoUrl;
      downloadBtn.download = `nexus2k26-${a.candidate_name.replace(/\s+/g, "_")}-${id}.webm`;
      show("downloadVideoBtn");
    } else {
      hide("videoContainer");
      hide("downloadVideoBtn");
      videoMeta.textContent = "";
      show("noVideoMsg");
    }

    // Playback rate buttons
    document.querySelectorAll(".speed-btn").forEach(b => {
      b.onclick = () => {
        document.querySelectorAll(".speed-btn").forEach(btn => btn.classList.remove("active"));
        b.classList.add("active");
        videoElem.playbackRate = parseFloat(b.dataset.speed);
      };
    });

    // Populate Comprehensive Event Log (Admin sees EVERYTHING)
    const timeline = $("eventTimeline");
    timeline.replaceChildren();

    if (!data.events || data.events.length === 0) {
      const li = document.createElement("li");
      li.textContent = "No proctoring events recorded for this session.";
      timeline.append(li);
    } else {
      const startTime = new Date(a.started_at).getTime();

      data.events.forEach(ev => {
        const li = document.createElement("li");
        li.className = ev.event_type;

        // Offset from session start
        const evTime = new Date(ev.occurred_at).getTime();
        const offsetSec = Math.max(0, Math.floor((evTime - startTime) / 1000));
        const offsetM = Math.floor(offsetSec / 60);
        const offsetS = offsetSec % 60;
        const offsetStr = `+${String(offsetM).padStart(2, "0")}:${String(offsetS).padStart(2, "0")}`;

        // Human-friendly event type label
        let badgeClass = "badge-info";
        let typeLabel = ev.event_type;

        if (ev.event_type === "tab_hidden") {
          badgeClass = "badge-danger";
          typeLabel = "Tab Switched / Minimized";
        } else if (ev.event_type === "tab_visible") {
          badgeClass = "badge-clean";
          typeLabel = "Returned to Tab";
        } else if (ev.event_type === "window_blur") {
          badgeClass = "badge-warning";
          typeLabel = "Window Focus Lost";
        } else if (ev.event_type === "window_focus") {
          badgeClass = "badge-clean";
          typeLabel = "Window Focus Regained";
        } else if (ev.event_type === "fullscreen_exit") {
          badgeClass = "badge-warning";
          typeLabel = "Fullscreen Exited";
        } else if (ev.event_type === "camera_stopped") {
          badgeClass = "badge-danger";
          typeLabel = "Camera Stopped / Error";
        } else if (ev.event_type === "form_opened") {
          badgeClass = "badge-info";
          typeLabel = "Google Form Opened";
        } else if (ev.event_type === "candidate_reported_submitted") {
          badgeClass = "badge-purple";
          typeLabel = "Submitted (Reported)";
        } else if (ev.event_type === "attempt_started") {
          badgeClass = "badge-clean";
          typeLabel = "Session Started";
        } else if (ev.event_type === "attempt_finished") {
          badgeClass = "badge-clean";
          typeLabel = "Session Finished";
        }

        li.innerHTML = `
          <span class="event-time">${formatDate(ev.occurred_at)} (${offsetStr})</span>
          <span class="badge ${badgeClass}" style="margin: 0 4px;">${typeLabel}</span>
          <span style="color: #334155;">${escapeHtml(ev.details || "")}</span>
        `;
        timeline.append(li);
      });
    }

    // Review Form Pre-population
    $("reviewStatusSelect").value = a.review_status || "pending";
    $("reviewNote").value = a.admin_note || "";

    show("detailModal");
  } catch (err) {
    alert("Could not load attempt details: " + err.message);
  }
}

// Close Modal
function closeModal() {
  const videoElem = $("reviewVideo");
  if (videoElem) {
    videoElem.pause();
    videoElem.src = "";
  }
  hide("detailModal");
  currentAttemptId = null;
}

$("modalCloseBtn").addEventListener("click", closeModal);
$("detailModal").addEventListener("click", (e) => {
  if (e.target === $("detailModal")) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("detailModal").classList.contains("hidden")) {
    closeModal();
  }
});

// Save Review Decision
$("reviewForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!currentAttemptId) return;

  const btn = $("saveReviewBtn");
  btn.disabled = true;
  $("reviewSaveStatus").textContent = "Saving…";
  $("reviewSaveStatus").style.color = "var(--primary)";

  const fd = new FormData(e.currentTarget);
  const reviewStatus = fd.get("reviewStatus");
  const note = fd.get("note");

  try {
    await request(`/api/admin/attempts/${currentAttemptId}/review`, {
      method: "PATCH",
      body: JSON.stringify({ reviewStatus, note })
    });

    $("reviewSaveStatus").innerHTML = '<svg class="icon icon-sm icon-success" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg> Saved successfully!';
    $("reviewSaveStatus").style.color = "var(--success)";

    // Update in memory and re-render table
    const target = allAttempts.find(a => a.id === currentAttemptId);
    if (target) {
      target.review_status = reviewStatus;
      target.admin_note = note;
      updateMetrics(allAttempts);
      applyFilters();
    }
  } catch (err) {
    $("reviewSaveStatus").innerHTML = '<svg class="icon icon-sm icon-danger" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg> Failed: ' + escapeHtml(err.message);
    $("reviewSaveStatus").style.color = "var(--danger)";
  } finally {
    btn.disabled = false;
  }
});

// Auto-login on load if token in session
(async () => {
  if (token) {
    hide("login");
    show("dashboard");
    show("logoutBtn");
    await loadAttempts();
  }
})();
