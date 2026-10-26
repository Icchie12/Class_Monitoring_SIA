const DEFAULT_API = "http://127.0.0.1:5000";
const MEET_PREFIX = "https://meet.google.com/";

async function getState() {
  return await chrome.storage.local.get(["studentId", "sessionId", "apiBase", "lastActivity", "meetTabIds", "lastMeetTabId"]);
}

async function apiUrl(path) {
  const s = await getState();
  return (s.apiBase || DEFAULT_API).replace(/\/$/, "") + path;
}

async function sendEvent(type, details="") {
  const s = await getState();
  if (!s.studentId) return;
  await fetch((s.apiBase || DEFAULT_API).replace(/\/$/, "") + "/api/event", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body:JSON.stringify({student_id:s.studentId, event_type:type, details})
  }).catch(()=>{});
}

function isMeet(url) { return typeof url === "string" && url.startsWith(MEET_PREFIX); }

async function rememberMeetTab(tabId, isMeetTab) {
  const s = await getState();
  let ids = Array.isArray(s.meetTabIds) ? s.meetTabIds : [];
  ids = isMeetTab ? [...new Set([...ids, tabId])] : ids.filter(id => id !== tabId);
  await chrome.storage.local.set({meetTabIds: ids});
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "SET_MONITOR_CONFIG") {
    chrome.storage.local.set({
      studentId: message.studentId, sessionId: message.sessionId,
      apiBase: message.apiBase || DEFAULT_API, lastActivity: Date.now()
    });
    return;
  }
  if (message.type === "ACTIVITY") {
    // Activity updates are used only for active/inactive status.
    // Do not create an ACTIVITY database event for mouse movement.
    chrome.storage.local.set({lastActivity: Date.now()});
  }
  if (message.type === "TAB_HIDDEN" || message.type === "TAB_VISIBLE") {
    sendEvent(message.type, message.details || "Google Meet tab visibility changed.");
  }
  if (message.type === "CHAT") sendEvent("CHAT", message.details || "Student sent a Google Meet chat message.");
  if (message.type === "CAMERA_ON") sendEvent("CAMERA_ON", "Camera appears ON in Google Meet.");
  if (message.type === "CAMERA_OFF") sendEvent("CAMERA_OFF", "Camera appears OFF in Google Meet.");
  if (message.type === "MIC_ON") sendEvent("MIC_ON", "Microphone appears ON in Google Meet.");
  if (message.type === "MIC_OFF") sendEvent("MIC_OFF", "Microphone appears OFF in Google Meet.");
});

chrome.tabs.onActivated.addListener(async ({tabId}) => {
  const tab = await chrome.tabs.get(tabId).catch(()=>null);
  if (!tab) return;
  const s = await getState();
  if (!s.studentId) return;
  const meet = isMeet(tab.url);
  await rememberMeetTab(tabId, meet);
  if (meet) {
    await chrome.storage.local.set({lastMeetTabId: tabId});
    await sendEvent("TAB_VISIBLE", "Google Meet tab became active.");
  } else {
    await sendEvent("TAB_HIDDEN", "Student switched away from Google Meet.");
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!tab || !isMeet(tab.url)) return;
  await rememberMeetTab(tabId, true);
  if (changeInfo.status === "complete") {
    const s = await getState();
    if (s.studentId) await sendEvent("RETURNED_MEET", "Google Meet page loaded.");
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const s = await getState();
  if (!s.studentId) return;
  const ids = Array.isArray(s.meetTabIds) ? s.meetTabIds : [];
  if (ids.includes(tabId)) {
    await sendEvent("LEFT_MEET", "Google Meet tab was closed.");
    await chrome.storage.local.set({meetTabIds: ids.filter(id => id !== tabId)});
  }
});

// Heartbeat is intentionally short so tab switching and inactivity are reflected quickly.
setInterval(async () => {
  const s = await getState();
  if (!s.studentId) return;
  const active = Date.now() - (s.lastActivity || 0) < 300000;
  await fetch((s.apiBase || DEFAULT_API).replace(/\/$/, "") + "/api/heartbeat", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body:JSON.stringify({student_id:s.studentId, active})
  }).catch(()=>{});
}, 15000);
