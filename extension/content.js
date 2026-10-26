// Online Class Monitor content script.
// Handles student-page configuration and best-effort monitoring of the student's
// own Google Meet browser state (tab activity, camera, microphone, and chat).

function send(type, extra = {}) {
  chrome.runtime.sendMessage({ type, ...extra }).catch(() => {});
}

// ------------------------------------------------------------
// Student setup page -> extension configuration
// ------------------------------------------------------------
if (location.hostname === "127.0.0.1" || location.hostname === "localhost") {
  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.type !== "ONLINE_CLASS_MONITOR_CONFIG") return;

    send("SET_MONITOR_CONFIG", {
      studentId: event.data.studentId,
      sessionId: event.data.sessionId,
      apiBase: event.data.apiBase || location.origin
    });
  });

  const studentId = localStorage.getItem("monitorStudentId");
  const sessionId = localStorage.getItem("monitorSessionId");
  if (studentId && sessionId) {
    send("SET_MONITOR_CONFIG", { studentId, sessionId });
  }
}

// ------------------------------------------------------------
// Google Meet monitoring
// Camera/microphone detection is best-effort because Meet can change its UI.
// Chat is counted only when the student submits a non-empty message.
// ------------------------------------------------------------
if (location.hostname === "meet.google.com") {
  let lastInteraction = Date.now();
  let lastCameraState = null;
  let lastMicState = null;
  let initializedToggleStates = false;
  let lastChatSentAt = 0;
  let lastChatFingerprint = "";
  let lastChatFingerprintAt = 0;

  function activity() {
    lastInteraction = Date.now();
    send("ACTIVITY");
  }

  function reportVisibility() {
    send(
      document.visibilityState === "visible" ? "TAB_VISIBLE" : "TAB_HIDDEN",
      { details: document.visibilityState === "visible" ? "Google Meet page is visible." : "Google Meet page is hidden." }
    );
  }
  document.addEventListener("visibilitychange", reportVisibility, true);
  window.addEventListener("focus", () => send("TAB_VISIBLE", { details: "Google Meet window focused." }), true);
  window.addEventListener("blur", () => send("TAB_HIDDEN", { details: "Google Meet window lost focus." }), true);

  ["mousemove", "keydown", "click", "pointerdown", "scroll", "touchstart"].forEach(name => {
    document.addEventListener(name, activity, { passive: true });
  });

  setInterval(() => {
    if (Date.now() - lastInteraction < 5000) send("ACTIVITY");
  }, 5000);

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && el.getClientRects().length > 0;
  }

  function labelOf(el) {
    return [
      el.getAttribute("aria-label"),
      el.getAttribute("data-tooltip"),
      el.getAttribute("title"),
      el.innerText
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function visibleControlLabels() {
    return Array.from(document.querySelectorAll("button, [role='button']"))
      .filter(isVisible)
      .map(labelOf)
      .filter(Boolean);
  }

  function stateFromLabels(labels, onPattern, offPattern) {
    const hasOn = labels.some(label => onPattern.test(label));
    const hasOff = labels.some(label => offPattern.test(label));
    if (hasOn && !hasOff) return "ON";
    if (hasOff && !hasOn) return "OFF";
    return null;
  }

  function detectToggleState() {
    const labels = visibleControlLabels();
    const micState = stateFromLabels(
      labels,
      /\b(turn off|mute) (your )?microphone\b|\bmicrophone is on\b/,
      /\b(turn on|unmute) (your )?microphone\b|\bmicrophone is off\b/
    );
    const cameraState = stateFromLabels(
      labels,
      /\bturn off (your )?camera\b|\bcamera is on\b/,
      /\bturn on (your )?camera\b|\bcamera is off\b/
    );

    // Establish the starting state quietly. Only record actual state changes
    // after the initial UI has been read, avoiding false events on page load.
    if (!initializedToggleStates) {
      if (micState !== null) lastMicState = micState;
      if (cameraState !== null) lastCameraState = cameraState;
      if (micState !== null || cameraState !== null) initializedToggleStates = true;
      return;
    }

    if (micState !== null && lastMicState !== null && micState !== lastMicState) {
      send(micState === "ON" ? "MIC_ON" : "MIC_OFF");
      lastMicState = micState;
    } else if (micState !== null && lastMicState === null) {
      lastMicState = micState;
    }

    if (cameraState !== null && lastCameraState !== null && cameraState !== lastCameraState) {
      send(cameraState === "ON" ? "CAMERA_ON" : "CAMERA_OFF");
      lastCameraState = cameraState;
    } else if (cameraState !== null && lastCameraState === null) {
      lastCameraState = cameraState;
    }
  }

  function chatInputs() {
    return Array.from(document.querySelectorAll("textarea, input, [contenteditable='true'], [role='textbox']"))
      .filter(isVisible)
      .filter(el => {
        const label = [
          el.getAttribute("aria-label"), el.getAttribute("placeholder"),
          el.getAttribute("data-placeholder"), el.getAttribute("data-tooltip")
        ].filter(Boolean).join(" ").toLowerCase();
        return /chat|message|send a message/.test(label);
      });
  }

  function inputText(el) {
    if (!el) return "";
    return String(("value" in el ? el.value : el.innerText) || el.textContent || "").trim();
  }

  function recordChatSend(input) {
    const messageText = inputText(input);
    if (!messageText) return;

    const now = Date.now();
    // Enter can trigger a send-button click as well. Collapse that same action
    // into one event, but allow the same text to be sent again later.
    const fingerprint = messageText;
    if (now - lastChatSentAt < 900) return;
    if (fingerprint === lastChatFingerprint && now - lastChatFingerprintAt < 900) return;

    lastChatSentAt = now;
    lastChatFingerprint = fingerprint;
    lastChatFingerprintAt = now;
    send("CHAT", { details: "Student sent a Google Meet chat message." });
  }

  function bindChatInputs() {
    for (const input of chatInputs()) {
      if (input.dataset.classWatchChatBound === "1") continue;
      input.dataset.classWatchChatBound = "1";
      input.addEventListener("keydown", event => {
        if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
        if (!inputText(input)) return;
        // Capture before Meet clears the input after sending.
        recordChatSend(input);
      }, true);
    }
  }

  function detectChatSendButton(event) {
    const target = event.target?.closest?.("button, [role='button']");
    if (!target || !isVisible(target)) return;
    const label = labelOf(target);
    if (!/\b(send|send message|send chat)\b/.test(label)) return;
    const input = chatInputs().find(el => inputText(el));
    if (input) recordChatSend(input);
  }

  document.addEventListener("click", detectChatSendButton, true);

  const observer = new MutationObserver(() => {
    detectToggleState();
    bindChatInputs();
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["aria-label", "data-tooltip", "title", "class", "placeholder"]
  });

  setInterval(() => {
    detectToggleState();
    bindChatInputs();
  }, 1000);

  setTimeout(() => {
    detectToggleState();
    bindChatInputs();
  }, 2500);
}
