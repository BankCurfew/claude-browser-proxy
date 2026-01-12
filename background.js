// Claude Browser Proxy - Background Service Worker
// Connects to local Mosquitto MQTT broker via WebSocket

const MQTT_WS_URL = 'ws://localhost:9001';
const TOPICS = {
  command: 'claude/browser/command',
  response: 'claude/browser/response',
  page: 'claude/browser/page',
  answer: 'claude/browser/answer'
};

let ws = null;
let isConnected = false;
let messageId = 1;

// Encode remaining length (MQTT variable byte integer)
function encodeRemainingLength(length) {
  const bytes = [];
  do {
    let byte = length % 128;
    length = Math.floor(length / 128);
    if (length > 0) byte |= 0x80;
    bytes.push(byte);
  } while (length > 0);
  return bytes;
}

// Create MQTT CONNECT packet
function createConnectPacket() {
  const clientId = 'claude-browser-' + Date.now();
  const clientIdBytes = new TextEncoder().encode(clientId);

  const variableHeader = [
    0x00, 0x04, // Protocol name length
    0x4D, 0x51, 0x54, 0x54, // "MQTT"
    0x04, // Protocol level (4 = 3.1.1)
    0x02, // Connect flags (clean session)
    0x00, 0x3C // Keep alive (60 seconds)
  ];

  const payload = [
    (clientIdBytes.length >> 8) & 0xFF,
    clientIdBytes.length & 0xFF,
    ...clientIdBytes
  ];

  const remainingLength = variableHeader.length + payload.length;

  return new Uint8Array([
    0x10, // CONNECT packet type
    ...encodeRemainingLength(remainingLength),
    ...variableHeader,
    ...payload
  ]);
}

// Create MQTT SUBSCRIBE packet
function createSubscribePacket(topic) {
  const topicBytes = new TextEncoder().encode(topic);
  const msgId = messageId++;

  const variableHeader = [
    (msgId >> 8) & 0xFF,
    msgId & 0xFF
  ];

  const payload = [
    (topicBytes.length >> 8) & 0xFF,
    topicBytes.length & 0xFF,
    ...topicBytes,
    0x00 // QoS 0
  ];

  const remainingLength = variableHeader.length + payload.length;

  return new Uint8Array([
    0x82, // SUBSCRIBE packet type
    ...encodeRemainingLength(remainingLength),
    ...variableHeader,
    ...payload
  ]);
}

// Create MQTT PUBLISH packet (with optional retain flag)
function createPublishPacket(topic, message, retain = false) {
  const topicBytes = new TextEncoder().encode(topic);
  const payloadBytes = new TextEncoder().encode(
    typeof message === 'string' ? message : JSON.stringify(message)
  );

  const variableHeader = [
    (topicBytes.length >> 8) & 0xFF,
    topicBytes.length & 0xFF,
    ...topicBytes
  ];

  const remainingLength = variableHeader.length + payloadBytes.length;
  const flags = retain ? 0x31 : 0x30; // 0x31 = PUBLISH + retain

  return new Uint8Array([
    flags, // PUBLISH packet type (QoS 0, optional retain)
    ...encodeRemainingLength(remainingLength),
    ...variableHeader,
    ...payloadBytes
  ]);
}

// Parse incoming MQTT packet
function parsePacket(data) {
  const type = (data[0] & 0xF0) >> 4;
  let offset = 1;

  // Decode remaining length
  let remainingLength = 0;
  let multiplier = 1;
  let byte;
  do {
    byte = data[offset++];
    remainingLength += (byte & 0x7F) * multiplier;
    multiplier *= 128;
  } while (byte & 0x80);

  return { type, offset, remainingLength, data };
}

// Handle incoming PUBLISH
function handlePublish(packet) {
  let offset = packet.offset;

  // Topic length
  const topicLength = (packet.data[offset] << 8) | packet.data[offset + 1];
  offset += 2;

  // Topic
  const topic = new TextDecoder().decode(
    packet.data.slice(offset, offset + topicLength)
  );
  offset += topicLength;

  // Payload
  const payload = new TextDecoder().decode(
    packet.data.slice(offset, offset + packet.remainingLength - topicLength - 2)
  );

  console.log('[MQTT] Received:', topic, payload);

  try {
    handleCommand(topic, JSON.parse(payload));
  } catch (e) {
    handleCommand(topic, payload);
  }
}

// Connect to MQTT broker
function connect() {
  console.log('[MQTT] Connecting to', MQTT_WS_URL);

  ws = new WebSocket(MQTT_WS_URL, 'mqtt');
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    console.log('[MQTT] WebSocket open, sending CONNECT');
    ws.send(createConnectPacket());
  };

  ws.onmessage = (event) => {
    const packet = parsePacket(new Uint8Array(event.data));

    switch (packet.type) {
      case 2: // CONNACK
        console.log('[MQTT] Connected!');
        isConnected = true;
        updateBadge(true);
        // Subscribe to command topic
        ws.send(createSubscribePacket(TOPICS.command));
        break;

      case 3: // PUBLISH
        handlePublish(packet);
        break;

      case 9: // SUBACK
        console.log('[MQTT] Subscribed to', TOPICS.command);
        break;

      case 13: // PINGRESP
        console.log('[MQTT] Ping OK');
        break;
    }
  };

  ws.onclose = () => {
    console.log('[MQTT] Disconnected');
    isConnected = false;
    updateBadge(false);
    setTimeout(connect, 5000);
  };

  ws.onerror = (err) => {
    console.error('[MQTT] WebSocket Error:', err);
    console.error('[MQTT] ReadyState:', ws.readyState);
  };
}

// Publish message (with optional retain)
function publish(topic, message, retain = false) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(createPublishPacket(topic, message, retain));
    console.log('[MQTT] Published to', topic, retain ? '(retained)' : '');
  }
}

// Update extension badge and storage
async function updateBadge(connected) {
  // Only show badge when on Gemini
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const onGemini = tab?.url?.includes('gemini.google.com');
    chrome.action.setBadgeText({ text: (connected && onGemini) ? 'ON' : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
  } catch (e) {
    chrome.action.setBadgeText({ text: '' });
  }
  // Save to storage for sidepanel
  chrome.storage.local.set({ mqttConnected: connected });
}

// Broadcast to sidepanel via storage
async function broadcastLog(type, data) {
  try {
    const stored = await chrome.storage.local.get('logs');
    const logs = stored.logs || [];
    logs.push({ type, data, time: Date.now() });
    if (logs.length > 50) logs.shift(); // Keep last 50
    await chrome.storage.local.set({ logs: logs });
    console.log('[Log] Stored:', type, logs.length, 'entries');
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
        result = { html: result[0]?.result?.substring(0, 50000) }; // Limit size
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
              // Handle both input/textarea and contenteditable
              if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                el.value = text;
              } else if (el.isContentEditable || el.getAttribute('contenteditable')) {
                el.textContent = text;
              } else {
                el.value = text; // fallback
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
              // Count initial responses to detect NEW ones
              const getResponses = () => document.querySelectorAll('message-content, [data-message-id], .model-response-text');
              const initialCount = getResponses().length;
              let lastText = '';
              let stableCount = 0;

              const checkResponse = () => {
                const responses = getResponses();
                // Wait for NEW response (more than initial)
                if (responses.length > initialCount) {
                  const lastResponse = responses[responses.length - 1];
                  const text = (lastResponse.textContent || lastResponse.innerText || '').trim();

                  // Check if text is stable (not still typing)
                  if (text === lastText && text.length > 5) {
                    stableCount++;
                    if (stableCount >= 3) { // Stable for 3 checks = done
                      resolve({ answer: text, success: true });
                      return true;
                    }
                  } else {
                    lastText = text;
                    stableCount = 0;
                  }
                }

                // Timeout check
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

              // Poll every 500ms
              const interval = setInterval(() => {
                if (checkResponse()) clearInterval(interval);
              }, 500);
            });
          },
          args: [command.timeout || 15000]
        });
        result = result[0]?.result;
        // Publish answer to separate topic and sidebar
        if (result?.answer) {
          publish(TOPICS.answer, {
            answer: result.answer,
            timestamp: Date.now()
          }, true); // retained
          await broadcastLog('answer', { answer: result.answer }); // Show in sidebar box
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
        // Select Gemini model: "fast", "thinking", "pro"
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async (modelName) => {
            // Click the model dropdown (Pro v button)
            const dropdownBtn = document.querySelector('button[aria-haspopup="listbox"]') ||
                               document.querySelector('[data-model-selector]') ||
                               Array.from(document.querySelectorAll('button')).find(b =>
                                 b.textContent.match(/Pro|Fast|Thinking/i) && b.querySelector('svg'));
            if (!dropdownBtn) return { error: 'Model dropdown not found' };

            dropdownBtn.click();
            await new Promise(r => setTimeout(r, 500));

            // Find and click the model option
            const modelMap = {
              'fast': 'Fast',
              'thinking': 'Thinking',
              'pro': 'Pro'
            };
            const targetModel = modelMap[modelName.toLowerCase()] || modelName;

            const options = document.querySelectorAll('[role="option"], [role="menuitem"]');
            for (const opt of options) {
              if (opt.textContent.includes(targetModel)) {
                opt.click();
                return { success: true, model: targetModel };
              }
            }

            // Try clicking by text content
            const allButtons = document.querySelectorAll('button, div[role="option"]');
            for (const btn of allButtons) {
              if (btn.textContent.trim().startsWith(targetModel)) {
                btn.click();
                return { success: true, model: targetModel };
              }
            }

            return { error: 'Model option not found: ' + targetModel };
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
  publish(TOPICS.response, response, true); // retain=true
  await broadcastLog('res', response);
}

// Listen for messages from popup/sidepanel
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'status') {
    sendResponse({ connected: isConnected });
  } else if (msg.action === 'reconnect') {
    if (ws) ws.close();
    connect();
    sendResponse({ ok: true });
  } else if (msg.action === 'command') {
    // Forward command to MQTT
    publish(TOPICS.command, msg.command);
    sendResponse({ ok: true });
  }
  return true;
});

// Enable side panel
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

// Start
console.log('[Claude Browser Proxy] v1.0.5 Starting...');
console.log('[Claude Browser Proxy] Connecting to:', MQTT_WS_URL);
try {
  connect();
} catch (e) {
  console.error('[Claude Browser Proxy] Failed to start:', e);
}

// Keep alive ping every 30 seconds
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(new Uint8Array([0xC0, 0x00])); // PINGREQ
  }
}, 30000);

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
      publish(TOPICS.page, pageInfo, true); // retain=true
      await broadcastLog('page', pageInfo); // Show in sidebar
    }
  } catch (e) {
    console.error('[Page] Error:', e);
  }
}

// Enable/disable sidebar based on URL (greyed out on non-Gemini)
async function updateSidebarState() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const onGemini = tab?.url?.includes('gemini.google.com');
    await chrome.sidePanel.setOptions({
      tabId: tab.id,
      path: 'sidepanel.html',
      enabled: onGemini
    });
  } catch (e) {
    // Ignore
  }
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
