# Deployment & Architecture Guide — Nexus 2k26 Technical-Quiz

This document outlines deployment instructions and scaling guidance for running the **Nexus 2k26 Technical-Quiz** proctoring system.

---

## 1. Quickstart Deployment

### Option A: Cloud Platforms (Render, Railway, Fly.io, Heroku)

1. Push this project to GitHub / GitLab.
2. Link your repository in Render or Railway as a **Web Service**.
3. Set the build and start commands:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. Configure Environment Variables:
   - `PORT`: Provided automatically by host (e.g. 3000)
   - `NODE_ENV`: `production`
   - `PUBLIC_BASE_URL`: `https://your-app-domain.com`
   - `GOOGLE_FORM_EMBED_URL`: `https://docs.google.com/forms/d/e/.../viewform?embedded=true`
   - `ADMIN_PASSWORD`: A secure 16+ character password
   - `DATA_DIR`: `./data` (attach a persistent disk or volume on Render/Railway so SQLite and video files survive container restarts)
   - `MAX_RECORDING_MB`: `500`

### Option B: Linux VPS (Ubuntu / Debian + Nginx + PM2)

1. **Install Node.js 20 & PM2:**
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs
   sudo npm install -g pm2
   ```

2. **Clone & Install Dependencies:**
   ```bash
   git clone <repo-url> /var/www/nexus-quiz
   cd /var/www/nexus-quiz
   npm install --production
   cp .env.example .env
   # Edit .env with your Google Form URL & strong ADMIN_PASSWORD
   nano .env
   ```

3. **Start with PM2:**
   ```bash
   pm2 start server.js --name "nexus-quiz"
   pm2 save
   pm2 startup
   ```

4. **Nginx Reverse Proxy Configuration:**
   ```nginx
   server {
       server_name quiz.nexus2k26.com;

       client_max_body_size 500M;

       location / {
           proxy_pass http://127.0.0.1:3000;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
           proxy_buffering off;
       }
   }
   ```
5. Install SSL Certificate with Certbot:
   ```bash
   sudo certbot --nginx -d quiz.nexus2k26.com
   ```

---

## 2. Event Readiness Guide for 100–500 Participants

> **Important Operational Notice:**
> The current setup is a single-node starter with local disk storage and SQLite. For an event with 100–500 simultaneous participants, review and implement the recommendations below prior to event day.

### Storage & Bandwidth Estimation

| Metric | 100 Participants (45 min) | 300 Participants (45 min) | 500 Participants (45 min) |
|---|---|---|---|
| **Video Bitrate** | ~600–800 kbps | ~600–800 kbps | ~600–800 kbps |
| **Storage per Candidate** | ~200–270 MB | ~200–270 MB | ~200–270 MB |
| **Total Disk Storage** | ~20–27 GB | ~60–81 GB | ~100–135 GB |
| **Concurrent Network Ingress**| ~60–80 Mbps | ~180–240 Mbps | ~300–400 Mbps |

---

### Key Pre-Event Architecture Checklist

#### 1. Move Video Files to Private Cloud Object Storage
- Local disk on ephemeral cloud containers (Heroku, standard Render) wipes on redeploy.
- Stream uploaded chunks or sync completed `.webm` files directly to **AWS S3, Cloudflare R2, or Google Cloud Storage**.
- Cloudflare R2 is ideal because it has **$0 egress fees**, making video playback by organizers cost-effective.
- Generate private Presigned URLs with short expiration (e.g. 15 minutes) for admin video review.

#### 2. Migrate Database to Managed PostgreSQL
- SQLite WAL mode works well up to a few dozen simultaneous writes, but 500 concurrent connections uploading chunks and events every 5–10 seconds can hit SQLite lock contention.
- Migrate the `attempts`, `events`, and `recordings` tables to a managed PostgreSQL database (e.g., Neon, Supabase, AWS RDS, or DigitalOcean Managed Database).

#### 3. Durable Sessions & In-Memory State
- Active participant sessions (`participantTokens`) and admin sessions (`adminSessions`) currently live in Node memory.
- If the server restarts during the quiz, candidates would need to re-authenticate.
- Move session tokens to **Redis** or database tables so server restarts or load-balanced multiple instances don't disrupt active participants.

#### 4. Upload Retries & Network Resilience
- On weak mobile connections, an upload chunk might time out.
- The client-side `uploadBlob` function should use exponential backoff (e.g. 3 retries with 1s, 2s, 4s delay) and store failed chunks in an in-memory or IndexedDB buffer before retrying.

#### 5. Secure Admin Access
- Enforce HTTPS across all routes.
- Change `ADMIN_PASSWORD` to a randomly generated 24+ character string.
- Restrict `/admin.html` access to organizer IPs or place it behind Cloudflare Access / Zero Trust SSO.

#### 6. Recording Consent, Retention & Deletion Policy
- Explicit candidate consent is captured before camera initialization.
- Establish a written retention policy (e.g., all recordings deleted 14 days after result declaration).
- Create a cron job or scheduled task to auto-delete video recordings older than the retention window:
  ```bash
  find ./data/recordings -type f -mtime +14 -delete
  ```

---

## 3. Pre-Flight Testing Checklist

- [ ] Verify Google Forms embed URL opens with `?embedded=true` without login issues.
- [ ] Test camera permissions on Android (Chrome) and iOS (Safari).
- [ ] Test intentional tab switching: verify candidate receives the warning modal without seeing raw logs.
- [ ] Test admin review: verify candidate appears with separate columns and the single video player plays the session recording.
- [ ] Test CSV export: download `nexus-2k26-quiz-attempts.csv` and verify data accuracy.
