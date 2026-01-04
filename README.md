# Claude Browser Proxy

Chrome extension that bridges Claude Code and your browser via MQTT.

```
Claude Code ←→ MQTT (Mosquitto) ←→ Browser Extension
```

## Features

- **Get page content**: HTML, text, links, images, videos
- **Execute actions**: Click, type, scroll
- **Download files**: Direct URL downloads
- **Screenshots**: Capture visible tab
- **Execute JS**: Run arbitrary JavaScript

## Requirements

- Mosquitto MQTT broker with WebSocket enabled
- Chrome browser

## Setup

### 1. Configure Mosquitto

Add to `/opt/homebrew/etc/mosquitto/mosquitto.conf`:

```conf
allow_anonymous true
listener 1883 localhost
listener 9001
protocol websockets
```

Restart: `brew services restart mosquitto`

### 2. Install Extension

1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select this folder

### 3. Test

Monitor MQTT:
```bash
mosquitto_sub -t "claude/browser/#" -v
```

Send command:
```bash
mosquitto_pub -t "claude/browser/command" -m '{"action":"get_url"}'
```

## Commands

| Action | Description | Params |
|--------|-------------|--------|
| `get_html` | Full page HTML | - |
| `get_text` | Page text content | - |
| `get_url` | Current URL | - |
| `get_title` | Page title | - |
| `get_selection` | Selected text | - |
| `get_links` | All links on page | - |
| `get_images` | All images | - |
| `get_videos` | Video sources | - |
| `click` | Click element | `selector` |
| `type` | Type text | `selector`, `text` |
| `scroll` | Scroll page | `direction` |
| `screenshot` | Capture tab | - |
| `download` | Download file | `url`, `filename` |
| `execute` | Run JavaScript | `code` |

## MQTT Topics

| Topic | Direction | Purpose |
|-------|-----------|---------|
| `claude/browser/command` | Claude → Browser | Send commands |
| `claude/browser/response` | Browser → Claude | Receive results |

## Example: Download Facebook Video

```bash
# 1. Get video sources from current page
mosquitto_pub -t "claude/browser/command" -m '{"action":"get_videos"}'

# 2. Read response
mosquitto_sub -t "claude/browser/response" -C 1

# 3. Download the video
mosquitto_pub -t "claude/browser/command" -m '{"action":"download","url":"https://..."}'
```

## License

MIT
