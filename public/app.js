const $ = (id) => document.getElementById(id);

let config = null;
let attempt = null;
let participantToken = null;
let stream = null;
let recorder = null;
let recordingStopped = false;
let uploadChain = Promise.resolve();
let finishing = false;
let sessionSeconds = 0;
let timerInterval = null;
let participantWarnings = 0;
let hasPendingWarning = false;

const hide = (id) => $(id)?.classList.add("hidden");
const show = (id) => $(id)?.classList.remove("hidden");

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (participantToken) headers["x-participant-token"] = participantToken;
  if (options.body && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

// Quietly report telemetry events to server for admin review
function logEvent(type, details = "") {
  if (!attempt || recordingStopped) return Promise.resolve();
  return api(`/api/attempts/${attempt.id}/events`, {
    method: "POST",
    body: JSON.stringify({ type, details })
  }).catch(err => console.warn("Event logging error:", err.message));
}

// Upload chunk sequentially to server (server appends chunk directly to single candidate recording)
function uploadBlob(blob) {
  if (!blob || !blob.size || !attempt || recordingStopped) return Promise.resolve();
  const form = new FormData();
  form.append("chunk", blob, `chunk-${Date.now()}.webm`);

  uploadChain = uploadChain.then(() =>
    api(`/api/attempts/${attempt.id}/recordings`, { method: "POST", body: form })
  ).catch(err => {
    console.error("Upload chunk error:", err);
    throw err;
  });

  return uploadChain;
}

// Initialize webcam preview immediately after candidate details form
async function initCameraPreview() {
  $("cameraError").textContent = "";
  $("cameraStatus").textContent = "Requesting camera access from browser…";
  $("cameraBadgeText").textContent = "Connecting…";
  $("startExam").disabled = true;
  hide("retryCamera");

  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("Webcam access is not supported by your browser or environment. Please use Google Chrome, Edge, Safari, or Firefox.");
    }

    // Stop any existing tracks before re-requesting
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }

    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: 1280, max: 1920 },
        height: { ideal: 720, max: 1080 },
        frameRate: { ideal: 24, max: 30 }
      },
      audio: false
    });

    const preview = $("preview");
    preview.srcObject = stream;
    await preview.play().catch(() => {});

    $("cameraStatus").innerHTML = '<svg class="icon icon-sm icon-success" viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg> Camera ready! Ensure your face is centered and clearly lit.';
    $("cameraBadgeText").textContent = "Live Preview";
    if ($("camStatusDot")) $("camStatusDot").className = "dot green";
    $("startExam").disabled = false;
  } catch (err) {
    console.error("Camera preview initialization failed:", err);
    $("camStatusDot").className = "dot pulse-red";
    $("cameraBadgeText").textContent = "Camera Error";
    
    let userMsg = "Camera access failed: " + err.message;
    if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
      userMsg = "Camera access was denied. Please click the camera/lock icon in your browser address bar, allow camera permissions, and click 'Retry Camera Access'.";
    } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
      userMsg = "No camera was detected on this device. Please connect a webcam and click 'Retry Camera Access'.";
    } else if (err.name === "NotReadableError" || err.name === "TrackStartError") {
      userMsg = "Your camera is currently in use by another application. Please close Zoom, Teams, Meet, or other browser tabs and click 'Retry Camera Access'.";
    }

    $("cameraError").textContent = userMsg;
    $("cameraStatus").textContent = "Camera access is mandatory to take the quiz.";
    show("retryCamera");
  }
}

// Start live proctoring & embed form
async function startRecording() {
  if (!stream || stream.getVideoTracks().length === 0 || !stream.getVideoTracks()[0].enabled) {
    await initCameraPreview();
    if (!stream) throw new Error("Please enable camera before starting the quiz.");
  }

  // Bind stream to floating picture-in-picture widget
  const pip = $("pipVideo");
  if (pip) {
    pip.srcObject = stream;
    pip.play().catch(() => {});
  }

  // Determine supported WebM mime type
  let mimeType = "video/webm";
  if (typeof MediaRecorder !== "undefined") {
    if (MediaRecorder.isTypeSupported("video/webm;codecs=vp8")) {
      mimeType = "video/webm;codecs=vp8";
    } else if (MediaRecorder.isTypeSupported("video/webm")) {
      mimeType = "video/webm";
    }
  }

  recorder = new MediaRecorder(stream, { mimeType });
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      uploadBlob(e.data).catch(() => {});
    }
  };

  recorder.onerror = () => logEvent("recording_error", "MediaRecorder encountered an error");
  recorder.onstop = () => {
    // Keep tracks active until full session completes
  };

  // Upload sequential WebM slices every 6 seconds to stream cleanly to server
  recorder.start(6000);

  // Monitor camera track health
  const videoTrack = stream.getVideoTracks()[0];
  if (videoTrack) {
    videoTrack.onended = () => {
      logEvent("camera_stopped", "Webcam video track ended prematurely");
      triggerWarning("Your camera was disconnected or stopped. Please reconnect your camera immediately.");
    };
  }

  // Start session duration timer
  sessionSeconds = 0;
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    sessionSeconds++;
    const m = String(Math.floor(sessionSeconds / 60)).padStart(2, "0");
    const s = String(sessionSeconds % 60).padStart(2, "0");
    const timerElem = $("timerText") || $("sessionTimer");
    if (timerElem) timerElem.textContent = `${m}:${s}`;
  }, 1000);
}

// Show official warning modal to participant
function triggerWarning(customText) {
  if (recordingStopped || finishing) return;
  participantWarnings++;
  $("warningBadge").textContent = `Violation Warning #${participantWarnings}`;
  if (customText) {
    const p = $("warningModal").querySelector("p");
    if (p) p.textContent = customText;
  }
  show("warningModal");
}

// Candidate Registration Form Submit
$("startForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("startError").textContent = "";
  const btn = $("btnContinue");
  btn.disabled = true;
  btn.textContent = "Setting up session…";

  const fd = new FormData(e.currentTarget);
  try {
    attempt = await api("/api/attempts", {
      method: "POST",
      body: JSON.stringify({
        name: fd.get("name"),
        email: fd.get("email"),
        candidateRef: fd.get("candidateRef"),
        consent: fd.get("consent") === "on"
      })
    });

    participantToken = attempt.token;
    $("candidateTitle").textContent = `${fd.get("name")}`;
    const ref = fd.get("candidateRef");
    $("candidateSub").textContent = ref ? `ID: ${ref} • Nexus 2k26 Technical-Quiz` : "Nexus 2k26 Technical-Quiz";

    hide("intro");
    show("cameraPanel");

    // REQUIREMENT 1: Immediately show camera preview upon entering camera section
    await initCameraPreview();
  } catch (err) {
    $("startError").textContent = err.message || "Could not register attempt. Please try again.";
    btn.disabled = false;
    btn.textContent = "Continue to Camera Check →";
  }
});

$("retryCamera")?.addEventListener("click", () => initCameraPreview());

// Start Exam Button Click
$("startExam").addEventListener("click", async () => {
  $("startExam").disabled = true;
  $("startExam").textContent = "Opening quiz…";
  $("cameraError").textContent = "";

  try {
    if (!config || !config.formUrl) {
      throw new Error("Quiz configuration could not be loaded. Please reload the page or contact the organizers.");
    }

    await startRecording();

    // Load Google Form in seamless blended frame
    const iframe = $("googleForm");
    iframe.onload = () => {
      const loader = $("formLoading");
      if (loader) loader.style.opacity = "0";
      setTimeout(() => hide("formLoading"), 300);
    };
    iframe.src = config.formUrl;

    await logEvent("form_opened", "Google Form iframe loaded in portal");

    hide("cameraPanel");
    show("examPanel");

    // Request fullscreen on desktop / supported mobile browsers
    try {
      if (document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
      } else if (document.documentElement.webkitRequestFullscreen) {
        await document.documentElement.webkitRequestFullscreen();
      }
    } catch (e) {
      // Fullscreen not allowed or rejected by user; ignore gracefully
    }
  } catch (err) {
    $("cameraError").textContent = err.message;
    $("startExam").disabled = false;
    $("startExam").textContent = "Start Recording & Open Quiz";
  }
});

// Tab switching & focus monitoring
document.addEventListener("visibilitychange", () => {
  if (!attempt || recordingStopped || finishing) return;

  if (document.hidden) {
    // Participant left tab
    hasPendingWarning = true;
    logEvent("tab_hidden", "Candidate switched away from quiz tab or minimized browser");
  } else {
    // Participant returned to tab
    logEvent("tab_visible", "Candidate returned to quiz tab");
    if (hasPendingWarning) {
      hasPendingWarning = false;
      triggerWarning();
    }
  }
});

window.addEventListener("blur", () => {
  if (!attempt || recordingStopped || finishing) return;
  logEvent("window_blur", "Browser window lost focus");
});

window.addEventListener("focus", () => {
  if (!attempt || recordingStopped || finishing) return;
  logEvent("window_focus", "Browser window regained focus");
});

document.addEventListener("fullscreenchange", () => {
  if (!attempt || recordingStopped || finishing) return;
  if (!document.fullscreenElement && !$("examPanel").classList.contains("hidden")) {
    logEvent("fullscreen_exit", "Candidate exited fullscreen mode");
  }
});

// Dismiss warning overlay
$("dismissWarningBtn")?.addEventListener("click", () => {
  hide("warningModal");
  // Try to restore fullscreen if possible
  try {
    if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  } catch (e) {}
});

// Finish session confirmation
$("finishExam").addEventListener("click", async () => {
  if (finishing) return;
  const ok = confirm("Have you already clicked 'Submit' inside the Google Form above?\n\nClick OK only if your answers have been submitted.");
  if (!ok) return;

  finishing = true;
  $("finishExam").disabled = true;
  $("finishStatus").textContent = "Uploading final recording data to server…";

  try {
    await logEvent("candidate_reported_submitted", "Candidate confirmed Google Forms submission");

    if (timerInterval) clearInterval(timerInterval);

    // Stop recorder and ensure final chunk is generated and uploaded
    if (recorder && recorder.state !== "inactive") {
      await new Promise((resolve) => {
        recorder.addEventListener("stop", resolve, { once: true });
        recorder.stop();
      });
    }

    // Wait for all chunk uploads to complete
    await uploadChain;

    // Notify backend to mark attempt finished
    await api(`/api/attempts/${attempt.id}/finish`, {
      method: "POST",
      body: JSON.stringify({ submitted: true })
    });

    recordingStopped = true;

    // Stop webcam hardware
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }

    // Exit fullscreen if active
    if (document.fullscreenElement && document.exitFullscreen) {
      await document.exitFullscreen().catch(() => {});
    }

    hide("examPanel");
    hide("floatingPip");
    show("donePanel");
  } catch (err) {
    $("finishStatus").textContent = `Could not finalize: ${err.message}. Please keep this page open and contact the organizers.`;
    finishing = false;
    $("finishExam").disabled = false;
  }
});

// Prevent accidental tab closure during active quiz
window.addEventListener("beforeunload", (e) => {
  if (attempt && !recordingStopped && !finishing) {
    e.preventDefault();
    e.returnValue = "Your quiz recording is currently in progress. Leaving this page may invalidate your submission.";
  }
});

// Load configuration on page load
(async () => {
  try {
    config = await fetch("/api/config").then(r => r.json());
  } catch {
    $("startError").textContent = "Could not connect to the competition server. Please check your internet connection.";
  }
})();
