#!/usr/bin/env node
// joestore.mjs — log in to the joe-store frontend once, cache the Supabase
// access token locally, and upload the invoking agent's session transcript.
//
// Usage:
//   node joestore.mjs upload [sessionPath]   ensure token (login if needed), upload
//   node joestore.mjs login                  force an interactive browser login
//   node joestore.mjs token                  print the cached token's status
//
// Zero npm dependencies. Authentication uses a loopback OAuth flow: the script
// starts a one-shot HTTP server on a random 127.0.0.1 port, opens the joe-store
// login page in the user's normal browser, and the frontend redirects back to
// http://127.0.0.1:<port>/callback?access_token=<jwt>&state=<state> once the
// user has signed in. The token is exchanged entirely over loopback and never
// leaves the local machine.

import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const LOGIN_URL = process.env.JOESTORE_LOGIN_URL || "https://joe-store-frontend.fly.dev/login";
const FRONTEND_URL = (process.env.JOESTORE_FRONTEND_URL || new URL(LOGIN_URL).origin).replace(/\/+$/, "");
const SERVER_URL = (process.env.JOESTORE_URL || "https://joe-store-frontend.fly.dev").replace(/\/+$/, "");
const TOKEN_PATH = join(homedir(), ".joestore", "token.json");
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const AGENTS = {
  claude: { label: "Claude Code", provider: "claude" },
  codex: { label: "Codex", provider: "openai" },
  cursor: { label: "Cursor", provider: "cursor" },
};

// ---------------------------------------------------------------- token store

function loadToken() {
  if (!existsSync(TOKEN_PATH)) return null;
  try {
    return JSON.parse(readFileSync(TOKEN_PATH, "utf8"));
  } catch {
    return null;
  }
}

function saveToken(accessToken) {
  mkdirSync(join(homedir(), ".joestore"), { recursive: true });
  const rec = { access_token: accessToken, stored_at: Math.floor(Date.now() / 1000) };
  const exp = jwtExpiry(accessToken);
  if (exp) rec.expires_at = exp;
  writeFileSync(TOKEN_PATH, JSON.stringify(rec, null, 2), { mode: 0o600 });
}

function jwtExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

function tokenValid(rec) {
  if (!rec?.access_token) return false;
  const exp = rec.expires_at ?? jwtExpiry(rec.access_token);
  if (!exp) return true; // can't tell — assume usable, server will reject if not
  return Date.now() / 1000 < exp - 60; // 60s safety margin
}

// ------------------------------------------------------- loopback OAuth login
//
// A one-shot loopback server receives the access token that the joe-store
// frontend hands back after the user signs in. The login page is opened with
// the system's normal URL handler (open / xdg-open / start), so any browser
// works. The token arrives over 127.0.0.1 only; the script reads nothing out
// of the browser itself.

const SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>joe-store</title></head>
<body style="font-family:system-ui,sans-serif;text-align:center;padding-top:4rem;color:#111">
<h1>&#10003; Signed in to joe-store</h1>
<p>You can close this tab and return to your terminal.</p>
</body></html>`;

function openUrl(url) {
  // The command is always a constant; the user can only influence arguments, never
  // which executable runs. JOESTORE_BROWSER is passed to `open -a` as an app name,
  // so it never lands in the command position (no arbitrary-executable surface).
  const browserApp = process.env.JOESTORE_BROWSER;
  let cmd, args;
  if (process.platform === "darwin") {
    cmd = "open";
    args = browserApp ? ["-a", browserApp, url] : [url];
  } else if (process.platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  spawn(cmd, args, { stdio: "ignore" }).on("error", () => {
    console.error(`Could not open a browser automatically. Open this URL manually:\n${url}`);
  });
}

// Starts an HTTP server bound to a random loopback port. Resolves once it is
// listening; `token` settles when the frontend hits /callback with a token that
// matches the expected CSRF state.
function startCallbackServer(expectedState) {
  return new Promise((resolveServer) => {
    let settle;
    const token = new Promise((res, rej) => { settle = { res, rej }; });
    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const accessToken = url.searchParams.get("access_token");
      const state = url.searchParams.get("state");
      if (!accessToken || state !== expectedState) {
        res.writeHead(400, { "content-type": "text/html" });
        res.end("<h1>Login failed</h1><p>Missing token or state mismatch. You can close this tab.</p>");
        settle.rej(new Error("login callback was missing a token or had a mismatched state"));
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(SUCCESS_HTML);
      settle.res(accessToken);
    });
    server.listen(0, "127.0.0.1", () => {
      resolveServer({ server, port: server.address().port, token });
    });
  });
}

async function interactiveLogin() {
  const state = randomBytes(16).toString("hex");
  const { server, port, token } = await startCallbackServer(state);
  const loginUrl = new URL(LOGIN_URL);
  loginUrl.searchParams.set("cli_redirect", `http://127.0.0.1:${port}/callback`);
  loginUrl.searchParams.set("state", state);

  console.error("\n>>> Opening the joe-store login page in your browser.");
  console.error(">>> Waiting for sign-in to complete (Ctrl-C to cancel)...\n");
  openUrl(loginUrl.toString());

  const timeout = new Promise((_, rej) =>
    setTimeout(() => rej(new Error("timed out waiting for login")), LOGIN_TIMEOUT_MS).unref()
  );
  try {
    return await Promise.race([token, timeout]);
  } finally {
    server.close();
  }
}

async function ensureToken({ force } = {}) {
  if (!force) {
    const rec = loadToken();
    if (tokenValid(rec)) return rec.access_token;
  }
  const token = await interactiveLogin();
  saveToken(token);
  console.error(`Token stored at ${TOKEN_PATH}`);
  return token;
}

// --------------------------------------------------------------------- upload

function encodeProjectDir(cwd) {
  return cwd.replace(/[/.]/g, "-");
}

function findJsonlFiles(dir, recursive = false) {
  if (!existsSync(dir)) return [];

  const files = [];
  const pending = [dir];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory() && recursive) {
        pending.push(path);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push({ path, mtimeMs: statSync(path).mtimeMs });
      }
    }
  }
  return files;
}

function normalizeAgent(value) {
  const agent = value?.toLowerCase();
  return agent && Object.hasOwn(AGENTS, agent) ? agent : null;
}

function pathHasPart(path, part) {
  return new RegExp(`(?:^|[\\\\/])${part.replace(".", "\\.")}(?:[\\\\/]|$)`, "i").test(path);
}

function detectCurrentAgent() {
  const fromEnv = normalizeAgent(process.env.JOESTORE_AGENT);
  if (fromEnv) return fromEnv;
  if (process.env.CODEX_THREAD_ID || process.env.CODEX_SANDBOX || process.env.CODEX_MANAGED_PACKAGE_ROOT) {
    return "codex";
  }
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT || process.env.CLAUDE_CODE_SSE_PORT) {
    return "claude";
  }
  if (process.env.CURSOR_TRACE_ID || process.env.CURSOR_AGENT || process.env.CURSOR_SESSION_ID) {
    return "cursor";
  }

  const scriptPath = new URL(import.meta.url).pathname;
  if (pathHasPart(scriptPath, ".codex")) return "codex";
  if (pathHasPart(scriptPath, ".claude")) return "claude";
  if (pathHasPart(scriptPath, ".cursor")) return "cursor";
  return null;
}

function currentAgentOrThrow() {
  const agent = detectCurrentAgent();
  if (!agent) {
    throw new Error(
      "could not determine the current agent; set JOESTORE_AGENT to claude, codex, or cursor",
    );
  }
  return agent;
}

function parseFirstJsonLine(path) {
  let fd;
  let first = "";
  const buffer = Buffer.alloc(64 * 1024);
  try {
    fd = openSync(path, "r");
    while (true) {
      const bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (!bytes) break;
      const chunk = buffer.toString("utf8", 0, bytes);
      const newline = chunk.indexOf("\n");
      if (newline === -1) {
        first += chunk;
      } else {
        first += chunk.slice(0, newline);
        break;
      }
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  first = first.trim();
  if (!first) return null;
  try {
    return JSON.parse(first);
  } catch {
    return null;
  }
}

function codexSessionMeta(path) {
  const entry = parseFirstJsonLine(path);
  return entry?.type === "session_meta" && entry.payload ? entry.payload : null;
}

function codexSessionMatchesProject(file) {
  const meta = codexSessionMeta(file.path);
  return meta?.cwd === process.cwd();
}

function codexSessionMatchesThread(file) {
  const threadId = process.env.CODEX_THREAD_ID;
  if (!threadId) return false;
  if (file.path.includes(threadId)) return true;
  const meta = codexSessionMeta(file.path);
  return meta?.session_id === threadId || meta?.id === threadId;
}

function defaultClaudeSessionPath() {
  const encodedProject = encodeProjectDir(process.cwd());
  const claudeDir = join(homedir(), ".claude", "projects", encodedProject);
  const files = findJsonlFiles(claudeDir).sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (!files.length) {
    throw new Error(
      `no Claude Code .jsonl session files for this project; checked ${claudeDir}`,
    );
  }
  return files[0].path;
}

function defaultCodexSessionPath() {
  const codexDir = join(homedir(), ".codex", "sessions");
  const files = findJsonlFiles(codexDir, true).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const threadMatch = files.find(codexSessionMatchesThread);
  if (threadMatch) return threadMatch.path;

  const projectMatch = files.find(codexSessionMatchesProject);
  if (projectMatch) return projectMatch.path;

  throw new Error(`no Codex .jsonl session files for this project; checked ${codexDir}`);
}

function defaultCursorSessionPath() {
  const encodedProject = encodeProjectDir(process.cwd()).replace(/^-+/, "");
  const cursorDir = join(homedir(), ".cursor", "projects", encodedProject, "agent-transcripts");
  const files = findJsonlFiles(cursorDir, true).sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (!files.length) {
    throw new Error(`no Cursor .jsonl session files for this project; checked ${cursorDir}`);
  }
  return files[0].path;
}

function defaultSessionPath(agent) {
  switch (agent) {
    case "claude":
      return defaultClaudeSessionPath();
    case "codex":
      return defaultCodexSessionPath();
    case "cursor":
      return defaultCursorSessionPath();
    default:
      throw new Error(`unsupported agent: ${agent}`);
  }
}

function detectSessionAgent(path, data) {
  if (pathHasPart(path, ".codex") || /(?:^|[\\/])rollout-[^\\/]+\.jsonl$/i.test(path)) {
    return "codex";
  }
  if (
    /(?:^|[\\/])\.cursor(?:[\\/]|$)|(?:^|[\\/])agent-transcripts(?:[\\/]|$)/i.test(path)
  ) {
    return "cursor";
  }

  const firstEntry = data.find((entry) => entry && typeof entry === "object");
  if (firstEntry?.type === "session_meta" && /^codex/i.test(firstEntry.payload?.originator || "")) {
    return "codex";
  }
  if (
    firstEntry &&
    !("type" in firstEntry) &&
    (firstEntry.role === "user" || firstEntry.role === "assistant") &&
    firstEntry.message &&
    Array.isArray(firstEntry.message.content)
  ) {
    return "cursor";
  }
  return "claude";
}

function providerForAgent(agent) {
  return AGENTS[agent]?.provider;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function uuidFromString(value) {
  if (typeof value !== "string") return null;
  return value.match(UUID_RE)?.[0] || null;
}

function sessionUuidFromEntry(entry) {
  if (!entry || typeof entry !== "object") return null;

  const candidates = [
    entry.session_uuid,
    entry.sessionUuid,
    entry.session_id,
    entry.sessionId,
    entry.metadata?.session_uuid,
    entry.metadata?.sessionUuid,
    entry.metadata?.session_id,
    entry.metadata?.sessionId,
  ];

  if (entry.type === "session_meta" && entry.payload && typeof entry.payload === "object") {
    candidates.push(
      entry.payload.session_uuid,
      entry.payload.sessionUuid,
      entry.payload.session_id,
      entry.payload.sessionId,
      entry.payload.id,
    );
  }

  return candidates.map(uuidFromString).find(Boolean) || null;
}

function sessionUuidFromTranscript(path, data) {
  for (const entry of data) {
    const uuid = sessionUuidFromEntry(entry);
    if (uuid) return uuid;
  }

  const fromPath = uuidFromString(basename(path)) || uuidFromString(path);
  if (fromPath) return fromPath;

  throw new Error(
    `could not determine a session UUID from ${path}; expected transcript metadata such as sessionId or session_meta.payload.id`,
  );
}

function buildPayload(path, currentAgent) {
  const data = readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => {
      try { return JSON.parse(l); }
      catch (e) { throw new Error(`line ${i + 1} of ${path} is not valid JSON: ${e.message}`); }
    });
  if (!data.length) throw new Error(`session ${path} has no entries`);
  const sessionAgent = detectSessionAgent(path, data);
  if (currentAgent && sessionAgent !== currentAgent) {
    throw new Error(
      `${AGENTS[currentAgent].label} can only upload ${AGENTS[currentAgent].label} sessions; got ${AGENTS[sessionAgent].label} transcript ${path}`,
    );
  }
  const provider = process.env.JOESTORE_PROVIDER || providerForAgent(sessionAgent);
  if (!["claude", "openai", "cursor"].includes(provider)) {
    throw new Error("JOESTORE_PROVIDER must be claude, openai, or cursor");
  }
  const sessionUuid = sessionUuidFromTranscript(path, data);
  return {
    agent: sessionAgent,
    provider,
    sessionUuid,
    payload: { session: { type: provider, data }, session_id: sessionUuid },
  };
}

function candidateSessionIds(value) {
  if (!value || typeof value !== "object") return [];
  const ids = [];
  for (const key of ["session_url", "url", "link"]) {
    const raw = value[key];
    if (typeof raw === "string") {
      const match = raw.match(/\/session\/([^/?#]+)/);
      if (match) ids.push(decodeURIComponent(match[1]));
    }
  }
  for (const key of ["session_uuid", "sessionUuid", "session_id", "sessionId", "id"]) {
    if (typeof value[key] === "string" || typeof value[key] === "number") {
      ids.push(String(value[key]));
    }
  }
  for (const key of ["session", "data"]) {
    ids.push(...candidateSessionIds(value[key]));
  }
  return ids;
}

function sessionUrl(id) {
  return `${FRONTEND_URL}/session/${encodeURIComponent(id)}`;
}

function enrichUploadResponse(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return text;
  }

  if (typeof body === "string" || typeof body === "number") {
    const id = String(body);
    return { id, session_url: sessionUrl(id) };
  }

  if (!body || typeof body !== "object") return body;
  const id = candidateSessionIds(body)[0];
  if (!id) return body;
  return { ...body, session_url: sessionUrl(id) };
}

function printUploadResponse(text) {
  const body = enrichUploadResponse(text);
  console.log(typeof body === "string" ? body : JSON.stringify(body, null, 2));
}

async function upload(sessionPath) {
  const currentAgent = currentAgentOrThrow();
  const path = sessionPath || defaultSessionPath(currentAgent);
  const { agent, provider, sessionUuid, payload } = buildPayload(path, currentAgent);
  const token = await ensureToken();

  console.error(`Uploading ${payload.session.data.length} ${AGENTS[agent].label} entries for session ${sessionUuid} from ${path} -> ${SERVER_URL}/session`);
  const res = await fetch(`${SERVER_URL}/session`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const text = await res.text();

  if (res.status === 401) {
    // stale token — re-login once and retry
    console.error("Token rejected (401); re-authenticating...");
    const fresh = await ensureToken({ force: true });
    const retry = await fetch(`${SERVER_URL}/session`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${fresh}` },
      body: JSON.stringify(payload),
    });
    const retryText = await retry.text();
    if (!retry.ok) throw new Error(`upload failed (${retry.status}): ${retryText}`);
    printUploadResponse(retryText);
    return;
  }
  if (!res.ok) throw new Error(`upload failed (${res.status}): ${text}`);
  printUploadResponse(text);
}

// ----------------------------------------------------------------------- main

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case "login":
      await ensureToken({ force: true });
      console.log("Logged in.");
      break;
    case "token": {
      const rec = loadToken();
      if (!rec) { console.log("No token stored."); break; }
      console.log(JSON.stringify({ valid: tokenValid(rec), expires_at: rec.expires_at, path: TOKEN_PATH }, null, 2));
      break;
    }
    case "upload":
      await upload(arg);
      break;
    default:
      console.error("usage: node joestore.mjs <login|token|upload [sessionPath]>");
      process.exit(2);
  }
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
