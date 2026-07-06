// Claude Browser Proxy - Background Service Worker
// Uses MQTT.js library for WebSocket connection to Mosquitto broker

importScripts('mqtt.min.js');

const VERSION = '3.0.0'; // Short version for badge display
const MQTT_URL = 'ws://localhost:9001';

// Map of downloadId → desired filename for renaming data URL downloads
const pendingFilenames = new Map();
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const wanted = pendingFilenames.get(item.id);
  if (wanted) {
    pendingFilenames.delete(item.id);
    suggest({ filename: wanted, conflictAction: 'uniquify' });
  }
});
const TOPICS = {
  command: 'claude/browser/command',
  response: 'claude/browser/response',
  page: 'claude/browser/page',
  answer: 'claude/browser/answer',
  status: 'claude/browser/status',
  state: 'claude/browser/state'  // Loading/tool state
};

let client = null;
let isConnected = false;
let connectedAt = 0; // Track connection time to ignore stale retained messages

// Connect to MQTT broker with LWT
function connect() {
  console.log('[MQTT] Connecting to', MQTT_URL);

  client = mqtt.connect(MQTT_URL, {
    clientId: 'claude-browser-' + Date.now(),
    keepalive: 15, // 15 seconds - LWT triggers after ~22 sec if no ping
    reconnectPeriod: 5000, // Reconnect every 5 seconds
    will: {
      topic: TOPICS.status,
      payload: JSON.stringify({ status: 'offline', timestamp: Date.now(), version: VERSION }),
      qos: 0,
      retain: true
    }
  });

  client.on('connect', () => {
    console.log('[MQTT] Connected!');
    isConnected = true;
    connectedAt = Date.now(); // Track connection time
    updateBadge(true);

    // Subscribe to command topic
    client.subscribe(TOPICS.command, (err) => {
      if (err) console.error('[MQTT] Subscribe error:', err);
      else console.log('[MQTT] Subscribed to', TOPICS.command);
    });

    // Publish "online" status (retained) - overrides LWT "offline"
    client.publish(TOPICS.status, JSON.stringify({
      status: 'online',
      timestamp: Date.now(),
      version: VERSION
    }), { retain: true });
  });

  client.on('message', (topic, message) => {
    console.log('[MQTT] Received:', topic);
    try {
      const command = JSON.parse(message.toString());

      // Ignore stale retained messages (older than our connection)
      if (command.ts && command.ts < connectedAt) {
        console.log('[MQTT] Ignoring stale message (ts:', command.ts, '< connected:', connectedAt, ')');
        return;
      }

      handleCommand(topic, command);
    } catch (e) {
      handleCommand(topic, message.toString());
    }
  });

  client.on('close', () => {
    console.log('[MQTT] Disconnected');
    isConnected = false;
    updateBadge(false);
  });

  client.on('error', (err) => {
    console.error('[MQTT] Error:', err);
  });
}

// Publish message (with optional retain)
function publish(topic, message, retain = false) {
  if (client && isConnected) {
    const payload = typeof message === 'string' ? message : JSON.stringify(message);
    client.publish(topic, payload, { retain });
    console.log('[MQTT] Published to', topic, retain ? '(retained)' : '');
  }
}

// Update extension badge and storage
async function updateBadge(connected) {
  chrome.storage.local.set({ mqttConnected: connected });
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const onAiSite = tab && tab.url && (tab.url.includes('gemini.google.com') || tab.url.includes('chatgpt.com') || tab.url.includes('chat.openai.com'));
    chrome.action.setBadgeText({ text: VERSION }); // Always show full version
    if (onAiSite && connected) {
      chrome.action.setBadgeBackgroundColor({ color: '#22c55e' }); // green
    } else {
      chrome.action.setBadgeBackgroundColor({ color: '#ef4444' }); // red
    }
  } catch (e) {
    chrome.action.setBadgeText({ text: VERSION });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  }
}

// Broadcast to sidepanel via storage
async function broadcastLog(type, data) {
  try {
    const stored = await chrome.storage.local.get('logs');
    const logs = stored.logs || [];
    logs.push({ type, data, time: Date.now() });
    if (logs.length > 50) logs.shift();
    await chrome.storage.local.set({ logs });
  } catch (e) {
    console.error('[Log] Error:', e);
  }
}

// Handle commands from Claude Code
async function handleCommand(topic, command) {
  console.log('[Claude] Command:', command);
  await broadcastLog('cmd', command);

  let result;
  let tab;

  try {
    // === TAB MANAGEMENT ACTIONS (don't require existing Gemini tab) ===
    switch (command.action) {
      case 'transcribe': {
        // All-in-one: create new tab + wait + send transcribe prompt
        const videoUrl = command.url || command.video;
        if (!videoUrl) {
          result = { error: 'url or video parameter required' };
          publish(TOPICS.response, { ...result, id: command.id, action: command.action });
          return;
        }

        // 1. Create new Gemini tab
        const transcribeTab = await chrome.tabs.create({
          url: 'https://gemini.google.com/app',
          active: true
        });

        // 2. Wait for page to load
        await new Promise(resolve => setTimeout(resolve, 3000));

        // 3. Send chat prompt
        const prompt = command.prompt || `Transcribe this YouTube video with timestamps:

${videoUrl}

Format:

[00:00]
Text spoken here.

[01:00]
Next section.

Use double newlines between timestamps!`;

        await chrome.scripting.executeScript({
          target: { tabId: transcribeTab.id },
          func: (text) => {
            const selectors = [
              'rich-textarea .ql-editor',
              'rich-textarea [contenteditable="true"]',
              '.ql-editor[contenteditable="true"]',
              '[contenteditable="true"]'
            ];
            for (const sel of selectors) {
              const el = document.querySelector(sel);
              if (el) {
                el.focus();
                el.innerHTML = text.replace(/\n/g, '<br>');
                el.dispatchEvent(new Event('input', { bubbles: true }));
                setTimeout(() => {
                  const sendBtn = document.querySelector('button[aria-label*="Send"], button.send-button, button[class*="send"]');
                  if (sendBtn) sendBtn.click();
                }, 500);
                return { success: true };
              }
            }
            return { error: 'Input not found' };
          },
          args: [prompt]
        });

        result = { success: true, tabId: transcribeTab.id, video: videoUrl };
        publish(TOPICS.response, { ...result, id: command.id, action: command.action });
        return;
      }

      case 'create_tab': {
        // Create new Gemini tab and return its ID
        const createdTab = await chrome.tabs.create({
          url: command.url || 'https://gemini.google.com/app',
          active: command.active !== false  // default: make active
        });
        result = {
          tabId: createdTab.id,
          url: createdTab.pendingUrl || createdTab.url,
          success: true
        };
        publish(TOPICS.response, { ...result, id: command.id, action: command.action });
        return;
      }

      case 'list_tabs':
        // List all AI tabs (Gemini + ChatGPT)
        const geminiTabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
        const chatgptTabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'] });
        const allAiTabs = [...geminiTabs, ...chatgptTabs];
        result = {
          tabs: allAiTabs.map(t => ({
            id: t.id,
            title: t.title,
            url: t.url,
            active: t.active,
            windowId: t.windowId,
            platform: t.url.includes('gemini.google.com') ? 'gemini' : 'chatgpt'
          })),
          count: allAiTabs.length,
          success: true
        };
        publish(TOPICS.response, { ...result, id: command.id, action: command.action });
        return;

      case 'new_tab': {
        // Create a new Gemini tab
        const url = command.url || 'https://gemini.google.com/app';
        const tab = await chrome.tabs.create({ url, active: true });
        result = {
          success: true,
          tabId: tab.id,
          url,
          message: 'New tab created'
        };
        publish(TOPICS.response, { ...result, id: command.id, action: command.action });
        return;
      }

      case 'focus_tab':
        // Focus a specific tab
        if (!command.tabId) throw new Error('tabId required for focus_tab');
        await chrome.tabs.update(command.tabId, { active: true });
        const focusedTab = await chrome.tabs.get(command.tabId);
        await chrome.windows.update(focusedTab.windowId, { focused: true });
        result = { success: true, tabId: command.tabId };
        publish(TOPICS.response, { ...result, id: command.id, action: command.action });
        return;

      case 'inject_badge':
        // DEBUG: Inject badge into specific tab
        if (!command.tabId) throw new Error('tabId required');
        await chrome.scripting.executeScript({
          target: { tabId: command.tabId },
          func: (id, msg) => {
            let badge = document.getElementById('claude-tab-badge');
            if (!badge) {
              badge = document.createElement('div');
              badge.id = 'claude-tab-badge';
              badge.style.cssText = 'position:fixed;top:10px;right:10px;background:#22c55e;color:white;padding:12px 20px;border-radius:8px;font-family:monospace;font-size:16px;font-weight:bold;z-index:99999;box-shadow:0 4px 12px rgba(0,0,0,0.4);';
              document.body.appendChild(badge);
            }
            badge.textContent = 'TAB ' + id + (msg ? ': ' + msg : '');
          },
          args: [command.tabId, command.text || '']
        });
        result = { success: true, tabId: command.tabId, injected: true };
        publish(TOPICS.response, { ...result, id: command.id, action: command.action });
        return;

      case 'inject_response_actions':
        // Inject custom buttons after the last button in each response
        if (!command.tabId) throw new Error('tabId required');
        result = await chrome.scripting.executeScript({
          target: { tabId: command.tabId },
          func: (actions) => {
            let injected = 0;
            const debug = [];

            // Find all model-response elements
            const modelResponses = document.querySelectorAll('model-response');
            debug.push('Found ' + modelResponses.length + ' model-responses');

            modelResponses.forEach((modelResponse, index) => {
              // Skip if already injected
              if (modelResponse.querySelector('.claude-response-actions')) return;

              // Find ALL buttons, get the last few (action bar is at bottom)
              const allButtons = Array.from(modelResponse.querySelectorAll('button'));
              debug.push('Response ' + index + ': ' + allButtons.length + ' buttons');

              if (allButtons.length < 3) return;

              // Last button should be the ⋮ menu
              const lastBtn = allButtons[allButtons.length - 1];
              const actionBar = lastBtn.parentElement;

              // Create custom buttons container
              const customContainer = document.createElement('div');
              customContainer.className = 'claude-response-actions';
              customContainer.style.cssText = 'display:inline-flex;gap:8px;margin-left:12px;align-items:center;';

              actions.forEach(action => {
                const btn = document.createElement('button');
                btn.textContent = action.label;
                btn.title = action.title || action.label;
                btn.style.cssText = 'background:transparent;border:none;color:#9aa0a6;cursor:pointer;font-size:16px;padding:4px;opacity:0.7;transition:opacity 0.2s;';
                btn.onmouseenter = () => btn.style.opacity = '1';
                btn.onmouseleave = () => btn.style.opacity = '0.7';
                btn.onclick = () => {
                  const msgContent = modelResponse.querySelector('MESSAGE-CONTENT, message-content');
                  window.postMessage({
                    type: 'claude-response-action',
                    action: action.id,
                    responseIndex: index,
                    text: msgContent?.innerText?.substring(0, 500) || ''
                  }, '*');
                };
                customContainer.appendChild(btn);
              });

              // Insert after the last button
              lastBtn.after(customContainer);
              injected++;
              debug.push('Response ' + index + ': injected');
            });

            return { success: true, injected, total: modelResponses.length, debug };
          },
          args: [command.actions || [
            { id: 'save', label: '💾', title: 'Save response' },
            { id: 'copy', label: '📋', title: 'Copy to clipboard' }
          ]]
        });
        result = result[0]?.result;
        publish(TOPICS.response, { ...result, id: command.id, action: command.action });
        return;

      case 'auto_inject_start':
        // Start auto-injection loop using MutationObserver
        if (!command.tabId) throw new Error('tabId required');
        result = await chrome.scripting.executeScript({
          target: { tabId: command.tabId },
          func: (actions) => {
            // Don't start twice
            if (window._claudeAutoInject) return { already: true };

            const injectButtons = () => {
              const modelResponses = document.querySelectorAll('model-response');
              let injected = 0;

              modelResponses.forEach((modelResponse, index) => {
                if (modelResponse.querySelector('.claude-response-actions')) return;

                const allButtons = Array.from(modelResponse.querySelectorAll('button'));
                if (allButtons.length < 3) return;

                const lastBtn = allButtons[allButtons.length - 1];

                const container = document.createElement('div');
                container.className = 'claude-response-actions';
                container.style.cssText = 'display:inline-flex;gap:8px;margin-left:12px;align-items:center;';

                actions.forEach(action => {
                  const btn = document.createElement('button');
                  btn.textContent = action.label;
                  btn.title = action.title || action.label;
                  btn.style.cssText = 'background:transparent;border:none;color:#9aa0a6;cursor:pointer;font-size:16px;padding:4px;opacity:0.7;transition:opacity 0.2s;';
                  btn.onmouseenter = () => btn.style.opacity = '1';
                  btn.onmouseleave = () => btn.style.opacity = '0.7';
                  btn.onclick = () => {
                    const msgContent = modelResponse.querySelector('MESSAGE-CONTENT, message-content');
                    window.postMessage({
                      type: 'claude-response-action',
                      action: action.id,
                      responseIndex: index,
                      text: msgContent?.innerText?.substring(0, 500) || ''
                    }, '*');
                  };
                  container.appendChild(btn);
                });

                lastBtn.after(container);
                injected++;
              });

              return injected;
            };

            // Initial inject
            const initial = injectButtons();

            // Watch for new responses
            const observer = new MutationObserver(() => {
              injectButtons();
            });

            observer.observe(document.body, {
              childList: true,
              subtree: true
            });

            window._claudeAutoInject = { observer, actions };
            return { started: true, initial };
          },
          args: [command.actions || [
            { id: 'save', label: '💾', title: 'Save' },
            { id: 'learn', label: '📚', title: 'Learn' }
          ]]
        });
        result = result[0]?.result;
        publish(TOPICS.response, { ...result, id: command.id, action: command.action });
        return;

      case 'auto_inject_stop':
        // Stop auto-injection
        if (!command.tabId) throw new Error('tabId required');
        result = await chrome.scripting.executeScript({
          target: { tabId: command.tabId },
          func: () => {
            if (window._claudeAutoInject) {
              window._claudeAutoInject.observer.disconnect();
              delete window._claudeAutoInject;
              return { stopped: true };
            }
            return { notRunning: true };
          }
        });
        result = result[0]?.result;
        publish(TOPICS.response, { ...result, id: command.id, action: command.action });
        return;
    }

    // === RESOLVE TARGET TAB ===
    if (command.tabId) {
      // Use specific tab if provided - simple and direct
      tab = await chrome.tabs.get(command.tabId);
      if (!tab) throw new Error('Tab not found: ' + command.tabId);
      console.log('[Tab] Using specific tab:', command.tabId, tab.url);
      // INJECT TABID INTO PAGE FOR DEBUGGING
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (id) => {
          let badge = document.getElementById('claude-tab-badge');
          if (!badge) {
            badge = document.createElement('div');
            badge.id = 'claude-tab-badge';
            badge.style.cssText = 'position:fixed;top:10px;right:10px;background:#22c55e;color:white;padding:8px 16px;border-radius:8px;font-family:monospace;font-size:14px;z-index:99999;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
            document.body.appendChild(badge);
          }
          badge.textContent = 'TAB: ' + id;
          badge.style.animation = 'none';
          badge.offsetHeight; // Trigger reflow
          badge.style.animation = 'pulse 0.5s';
        },
        args: [tab.id]
      });
    } else {
      // Find most recently active AI tab (Gemini or ChatGPT)
      const geminiTabs2 = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
      const chatgptTabs2 = await chrome.tabs.query({ url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'] });
      const allTabs = [...geminiTabs2, ...chatgptTabs2];
      if (allTabs.length > 0) {
        allTabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
        tab = allTabs[0];
      }
      if (!tab) {
        [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      }
    }

    if (!tab) throw new Error('No tab found');
    const isAiTab = tab.url?.includes('gemini.google.com') || tab.url?.includes('chatgpt.com') || tab.url?.includes('chat.openai.com');
    if (!isAiTab) {
      throw new Error('Tab is not Gemini or ChatGPT. Please open gemini.google.com or chatgpt.com');
    }

    // === GEMINI TAB ACTIONS ===
    switch (command.action) {
      case 'get_html':
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => document.documentElement.outerHTML
        });
        result = { html: result[0]?.result?.substring(0, 50000) };
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

      case 'get_state':
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            // Gemini State Detector
            const isLoading = () => {
              // Only check actual progress spinner, NOT avatar animation (always visible)
              const spinner = document.querySelector('mat-mdc-progress-spinner.mdc-circular-progress--indeterminate');
              if (spinner) {
                const rect = spinner.getBoundingClientRect();
                // Must be in response area (not in sidebar/header)
                if (rect.top > 100 && rect.top < window.innerHeight && rect.bottom > 0) return true;
              }
              // Also check for streaming indicator (text being typed)
              const streaming = document.querySelector('.streaming-indicator, [data-streaming="true"]');
              if (streaming) return true;
              return false;
            };

            const getActiveTool = () => {
              if (document.querySelector('img.youtube-icon')) return 'youtube';
              if (document.querySelector('img.tool-logo[src*="youtube"]')) return 'youtube';
              if (document.querySelector('img.tool-logo[src*="search"]')) return 'search';
              if (document.querySelector('img.tool-logo[src*="maps"]')) return 'maps';
              return null;
            };

            return {
              loading: isLoading(),
              tool: getActiveTool(),
              responseCount: document.querySelectorAll('MESSAGE-CONTENT').length,
              timestamp: Date.now()
            };
          }
        });
        result = result[0]?.result;
        // Auto-publish state to dedicated topic
        publish(TOPICS.state, result, false);
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

      case 'clickText':
        // Click element by text content (case-insensitive, partial match)
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (searchText, exactMatch) => {
            const text = searchText.toLowerCase();
            const clickable = document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"], a, [onclick], [tabindex]');
            for (const el of clickable) {
              const elText = el.textContent?.trim().toLowerCase() || '';
              const matches = exactMatch ? elText === text : elText.includes(text);
              if (matches) {
                el.click();
                return { success: true, text: el.textContent?.trim().substring(0, 50), tag: el.tagName };
              }
            }
            return { error: 'No element with text: ' + searchText };
          },
          args: [command.text, command.exact || false]
        });
        result = result[0]?.result;
        break;

      case 'type':
        // Smart default selector for Gemini input
        const typeSelector = command.selector || '[contenteditable="true"], textarea, input[type="text"]';
        const typeText = command.text || '';
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (sel, text) => {
            const el = document.querySelector(sel);
            if (el) {
              el.focus();
              if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                el.value = text;
                el.dispatchEvent(new Event('input', { bubbles: true }));
              } else if (el.isContentEditable || el.getAttribute('contenteditable')) {
                // Clear existing content and use execCommand for rich editors
                el.innerHTML = '';
                document.execCommand('insertText', false, text);
                el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
              } else {
                el.value = text;
                el.dispatchEvent(new Event('input', { bubbles: true }));
              }
              return { success: true, selector: sel };
            }
            return { error: 'Element not found', selector: sel };
          },
          args: [typeSelector, typeText]
        });
        result = result[0]?.result;
        break;

      case 'find':
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (sel, attrs) => {
            const els = document.querySelectorAll(sel);
            if (!attrs) return { count: els.length, found: els.length > 0 };
            const elements = Array.from(els).map((el, i) => {
              const info = { index: i, tag: el.tagName };
              for (const attr of attrs) {
                if (attr === 'text') info.text = (el.innerText || '').substring(0, 200);
                else info[attr] = el.getAttribute(attr) || el[attr] || null;
              }
              return info;
            });
            return { count: els.length, found: els.length > 0, elements };
          },
          args: [command.selector, command.attrs || null]
        });
        result = result[0]?.result;
        break;

      case 'get_images':
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN', // Must match shadow-fix.js world to see forced-open shadow roots
          func: (onlyResponses) => {
            // Helper: recursively walk shadow DOMs to find all elements matching tag
            function deepQueryAll(root, selector) {
              const results = Array.from(root.querySelectorAll(selector));
              // Walk shadow roots
              const allEls = root.querySelectorAll('*');
              for (const el of allEls) {
                if (el.shadowRoot) {
                  results.push(...deepQueryAll(el.shadowRoot, selector));
                }
              }
              return results;
            }

            const images = [];
            const seen = new Set();
            function addImg(src, alt, width, height) {
              const key = src.substring(0, 200);
              if (seen.has(key)) return;
              // Skip UI decorations, extension icons, profile pics, SVGs
              if (src.includes('chrome-extension://')) return;
              if (src.includes('googleusercontent.com/a/')) return;
              if (src.includes('lh3.google.com/a/')) return;
              if (src.includes('lh3.googleusercontent.com/a')) return;
              if (src.includes('gstatic.com/')) return;
              if (src.includes('/favicon')) return;
              if (src.includes('accounts.google.com')) return;
              if (src.includes('/avatar')) return;
              if (src.endsWith('.svg') || src.includes('.svg?') || src.startsWith('data:image/svg')) return;
              if (src.startsWith('data:image/gif')) return;
              seen.add(key);
              images.push({
                index: images.length, src, alt: alt || '',
                width, height,
                isBlob: src.startsWith('blob:'),
                isData: src.startsWith('data:'),
              });
            }

            // 1. Standard + shadow DOM <img> tags
            const allImgs = deepQueryAll(document, 'img');
            allImgs.filter(img => img.src && (img.naturalWidth > 100 || img.width > 100))
              .forEach(img => addImg(img.src, img.alt, img.naturalWidth || img.width, img.naturalHeight || img.height));

            // 2. Canvas elements (deep)
            const allCanvas = deepQueryAll(document, 'canvas');
            allCanvas.filter(c => c.width > 100 && c.height > 100).forEach(c => {
              try { addImg(c.toDataURL('image/png'), 'canvas-image', c.width, c.height); }
              catch(e) { /* tainted */ }
            });

            // 3. Background images (deep)
            const allBg = deepQueryAll(document, '[style*="background-image"]');
            allBg.forEach(el => {
              const match = el.style.backgroundImage.match(/url\(["']?(.+?)["']?\)/);
              if (match && match[1] && el.offsetWidth > 100) {
                addImg(match[1], 'bg-image', el.offsetWidth, el.offsetHeight);
              }
            });

            // 4. <source> inside <picture> elements (deep)
            const allSources = deepQueryAll(document, 'picture source, source[type*="image"]');
            allSources.forEach(s => {
              if (s.srcset) addImg(s.srcset.split(',')[0].trim().split(' ')[0], 'picture-source', 0, 0);
            });

            return { images, count: images.length };
          },
          args: [command.onlyResponses !== false]
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
              const getResponses = () => document.querySelectorAll('MESSAGE-CONTENT, message-content, [data-message-id], .model-response-text');
              const initialCount = getResponses().length;
              let lastText = '';
              let stableCount = 0;

              const checkResponse = () => {
                const responses = getResponses();
                if (responses.length > initialCount) {
                  const lastResponse = responses[responses.length - 1];
                  const text = (lastResponse.textContent || lastResponse.innerText || '').trim();

                  if (text === lastText && text.length > 5) {
                    stableCount++;
                    if (stableCount >= 3) {
                      resolve({ answer: text, success: true });
                      return true;
                    }
                  } else {
                    lastText = text;
                    stableCount = 0;
                  }
                }

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

              const interval = setInterval(() => {
                if (checkResponse()) clearInterval(interval);
              }, 500);
            });
          },
          args: [command.timeout || 15000]
        });
        result = result[0]?.result;
        if (result?.answer) {
          publish(TOPICS.answer, { answer: result.answer, timestamp: Date.now() }, true);
          await broadcastLog('answer', { answer: result.answer });
          // Store directly for sidebar
          await chrome.storage.local.set({ lastAnswer: result.answer, lastAnswerTime: Date.now() });
        }
        break;

      case 'get_response':
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const selectors = [
              'MESSAGE-CONTENT',     // Gemini uses uppercase custom element
              'message-content',     // fallback lowercase
              '[data-message-id]',
              '.model-response-text',
              '.response-container',
              '.markdown-main-panel'
            ];

            let responses = [];
            for (const sel of selectors) {
              const els = document.querySelectorAll(sel);
              if (els.length > 0) {
                responses = els;
                break;
              }
            }

            if (responses.length === 0) {
              return { error: 'No Gemini responses found on page' };
            }

            const lastResponse = responses[responses.length - 1];
            const text = (lastResponse.textContent || lastResponse.innerText || '').trim();

            if (!text || text.length < 5) {
              return { error: 'Response is empty or too short' };
            }

            return { answer: text, success: true, count: responses.length };
          }
        });
        result = result[0]?.result;
        if (result?.answer) {
          publish(TOPICS.answer, { answer: result.answer, timestamp: Date.now() }, true);
          await broadcastLog('answer', { answer: result.answer });
          // Store directly for sidebar
          await chrome.storage.local.set({ lastAnswer: result.answer, lastAnswerTime: Date.now() });
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

      case 'download_images': {
        // Extract images via canvas draw + fetch in content script context
        const imgResults = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN', // Must match shadow-fix.js world to see forced-open shadow roots
          func: async (responseIndex) => {
            function deepQueryAll(root, selector) {
              const results = Array.from(root.querySelectorAll(selector));
              for (const el of root.querySelectorAll('*')) {
                if (el.shadowRoot) results.push(...deepQueryAll(el.shadowRoot, selector));
              }
              return results;
            }

            // Collect all image sources (img tags + canvas + bg-image)
            const sources = [];
            const seen = new Set();
            function addSrc(src, w, h) {
              if (!src || src.includes('chrome-extension://') || src.includes('googleusercontent.com/a/') || src.includes('lh3.google.com/a/')) return;
              if (src.includes('lh3.googleusercontent.com/a')) return;
              if (src.includes('gstatic.com/')) return;
              if (src.includes('/favicon') || src.includes('accounts.google.com') || src.includes('/avatar')) return;
              if (src.endsWith('.svg') || src.includes('.svg?') || src.startsWith('data:image/svg') || src.startsWith('data:image/gif')) return;
              const key = src.split('?')[0].split('#')[0].replace(/=s\d+-\w+$/, '');
              if (seen.has(key)) return;
              seen.add(key);
              sources.push({ src, width: w, height: h });
            }

            deepQueryAll(document, 'img')
              .filter(img => img.src && (img.naturalWidth > 100 || img.width > 100))
              .forEach(img => addSrc(img.src, img.naturalWidth || img.width, img.naturalHeight || img.height));

            deepQueryAll(document, 'canvas')
              .filter(c => c.width > 100 && c.height > 100)
              .forEach(c => { try { addSrc(c.toDataURL('image/png'), c.width, c.height); } catch(e) {} });

            deepQueryAll(document, '[style*="background-image"]').forEach(el => {
              const m = el.style.backgroundImage.match(/url\(["']?(.+?)["']?\)/);
              if (m && m[1] && el.offsetWidth > 100) addSrc(m[1], el.offsetWidth, el.offsetHeight);
            });

            deepQueryAll(document, 'picture source, source[type*="image"]').forEach(s => {
              if (s.srcset) addSrc(s.srcset.split(',')[0].trim().split(' ')[0], 0, 0);
            });

            // Return sources only — background script will fetch with cookies
            return { sources, count: sources.length };
          },
          args: [command.responseIndex ?? -1]
        });

        let imgData = imgResults[0]?.result;

        // ── CDP Fallback: if deepQueryAll found nothing, pierce shadow DOM via debugger ──
        if (!imgData || imgData.count === 0) {
          console.log('[download_images] deepQueryAll found 0 images — trying CDP fallback');
          try {
            await chrome.debugger.attach({ tabId: tab.id }, '1.3');
            try {
              const doc = await chrome.debugger.sendCommand(
                { tabId: tab.id }, 'DOM.getDocument', { depth: -1, pierce: true }
              );

              // Walk the full DOM tree for IMG nodes with src attributes
              const cdpSources = [];
              const cdpSeen = new Set();
              function walkNode(node) {
                if (!node) return;
                // Check if this is an IMG element
                if (node.nodeName === 'IMG' && node.attributes) {
                  const attrs = node.attributes;
                  for (let i = 0; i < attrs.length; i += 2) {
                    if (attrs[i] === 'src') {
                      const src = attrs[i + 1];
                      // Aggressive junk URL exclusion — profile pics, icons, SVGs, UI assets
                      const isJunk = !src ||
                        src.includes('chrome-extension://') ||
                        src.includes('googleusercontent.com/a/') ||
                        src.includes('lh3.google.com/a/') ||
                        src.includes('lh3.googleusercontent.com/a') ||
                        src.includes('gstatic.com/') ||
                        src.includes('/favicon') ||
                        src.includes('accounts.google.com') ||
                        src.includes('/avatar') ||
                        src.endsWith('.svg') || src.includes('.svg?') ||
                        src.startsWith('data:image/svg') ||
                        src.startsWith('data:image/gif');
                      if (!isJunk) {
                        const key = src.split('?')[0].split('#')[0].replace(/=s\d+-\w+$/, '');
                        if (!cdpSeen.has(key)) {
                          cdpSeen.add(key);
                          cdpSources.push({ src, width: 0, height: 0 });
                        }
                      }
                      break;
                    }
                  }
                }
                // Recurse into children (including shadow DOM children via pierce)
                if (node.children) node.children.forEach(walkNode);
                if (node.contentDocument) walkNode(node.contentDocument);
                if (node.shadowRoots) node.shadowRoots.forEach(walkNode);
              }
              walkNode(doc.root);

              if (cdpSources.length > 0) {
                console.log(`[download_images] CDP found ${cdpSources.length} images`);
                imgData = { sources: cdpSources, count: cdpSources.length, method: 'cdp' };
              }
            } finally {
              await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
            }
          } catch (cdpErr) {
            console.error('[download_images] CDP fallback failed:', cdpErr.message);
          }
        }

        if (!imgData || imgData.count === 0) {
          result = { error: 'No images found (both DOM and CDP methods failed)' };
          break;
        }

        // Fetch cookies for googleusercontent.com (image CDN)
        let cookieHeader = '';
        try {
          const cookies = await chrome.cookies.getAll({ domain: '.google.com' });
          cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        } catch (e) { /* cookies permission may not be available */ }

        // Download each image — fetch with cookies in background, then download dataURL
        const downloads = [];
        const timestamp = Date.now();
        for (let i = 0; i < imgData.sources.length; i++) {
          const item = imgData.sources[i];

          // Belt-and-suspenders: filter junk URLs that slipped past collection phase
          const srcLower = (item.src || '').toLowerCase();
          if (srcLower.includes('gstatic.com/') || srcLower.includes('sparkle') ||
              srcLower.includes('lamda/images') || srcLower.endsWith('.svg') ||
              srcLower.includes('.svg?') || srcLower.startsWith('data:image/svg')) {
            console.log(`[download_images] Skipping junk URL at download phase: ${item.src.substring(0, 80)}`);
            continue;
          }

          const filename = command.prefix
            ? `${command.prefix}_${i + 1}.png`
            : `gemini_${timestamp}_${i + 1}.png`;

          try {
            // Skip data URLs — download directly
            if (item.src.startsWith('data:')) {
              const did = await chrome.downloads.download({ url: item.src, filename });
              downloads.push({ downloadId: did, filename, width: item.width, height: item.height, method: 'data_url' });
              continue;
            }

            // T032: blob URLs — fetch in page context, convert to dataURL
            if (item.src.startsWith('blob:')) {
              try {
                const [result] = await chrome.scripting.executeScript({
                  target: { tabId: command.tabId },
                  func: async (blobUrl) => {
                    const resp = await fetch(blobUrl);
                    const blob = await resp.blob();
                    return await new Promise((resolve) => {
                      const reader = new FileReader();
                      reader.onloadend = () => resolve(reader.result);
                      reader.readAsDataURL(blob);
                    });
                  },
                  args: [item.src],
                });
                if (result?.result && typeof result.result === 'string' && result.result.startsWith('data:')) {
                  const did = await chrome.downloads.download({ url: result.result, filename });
                  downloads.push({ downloadId: did, filename, width: item.width, height: item.height, method: 'blob_to_data' });
                } else {
                  console.log(`[download_images] blob conversion returned non-data result for: ${item.src.substring(0, 60)}`);
                }
              } catch (blobErr) {
                console.log(`[download_images] blob fetch failed: ${blobErr.message} — ${item.src.substring(0, 60)}`);
              }
              continue;
            }

            // Fetch image from background with cookies
            const fetchOpts = {};
            if (cookieHeader) {
              fetchOpts.headers = { 'Cookie': cookieHeader };
            }
            const resp = await fetch(item.src, fetchOpts);
            const ct = resp.headers.get('content-type') || '';

            // Skip SVG responses — never download SVG icons
            if (ct.includes('svg')) {
              console.log(`[download_images] Skipping SVG content-type: ${item.src.substring(0, 80)}`);
              continue;
            }

            if (ct.startsWith('image/')) {
              // Got actual image — convert to base64 data URL and download
              const arrayBuf = await resp.arrayBuffer();
              // Filesize gate: skip tiny images (<10KB = profile pics, icons)
              if (arrayBuf.byteLength < 10240) {
                console.log(`[download_images] Skipping tiny image (${arrayBuf.byteLength}B): ${item.src.substring(0, 80)}`);
                continue;
              }
              const bytes = new Uint8Array(arrayBuf);
              let binary = '';
              for (let b = 0; b < bytes.length; b++) binary += String.fromCharCode(bytes[b]);
              const base64 = btoa(binary);
              // Use image/png mime to help Chrome with filename
              const dataUrl = `data:image/png;base64,${base64}`;
              const did = await chrome.downloads.download({ url: dataUrl, filename });
              downloads.push({ downloadId: did, filename, width: item.width, height: item.height, size: arrayBuf.byteLength, method: 'cookie_fetch' });
            } else {
              // Not an image — try direct download as last resort
              const did = await chrome.downloads.download({ url: item.src, filename });
              downloads.push({ downloadId: did, filename, width: item.width, height: item.height, method: 'direct_url', contentType: ct });
            }
          } catch (e) {
            downloads.push({ error: e.message, filename, src: item.src.substring(0, 100) });
          }
        }

        result = { downloads, totalImages: imgData.count, downloaded: downloads.filter(d => d.downloadId).length };
        break;
      }

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
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async (modelName) => {
            const allBtns = Array.from(document.querySelectorAll('button'));
            const debug = { totalButtons: allBtns.length, candidates: [] };

            let dropdownBtn = null;
            dropdownBtn = allBtns.find(b => b.className.includes('input-area-switch'));
            if (dropdownBtn) debug.foundBy = 'input-area-switch';

            if (!dropdownBtn) {
              dropdownBtn = allBtns.find(b => b.textContent.trim().match(/^(Pro|Fast|Thinking)$/));
              if (dropdownBtn) debug.foundBy = 'text-match';
            }

            if (!dropdownBtn) {
              dropdownBtn = allBtns.find(b => b.parentElement?.className?.includes('pill-ui'));
              if (dropdownBtn) debug.foundBy = 'pill-ui-parent';
            }

            if (!dropdownBtn) {
              return { error: 'Model dropdown not found', debug, request: modelName };
            }

            debug.clickedButton = { class: dropdownBtn.className.substring(0, 50), text: dropdownBtn.textContent.trim() };
            dropdownBtn.click();
            await new Promise(r => setTimeout(r, 600));

            const modelMap = { 'fast': 'Fast', 'thinking': 'Thinking', 'pro': 'Pro' };
            const targetModel = modelMap[modelName.toLowerCase()] || modelName;

            const options = document.querySelectorAll('[role="option"], [role="menuitem"], [role="listbox"] button, .mat-mdc-menu-item');
            for (const opt of options) {
              if (opt.textContent.includes(targetModel)) {
                opt.click();
                return { success: true, model: targetModel, debug, request: modelName };
              }
            }

            const allClickables = document.querySelectorAll('button, div[role="option"], .mdc-list-item');
            for (const el of allClickables) {
              if (el.textContent.trim().startsWith(targetModel) && el !== dropdownBtn) {
                el.click();
                return { success: true, model: targetModel, debug, request: modelName };
              }
            }

            return { error: 'Model option not found: ' + targetModel, debug, request: modelName };
          },
          args: [command.model || 'pro']
        });
        result = result[0]?.result;
        break;

      case 'select_mode':
        // Select Gemini mode (Deep Research, etc) - use coordinates to click
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async (modeName) => {
            const allBtns = Array.from(document.querySelectorAll('button'));
            const debug = {};

            // Find Tools button
            let toolsBtn = allBtns.find(b => b.textContent?.trim() === 'Tools');
            if (!toolsBtn) {
              return { error: 'Tools button not found' };
            }

            toolsBtn.click();
            await new Promise(r => setTimeout(r, 800));

            // Find "Deep Research" text element (leaf node)
            const allElements = document.querySelectorAll('*');
            let textEl = null;

            for (const el of allElements) {
              if (el.textContent?.trim() === 'Deep Research' && el.children.length === 0) {
                textEl = el;
                break;
              }
            }

            if (!textEl) {
              return { error: 'Deep Research text not found' };
            }

            // Get bounding rect and click at center
            const rect = textEl.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;

            debug.rect = { x, y };

            const clickTarget = document.elementFromPoint(x, y);
            debug.clickTarget = { tag: clickTarget?.tagName, class: clickTarget?.className?.substring(0, 50) };

            if (clickTarget) {
              const eventInit = { bubbles: true, cancelable: true, clientX: x, clientY: y };
              clickTarget.dispatchEvent(new MouseEvent('mousedown', eventInit));
              clickTarget.dispatchEvent(new MouseEvent('mouseup', eventInit));
              clickTarget.dispatchEvent(new MouseEvent('click', eventInit));

              console.log('[Claude Proxy] Clicked at', x, y, clickTarget.tagName);
              return { success: true, mode: 'Deep Research', debug };
            }

            return { error: 'No element at coordinates', debug };
          },
          args: [command.mode || 'Deep Research']
        });
        result = result[0]?.result;
        break;

      case 'get_response':
        // Get Gemini responses (same as sidebar button)
        if (!tab.url?.includes('gemini.google.com')) {
          result = { error: 'Not on Gemini page' };
          break;
        }
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const all = document.querySelectorAll('MESSAGE-CONTENT, message-content');
            if (all.length === 0) return { error: 'No responses found' };
            // Get latest response (last one)
            const latest = all[all.length - 1];
            const answer = (latest.innerText || '').trim();
            return {
              answer: answer,
              count: all.length,
              timestamp: Date.now()
            };
          }
        });
        result = result[0]?.result;
        // Also publish to answer topic for convenience
        if (result && result.answer) {
          publish(TOPICS.answer, result, true);
        }
        break;

      case 'chat':
        // SMOOTH: Fast chat - direct text insert + Enter
        if (!tab.url?.includes('gemini.google.com')) {
          result = { error: 'Not on Gemini page' };
          break;
        }
        // newChat: navigate to /app in same tab (no new tab)
        if (command.newChat) {
          await chrome.tabs.update(tab.id, { url: 'https://gemini.google.com/app' });
          // Wait for page to load
          await new Promise(resolve => {
            const listener = (tabId, info) => {
              if (tabId === tab.id && info.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
              }
            };
            chrome.tabs.onUpdated.addListener(listener);
            setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 5000);
          });
          await new Promise(r => setTimeout(r, 1500)); // Extra wait for Gemini JS to init
        }
        const chatText = command.text || '';
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async (text) => {
            try {
              // Try multiple selectors for Gemini input
              const selectors = [
                'rich-textarea .ql-editor',
                'rich-textarea [contenteditable="true"]',
                '.ql-editor[contenteditable="true"]',
                'div[aria-label="Enter a prompt here"]',
                '[data-placeholder*="prompt"]',
                '[contenteditable="true"]'
              ];

              let input = null;
              for (const sel of selectors) {
                input = document.querySelector(sel);
                if (input) break;
              }

              if (!input) {
                return { error: 'Input not found', selectors: selectors.length };
              }

              // Focus the editor and select all to clear
              input.focus();
              document.execCommand('selectAll');
              document.execCommand('delete');

              // Type text character by character using InputEvent
              // This is the ONLY way to properly trigger Quill's input handler
              // Quill listens to DOM mutations caused by browser's native input handling
              for (const char of text) {
                // beforeinput tells the editor what's coming
                input.dispatchEvent(new InputEvent('beforeinput', {
                  inputType: 'insertText',
                  data: char,
                  bubbles: true,
                  cancelable: true,
                  composed: true
                }));
                // Actually insert the character via execCommand (native browser)
                document.execCommand('insertText', false, char);
              }

              // Wait for Quill to process all mutations
              await new Promise(r => setTimeout(r, 200));
              const quillReady = !input.classList.contains('ql-blank');
              const editorText = input.innerText.trim();

              // Click send button
              return new Promise(resolve => {
                setTimeout(() => {
                  const sendBtn = document.querySelector(
                    'button.send-button, button[aria-label*="Send message"], button.submit'
                  );
                  if (sendBtn && !sendBtn.disabled) {
                    sendBtn.click();
                    resolve({ success: true, sent: text.substring(0, 50), quillReady, editorText: editorText.substring(0, 50), method: 'type_button' });
                  } else {
                    input.dispatchEvent(new KeyboardEvent('keydown', {
                      key: 'Enter', code: 'Enter', keyCode: 13,
                      bubbles: true, cancelable: true
                    }));
                    resolve({ success: true, sent: text.substring(0, 50), quillReady, editorText: editorText.substring(0, 50), method: 'type_enter' });
                  }
                }, 300);
              });
            } catch (e) {
              return { error: e.message };
            }
          },
          args: [chatText]
        });
        result = result[0]?.result || { error: 'Script returned null' };
        break;

      case 'delete_chat': {
        // Delete current conversation from Gemini sidebar
        if (!tab.url?.includes('gemini.google.com')) {
          result = { error: 'Not on Gemini page' };
          break;
        }
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async () => {
            try {
              // Gemini uses: a[href*="/app/"] for conversation links
              // Menu button: button.gem-conversation-actions-menu-button
              //   aria-label="More options for [title]"
              const currentPath = window.location.pathname;
              const convId = currentPath.split('/app/')[1];

              // Strategy 1: Find menu button matching current conversation URL
              let menuBtn = null;
              if (convId) {
                const convLink = document.querySelector(`a[href*="/app/${convId}"]`);
                if (convLink) {
                  // Menu button is a sibling in the same parent container
                  const parent = convLink.closest('[class*="conversation"], li') || convLink.parentElement;
                  if (parent) {
                    menuBtn = parent.querySelector('.gem-conversation-actions-menu-button') ||
                      parent.querySelector('button[aria-label^="More options for"]');
                  }
                }
              }

              // Strategy 2: Find by conversation title from aria-label
              if (!menuBtn) {
                // Get all menu buttons, find the one for the active conversation
                const allMenuBtns = document.querySelectorAll('.gem-conversation-actions-menu-button');
                if (allMenuBtns.length > 0) {
                  // First button is most recent conversation (likely the one we just created)
                  menuBtn = allMenuBtns[0];
                }
              }

              // Strategy 3: Any button with "More options for" aria-label
              if (!menuBtn) {
                menuBtn = document.querySelector('button[aria-label^="More options for"]');
              }

              if (!menuBtn) {
                return { error: 'Menu button not found — no .gem-conversation-actions-menu-button in DOM' };
              }

              // Click menu button
              menuBtn.click();
              await new Promise(r => setTimeout(r, 500));

              // Find and click "Delete" in the Material dropdown menu
              const menuItems = document.querySelectorAll('[role="menuitem"], mat-menu-item, .mat-mdc-menu-item');
              let deleteClicked = false;
              for (const item of menuItems) {
                const text = item.textContent?.trim().toLowerCase();
                if (text?.includes('delete') || text?.includes('ลบ')) {
                  item.click();
                  deleteClicked = true;
                  break;
                }
              }

              if (!deleteClicked) {
                // Close menu if delete not found
                document.body.click();
                return { error: 'Delete option not found in menu' };
              }

              // Wait for confirmation dialog and click confirm
              await new Promise(r => setTimeout(r, 600));
              const dialogs = document.querySelectorAll('mat-dialog-container, [role="dialog"], [class*="dialog"]');
              for (const dialog of dialogs) {
                const btns = dialog.querySelectorAll('button');
                for (const btn of btns) {
                  const text = btn.textContent?.trim().toLowerCase();
                  if (text === 'delete' || text === 'confirm' || text === 'ลบ') {
                    btn.click();
                    return { success: true, method: 'gem_menu_delete' };
                  }
                }
              }

              // No dialog — deletion may have happened directly
              return { success: true, method: 'gem_menu_direct' };
            } catch (e) {
              return { error: e.message };
            }
          }
        });
        result = result[0]?.result || { error: 'Script returned null' };
        break;
      }

      case 'delete_chats_bulk': {
        // Delete old IMAGE GEN conversations from Gemini sidebar
        // command.count = max chats to delete (default: 50)
        // command.keepRecent = skip N most recent (default: 1)
        // command.filter = title keyword filter (default: image-gen patterns)
        // SAFETY: only deletes chats whose titles match image-gen patterns
        // (short titles, image keywords) — never deletes personal chats
        if (!tab.url?.includes('gemini.google.com')) {
          result = { error: 'Not on Gemini page' };
          break;
        }

        const keepRecent = command.keepRecent ?? 1;
        const maxDelete = command.count ?? 50;
        const filterKeywords = command.filter || null; // null = use default image-gen patterns

        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async (keepRecent, maxDelete, filterKeywords) => {
            try {
              let deleted = 0;
              let skipped = 0;
              let errors = [];

              // Image-gen title patterns — conversations created by gemini-gen.sh
              // typically have titles like "a red circle on white background" or
              // "generate image of sunset" — short, descriptive, image-related
              const IMAGE_GEN_PATTERNS = [
                /^(a |an |the |create |generate |make |draw |design |render |paint )/i,
                /\b(image|photo|picture|poster|banner|logo|icon|illustration|artwork|portrait|landscape)\b/i,
                /\b(red|blue|green|white|black|gold|silver|sunset|sunrise|circle|square|background)\b/i,
                /\b(minimalist|realistic|abstract|cartoon|anime|3d|flat|gradient)\b/i,
              ];

              for (let round = 0; round < maxDelete + skipped; round++) {
                if (deleted >= maxDelete) break;

                // Re-query each round since DOM changes after deletion
                const convItems = document.querySelectorAll('a[href*="/app/"]');
                const candidates = Array.from(convItems).slice(keepRecent);

                if (candidates.length === 0) break;

                // Find next candidate that matches image-gen pattern
                let target = null;
                let targetTitle = '';
                for (const item of candidates) {
                  const title = (item.textContent || item.title || '').trim();
                  if (filterKeywords) {
                    // Custom keyword filter
                    if (title.toLowerCase().includes(filterKeywords.toLowerCase())) {
                      target = item;
                      targetTitle = title;
                      break;
                    }
                  } else {
                    // Default: match image-gen patterns
                    const isImageGen = IMAGE_GEN_PATTERNS.some(p => p.test(title));
                    if (isImageGen) {
                      target = item;
                      targetTitle = title;
                      break;
                    }
                  }
                }

                if (!target) {
                  // No more matching conversations
                  break;
                }

                // Hover to reveal menu
                target.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
                await new Promise(r => setTimeout(r, 300));

                // Find menu button via Gemini's .gem-conversation-actions-menu-button
                const container = target.closest('[class*="conversation"], li') || target.parentElement;
                let menuBtn = container?.querySelector('.gem-conversation-actions-menu-button') ||
                  container?.querySelector('button[aria-label^="More options for"]');

                if (!menuBtn) {
                  errors.push(`Round ${round}: menu button not found for "${targetTitle.substring(0,30)}"`);
                  skipped++;
                  continue; // skip this one, try next
                }

                menuBtn.click();
                await new Promise(r => setTimeout(r, 500));

                const menuItems = document.querySelectorAll('[role="menuitem"], mat-menu-item, .mat-mdc-menu-item');
                let deleteClicked = false;
                for (const item of menuItems) {
                  const text = item.textContent?.trim().toLowerCase();
                  if (text?.includes('delete') || text?.includes('ลบ')) {
                    item.click();
                    deleteClicked = true;
                    break;
                  }
                }

                if (!deleteClicked) {
                  document.body.click(); // close menu
                  errors.push(`Round ${round}: delete option not found`);
                  skipped++;
                  continue;
                }

                // Confirm deletion in Material dialog
                await new Promise(r => setTimeout(r, 600));
                const dialogs = document.querySelectorAll('mat-dialog-container, [role="dialog"]');
                for (const dialog of dialogs) {
                  const btns = dialog.querySelectorAll('button');
                  for (const btn of btns) {
                    const text = btn.textContent?.trim().toLowerCase();
                    if (text === 'delete' || text === 'confirm' || text === 'ลบ') {
                      btn.click();
                      break;
                    }
                  }
                }

                deleted++;
                // Wait for DOM to update after deletion
                await new Promise(r => setTimeout(r, 800));
              }

              return { success: true, deleted, skipped, errors: errors.length ? errors : undefined };
            } catch (e) {
              return { error: e.message };
            }
          },
          args: [keepRecent, maxDelete, filterKeywords]
        });
        result = result[0]?.result || { error: 'Script returned null' };
        break;
      }

      // ═══ ChatGPT Actions ═══

      case 'chatgpt_chat': {
        // Send message to ChatGPT
        if (!tab.url?.includes('chatgpt.com') && !tab.url?.includes('chat.openai.com')) {
          result = { error: 'Not on ChatGPT page' };
          break;
        }
        const cgptText = command.text || '';
        if (command.newChat) {
          await chrome.tabs.update(tab.id, { url: 'https://chatgpt.com/' });
          await new Promise(resolve => {
            const listener = (tabId, info) => {
              if (tabId === tab.id && info.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
              }
            };
            chrome.tabs.onUpdated.addListener(listener);
            setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 8000);
          });
          await new Promise(r => setTimeout(r, 2000));
        }
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async (text) => {
            try {
              // ChatGPT uses a ProseMirror editor or contenteditable div
              const selectors = [
                '#prompt-textarea',
                'div[contenteditable="true"][id="prompt-textarea"]',
                'textarea[data-id="root"]',
                '[contenteditable="true"]',
                'textarea'
              ];
              let input = null;
              for (const sel of selectors) {
                input = document.querySelector(sel);
                if (input) break;
              }
              if (!input) return { error: 'Input not found' };

              input.focus();

              // ChatGPT uses ProseMirror — set innerHTML for <p> tags or use insertText
              if (input.tagName === 'TEXTAREA') {
                // Legacy textarea
                const nativeSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
                nativeSet.call(input, text);
                input.dispatchEvent(new Event('input', { bubbles: true }));
              } else {
                // ProseMirror contenteditable div
                input.innerHTML = `<p>${text}</p>`;
                input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
              }

              await new Promise(r => setTimeout(r, 300));

              // Click send button — try multiple selectors (ChatGPT DOM changes frequently)
              const sendSelectors = [
                '#composer-submit-button',
                'button[data-testid="send-button"]',
                'button[aria-label="Send prompt"]',
                'button[aria-label*="Send"]',
                'form button[type="submit"]',
              ];
              let sendBtn = null;
              for (const sel of sendSelectors) {
                sendBtn = document.querySelector(sel);
                if (sendBtn) break;
              }

              if (sendBtn && !sendBtn.disabled) {
                sendBtn.click();
                return { success: true, sent: text.substring(0, 50), method: 'button' };
              }

              // Retry after short wait — button may enable after file processing
              await new Promise(r => setTimeout(r, 500));
              for (const sel of sendSelectors) {
                sendBtn = document.querySelector(sel);
                if (sendBtn && !sendBtn.disabled) {
                  sendBtn.click();
                  return { success: true, sent: text.substring(0, 50), method: 'button_retry' };
                }
              }

              // Fallback: Enter key
              input.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true
              }));
              return { success: true, sent: text.substring(0, 50), method: 'enter' };
            } catch (e) {
              return { error: e.message };
            }
          },
          args: [cgptText]
        });
        result = result[0]?.result || { error: 'Script returned null' };
        break;
      }

      case 'chatgpt_get_state': {
        // Get ChatGPT state — response count, loading status
        if (!tab.url?.includes('chatgpt.com') && !tab.url?.includes('chat.openai.com')) {
          result = { error: 'Not on ChatGPT page' };
          break;
        }
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            // ChatGPT uses conversation-turn-N sections — odd=user, even=assistant
            const turns = document.querySelectorAll('[data-testid^="conversation-turn-"]');
            // Count assistant turns (even numbers: turn-2, turn-4, etc.)
            let assistantCount = 0;
            turns.forEach(t => {
              const id = t.getAttribute('data-testid') || '';
              const num = parseInt(id.replace('conversation-turn-', ''));
              if (num % 2 === 0) assistantCount++;
            });
            // Also check for .agent-turn (assistant response container)
            const agentTurns = document.querySelectorAll('.agent-turn');
            const count = Math.max(assistantCount, agentTurns.length);
            const isLoading = !!document.querySelector('.result-streaming, [class*="streaming"], button[aria-label="Stop generating"], button[aria-label="Stop"]');
            return {
              responseCount: count,
              loading: isLoading,
              url: window.location.href
            };
          }
        });
        result = result[0]?.result || { responseCount: 0, loading: false };
        break;
      }

      case 'chatgpt_get_images': {
        // Find DALL-E generated images in ChatGPT responses
        if (!tab.url?.includes('chatgpt.com') && !tab.url?.includes('chat.openai.com')) {
          result = { error: 'Not on ChatGPT page' };
          break;
        }
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN', // Must match shadow-fix.js world to see forced-open shadow roots
          func: () => {
            const images = [];
            const seen = new Set();

            // DALL-E images: served from chatgpt.com/backend-api/estuary/content
            // or oaiusercontent.com
            // Scan all imgs on the page — ChatGPT DOM structure changes frequently (#8)
            const isDalleUrl = (s) => s.includes('estuary/content') || s.includes('oaiusercontent');
            const isDalleAlt = (s) => s.startsWith('Generated image:');

            document.querySelectorAll('img').forEach(img => {
              const src = img.src || '';
              if (!src || src.includes('data:image/svg') || src.includes('/favicon') ||
                  src.includes('avatar') || src.includes('ui-avatars') ||
                  src.includes('chrome-extension://') ||
                  src.endsWith('.svg') || src.includes('.svg?')) return;
              const imgW = img.naturalWidth || img.width;
              const imgH = img.naturalHeight || img.height;
              const dalle = isDalleUrl(src) || isDalleAlt(img.alt || '');
              // DALL-E images render at various sizes in DOM (480×320 etc) — use low threshold
              // For non-DALL-E imgs, require larger size to skip UI chrome
              if (dalle ? (imgW < 100 || imgH < 100) : (imgW < 512 || imgH < 512)) return;
              const key = src.split('#')[0].substring(0, 200);
              if (seen.has(key)) return;
              seen.add(key);
              images.push({
                index: images.length,
                src,
                alt: img.alt || '',
                width: img.naturalWidth || img.width,
                height: img.naturalHeight || img.height,
                isBlob: src.startsWith('blob:'),
                isData: src.startsWith('data:'),
                isDalle: dalle
              });
            });

            // Also check for <a> links to DALL-E images (download links)
            document.querySelectorAll('a[href*="oaiusercontent.com"], a[href*="estuary/content"]').forEach(a => {
              const href = a.href;
              if (seen.has(href)) return;
              seen.add(href);
              images.push({
                index: images.length,
                src: href,
                alt: a.textContent?.trim() || '',
                width: 0, height: 0,
                isLink: true,
                isDalle: true
              });
            });

            return { count: images.length, images };
          }
        });
        result = result[0]?.result || { count: 0, images: [] };
        break;
      }

      case 'chatgpt_download_images': {
        // Download DALL-E images from ChatGPT
        if (!tab.url?.includes('chatgpt.com') && !tab.url?.includes('chat.openai.com')) {
          result = { error: 'Not on ChatGPT page' };
          break;
        }

        // First get images via content script
        // DOM-resilient scan (#8): no container selectors, detect DALL-E by URL/alt patterns
        const cgptImgResults = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN', // Must match shadow-fix.js world to see forced-open shadow roots
          func: () => {
            const sources = [];
            const seen = new Set();
            const isDalleUrl = (s) => s.includes('estuary/content') || s.includes('oaiusercontent');
            const isDalleAlt = (s) => s.startsWith('Generated image:');
            function addSrc(src, w, h) {
              if (!src) return;
              if (src.includes('data:image/svg') || src.includes('/favicon') ||
                  src.includes('avatar') || src.includes('ui-avatars') ||
                  src.includes('chrome-extension://') ||
                  src.endsWith('.svg') || src.includes('.svg?')) return;
              const key = src.split('#')[0].substring(0, 200);
              if (seen.has(key)) return;
              seen.add(key);
              sources.push({ src, width: w, height: h });
            }

            document.querySelectorAll('img').forEach(img => {
              const w = img.naturalWidth || img.width;
              const h = img.naturalHeight || img.height;
              const src = img.src || '';
              const dalle = isDalleUrl(src) || isDalleAlt(img.alt || '');
              // DALL-E images render at various sizes in DOM — use low threshold for known DALL-E
              if (dalle ? (w >= 100 && h >= 100) : (w >= 512 && h >= 512)) {
                addSrc(src, w, h);
              }
            });

            return { sources, count: sources.length };
          }
        });

        let cgptImgData = cgptImgResults[0]?.result;
        if (!cgptImgData || cgptImgData.count === 0) {
          result = { error: 'No DALL-E images found in ChatGPT responses' };
          break;
        }

        // Filter images by index/latest (#8 follow-up: was always downloading all)
        let toDownload = cgptImgData.sources;
        if (command.latest) {
          // Download only the most recent (last) image
          toDownload = [cgptImgData.sources[cgptImgData.sources.length - 1]];
        } else if (command.imageIndex !== undefined && command.imageIndex !== null) {
          const idx = Number(command.imageIndex);
          if (idx >= 0 && idx < cgptImgData.sources.length) {
            toDownload = [cgptImgData.sources[idx]];
          } else {
            result = { error: `imageIndex ${idx} out of range (0-${cgptImgData.sources.length - 1})`, count: cgptImgData.count };
            break;
          }
        }

        // Download selected image(s)
        const cgptDownloads = [];
        const cgptTimestamp = Date.now();
        for (let i = 0; i < toDownload.length; i++) {
          const item = toDownload[i];
          const filename = command.prefix
            ? `${command.prefix}_${i + 1}.png`
            : `chatgpt_${cgptTimestamp}_${i + 1}.png`;

          try {
            if (item.src.startsWith('data:')) {
              const did = await chrome.downloads.download({ url: item.src, filename });
              cgptDownloads.push({ downloadId: did, filename, width: item.width, height: item.height, method: 'data_url' });
              continue;
            }

            // Fetch with cookies
            let cookieHeader = '';
            try {
              const cookies = await chrome.cookies.getAll({ domain: '.chatgpt.com' });
              cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
            } catch (e) {}

            const fetchOpts = {};
            if (cookieHeader) fetchOpts.headers = { 'Cookie': cookieHeader };

            const resp = await fetch(item.src, fetchOpts);
            const ct = resp.headers.get('content-type') || '';

            if (ct.startsWith('image/')) {
              const arrayBuf = await resp.arrayBuffer();
              if (arrayBuf.byteLength < 5120) {
                console.log(`[chatgpt_download] Skipping tiny image (${arrayBuf.byteLength}B)`);
                continue;
              }
              const bytes = new Uint8Array(arrayBuf);
              let binary = '';
              for (let b = 0; b < bytes.length; b++) binary += String.fromCharCode(bytes[b]);
              const base64 = btoa(binary);
              const dataUrl = `data:image/png;base64,${base64}`;
              const did = await chrome.downloads.download({ url: dataUrl, filename });
              cgptDownloads.push({ downloadId: did, filename, width: item.width, height: item.height, size: arrayBuf.byteLength, method: 'cookie_fetch' });
            } else {
              const did = await chrome.downloads.download({ url: item.src, filename });
              cgptDownloads.push({ downloadId: did, filename, width: item.width, height: item.height, method: 'direct_url' });
            }
          } catch (e) {
            cgptDownloads.push({ error: e.message, filename, src: item.src.substring(0, 100) });
          }
        }

        result = {
          downloads: cgptDownloads,
          totalImages: cgptImgData.count,
          downloaded: cgptDownloads.filter(d => d.downloadId).length,
          // Debug: show what was selected (#10 diagnosis)
          _debug: {
            sourcesFound: cgptImgData.sources.length,
            selectedCount: toDownload.length,
            selectedSrcs: toDownload.map((s, i) => ({ i, src: s.src.substring(0, 120), w: s.width, h: s.height })),
            allSrcs: cgptImgData.sources.map((s, i) => ({ i, src: s.src.substring(0, 120), w: s.width, h: s.height })),
            params: { latest: command.latest, imageIndex: command.imageIndex }
          }
        };
        break;
      }

      case 'chatgpt_delete_chat': {
        // Delete current ChatGPT conversation
        if (!tab.url?.includes('chatgpt.com') && !tab.url?.includes('chat.openai.com')) {
          result = { error: 'Not on ChatGPT page' };
          break;
        }
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async () => {
            try {
              // ChatGPT sidebar: conversation items with a menu button
              const currentPath = window.location.pathname;
              const convId = currentPath.split('/c/')[1] || currentPath.split('/g/')[1];

              // Find the current conversation link in sidebar
              let convLink = null;
              if (convId) {
                convLink = document.querySelector(`a[href*="${convId}"]`);
              }
              if (!convLink) {
                // Try first conversation in sidebar (most recent)
                convLink = document.querySelector('nav a[href*="/c/"], nav a[href*="/g/"]');
              }
              if (!convLink) {
                return { error: 'No conversation found in sidebar' };
              }

              // Hover to reveal menu button
              convLink.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
              await new Promise(r => setTimeout(r, 300));

              // Find the menu button (3-dot)
              const container = convLink.closest('li') || convLink.parentElement;
              let menuBtn = container?.querySelector('button[aria-label*="Options"], button[data-testid*="options"]');
              if (!menuBtn) {
                const btns = container?.querySelectorAll('button') || [];
                for (const b of btns) {
                  if (b.querySelector('svg') && !b.textContent?.trim()) {
                    menuBtn = b;
                    break;
                  }
                }
              }
              if (!menuBtn) {
                return { error: 'Menu button not found on ChatGPT conversation' };
              }

              menuBtn.click();
              await new Promise(r => setTimeout(r, 400));

              // Find Delete in dropdown
              const menuItems = document.querySelectorAll('[role="menuitem"], [role="option"], button');
              let deleteClicked = false;
              for (const item of menuItems) {
                const text = item.textContent?.trim().toLowerCase();
                if (text?.includes('delete') || text?.includes('ลบ')) {
                  item.click();
                  deleteClicked = true;
                  break;
                }
              }

              if (!deleteClicked) {
                document.body.click();
                return { error: 'Delete option not found in ChatGPT menu' };
              }

              // Confirm
              await new Promise(r => setTimeout(r, 500));
              const dialogs = document.querySelectorAll('[role="dialog"], [class*="modal"]');
              for (const dialog of dialogs) {
                const btns = dialog.querySelectorAll('button');
                for (const btn of btns) {
                  const text = btn.textContent?.trim().toLowerCase();
                  if (text === 'delete' || text === 'confirm') {
                    btn.click();
                    return { success: true, method: 'chatgpt_delete' };
                  }
                }
              }

              return { success: true, method: 'chatgpt_delete_direct' };
            } catch (e) {
              return { error: e.message };
            }
          }
        });
        result = result[0]?.result || { error: 'Script returned null' };
        break;
      }

      case 'gemini_upload': {
        // Upload image/file to Gemini chat input
        // command.data = base64-encoded file content
        // command.filename = filename
        // command.mimeType = MIME type (default: "image/png")
        if (!tab.url?.includes('gemini.google.com')) {
          result = { error: 'Not on Gemini page' };
          break;
        }
        if (!command.data) {
          result = { error: 'data (base64) parameter required' };
          break;
        }
        const gemUploadFilename = command.filename || 'upload.png';
        const gemUploadMime = command.mimeType || 'image/png';

        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async (base64Data, filename, mimeType) => {
            try {
              // Convert base64 to File
              const binary = atob(base64Data);
              const bytes = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
              }
              const blob = new Blob([bytes], { type: mimeType });
              const file = new File([blob], filename, { type: mimeType, lastModified: Date.now() });

              // Click "Upload & tools" button to reveal upload menu
              const uploadBtn = document.querySelector('button[aria-label="Upload & tools"]') ||
                document.querySelector('button[aria-label*="Upload"]');
              if (!uploadBtn) {
                return { error: 'Upload & tools button not found' };
              }
              uploadBtn.click();
              await new Promise(r => setTimeout(r, 500));

              // Look for file input that appeared after clicking upload button
              let fileInput = document.querySelector('input[type="file"]');

              if (!fileInput) {
                // Click "Upload file" menu item if a menu appeared
                const menuItems = document.querySelectorAll('[role="menuitem"], button, [role="option"]');
                for (const item of menuItems) {
                  const text = item.textContent?.trim().toLowerCase();
                  if (text?.includes('upload') || text?.includes('file') || text?.includes('อัปโหลด')) {
                    item.click();
                    await new Promise(r => setTimeout(r, 500));
                    break;
                  }
                }
                fileInput = document.querySelector('input[type="file"]');
              }

              if (!fileInput) {
                // Fallback: try drag-and-drop onto the input area
                const inputArea = document.querySelector('rich-textarea, [contenteditable="true"]');
                if (inputArea) {
                  const dt = new DataTransfer();
                  dt.items.add(file);
                  const dropEvent = new DragEvent('drop', {
                    bubbles: true, cancelable: true, dataTransfer: dt
                  });
                  inputArea.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
                  inputArea.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
                  inputArea.dispatchEvent(dropEvent);
                  return { success: true, filename, size: bytes.length, method: 'drop' };
                }
                return { error: 'No file input found after clicking Upload & tools' };
              }

              // Set file via DataTransfer
              const dt = new DataTransfer();
              dt.items.add(file);
              fileInput.files = dt.files;
              fileInput.dispatchEvent(new Event('change', { bubbles: true }));

              return { success: true, filename, size: bytes.length, mimeType, method: 'fileInput' };
            } catch (e) {
              return { error: e.message };
            }
          },
          args: [command.data, gemUploadFilename, gemUploadMime]
        });
        result = result[0]?.result || { error: 'Script returned null' };
        break;
      }

      case 'chatgpt_upload': {
        // Upload image/file to ChatGPT chat input
        // command.data = base64-encoded file content
        // command.filename = filename (e.g., "logo.png")
        // command.mimeType = MIME type (default: "image/png")
        if (!tab.url?.includes('chatgpt.com') && !tab.url?.includes('chat.openai.com')) {
          result = { error: 'Not on ChatGPT page' };
          break;
        }
        if (!command.data) {
          result = { error: 'data (base64) parameter required' };
          break;
        }
        const uploadFilename = command.filename || 'upload.png';
        const uploadMime = command.mimeType || 'image/png';

        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async (base64Data, filename, mimeType) => {
            try {
              // Convert base64 to binary
              const binary = atob(base64Data);
              const bytes = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
              }
              const blob = new Blob([bytes], { type: mimeType });
              const file = new File([blob], filename, { type: mimeType, lastModified: Date.now() });

              // Find the image upload input (#upload-photos accepts image/*)
              let input = document.getElementById('upload-photos') ||
                document.getElementById('upload-files') ||
                document.querySelector('input[type="file"][accept*="image"]') ||
                document.querySelector('input[type="file"]');

              if (!input) {
                return { error: 'File input not found in ChatGPT UI' };
              }

              // Use DataTransfer to set files on the input
              const dt = new DataTransfer();
              dt.items.add(file);
              input.files = dt.files;

              // Trigger change event — ChatGPT's React/Next.js listens for this
              input.dispatchEvent(new Event('change', { bubbles: true }));

              // Also try input event for React synthetic events
              const inputEvent = new Event('input', { bubbles: true });
              Object.defineProperty(inputEvent, 'target', { value: input });
              input.dispatchEvent(inputEvent);

              return {
                success: true,
                filename,
                size: bytes.length,
                mimeType,
                inputId: input.id,
                method: 'dataTransfer'
              };
            } catch (e) {
              return { error: e.message };
            }
          },
          args: [command.data, uploadFilename, uploadMime]
        });
        result = result[0]?.result || { error: 'Script returned null' };
        break;
      }

      default:
        result = { error: 'Unknown action: ' + command.action };
    }
  } catch (err) {
    result = { error: err.message };
  }

  // Send response (retained) - include tabId for tracking
  const response = {
    id: command.id,
    action: command.action,
    ...(result && typeof result === 'object' ? result : { result }),
    tabId: tab?.id,
    timestamp: Date.now()
  };
  publish(TOPICS.response, response, true);
  await broadcastLog('res', response);
}

// Listen for messages from popup/sidepanel/content scripts
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'getTabId') {
    // Content script requesting its own tab ID
    sendResponse({ tabId: sender.tab?.id });
  } else if (msg.action === 'status') {
    sendResponse({ connected: isConnected });
  } else if (msg.action === 'reconnect') {
    if (client) client.end();
    connect();
    sendResponse({ ok: true });
  } else if (msg.action === 'publish_result') {
    // Direct publish from sidebar with debug info
    const data = msg.data;
    const payload = { action: data.action, result: data.result, timestamp: data.timestamp, source: 'sidebar' };
    const payloadStr = JSON.stringify(payload);
    publish(TOPICS.response, payload, true);
    sendResponse({
      ok: true,
      topic: TOPICS.response,
      qos: 0,
      retained: true,
      size: payloadStr.length,
      payload: payload
    });
  } else if (msg.action === 'command') {
    publish(TOPICS.command, msg.command);
    sendResponse({ ok: true });
  } else if (msg.action === 'select_model') {
    // Model selection from content script
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ error: 'No tab ID' });
      return true;
    }
    chrome.scripting.executeScript({
      target: { tabId },
      func: async (modelName) => {
        const allBtns = Array.from(document.querySelectorAll('button'));
        let dropdownBtn = allBtns.find(b => b.className.includes('input-area-switch'));
        if (!dropdownBtn) dropdownBtn = allBtns.find(b => b.textContent.trim().match(/^(Pro|Fast|Thinking)$/));
        if (!dropdownBtn) dropdownBtn = allBtns.find(b => b.parentElement?.className?.includes('pill-ui'));
        if (!dropdownBtn) return { error: 'Model dropdown not found' };

        dropdownBtn.click();
        await new Promise(r => setTimeout(r, 600));

        const modelMap = { 'fast': 'Fast', 'thinking': 'Thinking', 'pro': 'Pro' };
        const targetModel = modelMap[modelName.toLowerCase()] || modelName;

        // Look for clickable elements in the dropdown
        const options = document.querySelectorAll('[role="option"], [role="menuitem"], [role="listbox"] button, .mdc-list-item, [class*="option"]');
        for (const opt of options) {
          const text = opt.textContent?.trim();
          // Match if text starts with model name or first line matches
          if (text?.startsWith(targetModel) || text?.split('\n')[0]?.trim() === targetModel) {
            opt.click();
            return { success: true, model: targetModel };
          }
        }

        // Fallback: find any clickable with exact model name at start
        const allClickables = document.querySelectorAll('button, div[role="option"], div[tabindex], [class*="list-item"]');
        for (const el of allClickables) {
          const text = el.textContent?.trim();
          if (text?.startsWith(targetModel) && el !== dropdownBtn) {
            el.click();
            return { success: true, model: targetModel };
          }
        }
        return { error: 'Model option not found: ' + targetModel };
      },
      args: [msg.model || 'pro']
    }).then(results => {
      sendResponse(results[0]?.result || { error: 'Script failed' });
    }).catch(e => {
      sendResponse({ error: e.message });
    });
    return true; // Keep channel open for async response
  } else if (msg.action === 'select_mode') {
    // Mode selection from content script (Deep Research, etc)
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ error: 'No tab ID' });
      return true;
    }
    chrome.scripting.executeScript({
      target: { tabId },
      func: async (modeName) => {
        const allBtns = Array.from(document.querySelectorAll('button'));
        const debug = {};

        // Find Tools button
        let toolsBtn = allBtns.find(b => b.textContent?.trim() === 'Tools');
        if (!toolsBtn) {
          return { error: 'Tools button not found' };
        }

        toolsBtn.click();
        await new Promise(r => setTimeout(r, 800));

        // Find "Deep Research" text element
        const allElements = document.querySelectorAll('*');
        let textEl = null;

        for (const el of allElements) {
          if (el.textContent?.trim() === 'Deep Research' && el.children.length === 0) {
            textEl = el;
            break;
          }
        }

        if (!textEl) {
          return { error: 'Deep Research text not found' };
        }

        // Get bounding rect and click at center using elementFromPoint
        const rect = textEl.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;

        debug.rect = { x, y, width: rect.width, height: rect.height };

        // Find element at that point and click it
        const clickTarget = document.elementFromPoint(x, y);
        debug.clickTarget = { tag: clickTarget?.tagName, class: clickTarget?.className?.substring(0, 50) };

        if (clickTarget) {
          // Dispatch full mouse event sequence
          const eventInit = { bubbles: true, cancelable: true, clientX: x, clientY: y };
          clickTarget.dispatchEvent(new MouseEvent('mousedown', eventInit));
          clickTarget.dispatchEvent(new MouseEvent('mouseup', eventInit));
          clickTarget.dispatchEvent(new MouseEvent('click', eventInit));

          console.log('[Claude Proxy] Clicked at', x, y, clickTarget.tagName);
          return { success: true, mode: 'Deep Research', debug };
        }

        return { error: 'No element at coordinates', debug };
      },
      args: [msg.mode || 'Deep Research']
    }).then(results => {
      sendResponse(results[0]?.result || { error: 'Script failed' });
    }).catch(e => {
      sendResponse({ error: e.message });
    });
    return true;
  }
  return true;
});

// Enable side panel
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

// Start
console.log('[Claude Browser Proxy] v' + VERSION + ' Starting with MQTT.js...');
updateBadge(false); // Show red initially until connected
try {
  connect();
} catch (e) {
  console.error('[Claude Browser Proxy] Failed to start:', e);
}

// Publish current page info (retained) - only for Gemini
let lastPublishedUrl = '';
async function publishCurrentPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && (tab.url.includes('gemini.google.com') || tab.url.includes('chatgpt.com') || tab.url.includes('chat.openai.com')) && tab.url !== lastPublishedUrl) {
      lastPublishedUrl = tab.url;
      const pageInfo = {
        url: tab.url,
        title: tab.title,
        timestamp: Date.now()
      };
      publish(TOPICS.page, pageInfo, true);
      await broadcastLog('page', pageInfo);
    }
  } catch (e) {
    console.error('[Page] Error:', e);
  }
}

// Enable/disable sidebar based on URL
async function updateSidebarState() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const onAiSite2 = tab?.url?.includes('gemini.google.com') || tab?.url?.includes('chatgpt.com') || tab?.url?.includes('chat.openai.com');
    await chrome.sidePanel.setOptions({
      tabId: tab.id,
      path: 'sidepanel.html',
      enabled: onAiSite2
    });
  } catch (e) {}
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
