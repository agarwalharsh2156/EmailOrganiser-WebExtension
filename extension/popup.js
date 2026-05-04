document.addEventListener('DOMContentLoaded', async () => {
  const authView = document.getElementById('auth-view');
  const dashboardView = document.getElementById('dashboard-view');
  const runBtn = document.getElementById('btn-run');
  const toggle = document.getElementById('toggle-enable');
  const statusDot = document.getElementById('status-dot');

  // --- 1. INITIALIZATION & AUTH CHECK ---
  async function init() {
    // Silently check if we have a token
    chrome.identity.getAuthToken({ interactive: false }, async (token) => {
      if (chrome.runtime.lastError || !token) {
        authView.style.display = 'block';
        dashboardView.style.display = 'none';
      } else {
        authView.style.display = 'none';
        dashboardView.style.display = 'block';
        await loadStats();
      }
    });
  }

  // --- 2. LOAD STATS ---
  async function loadStats() {
    const data = await chrome.storage.local.get(['isEnabled', 'stats']);
    
    // Toggle
    toggle.checked = data.isEnabled || false;
    statusDot.className = 'status-dot ' + (toggle.checked ? '' : 'off');
    
    // Stats Syncing
    const todayStr = new Date().toDateString();
    let stats = data.stats || { total: 0, today: 0, date: todayStr, categories: [] };
    
    // If it's a new day, visually reset "Today"
    if (stats.date !== todayStr) stats.today = 0;

    document.getElementById('s-total').textContent = stats.total;
    document.getElementById('s-today').textContent = stats.today;
    document.getElementById('s-cats').textContent = stats.categories.length;
  }

  // --- 3. AUTHENTICATION BUTTONS ---
  document.getElementById('btn-login').addEventListener('click', () => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (!chrome.runtime.lastError && token) {
        init(); // Reload UI
      }
    });
  });

  document.getElementById('btn-logout').addEventListener('click', () => {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (token) {
        // 1. Revoke access on Google's servers
        fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`);
        // 2. Remove token from Chrome's cache
        chrome.identity.removeCachedAuthToken({ token: token }, () => {
          init(); // Reload UI (will show login screen)
        });
      }
    });
  });

  // --- 4. DASHBOARD CONTROLS ---
  toggle.addEventListener('change', async (e) => {
    const isEnabled = e.target.checked;
    await chrome.storage.local.set({ isEnabled: isEnabled });
    statusDot.className = 'status-dot ' + (isEnabled ? '' : 'off');
  });

  runBtn.addEventListener('click', () => {
    runBtn.innerHTML = '⏳ Scanning Inbox...';
    runBtn.disabled = true;
    resetStepper();
    
    chrome.runtime.sendMessage({ action: 'runNow' });
  });

  // --- 5. LIVE STEPPER LOGIC ---
  function resetStepper() {
    const steps = ['auth', 'fetch', 'ai', 'move'];
    steps.forEach(s => {
      const el = document.getElementById(`step-${s}`);
      el.className = 'step';
      el.querySelector('.icon').innerText = '○';
    });
  }

  // Listen for progress updates from background.js
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'PROGRESS_UPDATE') {
      const el = document.getElementById(`step-${msg.step}`);
      if (!el) return;

      if (msg.status === 'loading') {
        el.className = 'step active';
        el.querySelector('.icon').innerText = '⏳';
      } else if (msg.status === 'done') {
        el.className = 'step done';
        el.querySelector('.icon').innerText = '✅';
      } else if (msg.status === 'error') {
        el.className = 'step error';
        el.querySelector('.icon').innerText = '❌';
      }

      // Re-enable button when completely finished
      if (msg.step === 'move' && (msg.status === 'done' || msg.status === 'error')) {
        runBtn.innerHTML = '▶ Run Inbox Scan Now';
        runBtn.disabled = false;
        loadStats(); // Refresh stats after a scan completes
      }
    }
  });

  init();
});