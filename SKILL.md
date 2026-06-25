---
name: upload
description: Upload Claude Code, OpenAI, or Cursor JSONL session transcripts to joe-store. Use when the user asks to upload, save, or send a session to joe-store, authenticate with joe-store, switch joe-store accounts, or check joe-store authentication.
---

# Upload Session to joe-store

Use the bundled `scripts/joestore.mjs` command to authenticate and upload a
session transcript to joe-store's `PUT /session` endpoint.

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

   To upload a specific Claude Code, OpenAI, or Cursor JSONL transcript, provide its
   path explicitly:

   ```bash
   node <skill-directory>/scripts/joestore.mjs upload /path/to/session.jsonl
   ```

3. If the default browser opens, tell the user to complete the joe-store login.
   Keep the command running while they sign in. It waits up to five minutes,
   then prints the server's JSON response on success.
4. Report the returned session ID or the exact error to the user. Never print
   or expose the cached access token.

Without an explicit transcript path, the script selects the most recently
modified `*.jsonl` across the current project's Claude Code and Cursor session
directories. Cursor sessions are discovered under
`~/.cursor/projects/<project>/agent-transcripts`.

The script infers `cursor` from Cursor transcript paths or Cursor's
`role`/`message` entry shape, and infers `openai` from paths containing
`openai` or `rollout-`. Other transcripts default to `claude`.

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
- `JOESTORE_PROVIDER`: set to `claude`, `openai`, or `cursor` to override
  automatic provider detection
- `JOESTORE_BROWSER`: optional macOS application name or path used to open the
  login URL (passed to `open -a`), e.g. `Google Chrome`. When unset, the login
  URL opens in the system's default browser (`open` on macOS, `xdg-open` on
  Linux, `start` on Windows)

The script opens the login page in the user's normal browser and does not launch
a debugging session, read the browser profile, or modify any browser settings.
