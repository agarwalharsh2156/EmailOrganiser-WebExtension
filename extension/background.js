// background.js

const SCAN_INTERVAL = 1; // 1 minute polling for near real-time feel

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({ isEnabled: false, totalSorted: 0, processedIds: {} });
  chrome.alarms.create('email-scan-alarm', { periodInMinutes: SCAN_INTERVAL });
  console.log("EPD Detector installed. 1-minute alarm set.");
});

// ─── 1. THE ALARM (AUTO-SCAN) ───────────────────────────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'email-scan-alarm') {
    const data = await chrome.storage.local.get(['isEnabled']);
    if (data.isEnabled) {
      console.log("⏰ Auto-scan triggered...");
      await runFullScan();
    }
  }
});

// ─── 2. LISTEN FOR MANUAL BUTTON CLICK ──────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'runNow') {
    console.log("🖱️ Manual scan triggered...");
    runFullScan().then(() => sendResponse({ status: "success" }));
    return true; // Keep channel open
  }
});

// ─── 3. THE MAIN SCAN LOGIC ─────────────────────────────────────
async function runFullScan() {
  try {
    const token = await getToken();
    const data = await chrome.storage.local.get(['processedIds', 'totalSorted']);
    const processedIds = data.processedIds || {};
    let totalSorted = data.totalSorted || 0;

    const allUnreadIds = await listUnreadEmails(token);
    
    // FILTER 3: Remove IDs we have already processed
    const newIds = allUnreadIds.filter(id => !processedIds[id]);
    console.log(`Found ${allUnreadIds.length} unread. ${newIds.length} are new.`);

    for (const id of newIds) {
      // Fetch & Parse
      const rawMsg = await fetchEmail(id, token);
      const cleanEmail = parseEmail(rawMsg);
      
      // Call ML Backend
      const aiResult = await callBackend(cleanEmail);
      console.log(`🤖 Classified "${cleanEmail.subject}" as [${aiResult.predicted_class}]`);
      
      // Get or Create the Label in Gmail
      const labelId = await getOrCreateLabel(aiResult.predicted_class, token);
      
      // Move the email (Add label, Remove INBOX)
      await moveEmailToLabel(id, labelId, token);
      console.log(`✅ Moved to folder!`);

      // Save to storage so we never process it again
      processedIds[id] = true;
      totalSorted++;
    }

    // Save updated lists back to UI
    await chrome.storage.local.set({ processedIds, totalSorted });

  } catch (error) {
    console.error("Workflow failed:", error);
  }
}

// ─── 4. GMAIL API: LABELS & MOVING ──────────────────────────────
async function getOrCreateLabel(categoryName, token) {
  const folderName = `EPD/${categoryName}`; 
  
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels', {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  const existing = (data.labels || []).find(l => l.name.toLowerCase() === folderName.toLowerCase());
  
  if (existing) return existing.id;

  const createRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: folderName,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show'
    })
  });
  const newLabel = await createRes.json();
  return newLabel.id;
}

async function moveEmailToLabel(msgId, labelId, token) {
  await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}/modify`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      addLabelIds: [labelId],
      removeLabelIds: ['INBOX'] 
    })
  });
}

// ─── 5. HELPER FUNCTIONS ────────────────────────────────────────
async function getToken() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError.message);
      else resolve(token);
    });
  });
}

async function listUnreadEmails(token) {
  const query = encodeURIComponent('is:unread in:inbox newer_than:1d');
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=10`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`Gmail API failed: ${res.status}`);
  const data = await res.json();
  return (data.messages || []).map(m => m.id);
}

async function fetchEmail(msgId, token) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=full`, { 
    headers: { Authorization: `Bearer ${token}` } 
  });
  return res.json();
}

function parseEmail(msg) {
  const getHeader = (name) => msg.payload.headers.find(h => h.name === name)?.value || '';
  return { id: msg.id, subject: getHeader('Subject'), body: extractPlainText(msg.payload) };
}

function extractPlainText(payload) {
  if (payload.mimeType === 'text/plain' && payload.body?.data) return decodeBase64url(payload.body.data);
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) return decodeBase64url(part.body.data);
    }
    for (const part of payload.parts) {
      const found = extractPlainText(part);
      if (found) return found;
    }
  }
  return '';
}

function decodeBase64url(b64) {
  const standard = b64.replace(/-/g, '+').replace(/_/g, '/');
  try { return decodeURIComponent(escape(atob(standard))); } catch (e) { return atob(standard); }
}

// ─── 6. MACHINE LEARNING BACKEND CONNECTION ─────────────────────
async function callBackend(cleanEmail) {
  // TODO: Change this URL when your friend deploys the FastAPI server
  const BACKEND_URL = 'https://your-real-backend.railway.app'; 

  try {
    const res = await fetch(`${BACKEND_URL}/classify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message_id: cleanEmail.id,
        subject: cleanEmail.subject,
        body: cleanEmail.body.substring(0, 3000), 
        from: cleanEmail.from
      })
    });

    if (!res.ok) throw new Error(`Backend error: ${res.status}`);
    return await res.json(); 

  } catch (error) {
    console.warn("⚠️ Cannot reach backend. Using MOCK prediction.");
    // MOCK DATA: Randomly categorizing for testing purposes
    const categories = ["Meetings", "Alerts", "Newsletters", "Promotions", "Tasks"];
    return {
      predicted_class: categories[Math.floor(Math.random() * categories.length)],
      confidence: 0.95
    };
  }
}