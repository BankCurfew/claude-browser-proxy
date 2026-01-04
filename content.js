// Claude Browser Proxy - Content Script
// Runs in the context of web pages

console.log('[Claude Proxy] Content script loaded');

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Claude Proxy] Message from background:', message);

  // Handle any direct content script actions here
  if (message.action === 'ping') {
    sendResponse({ status: 'ok', url: window.location.href });
  }

  return true;
});
