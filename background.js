// Claude Browser Proxy - Background Service Worker
// Uses MQTT.js library for WebSocket connection to Mosquitto broker

importScripts('mqtt.min.js');

const VERSION = '2.4.0'; // Short version for badge display
const MQTT_URL = 'ws://localhost:9001';
const TOPICS = {
  command: 'claude/browser/command',
  response: 'claude/browser/response',
  page: 'claude/browser/page',
  answer: 'claude/browser/answer',
  status: 'claude/browser/status',
  state: 'claude/browser/state'  // Loading/tool state
};

let client = null;
let isConnected = false;

// Connect to MQTT broker with LWT
function connect() {
  console.log('[MQTT] Connecting to', MQTT_URL);

  client = mqtt.connect(MQTT_URL, {
    clientId: 'claude-browser-' + Date.now(),
    keepalive: 15, // 15 seconds - LWT triggers after ~22 sec if no ping
    reconnectPeriod: 5000, // Reconnect every 5 seconds
    will: {
      topic: TOPICS.status,
      payload: JSON.stringify({ status: 'offline', timestamp: Date.now(), version: VERSION }),
      qos: 0,
      retain: true
    }
  });

  client.on('connect', () => {
    console.log('[MQTT] Connected!');
    isConnected = true;
    updateBadge(true);

    // Subscribe to command topic
    client.subscribe(TOPICS.command, (err) => {
      if (err) console.error('[MQTT] Subscribe error:', err);
      else console.log('[MQTT] Subscribed to', TOPICS.command);
    });

    // Publish "online" status (retained) - overrides LWT "offline"
    client.publish(TOPICS.status, JSON.stringify({
      status: 'online',
      timestamp: Date.now(),
      version: VERSION
    }), { retain: true });
  });

  client.on('message', (topic, message) => {
    console.log('[MQTT] Received:', topic);
    try {
      const command = JSON.parse(message.toString());
      handleCommand(topic, command);
    } catch (e) {
      handleCommand(topic, message.toString());
    }
  });

  client.on('close', () => {
    console.log('[MQTT] Disconnected');
    isConnected = false;
    updateBadge(false);
  });

  client.on('error', (err) => {
    console.error('[MQTT] Error:', err);
  });
}

// Publish message (with optional retain)
function publish(topic, message, retain = false) {
  if (client && isConnected) {
    const payload = typeof message === 'string' ? message : JSON.stringify(message);
    client.publish(topic, payload, { retain });
    console.log('[MQTT] Published to', topic, retain ? '(retained)' : '');
  }
}

// Update extension badge and storage
async function updateBadge(connected) {
  chrome.storage.local.set({ mqttConnected: connected });
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const onGemini = tab && tab.url && tab.url.includes('gemini.google.com');
    chrome.action.setBadgeText({ text: VERSION }); // Always show full version "2.0.5"
    if (onGemini && connected) {
      chrome.action.setBadgeBackgroundColor({ color: '#22c55e' }); // green
    } else {
      chrome.action.setBadgeBackgroundColor({ color: '#ef4444' }); // red
    }
  } catch (e) {
    chrome.action.setBadgeText({ text: VERSION });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  }
}

// Broadcast to sidepanel via storage
async function broadcastLog(type, data) {
  try {
    const stored = await chrome.storage.local.get('logs');
    const logs = stored.logs || [];
    logs.push({ type, data, time: Date.now() });
    if (logs.length > 50) logs.shift();
    await chrome.storage.local.set({ logs });
  } catch (e) {
    console.error('[Log] Error:', e);
  }
}

// Handle commands from Claude Code
async function handleCommand(topic, command) {
  console.log('[Claude] Command:', command);
  await broadcastLog('cmd', command);

  let result;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('No active tab');

    switch (command.action) {
      case 'get_html':
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => document.documentElement.outerHTML
        });
        result = { html: result[0]?.result?.substring(0, 50000) };
        break;

      case 'get_text':
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => document.body.innerText
        });
        result = { text: result[0]?.result };
        break;

      case 'get_url':
        result = { url: tab.url, title: tab.title };
        break;

      case 'get_state':
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            // Gemini State Detector
            const isLoading = () => {
              // Only check actual progress spinner, NOT avatar animation (always visible)
              const spinner = document.querySelector('mat-mdc-progress-spinner.mdc-circular-progress--indeterminate');
              if (spinner) {
                const rect = spinner.getBoundingClientRect();
                // Must be in response area (not in sidebar/header)
                if (rect.top > 100 && rect.top < window.innerHeight && rect.bottom > 0) return true;
              }
              // Also check for streaming indicator (text being typed)
              const streaming = document.querySelector('.streaming-indicator, [data-streaming="true"]');
              if (streaming) return true;
              return false;
            };

            const getActiveTool = () => {
              if (document.querySelector('img.youtube-icon')) return 'youtube';
              if (document.querySelector('img.tool-logo[src*="youtube"]')) return 'youtube';
              if (document.querySelector('img.tool-logo[src*="search"]')) return 'search';
              if (document.querySelector('img.tool-logo[src*="maps"]')) return 'maps';
              return null;
            };

            return {
              loading: isLoading(),
              tool: getActiveTool(),
              responseCount: document.querySelectorAll('MESSAGE-CONTENT').length,
              timestamp: Date.now()
            };
          }
        });
        result = result[0]?.result;
        // Auto-publish state to dedicated topic
        publish(TOPICS.state, result, false);
        break;

      case 'get_videos':
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const videos = Array.from(document.querySelectorAll('video'));
            return videos.map(v => ({
              src: v.src || v.currentSrc,
              sources: Array.from(v.querySelectorAll('source')).map(s => s.src)
            }));
          }
        });
        result = { videos: result[0]?.result };
        break;

      case 'click':
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (sel) => {
            const el = document.querySelector(sel);
            if (el) { el.click(); return { success: true }; }
            return { error: 'Not found' };
          },
          args: [command.selector]
        });
        result = result[0]?.result;
        break;

      case 'type':
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (sel, text) => {
            const el = document.querySelector(sel);
            if (el) {
              el.focus();
              if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                el.value = text;
              } else if (el.isContentEditable || el.getAttribute('contenteditable')) {
                el.textContent = text;
              } else {
                el.value = text;
              }
              el.dispatchEvent(new Event('input', { bubbles: true }));
              return { success: true };
            }
            return { error: 'Not found' };
          },
          args: [command.selector, command.text]
        });
        result = result[0]?.result;
        break;

      case 'find':
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (sel) => {
            const els = document.querySelectorAll(sel);
            return { count: els.length, found: els.length > 0 };
          },
          args: [command.selector]
        });
        result = result[0]?.result;
        break;

      case 'key':
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (key) => {
            const event = new KeyboardEvent('keydown', { key: key, bubbles: true });
            document.activeElement.dispatchEvent(event);
            return { success: true };
          },
          args: [command.key]
        });
        result = result[0]?.result;
        break;

      case 'wait_response':
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (timeout) => {
            return new Promise((resolve) => {
              const startTime = Date.now();
              const getResponses = () => document.querySelectorAll('MESSAGE-CONTENT, message-content, [data-message-id], .model-response-text');
              const initialCount = getResponses().length;
              let lastText = '';
              let stableCount = 0;

              const checkResponse = () => {
                const responses = getResponses();
                if (responses.length > initialCount) {
                  const lastResponse = responses[responses.length - 1];
                  const text = (lastResponse.textContent || lastResponse.innerText || '').trim();

                  if (text === lastText && text.length > 5) {
                    stableCount++;
                    if (stableCount >= 3) {
                      resolve({ answer: text, success: true });
                      return true;
                    }
                  } else {
                    lastText = text;
                    stableCount = 0;
                  }
                }

                if (Date.now() - startTime > timeout) {
                  if (lastText.length > 5) {
                    resolve({ answer: lastText, success: true });
                  } else {
                    resolve({ error: 'Timeout waiting for response' });
                  }
                  return true;
                }
                return false;
              };

              const interval = setInterval(() => {
                if (checkResponse()) clearInterval(interval);
              }, 500);
            });
          },
          args: [command.timeout || 15000]
        });
        result = result[0]?.result;
        if (result?.answer) {
          publish(TOPICS.answer, { answer: result.answer, timestamp: Date.now() }, true);
          await broadcastLog('answer', { answer: result.answer });
        }
        break;

      case 'get_response':
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const selectors = [
              'MESSAGE-CONTENT',     // Gemini uses uppercase custom element
              'message-content',     // fallback lowercase
              '[data-message-id]',
              '.model-response-text',
              '.response-container',
              '.markdown-main-panel'
            ];

            let responses = [];
            for (const sel of selectors) {
              const els = document.querySelectorAll(sel);
              if (els.length > 0) {
                responses = els;
                break;
              }
            }

            if (responses.length === 0) {
              return { error: 'No Gemini responses found on page' };
            }

            const lastResponse = responses[responses.length - 1];
            const text = (lastResponse.textContent || lastResponse.innerText || '').trim();

            if (!text || text.length < 5) {
              return { error: 'Response is empty or too short' };
            }

            return { answer: text, success: true, count: responses.length };
          }
        });
        result = result[0]?.result;
        if (result?.answer) {
          publish(TOPICS.answer, { answer: result.answer, timestamp: Date.now() }, true);
          await broadcastLog('answer', { answer: result.answer });
        }
        break;

      case 'screenshot':
        const dataUrl = await chrome.tabs.captureVisibleTab();
        result = { screenshot: dataUrl };
        break;

      case 'download':
        const dlId = await chrome.downloads.download({
          url: command.url,
          filename: command.filename
        });
        result = { downloadId: dlId };
        break;

      case 'execute':
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (code) => {
            try {
              return eval(code);
            } catch (e) {
              return { error: e.message };
            }
          },
          args: [command.code]
        });
        result = result[0]?.result;
        break;

      case 'select_model':
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async (modelName) => {
            const allBtns = Array.from(document.querySelectorAll('button'));
            const debug = { totalButtons: allBtns.length, candidates: [] };

            let dropdownBtn = null;
            dropdownBtn = allBtns.find(b => b.className.includes('input-area-switch'));
            if (dropdownBtn) debug.foundBy = 'input-area-switch';

            if (!dropdownBtn) {
              dropdownBtn = allBtns.find(b => b.textContent.trim().match(/^(Pro|Fast|Thinking)$/));
              if (dropdownBtn) debug.foundBy = 'text-match';
            }

            if (!dropdownBtn) {
              dropdownBtn = allBtns.find(b => b.parentElement?.className?.includes('pill-ui'));
              if (dropdownBtn) debug.foundBy = 'pill-ui-parent';
            }

            if (!dropdownBtn) {
              return { error: 'Model dropdown not found', debug, request: modelName };
            }

            debug.clickedButton = { class: dropdownBtn.className.substring(0, 50), text: dropdownBtn.textContent.trim() };
            dropdownBtn.click();
            await new Promise(r => setTimeout(r, 600));

            const modelMap = { 'fast': 'Fast', 'thinking': 'Thinking', 'pro': 'Pro' };
            const targetModel = modelMap[modelName.toLowerCase()] || modelName;

            const options = document.querySelectorAll('[role="option"], [role="menuitem"], [role="listbox"] button, .mat-mdc-menu-item');
            for (const opt of options) {
              if (opt.textContent.includes(targetModel)) {
                opt.click();
                return { success: true, model: targetModel, debug, request: modelName };
              }
            }

            const allClickables = document.querySelectorAll('button, div[role="option"], .mdc-list-item');
            for (const el of allClickables) {
              if (el.textContent.trim().startsWith(targetModel) && el !== dropdownBtn) {
                el.click();
                return { success: true, model: targetModel, debug, request: modelName };
              }
            }

            return { error: 'Model option not found: ' + targetModel, debug, request: modelName };
          },
          args: [command.model || 'pro']
        });
        result = result[0]?.result;
        break;

      default:
        result = { error: 'Unknown action: ' + command.action };
    }
  } catch (err) {
    result = { error: err.message };
  }

  // Send response (retained)
  const response = {
    id: command.id,
    action: command.action,
    result: result,
    timestamp: Date.now()
  };
  publish(TOPICS.response, response, true);
  await broadcastLog('res', response);
}

// Listen for messages from popup/sidepanel
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'status') {
    sendResponse({ connected: isConnected });
  } else if (msg.action === 'reconnect') {
    if (client) client.end();
    connect();
    sendResponse({ ok: true });
  } else if (msg.action === 'command') {
    publish(TOPICS.command, msg.command);
    sendResponse({ ok: true });
  }
  return true;
});

// Enable side panel
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

// Start
console.log('[Claude Browser Proxy] v' + VERSION + ' Starting with MQTT.js...');
updateBadge(false); // Show red initially until connected
try {
  connect();
} catch (e) {
  console.error('[Claude Browser Proxy] Failed to start:', e);
}

// Publish current page info (retained) - only for Gemini
let lastPublishedUrl = '';
async function publishCurrentPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && tab.url.includes('gemini.google.com') && tab.url !== lastPublishedUrl) {
      lastPublishedUrl = tab.url;
      const pageInfo = {
        url: tab.url,
        title: tab.title,
        timestamp: Date.now()
      };
      publish(TOPICS.page, pageInfo, true);
      await broadcastLog('page', pageInfo);
    }
  } catch (e) {
    console.error('[Page] Error:', e);
  }
}

// Enable/disable sidebar based on URL
async function updateSidebarState() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const onGemini = tab?.url?.includes('gemini.google.com');
    await chrome.sidePanel.setOptions({
      tabId: tab.id,
      path: 'sidepanel.html',
      enabled: onGemini
    });
  } catch (e) {}
}

// Listen for tab changes
chrome.tabs.onActivated.addListener(() => {
  publishCurrentPage();
  updateBadge(isConnected);
  updateSidebarState();
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.title) {
    publishCurrentPage();
    updateBadge(isConnected);
    updateSidebarState();
  }
});

// Publish initial page after connection
setTimeout(publishCurrentPage, 2000);
