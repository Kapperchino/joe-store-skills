---
name: upload-session
description: Upload a Claude Code (or OpenAI) session transcript to the joe-store server. On first use it opens the joe-store frontend login page in a browser for the user to sign in, captures the Supabase access token, and caches it locally; subsequent uploads reuse the cached token. Use when the user asks to "upload a session", "send this session to joestore", or "log in to joestore".
---

# Upload a session to joe-store

Uploads a session transcript to the joe-store server's `PUT /session` endpoint.
Authentication is a Supabase JWT obtained by signing in to the frontend.

## How it works

A single zero-dependency Node script (`scripts/joestore.mjs`, needs Node ≥ 22)
handles everything:

1. **Token**: reads the cached token from `~/.joestore/token.json`. If it is
   missing or expired, it opens **https://joe-store-frontend.onrender.com/login**
   in a Brave window (driven over the Chrome DevTools Protocol) and waits for the
   user to log in. Once Supabase writes the session into the page's
   `localStorage`, the script extracts the `access_token` and caches it. If a
   valid token already exists, it skips login and uploads straight away.
2. **Session**: picks the most recently modified `*.jsonl` under
   `~/.claude/projects/<cwd>/` (the current project's transcript) unless a path
   is passed. Provider is inferred from the path (`openai`/`rollout-*` → openai,
   otherwise `claude`).
3. **Upload**: `PUT {JOESTORE_URL}/session` with the bearer token and a body of
   `{ "session": { "type": <provider>, "data": [<one object per jsonl line>] } }`.
   On a `401` it re-authenticates once and retries.

## Steps

1. Run the upload. The script auto-handles login on first use:
   ```bash
   node .claude/skills/upload-session/scripts/joestore.mjs upload
   ```
   To upload a specific transcript, pass its path:
   ```bash
   node .claude/skills/upload-session/scripts/joestore.mjs upload /path/to/session.jsonl
   ```
2. When the Brave window opens, tell the user to complete the login. The command
   blocks until sign-in succeeds (up to 5 minutes) and prints the server's JSON
   response (`{"status":"ok","session_id":<id>}`) on success.

## Other commands

- Force a fresh login (e.g. to switch accounts): `node .claude/skills/upload-session/scripts/joestore.mjs login`
- Check the cached token: `node .claude/skills/upload-session/scripts/joestore.mjs token`

## Configuration (env vars)

- `JOESTORE_URL` — server base URL (default `http://127.0.0.1:3000`).
- `JOESTORE_LOGIN_URL` — frontend login URL (default the onrender frontend).
- `JOESTORE_PROVIDER` — force `claude` or `openai` instead of inferring.

## Notes

- Requires Brave at `/Applications/Brave Browser.app`. To use a different
  Chromium browser, edit the `BRAVE` constant in `scripts/joestore.mjs`.
- The login uses a throwaway browser profile, so it won't touch the user's
  normal Brave session and is cleaned up afterward.
