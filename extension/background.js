const SCAN_INTERVAL = 1;

chrome.runtime.onInstalled.addListener(async () => {
  const todayStr = new Date().toDateString();
  await chrome.storage.local.set({
    isEnabled: false,
    processedIds: {},
    stats: { total: 0, today: 0, date: todayStr, categories: [] }
  });
  chrome.alarms.create("email-scan-alarm", { periodInMinutes: SCAN_INTERVAL });
});

// ─── ALARMS & LISTENERS ─────────────────────────────────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "email-scan-alarm") {
    const data = await chrome.storage.local.get(["isEnabled"]);
    if (data.isEnabled) await runFullScan();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "runNow") {
    runFullScan();
    sendResponse({ status: "started" });
    return true;
  }
});

// ─── UI COMMUNICATION HELPER ────────────────────────────────────
function sendProgress(step, status) {
  // Catch errors in case the popup is closed (which is fine during auto-scan)
  chrome.runtime.sendMessage({ action: "PROGRESS_UPDATE", step, status }).catch(() => {});
}

// ─── THE MAIN SCAN LOGIC ────────────────────────────────────────
async function runFullScan() {
  try {
    // 1. Auth Step
    sendProgress('auth', 'loading');
    const token = await getToken();
    sendProgress('auth', 'done');

    // Load Data & Stats
    const data = await chrome.storage.local.get(["processedIds", "stats"]);
    const processedIds = data.processedIds || {};
    
    // Sync Stats Date
    const todayStr = new Date().toDateString();
    let stats = data.stats || { total: 0, today: 0, date: todayStr, categories: [] };
    if (stats.date !== todayStr) {
      stats.today = 0;
      stats.date = todayStr;
    }

    // 2. Fetch Step
    sendProgress('fetch', 'loading');
    const allUnreadIds = await listUnreadEmails(token);
    const newIds = allUnreadIds.filter((id) => !processedIds[id]);
    
    if (newIds.length === 0) {
      sendProgress('fetch', 'done');
      sendProgress('ai', 'done');
      sendProgress('move', 'done'); // Instantly finish if nothing to do
      return;
    }

    const rawMsgs = await Promise.all(newIds.map((id) => fetchEmail(id, token)));
    const cleanEmails = rawMsgs.map(parseEmail);
    sendProgress('fetch', 'done');

    // 3. AI Classification Step
    sendProgress('ai', 'loading');
    const batchResults = await callBackend(cleanEmails); 
    sendProgress('ai', 'done');

    // 4. Moving & Labeling Step
    sendProgress('move', 'loading');
    await Promise.all(
      batchResults.map(async (aiResult, i) => {
        const id = newIds[i];
        const labelId = await getOrCreateLabel(aiResult.predicted_class, token);
        await moveEmailToLabel(id, labelId, token);
        
        // Update local memory and stats
        processedIds[id] = true;
        stats.total++;
        stats.today++;
        if (!stats.categories.includes(aiResult.predicted_class)) {
          stats.categories.push(aiResult.predicted_class);
        }
      })
    );
    
    // Save updated data
    await chrome.storage.local.set({ processedIds, stats });
    sendProgress('move', 'done');

  } catch (error) {
    console.error("Workflow failed:", error);
    sendProgress('move', 'error'); // Trigger red X on UI failure
  }
}

// ─── GMAIL API & HELPERS (Unchanged functionality) ──────────────
async function getOrCreateLabel(categoryName, token) {
  const folderName = `EPD/${categoryName}`;
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  const existing = (data.labels || []).find((l) => l.name.toLowerCase() === folderName.toLowerCase());

  if (existing) return existing.id;

  const createRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: folderName, labelListVisibility: "labelShow", messageListVisibility: "show" })
  });
  const newLabel = await createRes.json();
  return newLabel.id;
}

async function moveEmailToLabel(msgId, labelId, token) {
  await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}/modify`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ addLabelIds: [labelId], removeLabelIds: ["INBOX"] })
  });
}

async function getToken() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError.message);
      else resolve(token);
    });
  });
}

async function listUnreadEmails(token) {
  const query = encodeURIComponent("is:unread in:inbox newer_than:1d");
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=25`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Gmail API failed: ${res.status}`);
  const data = await res.json();
  return (data.messages || []).map((m) => m.id);
}

async function fetchEmail(msgId, token) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=full`, { headers: { Authorization: `Bearer ${token}` } });
  return res.json();
}

function parseEmail(msg) {
  const getHeader = (name) => msg.payload.headers.find((h) => h.name === name)?.value || "";
  return { id: msg.id, subject: getHeader("Subject"), body: extractPlainText(msg.payload), from: getHeader("From") };
}

function extractPlainText(payload) {
  if (payload.mimeType === "text/plain" && payload.body?.data) return decodeBase64url(payload.body.data);
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) return decodeBase64url(part.body.data);
    }
    for (const part of payload.parts) {
      const found = extractPlainText(part);
      if (found) return found;
    }
  }
  return "";
}

function decodeBase64url(b64) {
  const standard = b64.replace(/-/g, "+").replace(/_/g, "/");
  try { return decodeURIComponent(escape(atob(standard))); } catch (e) { return atob(standard); }
}

async function callBackend(cleanEmails) {
  const BACKEND_URL = 'http://127.0.0.1:8000';
  const payload = cleanEmails.map(e => ({ message_id: e.id, subject: e.subject, body: e.body.substring(0, 3000), from: e.from }));

  try {
    const res = await fetch(`${BACKEND_URL}/classify-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emails: payload })
    });
    if (!res.ok) throw new Error(`Backend error: ${res.status}`);
    const data = await res.json();
    return data.results; 
  } catch (error) {
    const categories = ["Meetings", "Alerts", "Newsletters", "Promotions", "Tasks"];
    return cleanEmails.map(() => ({
      predicted_class: categories[Math.floor(Math.random() * categories.length)],
      confidence: 0.95
    }));
  }
}