---
name: upload
description: Upload the current agent's Claude Code, Codex, or Cursor JSONL session transcript to joe-store. Use when the user asks to upload, save, or send this agent's session to joe-store, authenticate with joe-store, switch joe-store accounts, or check joe-store authentication.
---

# Upload Session to joe-store

Use the bundled `scripts/joestore.mjs` command to authenticate and upload this
agent's own session transcript to joe-store's `PUT /session` endpoint.

## Requirements

- A web browser (any browser; macOS, Linux, or Windows)
- Node.js 22 or newer

## Workflow

1. Determine this skill's installation directory: it is the directory that
   contains this `SKILL.md` file. Do not assume which agent-specific skills
   directory was used.
2. Run the bundled script with an absolute path:

   ```bash
   node <skill-directory>/scripts/joestore.mjs upload
   ```

   The default upload is intentionally scoped to the agent running the skill:
   Claude Code uploads Claude Code sessions, Codex uploads Codex sessions, and
   Cursor uploads Cursor sessions. The agent must not upload another agent's
   transcript by default.

   To upload a specific transcript for the same agent, provide its path
   explicitly:

   ```bash
   node <skill-directory>/scripts/joestore.mjs upload /path/to/session.jsonl
   ```

3. The upload request includes the transcript's `session_uuid` alongside the
   `session` payload. The script extracts this UUID from transcript metadata
   such as `sessionId` or Codex `session_meta.payload.id`, falling back to a UUID
   in the transcript filename.
4. If the default browser opens, tell the user to complete the joe-store login.
   Keep the command running while they sign in. It waits up to five minutes,
   then prints the server's JSON response on success. When the response contains
   a session UUID or ID, the script adds `session_url` using the public frontend
   route `https://joe-store-frontend.onrender.com/session/{id}`.
5. Report the returned `session_url` and session UUID or ID, or the exact error,
   to the user. Never print or expose the cached access token.

Without an explicit transcript path, the script detects the current agent and
selects that agent's session only. Claude Code sessions are discovered under
`~/.claude/projects/<project>`, Codex sessions under `~/.codex/sessions`, and
Cursor sessions under `~/.cursor/projects/<project>/agent-transcripts`.

For Codex, the script first uses `CODEX_THREAD_ID` when available, then falls
back to the most recently modified Codex session whose metadata `cwd` matches
the current project. If an explicit transcript path belongs to a different
agent, the script refuses to upload it.

## Authentication

On first use, the script starts a one-shot local callback server on a random
`127.0.0.1` port and opens the joe-store login page in the user's normal
browser. After the user signs in, the joe-store frontend redirects back to that
loopback URL with the Supabase access token, which the script stores at
`~/.joestore/token.json`. The token is exchanged entirely over loopback and the
script never reads the browser's profile, cookies, or storage. Later uploads
reuse a valid cached token. If the server returns `401`, the script prompts for
login once and retries.

Use these commands when needed:

```bash
# Switch accounts or force a fresh login
node <skill-directory>/scripts/joestore.mjs login

# Check whether a cached token exists and is valid
node <skill-directory>/scripts/joestore.mjs token
```

## Configuration

- `JOESTORE_URL`: server base URL; defaults to `https://joe-store.onrender.com`
- `JOESTORE_LOGIN_URL`: login URL; defaults to the hosted joe-store frontend
- `JOESTORE_FRONTEND_URL`: frontend base URL used to print `session_url`;
  defaults to the origin of `JOESTORE_LOGIN_URL`
- `JOESTORE_AGENT`: set to `claude`, `codex`, or `cursor` if automatic current
  agent detection is unavailable
- `JOESTORE_PROVIDER`: set to `claude`, `openai`, or `cursor` to override
  automatic provider detection
- `JOESTORE_BROWSER`: optional macOS application name or path used to open the
  login URL (passed to `open -a`), e.g. `Google Chrome`. When unset, the login
  URL opens in the system's default browser (`open` on macOS, `xdg-open` on
  Linux, `start` on Windows)

The script opens the login page in the user's normal browser and does not launch
a debugging session, read the browser profile, or modify any browser settings.
