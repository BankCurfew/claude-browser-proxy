// Side panel JS
const $ = id => document.getElementById(id);

// Version
$('v').textContent = 'v' + chrome.runtime.getManifest().version;

// Log function
function log(type, msg) {
  const el = document.createElement('div');
  el.className = 'log ' + type;
  el.innerHTML = '<span class="t">' + new Date().toLocaleTimeString() + '</span>' +
    (typeof msg === 'object' ? JSON.stringify(msg) : msg);
  $('l').appendChild(el);
  $('l').scrollTop = $('l').scrollHeight;
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
async function cmd(action) {
  const id = 'p_' + Date.now();
  log('cmd', { action, id });
  try {
    await chrome.runtime.sendMessage({ action: 'command', command: { action, id } });
    log('res', 'Sent');
  } catch (e) {
    log('res', 'Error: ' + e.message);
  }
}

// Buttons
$('b1').onclick = () => cmd('get_url');
$('b2').onclick = () => cmd('get_text');
$('b3').onclick = () => cmd('get_html');
$('b4').onclick = () => cmd('get_videos');
$('b5').onclick = () => cmd('screenshot');
$('b6').onclick = () => $('l').innerHTML = '';

// Init
checkStatus();
updatePage();
setInterval(checkStatus, 2000);
setInterval(updatePage, 3000);
log('res', 'Ready');
