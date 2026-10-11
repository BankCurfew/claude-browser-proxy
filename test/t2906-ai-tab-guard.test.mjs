// T2906 S2-C: the extension refuses non-AI tabs on EVERY script/tab path and opens only AI URLs.
// Runs the REAL background.js in a node vm (chrome.* stubbed, mqtt stubbed: no broker). Spies count executeScript,
// tabs.create/update/remove; a Gemini tab is the positive control (so the refusals are not just "nothing works").
//   node --test test/t2906-ai-tab-guard.test.mjs
import { test, after } from 'node:test';
after(() => setImmediate(() => process.exit(process.exitCode ?? 0)));
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const guard = createRequire(import.meta.url)(join(ROOT, 'guard.js'));
const TABS = {
  1: { id: 1, url: 'https://gemini.google.com/app/abc', lastAccessed: 1 },
  2: { id: 2, url: 'https://mail.google.com/mail/u/0/', lastAccessed: 2 },
  3: { id: 3, url: 'https://evil.example/?gemini.google.com', lastAccessed: 3 },
  4: { id: 4, url: 'http://gemini.google.com/app', lastAccessed: 4 },
};

function load() {
  const calls = { exec: [], create: [], update: [], remove: [], published: [] };
  const noop = () => {}, ev = { addListener: noop };
  const stub = () => new Proxy(function () { return Promise.resolve([]); }, { get: (t, k) => (k === 'then' ? undefined : k in t ? t[k] : (t[k] = stub())) });
  const withStub = (o) => new Proxy(o, { get: (t, k) => (k in t ? t[k] : (t[k] = stub())) });   // unknown chrome.* members = inert stubs
  const known = {
    runtime: { getManifest: () => ({ version: '0.0.0-test' }), getURL: (p) => 'chrome-extension://x/' + p, onMessage: ev, onInstalled: ev, onStartup: ev, sendMessage: noop },
    storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: ev },
    tabs: {
      get: async (id) => { if (!TABS[id]) throw new Error('no tab'); return TABS[id]; },
      query: async (q) => Object.values(TABS).filter((t) => [].concat(q.url || []).some((u) => t.url.startsWith(u.replace('*', '')))),
      create: async (o) => { calls.create.push(o.url); return { id: 99, pendingUrl: o.url }; },
      update: async (id) => { calls.update.push(id); return TABS[id]; },
      remove: async (id) => { calls.remove.push(id); },
      onRemoved: ev, onUpdated: ev, onActivated: ev,
    },
    scripting: { executeScript: async (o) => { calls.exec.push(o.target.tabId); return [{ result: 'ok' }]; } },
    action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
    alarms: { create: noop, onAlarm: ev }, sidePanel: { setPanelBehavior: async () => {} },
    downloads: { download: async () => 1 }, cookies: { getAll: async () => [] }, debugger: { attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}) },
  };
  const chrome = withStub(Object.fromEntries(Object.entries(known).map(([k, v]) => [k, withStub(v)])));
  const fakeClient = { on: noop, subscribe: noop, publish: (t, m) => calls.published.push(String(m)), end: noop, removeAllListeners: noop, connected: false, reconnecting: false };
  const ctx = vm.createContext({ chrome, console: { log: noop, error: noop, warn: noop }, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop,
    fetch: async () => ({ ok: false }), URL, mqtt: { connect: () => fakeClient } });
  ctx.self = ctx;
  vm.runInContext(readFileSync(join(ROOT, 'guard.js'), 'utf8'), ctx);
  vm.runInContext(readFileSync(join(ROOT, 'background.js'), 'utf8').replace(/^importScripts\(.*$/gm, ''), ctx);
  return { calls, run: (cmd) => vm.runInContext(`handleCommand('claude/browser/command', ${JSON.stringify(cmd)})`, ctx) };
}

test('guard: exact https host only', () => {
  assert.equal(guard.isAiUrl('https://gemini.google.com/app'), true);
  assert.equal(guard.isAiUrl('https://chatgpt.com/c/1'), true);
  for (const u of ['https://evil.example/?gemini.google.com', 'https://gemini.google.com.evil.example/', 'http://gemini.google.com/', 'https://mail.google.com/', 'javascript:alert(1)', '', null])
    assert.equal(guard.isAiUrl(u), false, String(u));
  assert.equal(guard.isImageHost('https://lh3.googleusercontent.com/x'), true);
  assert.equal(guard.isImageHost('https://evil.example/x.png'), false);
  assert.equal(guard.cookiesAllowed('https://lh3.googleusercontent.com/x'), true);
  assert.equal(guard.cookiesAllowed('https://gemini.google.com/x'), false);
  assert.equal(guard.chatgptCookiesAllowed('https://files.oaiusercontent.com/x'), true);
  assert.equal(guard.chatgptCookiesAllowed('https://evil.example/x'), false);
});

test('guard: broker credentials from storage, else file, else none', async () => {
  assert.deepEqual(await guard.brokerOptions(async () => ({ mqttUsername: 'u', mqttPassword: 'p' }), async () => null), { username: 'u', password: 'p', source: 'storage' });
  assert.deepEqual(await guard.brokerOptions(async () => ({}), async () => ({ username: 'f', password: 'q' })), { username: 'f', password: 'q', source: 'file' });
  assert.deepEqual(await guard.brokerOptions(async () => { throw new Error('x'); }, async () => { throw new Error('y'); }), { source: 'none' });
});

test('every tabId path refuses a non-AI tab before any script or tab action', async () => {
  const actions = ['inject_badge', 'inject_response_actions', 'auto_inject_start', 'auto_inject_stop', 'focus_tab', 'close_tab', 'get_text', 'get_html', 'execute', 'click', 'type'];
  for (const tabId of [2, 3, 4]) {
    const { calls, run } = load();
    for (const action of actions) await run({ id: `${action}-${tabId}`, action, tabId, code: '1', selector: 'a', text: 'x' });
    assert.deepEqual(calls.exec, [], `tab ${tabId}: executeScript ran`);
    assert.deepEqual(calls.update, [], `tab ${tabId}: focused`);
    assert.deepEqual(calls.remove, [], `tab ${tabId}: closed`);
  }
});

test('create_tab / new_tab open only AI URLs', async () => {
  const { calls, run } = load();
  for (const action of ['create_tab', 'new_tab']) {
    for (const url of ['https://mail.google.com/', 'https://evil.example/?gemini.google.com', 'javascript:alert(1)', 'file:///etc/passwd']) await run({ id: 'c', action, url });
  }
  assert.deepEqual(calls.create, []);
  await run({ id: 'ok', action: 'new_tab', url: 'https://gemini.google.com/app' });
  await run({ id: 'ok2', action: 'create_tab' });
  assert.deepEqual(calls.create, ['https://gemini.google.com/app', 'https://gemini.google.com/app']);
});

test('positive control: the same paths still work on a Gemini tab', async () => {
  const { calls, run } = load();
  await run({ id: 'b', action: 'inject_badge', tabId: 1, text: 'x' });
  await run({ id: 'g', action: 'get_text', tabId: 1 });
  await run({ id: 'f', action: 'focus_tab', tabId: 1 });
  assert.ok(calls.exec.length >= 2, `executeScript calls on the Gemini tab: ${calls.exec.length}`);
  assert.ok(calls.exec.every((id) => id === 1));
  assert.deepEqual(calls.update, [1]);
});
