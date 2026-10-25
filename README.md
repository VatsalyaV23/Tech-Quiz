# Nexus 2k26 Technical-Quiz — Online Proctoring Portal

A high-integrity, mobile-responsive online proctoring portal for the **Nexus 2k26 Technical-Quiz**, integrating an embedded Google Form with webcam recording, browser focus tracking, violation alerts, and a real-time organizer review dashboard.

---

## 🌟 Key Features

1. **Instant Camera Verification & Live Preview:**
   - Candidate details are verified and the live webcam preview initializes immediately with centered positioning guidelines.
   - Front-camera default (`facingMode: "user"`) optimized for both mobile phones and desktop computers.
   - Picture-in-Picture (PiP) floating camera badge during the quiz so participants have continuous confirmation that proctoring is active.

2. **Mobile Responsive & Compatible:**
   - Full responsiveness across all screen sizes (iPhone, Android, tablets, and laptops).
   - Touch-optimized buttons, inputs with 16px font to prevent iOS Safari auto-zoom, and responsive video previews.
   - Safe fullscreen API handling that gracefully adapts when mobile browsers restrict fullscreen gestures.

3. **Nexus 2k26 Branding & Visual Identity:**
   - Updated from legacy "Quiz Guard" to official **Nexus 2k26 Technical-Quiz** branding.
   - Custom event logo (`logo.jpeg`) integrated across candidate and admin headers.

4. **Seamless Google Forms Blending:**
   - Automatically formats embed URLs with `?embedded=true` to strip bulky Google headers and margins.
   - Sleek testing workbench container with session duration timer, candidate badges, and smooth loading placeholders.

5. **Participant Warning Modals & Focus Protection:**
   - Tab switching, window blur, and fullscreen exit events are quietly logged for organizer review.
   - Participants see **only authoritative warning dialogs** ("Warning #1: Tab switching is strictly prohibited") instead of raw event counters or logs.

6. **Organiser Admin Dashboard:**
   - **Separate, Distinct Table Columns:** Candidate (Name/Email/ID), Started At & Duration, Violations Badge, Session Status, Review Status, and Review Action.
   - **Live Search & Multi-Criteria Filters:** Filter by candidate name, review status (Pending, Flagged, Cleared, Disqualified), session status, and violation severity.
   - **Single Unified Video Player:** All recording chunks from a candidate's session are consolidated into one seamless, playable `.webm` video with speed controls (1x, 1.25x, 1.5x, 2x) and download capability.
   - **Complete Event Log Timeline:** Organizers see everything — exact timestamps, relative offsets, and color-coded event badges.
   - **CSV Export:** One-click download of all candidate records and review decisions to a `.csv` spreadsheet.

7. **Deployable Ready:**
   - Reverse proxy support (`trust proxy`), HTTP 206 partial content video streaming (Range requests for seeking), Dockerfile, `.env.example`, and graceful shutdown handlers.

---

## 🚀 Quick Start

### Prerequisites
- Node.js 20 or newer
- An embeddable Google Form URL

### Setup
1. Clone or extract this repository into your working directory:
   ```bash
   cd Tech-Quiz
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create your `.env` configuration file:
   ```bash
   cp .env.example .env
   ```
4. Edit `.env` with your settings:
   ```ini
   PORT=3000
   GOOGLE_FORM_EMBED_URL=https://docs.google.com/forms/d/e/.../viewform?embedded=true
   ADMIN_PASSWORD=YourStrongAdminPassword
   ```
5. Start the server:
   ```bash
   npm start
   ```
6. Open your browser:
   - **Candidate Portal:** [http://localhost:3000](http://localhost:3000)
   - **Admin Dashboard:** [http://localhost:3000/admin.html](http://localhost:3000/admin.html)

---

## 📋 Architecture & 100–500 Participants Scalability Notice

Before hosting an event with 100–500 simultaneous candidates, review the [DEPLOYMENT.md](file:///c:/Users/vatsa/Desktop/Projects/Tech-Quiz/DEPLOYMENT.md) guide:
- **Video Storage:** Move from local `./data/recordings` to private cloud object storage (e.g. Cloudflare R2, AWS S3).
- **Database:** Migrate SQLite to managed PostgreSQL (e.g. Supabase, Neon) to handle concurrent writes without file locking.
- **Durable Sessions:** Store session tokens in Redis or Postgres so restarts don't invalidate candidate tokens.
- **Retention Policy:** Implement automated retention/deletion scripts to remove video recordings after results are declared.
