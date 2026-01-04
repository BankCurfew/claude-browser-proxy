// Claude Browser Proxy - Background Service Worker
// Connects to local Mosquitto MQTT broker via WebSocket

const MQTT_WS_URL = 'ws://localhost:9001';
const TOPICS = {
  command: 'claude/browser/command',
  response: 'claude/browser/response'
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

// Create MQTT PUBLISH packet
function createPublishPacket(topic, message) {
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

  return new Uint8Array([
    0x30, // PUBLISH packet type (QoS 0)
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
    console.error('[MQTT] Error:', err);
  };
}

// Publish message
function publish(topic, message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(createPublishPacket(topic, message));
    console.log('[MQTT] Published to', topic);
  }
}

// Update extension badge
function updateBadge(connected) {
  chrome.action.setBadgeText({ text: connected ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
}

// Handle commands from Claude Code
async function handleCommand(topic, command) {
  console.log('[Claude] Command:', command);

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
              el.value = text;
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

      default:
        result = { error: 'Unknown action: ' + command.action };
    }
  } catch (err) {
    result = { error: err.message };
  }

  // Send response
  publish(TOPICS.response, {
    id: command.id,
    action: command.action,
    result: result,
    timestamp: Date.now()
  });
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'status') {
    sendResponse({ connected: isConnected });
  } else if (msg.action === 'reconnect') {
    if (ws) ws.close();
    connect();
    sendResponse({ ok: true });
  }
  return true;
});

// Start
console.log('[Claude Browser Proxy] Starting...');
connect();

// Keep alive ping every 30 seconds
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(new Uint8Array([0xC0, 0x00])); // PINGREQ
  }
}, 30000);
