/**
 * Browser Agent Relay Server
 *
 * Generic command relay between Claude CLI and a Tampermonkey userscript
 * running in the user's real browser. No application-specific logic —
 * just queue commands, collect results, track tabs.
 *
 * PM2: pm2 start agent-server.js --name browser-agent
 * Port: 3102 (behind reverse proxy at /api/browser-agent/)
 */
require("dotenv").config();
const http = require("http");

const PORT = process.env.BROWSER_AGENT_PORT || 3102;
const API_KEY = process.env.BROWSER_AGENT_KEY;
if (!API_KEY) {
  console.error("[Browser Agent] BROWSER_AGENT_KEY not set in environment. Exiting.");
  process.exit(1);
}

const fs = require("fs");
const path = require("path");

// ── State ──

const agentCommands = {};    // tabId -> [commands]
const agentResults = [];     // circular buffer of results
const MAX_RESULTS = 1000;
const agentTabs = {};        // tabId -> last heartbeat state
const TAB_TTL = 120_000;     // 2 min
const remoteLogs = [];
const MAX_LOGS = 500;
let cmdIdCounter = 0;

// Waiters for synchronous /interactive endpoint
const resultWaiters = {};    // cmdId -> { resolve, timer }

// ── Upload Blob Store ──
const uploadBlobs = {};      // blobId -> { base64, filename, mimetype, ts }
const BLOB_TTL = 300_000;    // 5 min

function pruneBlobs() {
  const now = Date.now();
  for (const [id, b] of Object.entries(uploadBlobs)) {
    if (now - b.ts > BLOB_TTL) delete uploadBlobs[id];
  }
}
setInterval(pruneBlobs, 60_000);

// ── Periodic cleanup for leaked state ──

const WAITER_TTL = 600_000;     // 10 min — max time a resultWaiter can live
const CMD_QUEUE_TTL = 120_000;  // 2 min — prune commands for dead tabs

function pruneResultWaiters() {
  const now = Date.now();
  for (const [id, w] of Object.entries(resultWaiters)) {
    if (w.createdAt && now - w.createdAt > WAITER_TTL) {
      clearTimeout(w.timer);
      delete resultWaiters[id];
      console.log(`[Cleanup] Expired stale resultWaiter: ${id}`);
    }
  }
}

function pruneCommandQueues() {
  pruneTabs();
  const liveTabIds = new Set(Object.keys(agentTabs));
  liveTabIds.add("all");
  for (const tabId of Object.keys(agentCommands)) {
    if (!liveTabIds.has(tabId) && agentCommands[tabId].length > 0) {
      console.log(`[Cleanup] Dropped ${agentCommands[tabId].length} orphaned commands for dead tab ${tabId.substring(0, 8)}`);
      delete agentCommands[tabId];
    }
  }
}

// Run cleanup every 30 seconds
setInterval(() => {
  pruneTabs();
  pruneResultWaiters();
  pruneCommandQueues();
}, 30_000);

// ── Cowork State ──

const COWORK_DIR = process.env.COWORK_SESSION_DIR || path.join(process.cwd(), "cowork-sessions");
const COWORK_REPO = process.env.COWORK_REPO_DIR || "";
const COWORK_WEBHOOK = process.env.DISCORD_COWORK_WEBHOOK_URL || "";
const coworkSessions = {};   // sessionId -> { slug, goal, startedAt, status, turns, lastHeartbeat, capturedAt }
let coworkPending = null;    // CLI-queued session start request
const { execFile } = require("child_process");

// ── Helpers ──

function parseUrl(req) {
  try { return new URL(req.url, `http://${req.headers.host || "localhost"}`); }
  catch { return null; }
}

function checkAuth(req) {
  const auth = req.headers.authorization || "";
  return auth === `Bearer ${API_KEY}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 2e6) { req.destroy(); reject(new Error("too large")); }
    });
    req.on("end", () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(e); }
    });
  });
}

function readBodyLarge(req, maxBytes = 10e6) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > maxBytes) { req.destroy(); reject(new Error("too large")); }
    });
    req.on("end", () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(e); }
    });
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(JSON.stringify(data));
}

function pruneTabs() {
  const now = Date.now();
  for (const [id, s] of Object.entries(agentTabs)) {
    if (now - s.receivedAt > TAB_TTL) delete agentTabs[id];
  }
}

function pushResult(result) {
  result.ts = Date.now();
  agentResults.push(result);
  if (agentResults.length > MAX_RESULTS) agentResults.shift();

  // Wake any synchronous waiter
  const waiter = resultWaiters[result.id];
  if (waiter) {
    clearTimeout(waiter.timer);
    delete resultWaiters[result.id];
    waiter.resolve(result);
  }
}

// ── Cowork Persistence ──

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

function persistCoworkSession(sessionId) {
  const session = coworkSessions[sessionId];
  if (!session) return;

  const date = (session.startedAt || new Date().toISOString()).slice(0, 10);
  const dir = path.join(COWORK_DIR, date);
  ensureDir(dir);

  const filePath = path.join(dir, `${session.slug || sessionId}.json`);
  try {
    fs.writeFileSync(filePath, JSON.stringify({ id: sessionId, ...session }, null, 2));
  } catch (err) {
    console.error(`[Cowork] Failed to persist JSON: ${err.message}`);
  }
}

function persistCoworkMarkdown(sessionId) {
  const session = coworkSessions[sessionId];
  if (!session || !session.turns?.length) return;

  const date = (session.startedAt || new Date().toISOString()).slice(0, 10);
  const dir = path.join(COWORK_DIR, date);
  ensureDir(dir);

  const md = snapshotToMarkdown(sessionId, session);
  const filePath = path.join(dir, `${session.slug || sessionId}.md`);
  try {
    fs.writeFileSync(filePath, md);
    console.log(`[Cowork] Wrote markdown: ${filePath}`);
  } catch (err) {
    console.error(`[Cowork] Failed to persist markdown: ${err.message}`);
  }
}

function snapshotToMarkdown(sessionId, session) {
  const started = session.startedAt
    ? new Date(session.startedAt).toISOString().replace("T", " ").slice(0, 16)
    : "unknown";

  let md = `# Session: ${session.slug || sessionId}\n`;
  md += `- **Started**: ${started}\n`;
  md += `- **Goal**: ${session.goal || "Cowork session"}\n`;
  md += `- **Status**: ${session.status || "unknown"}\n`;
  if (session.model) md += `- **Model**: ${session.model}\n`;
  md += `- **Source**: cowork-bridge (auto-captured)\n\n`;

  md += `## Turns\n\n`;

  let turnNum = 0;
  for (const turn of session.turns) {
    turnNum++;
    const time = turn.ts
      ? new Date(turn.ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })
      : "--:--";

    md += `### Turn ${turnNum} — ${time}\n`;
    md += `**${turn.role === "human" ? "User" : "Assistant"}**: ${turn.content.slice(0, 2000)}\n\n`;
  }

  if (session.status === "completed" || session.status === "interrupted") {
    md += `## Final Summary\n`;
    md += `Session ${session.status} with ${session.turns.length} turns. `;
    md += `Reason: ${session.reason || "normal end"}.\n`;
  }

  return md;
}

// ── Cowork Discord Posting ──

function postToDiscord(session) {
  if (!COWORK_WEBHOOK) {
    console.log("[Cowork] No DISCORD_COWORK_WEBHOOK_URL set, skipping Discord post");
    return;
  }

  const turnCount = session.turns?.length || 0;
  const status = session.status || "completed";
  const color = status === "completed" ? 3066993 : status === "interrupted" ? 15105570 : 3447003;
  const model = session.model || "";

  const recentTurns = (session.turns || []).slice(-3).map((t) => {
    const role = t.role === "human" ? "**User**" : "**Claude**";
    const text = t.content.slice(0, 200).replace(/\n/g, " ");
    return `${role}: ${text}${t.content.length > 200 ? "..." : ""}`;
  }).join("\n");

  const description = [
    `**Turns:** ${turnCount}`,
    model ? `**Model:** ${model}` : "",
    `**Status:** ${status}`,
    session.reason ? `**Reason:** ${session.reason}` : "",
    "",
    recentTurns || "(no turns captured)",
  ].filter(Boolean).join("\n").slice(0, 3900);

  const payload = JSON.stringify({
    username: "Cowork Bridge",
    embeds: [{
      title: `Cowork: ${session.slug || "session"}`,
      description,
      color,
      timestamp: new Date().toISOString(),
      footer: { text: "Cowork Bridge (auto-captured)" },
    }],
  });

  const url = new URL(`${COWORK_WEBHOOK}?wait=true`);
  const options = {
    hostname: url.hostname,
    port: 443,
    path: url.pathname + url.search,
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
  };

  const https = require("https");
  const req = https.request(options, (res) => {
    let body = "";
    res.on("data", (c) => (body += c));
    res.on("end", () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        console.log(`[Cowork] Discord posted: ${session.slug}`);
      } else {
        console.error(`[Cowork] Discord post failed (${res.statusCode}): ${body.slice(0, 200)}`);
      }
    });
  });
  req.on("error", (err) => console.error(`[Cowork] Discord post error: ${err.message}`));
  req.write(payload);
  req.end();
}

// ── Cowork Git Sync ──

function syncToGitRepo(sessionId) {
  const session = coworkSessions[sessionId];
  if (!session || !session.turns?.length) return;
  if (!COWORK_REPO) {
    console.log("[Cowork] COWORK_REPO_DIR not set, skipping git sync");
    return;
  }

  try {
    if (!fs.existsSync(path.join(COWORK_REPO, ".git"))) {
      console.log(`[Cowork] Git repo not found at ${COWORK_REPO}. Set COWORK_REPO_DIR to a valid git repo.`);
      return;
    }
  } catch {}

  doGitSync(sessionId);
}

function doGitSync(sessionId) {
  const session = coworkSessions[sessionId];
  if (!session) return;

  const date = (session.startedAt || new Date().toISOString()).slice(0, 10);
  const sessionDir = path.join(COWORK_REPO, "sessions", date);
  ensureDir(sessionDir);

  const md = snapshotToMarkdown(sessionId, session);
  const mdPath = path.join(sessionDir, `${session.slug || sessionId}.md`);

  try {
    fs.writeFileSync(mdPath, md);
  } catch (err) {
    console.error(`[Cowork] Failed to write session to repo: ${err.message}`);
    return;
  }

  const gitOpts = { cwd: COWORK_REPO };
  execFile("git", ["add", "sessions/"], gitOpts, (err) => {
    if (err) { console.error(`[Cowork] git add failed: ${err.message}`); return; }

    const msg = `Auto-capture: ${session.slug} (${session.turns.length} turns)`;
    execFile("git", ["commit", "-m", msg], gitOpts, (err) => {
      if (err) {
        if (err.message.includes("nothing to commit")) {
          console.log("[Cowork] Git: nothing new to commit");
        } else {
          console.error(`[Cowork] git commit failed: ${err.message}`);
        }
        return;
      }

      execFile("git", ["push", "origin", "main"], gitOpts, (err) => {
        if (err) {
          execFile("git", ["push", "origin", "master"], gitOpts, (err2) => {
            if (err2) console.error(`[Cowork] git push failed: ${err2.message}`);
            else console.log(`[Cowork] Git synced: ${session.slug} → master`);
          });
        } else {
          console.log(`[Cowork] Git synced: ${session.slug} → main`);
        }
      });
    });
  });
}

// ── Server ──

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    res.end();
    return;
  }

  const parsed = parseUrl(req);
  const path = parsed?.pathname || req.url;

  // ── Health ──
  if (req.method === "GET" && path === "/health") {
    pruneTabs();
    return json(res, {
      ok: true,
      tabs: Object.keys(agentTabs).length,
      pendingCommands: Object.values(agentCommands).reduce((s, c) => s + c.length, 0),
      results: agentResults.length,
    });
  }

  // ── Agent endpoints (no auth — called by TM script) ──

  if (req.method === "POST" && path === "/agent/heartbeat") {
    try {
      const state = await readBody(req);
      const tid = state.tabId || "default";
      agentTabs[tid] = { ...state, receivedAt: Date.now() };
      pruneTabs();
    } catch {}
    return json(res, { ok: true });
  }

  if (req.method === "POST" && path === "/agent/log") {
    try {
      const { tabId, msg, ts } = await readBody(req);
      const entry = `[${new Date(ts || Date.now()).toISOString()}] [${(tabId || "?").substring(0, 8)}] ${msg}`;
      remoteLogs.push(entry);
      if (remoteLogs.length > MAX_LOGS) remoteLogs.shift();
      console.log(`[Agent] ${msg}`);
    } catch {}
    return json(res, { ok: true });
  }

  if (req.method === "GET" && path === "/agent/commands") {
    const tid = parsed?.searchParams?.get("tabId") || "default";
    const url = parsed?.searchParams?.get("url") || "";
    if (agentTabs[tid]) {
      agentTabs[tid].url = url;
      agentTabs[tid].receivedAt = Date.now();
    }
    const cmds = [...(agentCommands[tid] || []), ...(agentCommands["all"] || [])];
    agentCommands[tid] = [];
    agentCommands["all"] = [];
    return json(res, { commands: cmds });
  }

  if (req.method === "POST" && path === "/agent/result") {
    try {
      const result = await readBody(req);
      pushResult(result);
      console.log(`[Result] cmd=${result.id} ok=${result.ok}`);
    } catch {}
    return json(res, { ok: true });
  }

  // ── Upload blob endpoints ──

  if (req.method === "POST" && path === "/agent/upload-blob") {
    if (!checkAuth(req)) return json(res, { error: "Unauthorized" }, 401);
    try {
      const { blobId, base64, filename, mimetype } = await readBodyLarge(req);
      if (!blobId || !base64) return json(res, { error: "blobId and base64 required" }, 400);
      uploadBlobs[blobId] = { base64, filename: filename || "file", mimetype: mimetype || "application/octet-stream", ts: Date.now() };
      pruneBlobs();
      console.log(`[Upload] Stored blob ${blobId} (${(base64.length * 0.75 / 1024).toFixed(0)}KB, ${filename})`);
      return json(res, { ok: true, blobId });
    } catch (err) {
      return json(res, { error: err.message }, 400);
    }
  }

  if (req.method === "GET" && path.startsWith("/agent/blob/")) {
    const blobId = path.replace("/agent/blob/", "");
    const blob = uploadBlobs[blobId];
    if (!blob) return json(res, { error: "Blob not found or expired" }, 404);
    return json(res, { ok: true, base64: blob.base64, filename: blob.filename, mimetype: blob.mimetype });
  }

  // ── Control endpoints (auth required — called by CLI) ──

  if (req.method === "GET" && path === "/agent/tabs") {
    if (!checkAuth(req)) return json(res, { error: "Unauthorized" }, 401);
    pruneTabs();
    return json(res, { tabs: agentTabs, count: Object.keys(agentTabs).length });
  }

  if (req.method === "GET" && path === "/agent/results") {
    if (!checkAuth(req)) return json(res, { error: "Unauthorized" }, 401);
    const since = parseInt(parsed?.searchParams?.get("since") || "0", 10);
    const cmdId = parsed?.searchParams?.get("cmdId");
    let results = agentResults.slice(since);
    if (cmdId) results = results.filter((r) => r.id === cmdId);
    return json(res, { results, total: agentResults.length });
  }

  if (req.method === "GET" && path === "/agent/logs") {
    if (!checkAuth(req)) return json(res, { error: "Unauthorized" }, 401);
    const since = parseInt(parsed?.searchParams?.get("since") || "0", 10);
    return json(res, { logs: remoteLogs.slice(since), total: remoteLogs.length });
  }

  if (req.method === "POST" && path === "/agent/command") {
    if (!checkAuth(req)) return json(res, { error: "Unauthorized" }, 401);
    try {
      const { tabId: tid, commands } = await readBody(req);
      const target = tid || "all";
      if (!agentCommands[target]) agentCommands[target] = [];
      const cmds = Array.isArray(commands) ? commands : [commands];
      for (const cmd of cmds) {
        cmd.id = cmd.id || `cmd-${++cmdIdCounter}`;
        agentCommands[target].push(cmd);
      }
      return json(res, { ok: true, queued: cmds.length, ids: cmds.map((c) => c.id) });
    } catch (err) {
      return json(res, { error: err.message }, 400);
    }
  }

  if (req.method === "POST" && path === "/agent/interactive") {
    if (!checkAuth(req)) return json(res, { error: "Unauthorized" }, 401);
    try {
      const { tabId: tid, command, timeout } = await readBody(req);
      const timeoutMs = Math.min(timeout || 30000, 60000);

      pruneTabs();
      let target = tid;
      if (!target) {
        const tabIds = Object.keys(agentTabs);
        if (tabIds.length === 0) return json(res, { error: "No browser tabs connected" }, 503);
        tabIds.sort((a, b) => (agentTabs[b].receivedAt || 0) - (agentTabs[a].receivedAt || 0));
        target = tabIds[0];
      }

      const cmd = { ...command };
      cmd.id = `cmd-${++cmdIdCounter}`;
      if (!agentCommands[target]) agentCommands[target] = [];
      agentCommands[target].push(cmd);

      const result = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          delete resultWaiters[cmd.id];
          resolve({ id: cmd.id, ok: false, error: "Timeout waiting for browser response", timedOut: true });
        }, timeoutMs);
        resultWaiters[cmd.id] = { resolve, timer, createdAt: Date.now() };
      });

      return json(res, result);
    } catch (err) {
      return json(res, { error: err.message }, 400);
    }
  }

  // ── Cowork endpoints (no auth — called by Chrome extension) ──

  if (req.method === "POST" && path === "/cowork/heartbeat") {
    try {
      const data = await readBody(req);
      if (data.sessionId && coworkSessions[data.sessionId]) {
        coworkSessions[data.sessionId].lastHeartbeat = Date.now();
        coworkSessions[data.sessionId].status = data.status || "active";
      }
    } catch {}
    return json(res, { ok: true });
  }

  if (req.method === "POST" && path === "/cowork/snapshot") {
    try {
      const data = await readBody(req);
      const sid = data.sessionId;
      if (!sid) return json(res, { error: "sessionId required" }, 400);

      const newTurnCount = (data.turns || []).length;
      const existing = coworkSessions[sid];

      if (existing && existing.turns?.length > 0 && newTurnCount < existing.turns.length) {
        console.log(`[Cowork] Chat cleared detected (${existing.turns.length} → ${newTurnCount}). Ending previous session.`);

        existing.status = "completed";
        existing.reason = "chat-cleared";
        existing.endedAt = new Date().toISOString();
        persistCoworkSession(sid);
        persistCoworkMarkdown(sid);
        postToDiscord(existing);
        syncToGitRepo(sid);

        const newSid = `${sid}-${Date.now()}`;
        coworkSessions[newSid] = {
          slug: `${data.slug}-${Date.now().toString(36).slice(-4)}`,
          goal: data.goal,
          startedAt: data.capturedAt || new Date().toISOString(),
          status: "in-progress",
          turns: data.turns || [],
          turnCount: newTurnCount,
          model: data.model,
          url: data.url,
          capturedAt: data.capturedAt || new Date().toISOString(),
          lastHeartbeat: Date.now(),
        };
        persistCoworkSession(newSid);
        console.log(`[Cowork] New session after clear: ${coworkSessions[newSid].slug}`);
        return json(res, { ok: true, newSessionId: newSid });
      }

      coworkSessions[sid] = {
        ...existing,
        slug: data.slug,
        goal: data.goal,
        startedAt: data.startedAt || existing?.startedAt,
        status: data.status || "in-progress",
        turns: data.turns || [],
        turnCount: newTurnCount,
        model: data.model,
        url: data.url,
        capturedAt: data.capturedAt || new Date().toISOString(),
        lastHeartbeat: Date.now(),
      };

      persistCoworkSession(sid);

      console.log(`[Cowork] Snapshot: ${data.slug} (${newTurnCount} turns)`);
    } catch (err) {
      console.error("[Cowork] Snapshot error:", err.message);
    }
    return json(res, { ok: true });
  }

  if (req.method === "POST" && path === "/cowork/turn") {
    try {
      const data = await readBody(req);
      const sid = data.sessionId;
      if (sid && coworkSessions[sid] && data.turn) {
        const session = coworkSessions[sid];
        if (data.turnIndex >= session.turns.length) {
          session.turns.push(data.turn);
          session.turnCount = session.turns.length;
          console.log(`[Cowork] Turn ${data.turnIndex}: ${data.turn.role} (${data.turn.content.slice(0, 60)}...)`);
        }
      }
    } catch {}
    return json(res, { ok: true });
  }

  if (req.method === "POST" && path === "/cowork/end") {
    try {
      const data = await readBody(req);
      const sid = data.sessionId;
      if (!sid) return json(res, { error: "sessionId required" }, 400);

      coworkSessions[sid] = {
        ...coworkSessions[sid],
        slug: data.slug || coworkSessions[sid]?.slug,
        goal: data.goal || coworkSessions[sid]?.goal,
        startedAt: data.startedAt || coworkSessions[sid]?.startedAt,
        status: data.reason === "page-unload" ? "interrupted" : "completed",
        turns: data.turns || coworkSessions[sid]?.turns || [],
        reason: data.reason,
        endedAt: new Date().toISOString(),
      };
      coworkSessions[sid].turnCount = coworkSessions[sid].turns.length;

      persistCoworkSession(sid);
      persistCoworkMarkdown(sid);
      postToDiscord(coworkSessions[sid]);
      syncToGitRepo(sid);

      console.log(`[Cowork] Session ended: ${coworkSessions[sid].slug} (${data.reason}, ${coworkSessions[sid].turns.length} turns)`);
    } catch (err) {
      console.error("[Cowork] End error:", err.message);
    }
    return json(res, { ok: true });
  }

  if (req.method === "GET" && path === "/cowork/pending") {
    return json(res, { ok: true, pending: coworkPending });
  }

  if (req.method === "POST" && path === "/cowork/pending/ack") {
    try {
      const data = await readBody(req);
      if (coworkPending && data.requestId === coworkPending.requestId) {
        console.log(`[Cowork] Pending session acknowledged: ${coworkPending.goal}`);
        coworkPending = null;
      }
    } catch {}
    return json(res, { ok: true });
  }

  if (req.method === "GET" && path === "/cowork/summary") {
    const sessions = Object.entries(coworkSessions)
      .map(([id, s]) => ({
        id,
        slug: s.slug,
        goal: s.goal,
        status: s.status,
        turnCount: s.turnCount || 0,
        startedAt: s.startedAt,
      }))
      .sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""))
      .slice(0, 10);
    return json(res, { sessions, count: sessions.length });
  }

  if (req.method === "GET" && path === "/cowork/config") {
    return json(res, {
      selectors: {
        turnElements: '[data-test-id="user-message"], [data-test-id="assistant-message"], [data-testid="user-message"], [data-testid="assistant-message"]',
        userMessage: '[data-test-id="user-message"], [data-testid="user-message"]',
        assistantMessage: '[data-test-id="assistant-message"], [data-testid="assistant-message"]',
        inputField: '[data-test-id="message-input"]',
        sendButton: '[data-test-id="send-button"]',
        modelSelector: 'button[aria-label*="Model selector"]',
      },
      scrapeIntervalMs: 30000,
      version: "1.2.0",
    });
  }

  // ── Cowork control endpoints (auth required — called by CLI) ──

  if (req.method === "GET" && path === "/cowork/sessions") {
    if (!checkAuth(req)) return json(res, { error: "Unauthorized" }, 401);
    const today = parsed?.searchParams?.get("date") || "";
    const sessions = Object.entries(coworkSessions)
      .filter(([_, s]) => !today || (s.startedAt || "").startsWith(today))
      .map(([id, s]) => ({
        id,
        slug: s.slug,
        goal: s.goal,
        status: s.status,
        turnCount: s.turnCount || 0,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
      }))
      .sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
    return json(res, { sessions, count: sessions.length });
  }

  if (req.method === "GET" && path.startsWith("/cowork/session/")) {
    if (!checkAuth(req)) return json(res, { error: "Unauthorized" }, 401);
    const sid = path.replace("/cowork/session/", "");
    const session = coworkSessions[sid];
    if (!session) return json(res, { error: "Session not found" }, 404);
    return json(res, { session: { id: sid, ...session } });
  }

  if (req.method === "GET" && path === "/cowork/status") {
    if (!checkAuth(req)) return json(res, { error: "Unauthorized" }, 401);
    const activeSessions = Object.entries(coworkSessions)
      .filter(([_, s]) => s.status === "active" || s.status === "in-progress")
      .filter(([_, s]) => Date.now() - (s.lastHeartbeat || 0) < 60_000)
      .map(([id, s]) => ({ id, slug: s.slug, goal: s.goal, turnCount: s.turnCount }));
    return json(res, {
      active: activeSessions.length > 0,
      sessions: activeSessions,
      pending: !!coworkPending,
    });
  }

  if (req.method === "POST" && path === "/cowork/start") {
    if (!checkAuth(req)) return json(res, { error: "Unauthorized" }, 401);
    try {
      const data = await readBody(req);
      coworkPending = {
        requestId: `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        goal: data.goal || "CLI-initiated session",
        instructions: data.instructions || "",
        queuedAt: new Date().toISOString(),
      };
      console.log(`[Cowork] Session queued by CLI: ${coworkPending.goal}`);
      return json(res, { ok: true, requestId: coworkPending.requestId });
    } catch (err) {
      return json(res, { error: err.message }, 400);
    }
  }

  // ── 404 ──
  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[Browser Agent] Listening on http://127.0.0.1:${PORT}`);
});
