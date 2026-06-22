#!/usr/bin/env node
// joestore.mjs — log in to the joe-store frontend once, cache the Supabase
// access token locally, and upload Claude/OpenAI/Cursor session transcripts.
//
// Usage:
//   node joestore.mjs upload [sessionPath]   ensure token (login if needed), upload
//   node joestore.mjs login                  force an interactive browser login
//   node joestore.mjs token                  print the cached token's status
//
// Zero npm dependencies: uses Node's built-in fetch + WebSocket (Node >= 22)
// and drives the user's default browser over the Chrome DevTools Protocol so
// the user can log in interactively, then reads the Supabase session out of
// localStorage.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

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
  writeFileSync(TOKEN_PATH, JSON.stringify(rec, null, 2));
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

// ------------------------------------------------------------------ CDP login

async function cdpSend(ws, pending, method, params = {}) {
  const id = pending.nextId++;
  const msg = JSON.stringify({ id, method, params });
  return new Promise((resolve, reject) => {
    pending.map.set(id, { resolve, reject });
    ws.send(msg);
  });
}

async function waitForBrowser(port) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(
    "the default browser did not expose a DevTools endpoint; use a Chromium-based default browser or set JOESTORE_BROWSER"
  );
}

async function findPageTarget(port) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await sleep(250);
  }
  throw new Error("no page target found");
}

function defaultBrowserBundleId() {
  if (process.platform !== "darwin") {
    throw new Error("automatic default-browser detection currently requires macOS");
  }

  const exported = spawnSync("defaults", [
    "export",
    "com.apple.LaunchServices/com.apple.launchservices.secure",
    "-",
  ]);
  if (exported.status !== 0) {
    throw new Error("could not read the macOS default-browser setting");
  }

  const converted = spawnSync("plutil", ["-convert", "json", "-o", "-", "-"], {
    input: exported.stdout,
    encoding: "utf8",
  });
  if (converted.status !== 0) {
    throw new Error("could not parse the macOS default-browser setting");
  }

  let handlers;
  try {
    handlers = JSON.parse(converted.stdout).LSHandlers;
  } catch {
    throw new Error("macOS returned an invalid default-browser setting");
  }

  const handler = handlers?.find((entry) =>
    entry.LSHandlerContentType === "com.apple.default-app.web-browser" && entry.LSHandlerRoleAll
  ) ?? handlers?.find((entry) =>
    entry.LSHandlerURLScheme === "https" && entry.LSHandlerRoleAll
  );
  if (!handler) throw new Error("no default HTTPS browser is configured");
  return handler.LSHandlerRoleAll;
}

function launchBrowser(port, userDir) {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    LOGIN_URL,
  ];
  const override = process.env.JOESTORE_BROWSER;

  if (override) {
    return spawn(override, args, { stdio: "ignore" });
  }

  const bundleId = defaultBrowserBundleId();
  return spawn("open", ["-n", "-b", bundleId, "--args", ...args], {
    stdio: "ignore",
  });
}

// Runs in the browser: pull the access_token out of localStorage. The joe-store
// frontend stores the raw JWT under 'joe-store.auth.access-token' (see
// src/lib/auth.ts). Fall back to the Supabase session JSON (custom storageKey or
// default 'sb-*-auth-token'), handling chunked (`.0/.1`) and `base64-` values.
const EXTRACT_EXPR = `(() => {
  const direct = localStorage.getItem('joe-store.auth.access-token');
  if (direct) return direct;
  const keys = Object.keys(localStorage).filter(k =>
    k === 'joe-store.auth.session' || (k.startsWith('sb-') && k.includes('-auth-token')));
  const groups = {};
  for (const k of keys) {
    const m = k.match(/^(.*?)(?:\\.(\\d+))?$/);
    if (!m) continue;
    (groups[m[1]] = groups[m[1]] || []).push({ k, idx: m[2] === undefined ? -1 : +m[2] });
  }
  for (const base of Object.keys(groups)) {
    const parts = groups[base];
    let raw = parts.length === 1 && parts[0].idx === -1
      ? localStorage.getItem(parts[0].k)
      : parts.filter(p => p.idx >= 0).sort((a,b)=>a.idx-b.idx).map(p=>localStorage.getItem(p.k)).join('');
    if (!raw) continue;
    if (raw.startsWith('base64-')) { try { raw = atob(raw.slice(7)); } catch { continue; } }
    try { const o = JSON.parse(raw); if (o && o.access_token) return o.access_token; } catch {}
  }
  return null;
})()`;

async function interactiveLogin() {
  const port = 9000 + Math.floor(Math.random() * 1000);
  const userDir = mkdtempSync(join(tmpdir(), "joestore-login-"));
  const proc = launchBrowser(port, userDir);
  let ws;

  const cleanup = () => {
    try { proc.kill(); } catch {}
    try { rmSync(userDir, { recursive: true, force: true }); } catch {}
  };

  try {
    await waitForBrowser(port);
    const target = await findPageTarget(port);
    ws = new WebSocket(target.webSocketDebuggerUrl);
    const pending = { nextId: 1, map: new Map() };
    ws.addEventListener("message", (ev) => {
      const data = JSON.parse(ev.data);
      if (data.id && pending.map.has(data.id)) {
        const { resolve, reject } = pending.map.get(data.id);
        pending.map.delete(data.id);
        data.error ? reject(new Error(data.error.message)) : resolve(data.result);
      }
    });
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error("CDP websocket error")), { once: true });
    });
    await cdpSend(ws, pending, "Runtime.enable");

    console.error("\n>>> A browser window opened. Log in at the joe-store frontend.");
    console.error(">>> Waiting for sign-in to complete (Ctrl-C to cancel)...\n");

    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const res = await cdpSend(ws, pending, "Runtime.evaluate", {
        expression: EXTRACT_EXPR,
        returnByValue: true,
      }).catch(() => null);
      const token = res?.result?.value;
      if (token) {
        return token;
      }
      await sleep(1500);
    }
    throw new Error("timed out waiting for login");
  } finally {
    if (ws?.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ id: 0, method: "Browser.close" })); } catch {}
      await sleep(500);
      try { ws.close(); } catch {}
    }
    cleanup();
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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
