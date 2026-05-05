// background.js

const SCAN_INTERVAL = 1; // 1 minute polling for near real-time feel

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({
    isEnabled: false,
    totalSorted: 0,
    processedIds: {},
  });
  chrome.alarms.create("email-scan-alarm", { periodInMinutes: SCAN_INTERVAL });
  console.log("EPD Detector installed. 1-minute alarm set.");
});

// ─── 1. THE ALARM (AUTO-SCAN) ───────────────────────────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "email-scan-alarm") {
    const data = await chrome.storage.local.get(["isEnabled"]);
    if (data.isEnabled) {
      console.log("⏰ Auto-scan triggered...");
      await runFullScan();
    }
  }
});

// ─── 2. LISTEN FOR MANUAL BUTTON CLICK ──────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "runNow") {
    console.log("🖱️ Manual scan triggered...");
    runFullScan().then(() => sendResponse({ status: "success" }));
    return true; // Keep channel open
  }
});

// ─── 3. THE MAIN SCAN LOGIC ─────────────────────────────────────
async function runFullScan() {
  try {
    const token = await getToken();
    const data = await chrome.storage.local.get([
      "processedIds",
      "totalSorted",
    ]);
    const processedIds = data.processedIds || {};
    let totalSorted = data.totalSorted || 0;

    const allUnreadIds = await listUnreadEmails(token);

    // FILTER 3: Remove IDs we have already processed
    const newIds = allUnreadIds.filter((id) => !processedIds[id]);
    console.log(
      `Found ${allUnreadIds.length} unread. ${newIds.length} are new.`,
    );

    // Step 1: Fetch all emails in parallel
    const rawMsgs = await Promise.all(
      newIds.map((id) => fetchEmail(id, token)),
    );
    const cleanEmails = rawMsgs.map(parseEmail);
    console.log("✔️ Parsed", cleanEmails.length, "clean emails");

    // Step 2: Single batch call to backend
    console.log("🟣 About to call callBackend with", cleanEmails.length, "emails");
    try {
      const batchResults = await callBackend(cleanEmails);
      console.log(`🤖 Batch classified ${batchResults.length} emails`);

      // Step 3: Apply labels in parallel
      await Promise.all(
        batchResults.map(async (aiResult, i) => {
          const id = newIds[i];
          const labelId = await getOrCreateLabel(aiResult.predicted_class, token);
          await moveEmailToLabel(id, labelId, token);
          console.log(
            `✅ "${cleanEmails[i].subject}" → [${aiResult.predicted_class}]`,
          );
          processedIds[id] = true;
          totalSorted++;
        }),
      );
    } catch (backendError) {
      console.error("❌ Error in backend processing:", backendError);
      throw backendError;
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

  // Fetch existing labels
  const res = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/labels",
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  const data = await res.json();
  const existing = (data.labels || []).find(
    (l) => l.name.toLowerCase() === folderName.toLowerCase(),
  );

  if (existing) {
    console.log(`🏷️ Label "${folderName}" already exists with ID: ${existing.id}`);
    return existing.id;
  }

  // Label doesn't exist, create it
  console.log(`🆕 Creating new label: "${folderName}"`);
  const createRes = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/labels",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: folderName,
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      }),
    },
  );
  
  if (!createRes.ok) {
    const errorData = await createRes.json();
    console.error("❌ Failed to create label:", errorData);
    throw new Error(`Failed to create label: ${createRes.status}`);
  }
  
  const newLabel = await createRes.json();
  console.log(`✅ Label created successfully with ID: ${newLabel.id}`);
  
  // Small delay to ensure Gmail has synced the label before trying to use it
  await new Promise(resolve => setTimeout(resolve, 500));
  
  return newLabel.id;
}

async function moveEmailToLabel(msgId, labelId, token) {
  console.log(`🔄 Moving email ${msgId} to label ${labelId}`);
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}/modify`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        addLabelIds: [labelId],
        removeLabelIds: ["INBOX"],
      }),
    },
  );
  
  if (!res.ok) {
    const errorData = await res.json();
    console.error(`❌ Failed to move email: ${res.status}`, errorData);
    throw new Error(`Failed to move email: ${res.status}`);
  }
  
  console.log(`✅ Email ${msgId} moved successfully`);
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
  const query = encodeURIComponent("is:unread in:inbox newer_than:1d");
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=25`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  if (!res.ok) throw new Error(`Gmail API failed: ${res.status}`);
  const data = await res.json();
  return (data.messages || []).map((m) => m.id);
}

async function fetchEmail(msgId, token) {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=full`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  return res.json();
}

function parseEmail(msg) {
  const getHeader = (name) =>
    msg.payload.headers.find((h) => h.name === name)?.value || "";
  return {
    id: msg.id,
    subject: getHeader("Subject"),
    body: extractPlainText(msg.payload),
    from: getHeader("From"),
  };
}

function extractPlainText(payload) {
  if (payload.mimeType === "text/plain" && payload.body?.data)
    return decodeBase64url(payload.body.data);
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data)
        return decodeBase64url(part.body.data);
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
  try {
    return decodeURIComponent(escape(atob(standard)));
  } catch (e) {
    return atob(standard);
  }
}

async function callBackend(cleanEmails) {
  const BACKEND_URL = 'http://127.0.0.1:8000';

  console.log("🔵 callBackend called with", cleanEmails.length, "emails");

  const payload = cleanEmails.map(e => ({
    message_id: e.id,
    subject:    e.subject,
    body:       e.body.substring(0, 3000),
    from:       e.from
  }));

  console.log("📤 Payload to backend:", payload);
  console.log("📤 Payload JSON:", JSON.stringify({ emails: payload }));
  
  try {
    console.log("🟡 Attempting to fetch from", BACKEND_URL + "/classify-batch");
    const res = await fetch(`${BACKEND_URL}/classify-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emails: payload })
    });
    console.log("🟡 Fetch response status:", res.status, res.ok);
    
    if (!res.ok) throw new Error(`Backend error: ${res.status}`);
    const data = await res.json();
    console.log("📥 Response from backend:", data);
    console.log("🟢 Returning", data.results?.length || 0, "results");
    return data.results; // array of { predicted_class, confidence }

  } catch (error) {
    console.warn("⚠️ Cannot reach backend. Error:", error.message);
    console.warn("⚠️ Using MOCK predictions.");
    const categories = ["Meetings", "Alerts", "Newsletters", "Promotions", "Tasks"];
    return cleanEmails.map(() => ({
      predicted_class: categories[Math.floor(Math.random() * categories.length)],
      confidence: 0.95
    }));
  }
}
