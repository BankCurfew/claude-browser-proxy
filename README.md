# Claude Browser Proxy

> Chrome extension that bridges Claude Code CLI and your browser via MQTT

Chrome extension ที่เชื่อมต่อ Claude Code CLI กับ browser ผ่าน MQTT

```
Claude Code CLI  <-->  MQTT Broker (Mosquitto)  <-->  Chrome Extension  <-->  Browser
```

## What is this? | นี่คืออะไร?

**Claude Browser Proxy** lets Claude Code (the CLI) control your browser through MQTT messages. This enables powerful automation workflows:

- Scrape web pages and extract content
- Interact with Gemini AI through your existing session
- Control browser tabs programmatically
- Capture screenshots
- Execute JavaScript in page context

**Claude Browser Proxy** ช่วยให้ Claude Code (CLI) ควบคุม browser ผ่าน MQTT ทำให้สามารถ:

- ดึงเนื้อหาจากหน้าเว็บ
- ใช้งาน Gemini AI ผ่าน session ที่ login อยู่แล้ว
- ควบคุม tab ต่างๆ ใน browser
- ถ่ายภาพหน้าจอ
- รัน JavaScript ในหน้าเว็บ

## Features | ความสามารถ

### Page Content | ดึงเนื้อหา
- `get_html` - Full page HTML
- `get_text` - Page text content
- `get_url` - Current URL and title
- `get_videos` - Video sources on page
- `get_response` - Get Gemini's latest response

### DOM Interaction | ควบคุม DOM
- `click` - Click element by CSS selector
- `clickText` - Click element by text content
- `type` - Type text into input fields
- `find` - Find elements by selector
- `key` - Send keyboard events

### Tab Management | จัดการ Tab
- `create_tab` - Create new browser tab
- `list_tabs` - List all Gemini tabs
- `focus_tab` - Focus specific tab
- `new_tab` - Create Gemini tab

### Gemini AI Integration | ใช้งาน Gemini
- `chat` - Send message to Gemini
- `select_model` - Switch Gemini model (Fast/Thinking/Pro)
- `select_mode` - Switch to Deep Research mode
- `wait_response` - Wait for Gemini response
- `transcribe` - Transcribe YouTube video via Gemini

### Utilities | เครื่องมือเสริม
- `screenshot` - Capture visible tab
- `download` - Download file from URL
- `execute` - Run arbitrary JavaScript
- `get_state` - Check if Gemini is loading/responding

## Installation | การติดตั้ง

### 1. Install Mosquitto MQTT Broker

**macOS:**
```bash
brew install mosquitto
```

**Ubuntu/Debian:**
```bash
sudo apt install mosquitto mosquitto-clients
```

### 2. Configure Mosquitto for WebSocket

Edit the config file:

**macOS:** `/opt/homebrew/etc/mosquitto/mosquitto.conf`
**Linux:** `/etc/mosquitto/mosquitto.conf`

Add these lines:
```conf
allow_anonymous true
listener 1883 localhost
listener 9001
protocol websockets
```

Restart Mosquitto:
```bash
# macOS
brew services restart mosquitto

# Linux
sudo systemctl restart mosquitto
```

### 3. Install Chrome Extension

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top-right)
4. Click **Load unpacked**
5. Select the `claude-browser-proxy` folder

The extension icon should appear with a version badge.

## Usage | การใช้งาน

### Monitor MQTT Traffic

```bash
# Watch all browser messages
mosquitto_sub -t "claude/browser/#" -v
```

### Send Commands

Commands are JSON objects sent to `claude/browser/command`:

```bash
# Get current page URL
mosquitto_pub -t "claude/browser/command" -m '{"action":"get_url"}'

# Click a button
mosquitto_pub -t "claude/browser/command" -m '{"action":"click","selector":"button.submit"}'

# Type in an input field
mosquitto_pub -t "claude/browser/command" -m '{"action":"type","text":"Hello world"}'

# Send message to Gemini
mosquitto_pub -t "claude/browser/command" -m '{"action":"chat","text":"What is 2+2?"}'

# Switch Gemini model
mosquitto_pub -t "claude/browser/command" -m '{"action":"select_model","model":"pro"}'

# Take screenshot
mosquitto_pub -t "claude/browser/command" -m '{"action":"screenshot"}'
```

### CLI Helper Script

A convenience script is included:

```bash
# Make executable
chmod +x claude-browser.sh

# Get page URL
./claude-browser.sh get_url

# Send to Gemini
./claude-browser.sh chat "Explain quantum computing"

# Get Gemini response
./claude-browser.sh get_response
```

## MQTT Topics | หัวข้อ MQTT

| Topic | Direction | Purpose |
|-------|-----------|---------|
| `claude/browser/command` | CLI -> Browser | Send commands |
| `claude/browser/response` | Browser -> CLI | Command results |
| `claude/browser/status` | Browser -> CLI | Online/offline status |
| `claude/browser/answer` | Browser -> CLI | Gemini responses |
| `claude/browser/state` | Browser -> CLI | Loading/tool state |

## Commands Reference | รายการคำสั่งทั้งหมด

### Page Content

| Action | Description | Parameters |
|--------|-------------|------------|
| `get_html` | Full page HTML (max 50KB) | - |
| `get_text` | Page text content | - |
| `get_url` | Current URL and title | - |
| `get_videos` | Video sources | - |
| `get_response` | Latest Gemini response | - |
| `get_state` | Gemini loading state | - |

### DOM Interaction

| Action | Description | Parameters |
|--------|-------------|------------|
| `click` | Click element | `selector` |
| `clickText` | Click by text | `text`, `exact` (optional) |
| `type` | Type text | `text`, `selector` (optional) |
| `find` | Find elements | `selector` |
| `key` | Send key event | `key` |

### Tab Management

| Action | Description | Parameters |
|--------|-------------|------------|
| `create_tab` | Create new tab | `url` (optional), `active` (optional) |
| `list_tabs` | List Gemini tabs | - |
| `focus_tab` | Focus tab | `tabId` |
| `new_tab` | Create Gemini tab | `url` (optional) |

### Gemini AI

| Action | Description | Parameters |
|--------|-------------|------------|
| `chat` | Send to Gemini | `text` |
| `select_model` | Switch model | `model` (fast/thinking/pro) |
| `select_mode` | Switch mode | `mode` (Deep Research) |
| `wait_response` | Wait for response | `timeout` (ms, default 15000) |
| `transcribe` | Transcribe YouTube | `url`, `prompt` (optional) |

### Utilities

| Action | Description | Parameters |
|--------|-------------|------------|
| `screenshot` | Capture tab | - |
| `download` | Download file | `url`, `filename` (optional) |
| `execute` | Run JavaScript | `code` |

### Tab Targeting

Most commands default to the active Gemini tab. Use `tabId` to target a specific tab:

```bash
mosquitto_pub -t "claude/browser/command" -m '{"action":"chat","text":"Hello","tabId":123456789}'
```

## Examples | ตัวอย่างการใช้งาน

### Ask Gemini and Get Response

```bash
# Send question
mosquitto_pub -t "claude/browser/command" -m '{"action":"chat","text":"What is machine learning?"}'

# Wait for response (15 second timeout)
mosquitto_pub -t "claude/browser/command" -m '{"action":"wait_response","timeout":15000}'

# Or get immediately
mosquitto_pub -t "claude/browser/command" -m '{"action":"get_response"}'
```

### YouTube Transcription

```bash
# One command: opens Gemini tab + sends transcribe request
mosquitto_pub -t "claude/browser/command" -m '{"action":"transcribe","url":"https://youtube.com/watch?v=xxx"}'
```

### Multi-Tab Workflow

```bash
# Create new Gemini tab
mosquitto_pub -t "claude/browser/command" -m '{"action":"create_tab"}'
# Response: {"tabId": 123, "success": true}

# Use specific tab
mosquitto_pub -t "claude/browser/command" -m '{"action":"chat","text":"Research topic A","tabId":123}'

# Create another tab
mosquitto_pub -t "claude/browser/command" -m '{"action":"create_tab"}'
# Response: {"tabId": 456, "success": true}

# Use second tab
mosquitto_pub -t "claude/browser/command" -m '{"action":"chat","text":"Research topic B","tabId":456}'

# List all tabs
mosquitto_pub -t "claude/browser/command" -m '{"action":"list_tabs"}'
```

### Deep Research Mode

```bash
# Switch to Deep Research
mosquitto_pub -t "claude/browser/command" -m '{"action":"select_mode","mode":"Deep Research"}'

# Send research query
mosquitto_pub -t "claude/browser/command" -m '{"action":"chat","text":"Compare React vs Vue in 2025"}'
```

## Extension UI | หน้าต่าง Extension

The extension includes:

- **Badge**: Shows version number, green when connected to MQTT + on Gemini
- **Side Panel**: Debug view showing commands, responses, and connection status
- **Injected UI**: Model switcher buttons and tab ID badges on Gemini pages

## Troubleshooting | แก้ปัญหา

### Extension badge is red

MQTT broker not running or not configured for WebSocket.

1. Check Mosquitto is running: `brew services list` or `systemctl status mosquitto`
2. Verify WebSocket config has `listener 9001` and `protocol websockets`
3. Restart Mosquitto after config changes

### Commands not working

1. Open Chrome DevTools on extension service worker (chrome://extensions/ -> Inspect)
2. Check console for MQTT connection status
3. Verify you're on a Gemini tab for Gemini-specific commands

### "Tab is not Gemini" error

The command requires a Gemini tab. Either:
- Open https://gemini.google.com/app
- Use `create_tab` to open a new Gemini tab
- Specify `tabId` of an existing Gemini tab

### Gemini selectors not working

Gemini's UI may change. The extension uses multiple fallback selectors, but if issues persist:
1. Check Chrome DevTools console on the Gemini page
2. Report issues with the specific action that fails

## Architecture | สถาปัตยกรรม

```
┌─────────────┐     MQTT (1883)     ┌─────────────────┐
│ Claude Code │ <-----------------> │   Mosquitto     │
│    CLI      │   (mosquitto_pub)   │  MQTT Broker    │
└─────────────┘                     └────────┬────────┘
                                             │
                                    WebSocket (9001)
                                             │
                                    ┌────────▼────────┐
                                    │ Chrome Extension│
                                    │  (background.js)│
                                    └────────┬────────┘
                                             │
                                    Chrome APIs
                                             │
                                    ┌────────▼────────┐
                                    │   Browser Tabs  │
                                    │  (content.js)   │
                                    └─────────────────┘
```

## Contributing | ร่วมพัฒนา

Issues and PRs welcome! Please:

1. Check existing issues first
2. Provide clear reproduction steps for bugs
3. Test changes across different Gemini pages

## License | สัญญาอนุญาต

MIT License - see [LICENSE](LICENSE)

---

Made with care by [Soul Brews Studio](https://github.com/Soul-Brews-Studio)
