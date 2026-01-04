#!/bin/bash
# Claude Browser Proxy - CLI Helper
# Usage: ./claude-browser.sh <command> [args]

COMMAND_TOPIC="claude/browser/command"
RESPONSE_TOPIC="claude/browser/response"

send_command() {
  local cmd="$1"
  mosquitto_pub -h localhost -t "$COMMAND_TOPIC" -m "$cmd"
}

wait_response() {
  mosquitto_sub -h localhost -t "$RESPONSE_TOPIC" -C 1 2>/dev/null
}

case "$1" in
  url)
    send_command '{"action":"get_url"}'
    wait_response
    ;;
  title)
    send_command '{"action":"get_title"}'
    wait_response
    ;;
  html)
    send_command '{"action":"get_html"}'
    wait_response
    ;;
  text)
    send_command '{"action":"get_text"}'
    wait_response
    ;;
  selection)
    send_command '{"action":"get_selection"}'
    wait_response
    ;;
  links)
    send_command '{"action":"get_links"}'
    wait_response
    ;;
  images)
    send_command '{"action":"get_images"}'
    wait_response
    ;;
  videos)
    send_command '{"action":"get_videos"}'
    wait_response
    ;;
  screenshot)
    send_command '{"action":"screenshot"}'
    wait_response
    ;;
  click)
    send_command "{\"action\":\"click\",\"selector\":\"$2\"}"
    wait_response
    ;;
  type)
    send_command "{\"action\":\"type\",\"selector\":\"$2\",\"text\":\"$3\"}"
    wait_response
    ;;
  scroll)
    send_command "{\"action\":\"scroll\",\"direction\":\"${2:-down}\"}"
    wait_response
    ;;
  download)
    send_command "{\"action\":\"download\",\"url\":\"$2\",\"filename\":\"$3\"}"
    wait_response
    ;;
  exec)
    send_command "{\"action\":\"execute\",\"code\":\"$2\"}"
    wait_response
    ;;
  monitor)
    echo "Monitoring MQTT topics..."
    mosquitto_sub -h localhost -t "claude/browser/#" -v
    ;;
  *)
    echo "Claude Browser Proxy CLI"
    echo ""
    echo "Usage: $0 <command> [args]"
    echo ""
    echo "Commands:"
    echo "  url         - Get current URL"
    echo "  title       - Get page title"
    echo "  html        - Get page HTML"
    echo "  text        - Get page text"
    echo "  selection   - Get selected text"
    echo "  links       - Get all links"
    echo "  images      - Get all images"
    echo "  videos      - Get video sources"
    echo "  screenshot  - Capture screenshot"
    echo "  click <sel> - Click element"
    echo "  type <sel> <text> - Type text"
    echo "  scroll [dir] - Scroll (up/down/top/bottom)"
    echo "  download <url> [filename] - Download file"
    echo "  exec <code> - Execute JavaScript"
    echo "  monitor     - Watch all MQTT traffic"
    ;;
esac
