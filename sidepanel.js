// Side panel JS
const $ = id => document.getElementById(id);

// Version
const version = 'v' + chrome.runtime.getManifest().version;
$('v').textContent = version;
$('vb').textContent = version;

// Log function
function log(type, msg) {
  const el = document.createElement('div');
  el.className = 'log ' + type;
  el.innerHTML = '<span class="t">' + new Date().toLocaleTimeString() + '</span>' +
    (typeof msg === 'object' ? JSON.stringify(msg) : msg);
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

// Init
checkStatus();
updatePage();
syncLogs();
setInterval(checkStatus, 2000);
setInterval(updatePage, 3000);
setInterval(syncLogs, 1000); // Poll for logs as fallback
log('res', 'Ready');
