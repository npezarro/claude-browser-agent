#!/usr/bin/env bash
# browser-cli.sh — Synchronous CLI for controlling a remote browser via the browser-agent server.
#
# Usage:
#   browser-cli.sh <command> [args...]
#
# Commands:
#   tabs                          List active browser tabs
#   state [tabId]                 Get full page state (buttons, inputs, text)
#   text [tabId] [maxLen]         Get body text
#   html <selector> [tabId]       Get innerHTML of element
#   click <"text"|selector> [tabId]  Click a button/link
#   navigate <url> [tabId]        Navigate current tab to URL
#   open <url> [tabId]            Open URL in new tab
#   close [tabId]                 Close tab
#   ensure <url> [wait_s]         Reuse or open tab for URL, return tabId
#   back [tabId]                  Go back
#   reload [tabId]                Reload page
#   eval <code> [tabId]           Execute JS in page context
#   query <selector> [tabId]      querySelector
#   queryall <selector> [tabId]   querySelectorAll
#   read <selector> [tabId]       Read element text
#   set-input <selector> <value> [tabId]  Set input value
#   type <selector> <text> [tabId]  Type text with keystrokes
#   fill <json> [tabId]           Fill form: {"#id": "value", ...}
#   select <selector> <value> [tabId]  Select dropdown option
#   wait <ms> [tabId]             Wait N milliseconds
#   wait-for <selector> [timeout] [tabId]  Wait for element
#   wait-text <text> [timeout] [tabId]  Wait for text to appear
#   assert-text <text> [tabId]    Assert text exists on page
#   assert-no-text <text> [tabId] Assert text does NOT exist
#   assert <selector> [tabId]     Assert element exists
#   assert-not <selector> [tabId] Assert element does NOT exist
#   console [count] [tabId]       Get console logs
#   errors [tabId]                Get network/console errors
#   logs [since]                  Get agent logs
#   health                        Server health check
#   click-any <"text"> [tabId]       Click any element with matching text (wider than click)
#   upload <selector> <filepath> [tabId] [--drag-drop]  Upload file to input
#   ping [tabId]                  Ping browser agent
#   wait-render [minLen] [timeout] [tabId]  Wait for SPA body to hydrate
#
# Flags (append to click/click-any):
#   --nth N                       Click the Nth match (default: 1st)
#
# Cowork commands:
#   cowork-status                 Check if Cowork panel is active
#   cowork-sessions [--today]     List captured Cowork sessions
#   cowork-read <session-id>      Read a specific session's content
#   cowork-start "goal" [--instructions file.md]  Queue a new Cowork session
#
# Environment:
#   BROWSER_AGENT_URL   Server URL (default: http://localhost:3102)
#   BROWSER_AGENT_KEY   Auth key (required)
#   BROWSER_AGENT_TAB   Default tab ID (auto-detected if omitted)

set -euo pipefail

API="${BROWSER_AGENT_URL:-http://localhost:3102}"
KEY="${BROWSER_AGENT_KEY:?BROWSER_AGENT_KEY not set — add to ~/.bashrc or export it}"
DEFAULT_TAB="${BROWSER_AGENT_TAB:-}"
TIMEOUT=30

# ── Helpers ──

auth_header="Authorization: Bearer $KEY"

# Synchronous command: POST to /agent/interactive, block for result
interactive() {
  local tab_id="${1:-}"
  local command_json="$2"
  local timeout="${3:-$TIMEOUT}"

  local body
  if [ -n "$tab_id" ]; then
    body=$(jq -nc --arg tid "$tab_id" --argjson cmd "$command_json" --argjson to "$((timeout * 1000))" \
      '{tabId: $tid, command: $cmd, timeout: $to}')
  else
    body=$(jq -nc --argjson cmd "$command_json" --argjson to "$((timeout * 1000))" \
      '{command: $cmd, timeout: $to}')
  fi

  local resp
  resp=$(curl -s -m "$((timeout + 5))" -X POST "$API/agent/interactive" \
    -H "Content-Type: application/json" \
    -H "$auth_header" \
    -d "$body")

  local ok
  ok=$(echo "$resp" | jq -r '.ok // false')
  if [ "$ok" = "true" ]; then
    echo "$resp" | jq -r '.result'
  else
    local err
    err=$(echo "$resp" | jq -r '.error // "Unknown error"')
    echo "ERROR: $err" >&2
    echo "$resp" | jq '.' 2>/dev/null || echo "$resp"
    return 1
  fi
}

# ── Commands ──

cmd="${1:-help}"
shift || true

case "$cmd" in

  tabs)
    curl -s "$API/agent/tabs" -H "$auth_header" | jq '{count, tabs: [.tabs | to_entries[] | {id: .key, url: .value.url, title: .value.title, age: (now - .value.receivedAt/1000 | floor | tostring + "s")}]}'
    ;;

  state)
    interactive "${1:-$DEFAULT_TAB}" '{"action":"getState"}'
    ;;

  text)
    local_tab="${1:-$DEFAULT_TAB}"
    local_max="${2:-5000}"
    interactive "$local_tab" "$(jq -nc --argjson m "$local_max" '{action:"getBodyText", maxLen:$m}')"
    ;;

  html)
    interactive "${2:-$DEFAULT_TAB}" "$(jq -nc --arg s "${1:?selector required}" '{action:"getHtml", selector:$s}')"
    ;;

  click)
    local_target="${1:?text or selector required}"
    shift
    local_tab="$DEFAULT_TAB"
    local_nth=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --nth) local_nth="${2:?--nth requires a number}"; shift 2 ;;
        *) if [ -z "$local_tab" ] || [ "$local_tab" = "$DEFAULT_TAB" ]; then local_tab="$1"; fi; shift ;;
      esac
    done
    if [[ "$local_target" =~ ^[.#\[] ]]; then
      if [ -n "$local_nth" ]; then
        interactive "$local_tab" "$(jq -nc --arg s "$local_target" --argjson n "$local_nth" '{action:"click", selector:$s, nth:$n}')"
      else
        interactive "$local_tab" "$(jq -nc --arg s "$local_target" '{action:"click", selector:$s}')"
      fi
    else
      if [ -n "$local_nth" ]; then
        interactive "$local_tab" "$(jq -nc --arg t "$local_target" --argjson n "$local_nth" '{action:"click", text:$t, nth:$n}')"
      else
        interactive "$local_tab" "$(jq -nc --arg t "$local_target" '{action:"click", text:$t}')"
      fi
    fi
    ;;

  navigate|nav|goto)
    interactive "${2:-$DEFAULT_TAB}" "$(jq -nc --arg u "${1:?url required}" '{action:"navigate", url:$u}')"
    ;;

  open|open-tab)
    interactive "${2:-$DEFAULT_TAB}" "$(jq -nc --arg u "${1:?url required}" '{action:"openTab", url:$u}')"
    ;;

  close|close-tab)
    interactive "${1:-$DEFAULT_TAB}" '{"action":"closeTab"}'
    ;;

  ensure)
    local_url="${1:?url required}"
    local_wait="${2:-6}"
    existing=$(curl -s "$API/agent/tabs" -H "$auth_header" | jq -r --arg u "$local_url" \
      '[.tabs | to_entries[] | select(.value.url | startswith($u)) | .key] | first // empty')
    if [ -n "$existing" ]; then
      echo "{\"tabId\":\"$existing\",\"action\":\"reused\",\"url\":\"$local_url\"}"
    else
      interactive "" "$(jq -nc --arg u "$local_url" '{action:"openTab", url:$u}')" > /dev/null 2>&1
      for i in $(seq 1 "$local_wait"); do
        sleep 1
        found=$(curl -s "$API/agent/tabs" -H "$auth_header" | jq -r --arg u "$local_url" \
          '[.tabs | to_entries[] | select(.value.url | startswith($u)) | .key] | first // empty')
        if [ -n "$found" ]; then
          echo "{\"tabId\":\"$found\",\"action\":\"opened\",\"url\":\"$local_url\"}"
          exit 0
        fi
      done
      echo "{\"tabId\":null,\"action\":\"timeout\",\"url\":\"$local_url\"}" >&2
      exit 1
    fi
    ;;

  back)
    interactive "${1:-$DEFAULT_TAB}" '{"action":"back"}'
    ;;

  reload)
    interactive "${1:-$DEFAULT_TAB}" '{"action":"reload"}'
    ;;

  eval|js)
    interactive "${2:-$DEFAULT_TAB}" "$(jq -nc --arg c "${1:?code required}" '{action:"eval", code:$c}')"
    ;;

  query|qs)
    interactive "${2:-$DEFAULT_TAB}" "$(jq -nc --arg s "${1:?selector required}" '{action:"querySelector", selector:$s}')"
    ;;

  queryall|qsa)
    interactive "${2:-$DEFAULT_TAB}" "$(jq -nc --arg s "${1:?selector required}" '{action:"querySelectorAll", selector:$s}')"
    ;;

  read)
    interactive "${2:-$DEFAULT_TAB}" "$(jq -nc --arg s "${1:?selector required}" '{action:"read", selector:$s}')"
    ;;

  set-input|input)
    interactive "${3:-$DEFAULT_TAB}" "$(jq -nc --arg s "${1:?selector required}" --arg v "${2:?value required}" '{action:"setInput", selector:$s, value:$v}')"
    ;;

  type)
    interactive "${3:-$DEFAULT_TAB}" "$(jq -nc --arg s "${1:?selector required}" --arg t "${2:?text required}" '{action:"type", selector:$s, text:$t}')"
    ;;

  fill)
    interactive "${2:-$DEFAULT_TAB}" "$(jq -nc --argjson f "${1:?json required}" '{action:"fillForm", fields:$f}')"
    ;;

  select)
    interactive "${3:-$DEFAULT_TAB}" "$(jq -nc --arg s "${1:?selector required}" --arg v "${2:?value required}" '{action:"selectOption", selector:$s, value:$v}')"
    ;;

  wait)
    interactive "${2:-$DEFAULT_TAB}" "$(jq -nc --argjson ms "${1:-1000}" '{action:"wait", ms:$ms}')"
    ;;

  wait-for|wf)
    local_timeout="${2:-10000}"
    interactive "${3:-$DEFAULT_TAB}" "$(jq -nc --arg s "${1:?selector required}" --argjson t "$local_timeout" '{action:"waitForSelector", selector:$s, timeout:$t}')" "$(( (local_timeout / 1000) + 5 ))"
    ;;

  wait-text|wt)
    local_timeout2="${2:-10000}"
    interactive "${3:-$DEFAULT_TAB}" "$(jq -nc --arg t "${1:?text required}" --argjson to "$local_timeout2" '{action:"waitForText", text:$t, timeout:$to}')" "$(( (local_timeout2 / 1000) + 5 ))"
    ;;

  assert-text|at)
    interactive "${2:-$DEFAULT_TAB}" "$(jq -nc --arg t "${1:?text required}" '{action:"assertText", text:$t}')"
    ;;

  assert-no-text|ant)
    interactive "${2:-$DEFAULT_TAB}" "$(jq -nc --arg t "${1:?text required}" '{action:"assertText", text:$t, negate:true}')"
    ;;

  assert)
    interactive "${2:-$DEFAULT_TAB}" "$(jq -nc --arg s "${1:?selector required}" '{action:"assertSelector", selector:$s}')"
    ;;

  assert-not)
    interactive "${2:-$DEFAULT_TAB}" "$(jq -nc --arg s "${1:?selector required}" '{action:"assertSelector", selector:$s, negate:true}')"
    ;;

  console)
    interactive "${2:-$DEFAULT_TAB}" "$(jq -nc --argjson n "${1:-50}" '{action:"getConsoleLog", count:$n}')"
    ;;

  errors)
    interactive "${1:-$DEFAULT_TAB}" '{"action":"getNetworkErrors"}'
    ;;

  logs)
    curl -s "$API/agent/logs?since=${1:-0}" -H "$auth_header" | jq '.'
    ;;

  health|h)
    curl -s "$API/health" | jq '.'
    ;;

  click-any|ca)
    local_text="${1:?text required}"
    shift
    local_tab="$DEFAULT_TAB"
    local_nth=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --nth) local_nth="${2:?--nth requires a number}"; shift 2 ;;
        *) if [ -z "$local_tab" ] || [ "$local_tab" = "$DEFAULT_TAB" ]; then local_tab="$1"; fi; shift ;;
      esac
    done
    if [ -n "$local_nth" ]; then
      interactive "$local_tab" "$(jq -nc --arg t "$local_text" --argjson n "$local_nth" '{action:"clickAny", text:$t, nth:$n}')"
    else
      interactive "$local_tab" "$(jq -nc --arg t "$local_text" '{action:"clickAny", text:$t}')"
    fi
    ;;

  upload)
    local_selector="${1:?selector required}"
    local_filepath="${2:?filepath required}"
    local_tab="${3:-$DEFAULT_TAB}"
    local_dragdrop=false
    for arg in "$@"; do
      if [ "$arg" = "--drag-drop" ]; then local_dragdrop=true; fi
    done

    if [ ! -f "$local_filepath" ]; then
      echo "ERROR: File not found: $local_filepath" >&2
      exit 1
    fi

    local_filename=$(basename "$local_filepath")
    local_mimetype=$(file -b --mime-type "$local_filepath" 2>/dev/null || echo "application/octet-stream")
    local_blobid="blob-$(date +%s)-$(head -c 4 /dev/urandom | xxd -p)"

    local_tmpfile=$(mktemp /tmp/browser-upload-XXXXXX.json)
    trap "rm -f '$local_tmpfile'" EXIT
    python3 -c "
import base64, json, sys
with open(sys.argv[1], 'rb') as f:
    b64 = base64.b64encode(f.read()).decode()
json.dump({'blobId': sys.argv[2], 'base64': b64, 'filename': sys.argv[3], 'mimetype': sys.argv[4]}, open(sys.argv[5], 'w'))
" "$local_filepath" "$local_blobid" "$local_filename" "$local_mimetype" "$local_tmpfile"

    local_upload_resp=$(curl -s -m 60 -X POST "$API/agent/upload-blob" \
      -H "Content-Type: application/json" \
      -H "$auth_header" \
      -d @"$local_tmpfile")
    rm -f "$local_tmpfile"

    local_upload_ok=$(echo "$local_upload_resp" | jq -r '.ok // false')
    if [ "$local_upload_ok" != "true" ]; then
      echo "ERROR: Failed to upload blob: $(echo "$local_upload_resp" | jq -r '.error // "unknown"')" >&2
      exit 1
    fi

    interactive "$local_tab" "$(jq -nc \
      --arg s "$local_selector" \
      --arg bid "$local_blobid" \
      --argjson dd "$local_dragdrop" \
      '{action:"uploadFile", selector:$s, blobId:$bid, dragDrop:$dd}')" 45
    ;;

  wait-render|wr)
    local_minlen="${1:-50}"
    local_timeout="${2:-15000}"
    local_tab="${3:-$DEFAULT_TAB}"
    interactive "$local_tab" "$(jq -nc --argjson m "$local_minlen" --argjson t "$local_timeout" '{action:"waitForRender", minLength:$m, timeout:$t}')" "$(( (local_timeout / 1000) + 5 ))"
    ;;

  ping)
    interactive "${1:-$DEFAULT_TAB}" '{"action":"ping"}'
    ;;

  # ── Cowork commands ──

  cowork-status|cws)
    curl -s "$API/cowork/status" -H "$auth_header" | jq '.'
    ;;

  cowork-sessions|cwl)
    local_date=""
    if [[ "${1:-}" == "--today" ]]; then
      local_date=$(date +%Y-%m-%d)
    elif [[ -n "${1:-}" ]]; then
      local_date="$1"
    fi
    if [ -n "$local_date" ]; then
      curl -s "$API/cowork/sessions?date=$local_date" -H "$auth_header" | jq '.sessions[] | {id, slug, goal, status, turnCount, startedAt}'
    else
      curl -s "$API/cowork/sessions" -H "$auth_header" | jq '.sessions[] | {id, slug, goal, status, turnCount, startedAt}'
    fi
    ;;

  cowork-read|cwr)
    local_sid="${1:?session-id required}"
    curl -s "$API/cowork/session/$local_sid" -H "$auth_header" | jq '.'
    ;;

  cowork-start|cwstart)
    local_goal="${1:?goal required}"
    local_instructions=""
    if [[ "${2:-}" == "--instructions" ]]; then
      local_file="${3:?instructions file required}"
      if [ ! -f "$local_file" ]; then
        echo "ERROR: File not found: $local_file" >&2
        exit 1
      fi
      local_instructions=$(cat "$local_file")
    fi
    curl -s -X POST "$API/cowork/start" \
      -H "Content-Type: application/json" \
      -H "$auth_header" \
      -d "$(jq -nc --arg g "$local_goal" --arg i "$local_instructions" '{goal: $g, instructions: $i}')" | jq '.'
    ;;

  help|--help|-h)
    head -55 "$0" | tail -53
    ;;

  *)
    echo "Unknown command: $cmd. Run '$0 help' for usage." >&2
    exit 1
    ;;
esac
