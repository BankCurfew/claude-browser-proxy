// T2906 S2-C (security HIGH: claude/browser/# was open to anonymous MQTT clients). Pure checks used by background.js.
// Loaded with importScripts in the service worker; required by the node tests.
//   isAiUrl       exact https host match (url.includes('gemini.google.com') also matched https://evil.example/?gemini.google.com)
//   isImageHost   where download_images may fetch from (AI hosts + their image CDNs), and only those get cookies
//   brokerOptions MQTT username/password from chrome.storage.local, else the gitignored broker-creds.json (never in git)
(function (root) {
  const AI_HOSTS = ['gemini.google.com', 'chatgpt.com', 'chat.openai.com'];
  const IMAGE_SUFFIXES = ['.googleusercontent.com', '.oaiusercontent.com'];

  function hostOf(u) {
    try { const x = new URL(String(u)); return x.protocol === 'https:' ? x.hostname.toLowerCase() : null; } catch (e) { return null; }
  }
  function isAiUrl(u) { const h = hostOf(u); return !!h && AI_HOSTS.includes(h); }
  function isImageHost(u) { const h = hostOf(u); return !!h && (AI_HOSTS.includes(h) || IMAGE_SUFFIXES.some((s) => h.endsWith(s))); }
  /** Cookies ride only to Google's own image CDN, never to any other host an image src names. */
  function cookiesAllowed(u) { const h = hostOf(u); return !!h && h.endsWith('.googleusercontent.com'); }
  function chatgptCookiesAllowed(u) { const h = hostOf(u); return !!h && (h === 'chatgpt.com' || h.endsWith('.oaiusercontent.com')); }

  async function brokerOptions(storageGet, fetchCreds) {
    try {
      const s = await storageGet(['mqttUsername', 'mqttPassword']);
      if (s && s.mqttUsername && s.mqttPassword) return { username: s.mqttUsername, password: s.mqttPassword, source: 'storage' };
    } catch (e) { /* fall through */ }
    try {
      const c = await fetchCreds();
      if (c && c.username && c.password) return { username: c.username, password: c.password, source: 'file' };
    } catch (e) { /* no file */ }
    return { source: 'none' };   // anonymous: refused once the broker has allow_anonymous false (admin, S2-A)
  }

  const api = { AI_HOSTS, isAiUrl, isImageHost, cookiesAllowed, chatgptCookiesAllowed, brokerOptions };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(globalThis);   // in a service worker globalThis === self
