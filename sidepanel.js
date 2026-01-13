// Side panel JS
const $ = id => document.getElementById(id);

// Version
const version = 'v' + chrome.runtime.getManifest().version;
$('v').textContent = version;
$('vb').textContent = version;

// Format JSON nicely - show friendly action names, collapse details
function formatMsg(msg) {
  if (typeof msg !== 'object') return msg;

  // Action icons for friendly display
  const actionIcons = {
    'get_url': '🔗', 'get_text': '📄', 'get_html': '🌐', 'get_videos': '🎬',
    'get_state': '📊', 'get_response': '📥', 'screenshot': '📸', 'click': '👆',
    'type': '⌨️', 'key': '⌨️', 'find': '🔍', 'execute': '⚡', 'download': '💾',
    'select_model': '🤖', 'wait_response': '⏳'
  };

  const action = msg.action || msg.result?.action || '';
  const icon = actionIcons[action] || '📦';
  const success = msg.result?.success ? ' ✅' : (msg.result?.error ? ' ❌' : '');

  // Friendly summary line
  const summary = icon + ' ' + (action || 'data') + success;

  const str = JSON.stringify(msg, null, 2);
  // Always collapsible with friendly summary
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

// Buttons
$('b1').onclick = () => cmd('get_url');
$('b2').onclick = () => cmd('get_text');
$('b3').onclick = () => cmd('get_html');
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

// Get Gemini Response button
$('b7').onclick = async () => {
  log('cmd', '📥 Getting Gemini response...');
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'command',
      command: { action: 'get_response', id: 'get_resp_' + Date.now() }
    });
    // Response will come via storage logs
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

// Load last answer from logs on startup
async function loadLastAnswer() {
  const data = await chrome.storage.local.get('logs');
  const logs = data.logs || [];
  // Find last answer in logs (scan backwards)
  for (let i = logs.length - 1; i >= 0; i--) {
    const l = logs[i];
    const answer = l.data?.answer || l.data?.result?.answer;
    if (answer && typeof answer === 'string') {
      showAnswer(answer);
      break;
    }
  }
}

// Init
checkStatus();
updatePage();
syncLogs();
loadLastAnswer(); // Show last answer on startup
updateState(); // Initial state check
setInterval(checkStatus, 2000);
setInterval(updatePage, 3000);
setInterval(syncLogs, 1000);
setInterval(updateState, 2000); // Poll state every 2s
log('res', 'Ready');
