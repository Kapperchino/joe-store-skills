#!/usr/bin/env node
// joestore.mjs — log in to the joe-store frontend once, cache the Supabase
// access token locally, and upload Claude/OpenAI/Cursor session transcripts.
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
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const LOGIN_URL = process.env.JOESTORE_LOGIN_URL || "https://joe-store-frontend.onrender.com/login";
const SERVER_URL = (process.env.JOESTORE_URL || "https://joe-store.onrender.com").replace(/\/+$/, "");
const TOKEN_PATH = join(homedir(), ".joestore", "token.json");
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

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

function defaultSessionPath() {
  const encodedProject = encodeProjectDir(process.cwd());
  const claudeDir = join(homedir(), ".claude", "projects", encodedProject);
  const cursorDir = join(
    homedir(),
    ".cursor",
    "projects",
    encodedProject.replace(/^-+/, ""),
    "agent-transcripts",
  );
  const files = [
    ...findJsonlFiles(claudeDir),
    ...findJsonlFiles(cursorDir, true),
  ].sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (!files.length) {
    throw new Error(
      `no Claude or Cursor .jsonl session files for this project; checked ${claudeDir} and ${cursorDir}`,
    );
  }
  return files[0].path;
}

function detectProvider(path, data) {
  if (
    /(?:^|[\\/])\.cursor(?:[\\/]|$)|(?:^|[\\/])agent-transcripts(?:[\\/]|$)/i.test(path)
  ) {
    return "cursor";
  }
  if (/openai/i.test(path) || /rollout-/i.test(path)) return "openai";

  const firstEntry = data.find((entry) => entry && typeof entry === "object");
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

function buildPayload(path) {
  const data = readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => {
      try { return JSON.parse(l); }
      catch (e) { throw new Error(`line ${i + 1} of ${path} is not valid JSON: ${e.message}`); }
    });
  if (!data.length) throw new Error(`session ${path} has no entries`);
  const provider = process.env.JOESTORE_PROVIDER || detectProvider(path, data);
  if (!["claude", "openai", "cursor"].includes(provider)) {
    throw new Error("JOESTORE_PROVIDER must be claude, openai, or cursor");
  }
  return { provider, payload: { session: { type: provider, data } } };
}

async function upload(sessionPath) {
  const path = sessionPath || defaultSessionPath();
  const { provider, payload } = buildPayload(path);
  const token = await ensureToken();

  console.error(`Uploading ${payload.session.data.length} ${provider} entries from ${path} -> ${SERVER_URL}/session`);
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
    console.log(retryText);
    return;
  }
  if (!res.ok) throw new Error(`upload failed (${res.status}): ${text}`);
  console.log(text);
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
