---
name: upload-session
description: Upload Claude Code or OpenAI JSONL session transcripts to joe-store. Use when the user asks to upload, save, or send a session to joe-store, authenticate with joe-store, switch joe-store accounts, or check joe-store authentication.
---

# Upload Session to joe-store

Use the bundled `scripts/joestore.mjs` command to authenticate and upload a
session transcript to joe-store's `PUT /session` endpoint.

## Requirements

- macOS with a Chromium-based default browser
- Node.js 22 or newer

## Workflow

1. Determine this skill's installation directory: it is the directory that
   contains this `SKILL.md` file. Do not assume which agent-specific skills
   directory was used.
2. Run the bundled script with an absolute path:

   ```bash
   node <skill-directory>/scripts/joestore.mjs upload
   ```

   To upload a specific Claude Code or OpenAI JSONL transcript, provide its
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
modified `*.jsonl` under the current project's Claude Code session directory.
It infers the provider from the path: paths containing `openai` or `rollout-`
use `openai`; all other paths use `claude`.

## Authentication

On first use, the script opens the joe-store login page in a temporary profile
in the user's default browser. It reads the Supabase access token from the page
after login and stores it at `~/.joestore/token.json`. Later uploads reuse a
valid cached token. If the server returns `401`, the script prompts for login
once and retries.

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
- `JOESTORE_PROVIDER`: set to `claude` or `openai` to override path-based
  provider detection
- `JOESTORE_BROWSER`: optional path to a Chromium-based browser executable;
  overrides the macOS default browser

The temporary browser profile is deleted when authentication finishes. The
script does not modify the user's normal browser profile.
