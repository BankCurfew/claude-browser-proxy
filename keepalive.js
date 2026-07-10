// MV3 keepalive: content script maintains a port to the service worker.
// As long as this port is open, Chrome won't terminate the service worker.
// Reconnects every 250s (Chrome force-closes ports at 5 minutes).
(function keepAlive() {
  const port = chrome.runtime.connect({ name: 'keepalive' });
  port.onDisconnect.addListener(keepAlive);
  setTimeout(() => { port.disconnect(); }, 250000);
})();
