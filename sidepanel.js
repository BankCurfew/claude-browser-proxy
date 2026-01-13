// Side panel JS
const $ = id => document.getElementById(id);

// Version
const version = 'v' + chrome.runtime.getManifest().version;
$('v').textContent = version;
$('vb').textContent = version;

// Format JSON nicely - show friendly action names + preview
function formatMsg(msg) {
  if (typeof msg !== 'object') return msg;

  // Action icons
  const actionIcons = {
    'get_url': '🔗', 'get_text': '📄', 'get_html': '🌐', 'get_videos': '🎬',
    'get_state': '📊', 'get_response': '📥', 'screenshot': '📸', 'click': '👆',
    'type': '⌨️', 'key': '⌨️', 'find': '🔍', 'execute': '⚡', 'download': '💾',
    'select_model': '🤖', 'wait_response': '⏳', 'publish': '📤'
  };

  // Check if this is a publish log (from sidebar button)
  if (msg.topic && msg.payload) {
    const action = msg.payload?.action || 'unknown';
    const summary = '📤 ' + action + ' → ' + msg.topic + ' (' + msg.size + 'b, qos:' + msg.qos + ', retained:' + msg.retained + ')';
    const str = JSON.stringify(msg, null, 2);
    return '<details><summary>' + summary + '</summary><pre>' + str + '</pre></details>';
  }

  const action = msg.action || msg.result?.action || '';
  const icon = actionIcons[action] || '📦';
  const r = msg.result || {};

  // Build preview based on action/result
  let preview = '';
  const isCommand = msg.id && !msg.result; // Command being sent (no result yet)

  if (r.error) preview = '❌ ' + r.error;
  else if (r.url) preview = '← ' + r.url.substring(0, 45);
  else if (msg.url) preview = '← ' + msg.url.substring(0, 45); // direct url
  else if (r.title) preview = '← ' + r.title.substring(0, 40);
  else if (r.text) preview = '← ' + r.text.substring(0, 45) + '...';
  else if (r.html) preview = '← ' + r.html.length + ' chars';
  else if (r.answer) preview = '← ' + r.answer.substring(0, 35) + '...';
  else if (r.success) preview = '← ✅';
  else if (msg.text) preview = '→ ' + msg.text.substring(0, 35); // type command
  else if (msg.selector) preview = '→ ' + msg.selector.substring(0, 30); // click
  else if (isCommand) preview = '→ sending...'; // outgoing command

  const summary = icon + ' ' + (action || 'data') + (preview ? ' — ' + preview : '');
  const str = JSON.stringify(msg, null, 2);
  return '<details><summary>' + summary + '</summary><pre>' + str + '</pre></details>';
}

// Log function
function log(type, msg) {
  const el = document.createElement('div');
  el.className = 'log ' + type;
  el.innerHTML = '<span class="t">' + new Date().toLocaleTimeString() + '</span>' + formatMsg(msg);
  $('l').appendChild(el);
  $('l').scrollTop = $('l').scrollHeight;

  // Show answer in dedicated box
  if (type === 'answer' || (msg?.result?.answer)) {
    const answer = msg?.result?.answer || msg?.answer || msg;
    if (answer && typeof answer === 'string') {
      showAnswer(answer);
    }
  }
}

// Show Gemini answer in box
function showAnswer(text) {
  $('ab').style.display = 'block';
  $('at').textContent = text;
}

// Status check
async function checkStatus() {
  try {
    const data = await chrome.storage.local.get('mqttConnected');
    const on = data.mqttConnected || false;
    $('d').className = 'dot' + (on ? ' on' : '');
    $('s').textContent = on ? 'Connected to MQTT' : 'Disconnected';
  } catch (e) {
    $('s').textContent = 'Error';
  }
}

// Page info
async function updatePage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      $('pt').textContent = tab.title || 'Unknown';
      $('pu').textContent = tab.url || '';
    }
  } catch (e) {}
}

// Send command
async function cmd(action, extra = {}) {
  const id = 'p_' + Date.now();
  const command = { action, id, ...extra };
  log('cmd', command);
  try {
    await chrome.runtime.sendMessage({ action: 'command', command });
    log('res', 'Sent');
  } catch (e) {
    log('res', 'Error: ' + e.message);
  }
}

// Send chat to Gemini (clean UI)
async function sendChat(text) {
  log('cmd', '💬 You: ' + text);

  // 1. Click input
  log('res', '⏳ Clicking input...');
  await chrome.runtime.sendMessage({ action: 'command', command: { action: 'click', selector: 'div[aria-label="Enter a prompt here"]', id: 'chat_click' } });
  await new Promise(r => setTimeout(r, 300));

  // 2. Type message
  log('res', '⏳ Typing message...');
  await chrome.runtime.sendMessage({ action: 'command', command: { action: 'type', selector: 'div[aria-label="Enter a prompt here"]', text: text, id: 'chat_type' } });
  await new Promise(r => setTimeout(r, 300));

  // 3. Press Enter
  log('res', '⏳ Submitting...');
  await chrome.runtime.sendMessage({ action: 'command', command: { action: 'key', key: 'Enter', id: 'chat_enter' } });
  await new Promise(r => setTimeout(r, 500));

  // 4. Wait for response
  log('res', '⏳ Waiting for Gemini...');
  await chrome.runtime.sendMessage({ action: 'command', command: { action: 'wait_response', timeout: 30000, id: 'chat_wait' } });
}

// Run input (chat, JS, or selector)
$('run').onclick = () => {
  const val = $('inp').value.trim();
  if (!val) return;
  $('inp').value = ''; // Clear input
  if (val.startsWith('js:')) {
    // Execute JS
    cmd('execute', { code: val.slice(3) });
  } else if (val.startsWith('type:')) {
    // Type text: "type:selector|text"
    const [sel, text] = val.slice(5).split('|');
    cmd('type', { selector: sel, text: text });
  } else if (val.startsWith('.') || val.startsWith('#') || val.startsWith('[')) {
    // Selector - click it
    cmd('click', { selector: val });
  } else {
    // Chat message - send to Gemini
    sendChat(val);
  }
};
$('inp').onkeydown = (e) => { if (e.key === 'Enter') $('run').click(); };

// Helper: publish result to MQTT (returns debug info)
async function publishResult(action, result) {
  try {
    const resp = await chrome.runtime.sendMessage({
      action: 'publish_result',
      data: { action, result, timestamp: Date.now() }
    });
    return resp; // { ok, topic, qos, retained, size }
  } catch (e) { return null; }
}

// Buttons - direct execution + MQTT publish with debug
$('b1').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const result = { url: tab?.url || 'No URL', title: tab?.title || '' };
  log('res', '🔗 ' + result.url);
  const pub = await publishResult('get_url', result);
  if (pub?.ok) log('pub', pub);
};
$('b2').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { log('res', '❌ No tab'); return; }
  const r = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.body.innerText });
  const text = r[0]?.result || '';
  log('res', '📄 ' + text.substring(0, 200) + '...');
  const pub = await publishResult('get_text', { text });
  if (pub?.ok) log('pub', { ...pub, payload: { ...pub.payload, result: { text: text.substring(0, 200) + '...' } } });
};
$('b3').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { log('res', '❌ No tab'); return; }
  const r = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.documentElement.outerHTML });
  const html = r[0]?.result || '';
  log('res', '🌐 ' + html.length + ' chars');
  const pub = await publishResult('get_html', { html });
  if (pub?.ok) log('pub', { ...pub, payload: { ...pub.payload, result: { chars: html.length } } });
};
$('b4').onclick = () => cmd('get_videos');
$('b5').onclick = () => cmd('screenshot');
$('b6').onclick = async () => {
  $('l').innerHTML = '';
  $('ab').style.display = 'none'; // Hide answer box
  $('at').textContent = 'Waiting for response...'; // Reset answer text
  lastLogCount = 0;
  await chrome.storage.local.set({ logs: [] });
  log('res', 'Cleared');
};

// Get Gemini Response button - directly from DOM
$('b7').onclick = async () => {
  log('cmd', '📥 Getting Gemini response...');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url?.includes('gemini.google.com')) {
      log('res', '❌ Not on Gemini page');
      return;
    }
    // Get ALL responses from DOM
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const all = document.querySelectorAll('MESSAGE-CONTENT, message-content');
        if (all.length === 0) return { error: 'No responses found' };
        // Get all responses as array (full text)
        const responses = Array.from(all).map((el, i) => {
          const text = (el.innerText || '').trim();
          return `[${i + 1}] ${text}`;
        });
        return { answers: responses, count: all.length };
      }
    });
    const data = result[0]?.result;
    if (data?.answers) {
      showAnswer(data.answers.join('\n\n---\n\n'));
      log('res', '✅ Got ' + data.count + ' response(s)');
    } else {
      log('res', '❌ ' + (data?.error || 'No response'));
    }
  } catch (e) {
    log('res', '❌ Error: ' + e.message);
  }
};

// Model selection buttons
document.querySelectorAll('.model-btn').forEach(btn => {
  btn.onclick = async () => {
    const model = btn.dataset.model;
    log('cmd', '🔄 Switching to ' + model + '...');

    // Update UI immediately
    document.querySelectorAll('.model-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    // Send command
    try {
      await chrome.runtime.sendMessage({
        action: 'command',
        command: { action: 'select_model', model: model, id: 'model_' + Date.now() }
      });
    } catch (e) {
      log('res', '❌ Error: ' + e.message);
    }
  };
});

// Watch for MQTT logs from background (filter chat noise)
let lastLogCount = 0;
async function syncLogs() {
  const data = await chrome.storage.local.get('logs');
  const logs = data.logs || [];
  if (logs.length > lastLogCount) {
    // Show new logs (skip chat command noise)
    logs.slice(lastLogCount).forEach(l => {
      const id = l.data?.id || '';
      // Skip raw chat commands - we show clean status instead
      if (id.startsWith('chat_')) return;
      // Skip page updates (too noisy)
      if (l.type === 'page') return;
      // Show answers in the answer box
      if (l.type === 'answer') {
        showAnswer(l.data?.answer || JSON.stringify(l.data));
        log('res', '✅ Gemini responded!');
        return;
      }
      // Show other logs normally
      log(l.type, l.data);
    });
    lastLogCount = logs.length;
  }
}

// Listen for storage changes (real-time)
chrome.storage.onChanged.addListener((changes) => {
  if (changes.logs) syncLogs();
  if (changes.mqttConnected) checkStatus();
  // Direct answer updates (bypass log sync issues)
  if (changes.lastAnswer?.newValue) {
    showAnswer(changes.lastAnswer.newValue);
    log('res', '✅ Gemini responded!');
  }
});

// Update Gemini state display
async function updateState() {
  try {
    // Send get_state command
    await chrome.runtime.sendMessage({
      action: 'command',
      command: { action: 'get_state', id: 'state_poll_' + Date.now() }
    });
  } catch (e) {
    // Ignore errors
  }
}

// Track previous state for auto-fetch
let prevLoading = null; // null = first run, don't auto-fetch on init
let prevResponseCount = 0;

// Handle state from logs
function handleStateUpdate(state) {
  if (!state || state.error) return; // Skip errors

  // Update loading indicator
  const loadingEl = $('sl');
  const count = state.responseCount || 0;
  if (state.loading) {
    loadingEl.textContent = '🔄';
    loadingEl.title = 'Loading...';
  } else {
    loadingEl.textContent = count > 0 ? '✅' : '⚪';
    loadingEl.title = count > 0 ? 'Done' : 'Ready';
  }

  // Auto-fetch response when: loading done AND new response appeared
  // Skip on first run (prevLoading === null)
  if (prevLoading === true && !state.loading && count > prevResponseCount) {
    log('res', '⏳ Auto-fetching response...');
    chrome.runtime.sendMessage({
      action: 'command',
      command: { action: 'get_response', id: 'auto_fetch_' + Date.now() }
    }).catch(() => {});
  }
  prevLoading = state.loading;
  prevResponseCount = count;

  // Update tool indicator
  const toolEl = $('st');
  toolEl.className = 'state-tool';
  if (state.tool) {
    toolEl.textContent = state.tool;
    toolEl.classList.add(state.tool);
  } else {
    toolEl.textContent = '-';
  }

  // Update response count
  $('sc').textContent = count + ' response' + (count !== 1 ? 's' : '');
}

// Hook into log sync to capture state updates
const origSyncLogs = syncLogs;
async function syncLogsWithState() {
  const data = await chrome.storage.local.get('logs');
  const logs = data.logs || [];
  if (logs.length > lastLogCount) {
    logs.slice(lastLogCount).forEach(l => {
      // Check for state response
      if (l.data?.action === 'get_state' && l.data?.result) {
        handleStateUpdate(l.data.result);
      }
      const id = l.data?.id || '';
      if (id.startsWith('chat_')) return;
      if (id.startsWith('state_poll_')) return; // Hide state polls
      if (l.type === 'page') return;

      // Handle answer - both direct type and via result.answer
      const answer = l.data?.answer || l.data?.result?.answer;
      if (l.type === 'answer' || answer) {
        if (answer && typeof answer === 'string') {
          showAnswer(answer);
          log('res', '✅ Gemini responded!');
        }
        return;
      }
      log(l.type, l.data);
    });
    lastLogCount = logs.length;
  }
}

// Replace sync function
syncLogs = syncLogsWithState;

// Auto-load responses from DOM on startup
async function autoLoadResponses() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url?.includes('gemini.google.com')) return;

    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const all = document.querySelectorAll('MESSAGE-CONTENT, message-content');
        if (all.length === 0) return null;
        const responses = Array.from(all).map((el, i) => {
          const text = (el.innerText || '').trim();
          return `[${i + 1}] ${text}`;
        });
        return { answers: responses, count: all.length };
      }
    });
    const data = result[0]?.result;
    if (data?.answers) {
      showAnswer(data.answers.join('\n\n---\n\n'));
      log('res', '✅ Loaded ' + data.count + ' response(s)');
    }
  } catch (e) {
    // Ignore errors on startup
  }
}

// Init
checkStatus();
updatePage();
syncLogs();
autoLoadResponses(); // Auto-load from DOM on startup
updateState(); // Initial state check
setInterval(checkStatus, 2000);
setInterval(updatePage, 3000);
setInterval(syncLogs, 1000);
setInterval(updateState, 2000); // Poll state every 2s
log('res', 'Ready');
