document.addEventListener('DOMContentLoaded', async () => {
  // 1. Fetch saved state
  const data = await chrome.storage.local.get(['isEnabled', 'totalSorted']);
  
  // 2. Set initial toggle state
  const toggle = document.getElementById('toggle-enable');
  const statusDot = document.getElementById('status-dot');
  
  toggle.checked = data.isEnabled || false;
  statusDot.className = 'status-dot ' + (toggle.checked ? '' : 'off');
  
  // Set mock stats for the skeleton
  document.getElementById('s-total').textContent = data.totalSorted || 0;

  // 3. Listen for toggle changes
  toggle.addEventListener('change', async (e) => {
    const isEnabled = e.target.checked;
    await chrome.storage.local.set({ isEnabled: isEnabled });
    statusDot.className = 'status-dot ' + (isEnabled ? '' : 'off');
    
    // Optional: Tell background worker to start an immediate scan if turned on
    if (isEnabled) {
      chrome.runtime.sendMessage({ action: 'runNow' });
    }
  });

  // 4. Listen for "Run Now" button click
  const runBtn = document.getElementById('btn-run');
  runBtn.addEventListener('click', () => {
    runBtn.innerHTML = '⏳ Scanning Inbox...';
    runBtn.classList.add('scanning');
    
    // Send message to the background engine
    chrome.runtime.sendMessage({ action: 'runNow' }, (response) => {
      // Revert button after 1.5 seconds for this UI mockup phase
      setTimeout(() => {
        runBtn.innerHTML = '▶ Run Inbox Scan Now';
        runBtn.classList.remove('scanning');
      }, 1500);
    });
  });
});