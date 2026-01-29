// Claude Browser Proxy - Content Script
// Runs in the context of web pages (Gemini)

console.log('[Claude Proxy] Content script loaded');

// Actions for response buttons (no model selectors - those are in input area)
const DEFAULT_ACTIONS = [
  { id: 'save', label: '💾', title: 'Export to Google Docs' },
  { id: 'listen', label: '🔊', title: 'Listen to response' },
  { id: 'check', label: '✓', title: 'Double-check response' }
];

// Click menu item by text (used after opening 3-dot menu)
function clickMenuItemByText(text) {
  return new Promise((resolve) => {
    // Wait for menu to appear
    setTimeout(() => {
      const menuItems = document.querySelectorAll('[role="menuitem"], [role="option"], button');
      for (const item of menuItems) {
        if (item.textContent?.includes(text)) {
          item.click();
          console.log('[Claude Proxy] Clicked menu item:', text);
          resolve(true);
          return;
        }
      }
      console.log('[Claude Proxy] Menu item not found:', text);
      resolve(false);
    }, 300);
  });
}

// Wait for toast with "Open Docs" link and extract URL
function waitForDocsLink() {
  return new Promise((resolve) => {
    let attempts = 0;
    const maxAttempts = 20; // 2 seconds max

    const check = () => {
      attempts++;
      // Look for the "Open Docs" link in toast/snackbar
      const links = document.querySelectorAll('a[href*="docs.google.com"]');
      for (const link of links) {
        if (link.textContent?.includes('Open Docs') || link.href?.includes('docs.google.com/document')) {
          const url = link.href;
          console.log('[Claude Proxy] Found Docs link:', url);
          resolve(url);
          return;
        }
      }

      // Also check buttons that might open docs
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent?.includes('Open Docs')) {
          // Click to see where it goes, or check parent for link
          const parent = btn.closest('a');
          if (parent?.href) {
            console.log('[Claude Proxy] Found Docs link from button parent:', parent.href);
            resolve(parent.href);
            return;
          }
        }
      }

      if (attempts < maxAttempts) {
        setTimeout(check, 100);
      } else {
        console.log('[Claude Proxy] Docs link not found after 2s');
        resolve(null);
      }
    };

    check();
  });
}

// Show toast notification
function showToast(message, duration = 3000) {
  let toast = document.getElementById('claude-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'claude-toast';
    toast.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#3b82f6;color:white;padding:12px 24px;border-radius:8px;font-family:system-ui;font-size:14px;z-index:99999;box-shadow:0 4px 12px rgba(0,0,0,0.3);transition:opacity 0.3s;';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.opacity = '1';
  setTimeout(() => { toast.style.opacity = '0'; }, duration);
}

// Inject buttons into a model-response
function injectButtons(modelResponse, index, actions) {
  if (modelResponse.querySelector('.claude-response-actions')) return false;

  // Find action buttons row - look for thumbs up/down, refresh, copy pattern
  const allButtons = Array.from(modelResponse.querySelectorAll('button'));
  if (allButtons.length < 3) return false;

  // Filter out "Sources" button and any buttons with text content
  const actionButtons = allButtons.filter(b => {
    const text = b.textContent?.trim();
    // Skip if it has long text like "Sources", "Try now", etc.
    if (text && text.length > 3 && !text.includes('⋮')) return false;
    return true;
  });

  if (actionButtons.length < 3) return false;

  // The ⋮ menu is typically the last action button (after 👍👎🔄📋)
  const lastBtn = actionButtons[actionButtons.length - 1];

  const container = document.createElement('div');
  container.className = 'claude-response-actions';
  container.style.cssText = 'display:inline-flex;gap:8px;margin-left:12px;align-items:center;';

  actions.forEach(action => {
    // Separator is just a visual divider
    if (action.id === 'separator') {
      const sep = document.createElement('span');
      sep.textContent = '|';
      sep.style.cssText = 'color:#555;font-size:14px;padding:0 4px;user-select:none;';
      container.appendChild(sep);
      return;
    }

    const btn = document.createElement('button');
    btn.textContent = action.label;
    btn.title = action.title || action.label;
    btn.style.cssText = 'background:transparent;border:none;color:#9aa0a6;cursor:pointer;font-size:16px;padding:4px;opacity:0.7;transition:opacity 0.2s;';
    btn.onmouseenter = () => btn.style.opacity = '1';
    btn.onmouseleave = () => btn.style.opacity = '0.7';

    btn.onclick = async () => {
      if (action.id === 'save') {
        // 💾 = Click 3-dot menu, then "Export to Docs", then get link
        console.log('[Claude Proxy] Save clicked - opening menu...');
        lastBtn.click(); // Click the ⋮ menu
        const clicked = await clickMenuItemByText('Export to Docs');

        if (clicked) {
          showToast('⏳ Creating Google Doc...');
          const docsUrl = await waitForDocsLink();

          if (docsUrl) {
            // Copy to clipboard
            try {
              await navigator.clipboard.writeText(docsUrl);
              showToast('📋 Link copied: ' + docsUrl.substring(0, 50) + '...');
            } catch (e) {
              showToast('📄 ' + docsUrl);
            }

            // Send to background for MQTT
            chrome.runtime.sendMessage({
              action: 'docs_exported',
              url: docsUrl,
              geminiUrl: window.location.href
            });
          } else {
            showToast('⚠️ Could not get Docs link');
          }
        }
      } else if (action.id === 'listen') {
        // 🔊 = Click 3-dot menu, then "Listen"
        console.log('[Claude Proxy] Listen clicked - opening menu...');
        lastBtn.click(); // Click the ⋮ menu
        await clickMenuItemByText('Listen');
      } else if (action.id === 'check') {
        // ✓ = Click 3-dot menu, then "Double-check response"
        console.log('[Claude Proxy] Check clicked - opening menu...');
        lastBtn.click(); // Click the ⋮ menu
        await clickMenuItemByText('Double-check');
      } else if (action.id === 'separator') {
        // Just a visual separator, do nothing
        return;
      } else if (action.id === 'fast' || action.id === 'thinking' || action.id === 'pro') {
        // Model selection - use select_model action via background
        console.log('[Claude Proxy] Model select:', action.id);
        showToast('🔄 Switching to ' + action.id + '...');
        chrome.runtime.sendMessage({
          action: 'select_model',
          model: action.id
        }, (response) => {
          if (response?.success) {
            showToast('✅ Switched to ' + response.model);
          } else {
            showToast('⚠️ ' + (response?.error || 'Failed'));
          }
        });
      } else {
        // Other actions - post message
        const msgContent = modelResponse.querySelector('MESSAGE-CONTENT, message-content');
        window.postMessage({
          type: 'claude-response-action',
          action: action.id,
          responseIndex: index,
          text: msgContent?.innerText?.substring(0, 500) || ''
        }, '*');
      }
    };
    container.appendChild(btn);
  });

  lastBtn.after(container);
  return true;
}

// Scan and inject all responses
function injectAll(actions = DEFAULT_ACTIONS) {
  const modelResponses = document.querySelectorAll('model-response');
  let injected = 0;
  modelResponses.forEach((mr, i) => {
    if (injectButtons(mr, i, actions)) injected++;
  });
  return injected;
}

// Auto-start MutationObserver
function startAutoInject(actions = DEFAULT_ACTIONS) {
  if (window._claudeAutoInject) return;

  // Initial inject
  const initial = injectAll(actions);
  injectInputAreaButtons(currentTabId);
  injectHeaderTabId(currentTabId);
  console.log('[Claude Proxy] Initial inject:', initial);

  // Watch for new responses and input area
  const observer = new MutationObserver(() => {
    injectAll(actions);
    injectInputAreaButtons(currentTabId);
    injectHeaderTabId(currentTabId);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  window._claudeAutoInject = { observer, actions };
  console.log('[Claude Proxy] Auto-inject started');
}

// Inject model buttons into input area (after Tools)
function injectInputAreaButtons(tabId) {
  if (document.getElementById('claude-input-buttons')) return false;

  // Find the "Tools" button
  const allBtns = Array.from(document.querySelectorAll('button'));
  const toolsBtn = allBtns.find(b => b.textContent?.trim() === 'Tools');
  if (!toolsBtn) return false;

  const container = document.createElement('div');
  container.id = 'claude-input-buttons';
  container.style.cssText = 'display:inline-flex;gap:4px;margin-left:12px;align-items:center;';

  const models = [
    { id: 'fast', label: '⚡', title: 'Fast' },
    { id: 'thinking', label: '💭', title: 'Thinking' },
    { id: 'pro', label: '🧠', title: 'Pro' }
  ];

  models.forEach(model => {
    const btn = document.createElement('button');
    btn.textContent = model.label;
    btn.title = model.title;
    btn.style.cssText = 'background:transparent;border:1px solid #555;color:#9aa0a6;cursor:pointer;font-size:14px;padding:4px 8px;border-radius:16px;opacity:0.8;transition:all 0.2s;';
    btn.onmouseenter = () => { btn.style.opacity = '1'; btn.style.borderColor = '#888'; };
    btn.onmouseleave = () => { btn.style.opacity = '0.8'; btn.style.borderColor = '#555'; };
    btn.onclick = () => {
      showToast('🔄 Switching to ' + model.title + '...');
      chrome.runtime.sendMessage({
        action: 'select_model',
        model: model.id
      }, (response) => {
        if (response?.success) {
          showToast('✅ ' + response.model);
        } else {
          showToast('⚠️ ' + (response?.error || 'Failed'));
        }
      });
    };
    container.appendChild(btn);
  });

  // Add separator
  const sep = document.createElement('span');
  sep.textContent = '|';
  sep.style.cssText = 'color:#555;font-size:14px;padding:0 4px;user-select:none;';
  container.appendChild(sep);

  // Add Deep Research button - uses select_mode action via background
  const researchBtn = document.createElement('button');
  researchBtn.textContent = '🔬';
  researchBtn.title = 'Deep Research';
  researchBtn.style.cssText = 'background:transparent;border:1px solid #555;color:#9aa0a6;cursor:pointer;font-size:14px;padding:4px 8px;border-radius:16px;opacity:0.8;transition:all 0.2s;';
  researchBtn.onmouseenter = () => { researchBtn.style.opacity = '1'; researchBtn.style.borderColor = '#888'; };
  researchBtn.onmouseleave = () => { researchBtn.style.opacity = '0.8'; researchBtn.style.borderColor = '#555'; };
  researchBtn.onclick = () => {
    showToast('🔄 Switching to Deep Research...');
    chrome.runtime.sendMessage({
      action: 'select_mode',
      mode: 'Deep Research'
    }, (response) => {
      if (response?.success) {
        showToast('✅ Deep Research');
      } else {
        showToast('⚠️ ' + (response?.error || 'Failed'));
      }
    });
  };
  container.appendChild(researchBtn);

  // Add TAB ID after brain
  if (tabId) {
    const tabBadge = document.createElement('span');
    tabBadge.id = 'claude-tab-inline';
    tabBadge.textContent = 'TAB:' + tabId;
    tabBadge.style.cssText = 'background:#22c55e;color:white;padding:4px 10px;border-radius:12px;font-family:monospace;font-size:12px;font-weight:bold;margin-left:8px;';
    container.appendChild(tabBadge);
  }

  toolsBtn.after(container);
  console.log('[Claude Proxy] Input area buttons injected');
  return true;
}

// Store tabId globally for injection
let currentTabId = null;

// Inject TAB ID in header (fixed position, top-right before PRO)
function injectHeaderTabId(tabId) {
  if (!tabId || document.getElementById('claude-header-tab')) return false;

  const tabBadge = document.createElement('div');
  tabBadge.id = 'claude-header-tab';
  tabBadge.textContent = 'TAB:' + tabId;
  tabBadge.style.cssText = 'position:fixed;top:22px;right:130px;background:#22c55e;color:white;padding:6px 14px;border-radius:16px;font-family:monospace;font-size:12px;font-weight:bold;z-index:99999;';

  document.body.appendChild(tabBadge);
  console.log('[Claude Proxy] Header TAB ID injected (fixed position)');
  return true;
}

// Start after page is ready
function init() {
  // Get tab ID from background
  chrome.runtime.sendMessage({ action: 'getTabId' }, (response) => {
    if (response?.tabId) {
      currentTabId = response.tabId;
      console.log('[Claude Proxy] Tab ID:', currentTabId);
    }
    // Start auto-inject after getting tab ID
    setTimeout(() => startAutoInject(), 500);

    // Retry injection every 2 seconds for first 10 seconds (handles slow page loads)
    let retries = 0;
    const retryInterval = setInterval(() => {
      retries++;
      injectAll();
      injectInputAreaButtons(currentTabId);
      injectHeaderTabId(currentTabId);
      if (retries >= 5) clearInterval(retryInterval);
    }, 2000);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Claude Proxy] Message from background:', message);

  if (message.action === 'ping') {
    sendResponse({ status: 'ok', url: window.location.href });
  }

  if (message.action === 'update_actions') {
    // Allow updating actions from background
    if (window._claudeAutoInject) {
      window._claudeAutoInject.actions = message.actions;
    }
    startAutoInject(message.actions);
    sendResponse({ ok: true });
  }

  return true;
});
