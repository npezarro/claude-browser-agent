# Claude Browser Agent

A generic remote browser control system that lets Claude CLI (or any CLI tool) send commands to a live browser via a Tampermonkey userscript and a lightweight Node.js relay server.

## Architecture

```
browser-cli.sh ──(HTTPS)──▶ agent-server.js (relay) ◀──(poll)── browser-agent.user.js (browser)
```

- **browser-agent.user.js** — Tampermonkey userscript, matches all pages, polls for commands every 3s
- **agent-server.js** — Node.js relay server, queues commands and collects results
- **browser-cli.sh** — Bash CLI wrapper with 30+ commands

## Quick Start

### 1. Server

```bash
cp .env.example .env
# Edit .env — set BROWSER_AGENT_KEY to a random secret
npm install
node agent-server.js
```

### 2. Browser

Install [Tampermonkey](https://www.tampermonkey.net/), then install `browser-agent.user.js`.

The userscript defaults to `http://localhost:3102`. To point it at a remote server, open your browser console on any page and run:

```js
GM_setValue("BROWSER_AGENT_API", "https://your-server.com/api/browser-agent")
```

### 3. CLI

```bash
export BROWSER_AGENT_KEY="your-secret-key"
export BROWSER_AGENT_URL="http://localhost:3102"  # or your remote server

# Check connection
./browser-cli.sh health
./browser-cli.sh tabs

# Control the browser
./browser-cli.sh navigate "https://example.com"
./browser-cli.sh click "Sign In"
./browser-cli.sh text
```

## Commands

| Command | Description |
|---------|-------------|
| `tabs` | List active browser tabs |
| `state [tabId]` | Full page state (buttons, inputs, text) |
| `text [tabId] [maxLen]` | Get body text |
| `click <"text"\|selector> [tabId]` | Click a button/link |
| `click-any <"text"> [tabId]` | Click any element with matching text |
| `navigate <url> [tabId]` | Navigate to URL |
| `open <url>` | Open URL in new tab |
| `close [tabId]` | Close tab |
| `ensure <url> [wait_s]` | Reuse or open tab (idempotent) |
| `eval <code> [tabId]` | Execute JS in page |
| `set-input <selector> <value>` | Set input value |
| `type <selector> <text>` | Type with keystrokes |
| `fill <json>` | Batch fill form fields |
| `upload <selector> <filepath>` | Upload local file to input |
| `wait-for <selector> [timeout]` | Wait for element |
| `wait-text <text> [timeout]` | Wait for text to appear |
| `wait-render [minLen] [timeout]` | Wait for SPA hydration |
| `assert-text <text>` | Assert text exists |
| `assert <selector>` | Assert element exists |
| `ping` | Ping browser agent |
| `health` | Server health check |

### Flags

- `--nth N` — Click the Nth match (for duplicate text buttons)
- `--drag-drop` — Use drag-and-drop upload mode

## How It Works

1. The **relay server** holds a command queue per browser tab
2. The **Tampermonkey userscript** polls the server every 3 seconds for pending commands
3. When the **CLI** sends a command via `/agent/interactive`, it blocks until the browser executes it and returns the result
4. Auth: CLI requests require a `Bearer` token; browser-to-server communication is unauthenticated (same-origin polling)

## Deployment

For remote deployment (behind a reverse proxy):

```bash
export VM_USER=youruser VM_HOST=yourserver.com VM_KEY=~/.ssh/your_key
bash deploy.sh
```

The deploy script copies files to the VM, installs deps, restarts PM2, and deploys the userscript to the web root.

## Cowork Session Capture

The server also hosts `/cowork/*` endpoints for capturing Claude web conversations via a companion Chrome extension. Sessions are persisted as JSON + markdown and optionally posted to Discord.

## Design Decisions

- **sessionStorage for tab IDs** — `GM_setValue` is shared across tabs; sessionStorage gives unique per-tab identity
- **Fire-and-forget navigation** — `navigate`/`back`/`reload` post results before executing (page unload kills the script)
- **iframe filter** — Skips iframes to avoid duplicate agent instances
- **Most-recent-tab default** — When no tabId specified, the server picks the tab with the latest heartbeat
- **Per-command timeout** — Each command has a 20s timeout to prevent hung commands from poisoning the queue

## License

MIT
