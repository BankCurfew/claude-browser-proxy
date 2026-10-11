// T2890: one MQTT client per service worker, however often the keepalive alarm fires.
// 11 Oct: Chrome :9222's proxy held 10 broker connections (admin), so every list_tabs got 5 late duplicate
// replies and gemini-gen/status read "not detected" / "offline". Cause: the 30 s keepalive alarm called connect()
// whenever isConnected was false — including while mqtt.js was already auto-reconnecting the existing client —
// and connect() never ended the old client.
//
// Runs the REAL background.js in a node vm (chrome.* stubbed) against a PRIVATE mosquitto on port 19001
// (never the shared :9001 broker: the extension publishes a retained online/offline status there).
//   node --test test/t2890-mqtt-single-client.test.mjs          (needs /usr/sbin/mosquitto)
import { test, after } from 'node:test';
// the extension's own intervals would keep node alive after the assertion
after(() => setImmediate(() => process.exit(process.exitCode ?? 0)));
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 19001;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startBroker() {
  const dir = mkdtempSync(join(tmpdir(), 't2890-mqtt-'));
  const conf = join(dir, 'm.conf');
  writeFileSync(conf, `listener ${PORT}\nprotocol websockets\nallow_anonymous true\n`);
  const p = spawn('/usr/sbin/mosquitto', ['-c', conf, '-v'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  p.stdout.on('data', (d) => (log += d)); p.stderr.on('data', (d) => (log += d));
  return { stop: () => p.kill(), log: () => log };
}

/** background.js in a vm with chrome.* stubbed; returns the alarm handler + a way to read/write its globals. */
function loadExtension(src) {
  let alarm = null;
  // any chrome.* API the worker touches at load is a no-op stub; only the ones this test relies on are real
  const stub = () => new Proxy(function () { return Promise.resolve([]); }, { get: (t, k) => (k === 'then' ? undefined : k in t ? t[k] : (t[k] = stub())) });
  const known = {
    alarms: { create() {}, onAlarm: { addListener: (f) => (alarm = f) } },
    runtime: Object.assign(stub(), { getManifest: () => ({ version: '0.0.0-test' }) }),
    storage: { local: { get: async () => ({}), set: async () => {} } },
    tabs: Object.assign(stub(), { query: async () => [] }),
  };
  const chrome = new Proxy(known, { get: (t, k) => (k in t ? t[k] : (t[k] = stub())) });
  const ctx = vm.createContext({ chrome, console: { log() {}, error: (...a) => process.stderr.write('[ext] ' + a.map(String).join(' ') + '\n'), warn() {} }, setTimeout, clearTimeout, setInterval, clearInterval,
    WebSocket, URL, TextEncoder, TextDecoder, Blob, AbortController, AbortSignal, EventTarget, Event, crypto, atob, btoa, location: { protocol: "chrome-extension:" }, navigator: { userAgentData: null }, performance, queueMicrotask, Buffer, process: { nextTick: queueMicrotask, env: {} } });
  // what mqtt.js sees in a real MV3 worker: no window/document, `self` is a ServiceWorkerGlobalScope
  class ServiceWorkerGlobalScope {}
  ctx.self = Object.assign(new ServiceWorkerGlobalScope(), { WebSocket });
  vm.runInContext(readFileSync(join(ROOT, 'mqtt.min.js'), 'utf8'), ctx);
  vm.runInContext(readFileSync(join(ROOT, 'guard.js'), 'utf8'), ctx);   // T2906: background.js importScripts('guard.js')
  vm.runInContext(src.replace(/^importScripts\(.*$/gm, '').replace(`'ws://localhost:9001'`, `'ws://localhost:${PORT}'`), ctx);
  return { fireAlarm: () => alarm({ name: 'mqtt-keepalive' }), run: (code) => vm.runInContext(code, ctx) };
}

test('keepalive alarms during a reconnect window never add a second broker client', async () => {
  const broker = startBroker();
  await sleep(500);
  try {
    const ext = loadExtension(readFileSync(join(ROOT, 'background.js'), 'utf8'));
    for (let i = 0; i < 20 && !ext.run('isConnected'); i++) await sleep(250);
    assert.equal(ext.run('isConnected'), true, `extension connected to the private broker\n${broker.log().slice(-600)}`);
    // the window that leaked: mqtt.js is (re)connecting the existing client, isConnected reads false, the alarm fires
    for (let i = 0; i < 3; i++) { ext.run('isConnected = false'); ext.fireAlarm(); await sleep(800); }
    await sleep(1500);
    const live = new Set();
    for (const m of broker.log().matchAll(/New client connected from \S+ as (\S+)/g)) live.add(m[1]);
    for (const m of broker.log().matchAll(/Client (\S+) (?:disconnected|closed its connection)/g)) live.delete(m[1]);
    ext.run('client && client.end(true)');
    assert.equal(live.size, 1, `broker clients still connected: ${[...live].join(', ')}`);
  } finally { broker.stop(); }
});
