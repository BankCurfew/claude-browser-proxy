// Claude Browser Proxy - Background Service Worker
// Connects to local Mosquitto MQTT broker via WebSocket

const MQTT_WS_URL = 'ws://localhost:9001';
const TOPICS = {
  command: 'claude/browser/command',
  response: 'claude/browser/response',
  context: 'claude/browser/context'
};

let mqttClient = null;
let isConnected = false;
let reconnectTimer = null;

// Simple MQTT over WebSocket implementation
class SimpleMQTT {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.messageId = 1;
    this.subscriptions = new Map();
    this.onMessage = null;
    this.onConnect = null;
    this.onDisconnect = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url, 'mqtt');
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
          console.log('[MQTT] WebSocket connected');
          this.sendConnect();
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(new Uint8Array(event.data));
        };

        this.ws.onclose = () => {
          console.log('[MQTT] WebSocket closed');
          if (this.onDisconnect) this.onDisconnect();
        };

        this.ws.onerror = (err) => {
          console.error('[MQTT] WebSocket error:', err);
          reject(err);
        };

        // Resolve after CONNACK
        this._connectResolve = resolve;
        this._connectReject = reject;
      } catch (err) {
        reject(err);
      }
    });
  }

  sendConnect() {
    // MQTT CONNECT packet
    const clientId = 'claude-browser-' + Math.random().toString(36).substr(2, 9);
    const clientIdBytes = new TextEncoder().encode(clientId);

    const packet = new Uint8Array([
      0x10, // CONNECT
      12 + clientIdBytes.length, // Remaining length
      0x00, 0x04, 0x4D, 0x51, 0x54, 0x54, // Protocol name "MQTT"
      0x04, // Protocol level (4 = MQTT 3.1.1)
      0x02, // Connect flags (clean session)
      0x00, 0x3C, // Keep alive (60 seconds)
      0x00, clientIdBytes.length, // Client ID length
      ...clientIdBytes
    ]);

    this.ws.send(packet);
  }

  handleMessage(data) {
    const type = (data[0] & 0xF0) >> 4;

    switch (type) {
      case 2: // CONNACK
        console.log('[MQTT] Connected to broker');
        isConnected = true;
        if (this.onConnect) this.onConnect();
        if (this._connectResolve) this._connectResolve();
        break;

      case 3: // PUBLISH
        this.handlePublish(data);
        break;

      case 9: // SUBACK
        console.log('[MQTT] Subscribed');
        break;
    }
  }

  handlePublish(data) {
    let offset = 1;
    let remainingLength = data[offset++];

    // Topic length
    const topicLength = (data[offset] << 8) | data[offset + 1];
    offset += 2;

    // Topic
    const topic = new TextDecoder().decode(data.slice(offset, offset + topicLength));
    offset += topicLength;

    // Payload
    const payload = new TextDecoder().decode(data.slice(offset));

    console.log('[MQTT] Received:', topic, payload);

    if (this.onMessage) {
      try {
        this.onMessage(topic, JSON.parse(payload));
      } catch (e) {
        this.onMessage(topic, payload);
      }
    }
  }

  subscribe(topic) {
    const topicBytes = new TextEncoder().encode(topic);
    const msgId = this.messageId++;

    const packet = new Uint8Array([
      0x82, // SUBSCRIBE
      5 + topicBytes.length, // Remaining length
      (msgId >> 8) & 0xFF, msgId & 0xFF, // Message ID
      0x00, topicBytes.length, // Topic length
      ...topicBytes,
      0x00 // QoS 0
    ]);

    this.ws.send(packet);
    console.log('[MQTT] Subscribing to:', topic);
  }

  publish(topic, message) {
    const topicBytes = new TextEncoder().encode(topic);
    const payload = typeof message === 'string' ? message : JSON.stringify(message);
    const payloadBytes = new TextEncoder().encode(payload);

    const packet = new Uint8Array([
      0x30, // PUBLISH (QoS 0)
      2 + topicBytes.length + payloadBytes.length,
      0x00, topicBytes.length,
      ...topicBytes,
      ...payloadBytes
    ]);

    this.ws.send(packet);
    console.log('[MQTT] Published to:', topic);
  }

  disconnect() {
    if (this.ws) {
      this.ws.send(new Uint8Array([0xE0, 0x00])); // DISCONNECT
      this.ws.close();
    }
  }
}

// Connect to MQTT
async function connectMQTT() {
  try {
    mqttClient = new SimpleMQTT(MQTT_WS_URL);

    mqttClient.onConnect = () => {
      mqttClient.subscribe(TOPICS.command);
      updateIcon(true);
    };

    mqttClient.onDisconnect = () => {
      isConnected = false;
      updateIcon(false);
      scheduleReconnect();
    };

    mqttClient.onMessage = handleCommand;

    await mqttClient.connect();
    console.log('[Claude Proxy] Connected to MQTT broker');
  } catch (err) {
    console.error('[Claude Proxy] Connection failed:', err);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectMQTT();
  }, 5000);
}

function updateIcon(connected) {
  // Could update badge here
  chrome.action.setBadgeText({ text: connected ? 'ON' : 'OFF' });
  chrome.action.setBadgeBackgroundColor({ color: connected ? '#22c55e' : '#ef4444' });
}

// Handle commands from Claude Code
async function handleCommand(topic, command) {
  console.log('[Claude Proxy] Command:', command);

  try {
    let result;

    switch (command.action) {
      case 'get_html':
        result = await executeInTab('getHTML');
        break;

      case 'get_text':
        result = await executeInTab('getText');
        break;

      case 'get_url':
        result = await executeInTab('getURL');
        break;

      case 'get_title':
        result = await executeInTab('getTitle');
        break;

      case 'get_selection':
        result = await executeInTab('getSelection');
        break;

      case 'get_links':
        result = await executeInTab('getLinks');
        break;

      case 'get_images':
        result = await executeInTab('getImages');
        break;

      case 'get_videos':
        result = await executeInTab('getVideos');
        break;

      case 'click':
        result = await executeInTab('click', command.selector);
        break;

      case 'type':
        result = await executeInTab('type', command.selector, command.text);
        break;

      case 'scroll':
        result = await executeInTab('scroll', command.direction, command.amount);
        break;

      case 'screenshot':
        result = await captureScreenshot();
        break;

      case 'download':
        result = await downloadFile(command.url, command.filename);
        break;

      case 'execute':
        result = await executeInTab('execute', command.code);
        break;

      default:
        result = { error: 'Unknown action: ' + command.action };
    }

    // Send response
    mqttClient.publish(TOPICS.response, {
      id: command.id,
      action: command.action,
      result: result,
      timestamp: Date.now()
    });

  } catch (err) {
    mqttClient.publish(TOPICS.response, {
      id: command.id,
      action: command.action,
      error: err.message,
      timestamp: Date.now()
    });
  }
}

// Execute script in active tab
async function executeInTab(action, ...args) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab');

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: contentActions[action],
    args: args
  });

  return results[0]?.result;
}

// Content script actions (injected into page)
const contentActions = {
  getHTML: () => document.documentElement.outerHTML,
  getText: () => document.body.innerText,
  getURL: () => window.location.href,
  getTitle: () => document.title,
  getSelection: () => window.getSelection().toString(),

  getLinks: () => Array.from(document.querySelectorAll('a[href]')).map(a => ({
    href: a.href,
    text: a.innerText.trim().slice(0, 100)
  })).slice(0, 100),

  getImages: () => Array.from(document.querySelectorAll('img[src]')).map(img => ({
    src: img.src,
    alt: img.alt
  })).slice(0, 50),

  getVideos: () => Array.from(document.querySelectorAll('video')).map(v => ({
    src: v.src || v.currentSrc,
    sources: Array.from(v.querySelectorAll('source')).map(s => s.src)
  })),

  click: (selector) => {
    const el = document.querySelector(selector);
    if (el) { el.click(); return { success: true }; }
    return { error: 'Element not found' };
  },

  type: (selector, text) => {
    const el = document.querySelector(selector);
    if (el) { el.value = text; el.dispatchEvent(new Event('input')); return { success: true }; }
    return { error: 'Element not found' };
  },

  scroll: (direction, amount = 300) => {
    const dirs = { up: -amount, down: amount, top: -99999, bottom: 99999 };
    window.scrollBy(0, dirs[direction] || 0);
    return { success: true };
  },

  execute: (code) => {
    try { return eval(code); }
    catch (e) { return { error: e.message }; }
  }
};

// Capture screenshot
async function captureScreenshot() {
  const dataUrl = await chrome.tabs.captureVisibleTab();
  return { dataUrl };
}

// Download file
async function downloadFile(url, filename) {
  const id = await chrome.downloads.download({
    url: url,
    filename: filename || 'download'
  });
  return { downloadId: id };
}

// Start connection
connectMQTT();
