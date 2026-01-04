// Popup script
document.addEventListener('DOMContentLoaded', async () => {
  // Show version
  const manifest = chrome.runtime.getManifest();
  document.getElementById('version').textContent = 'v' + manifest.version;

  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');

  // Check connection status via badge
  const text = await chrome.action.getBadgeText({});
  const connected = text === 'ON';

  statusDot.classList.toggle('connected', connected);
  statusText.textContent = connected ? 'Connected to MQTT' : 'Disconnected';

  // Test button
  document.getElementById('testBtn').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      statusText.textContent = 'Testing...';
      // Send test via content script
      chrome.tabs.sendMessage(tab.id, { action: 'ping' }, (response) => {
        if (response) {
          statusText.textContent = 'Page: ' + new URL(response.url).hostname;
        } else {
          statusText.textContent = 'No response';
        }
      });
    }
  });

  // Reconnect button
  document.getElementById('reconnectBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'reconnect' });
    statusText.textContent = 'Reconnecting...';
    setTimeout(() => window.close(), 500);
  });
});
