# joe-store upload session skill

[![skills.sh](https://skills.sh/b/Kapperchino/joe-store-skills)](https://skills.sh/Kapperchino/joe-store-skills)

An agent skill for uploading Claude Code, OpenAI, and Cursor JSONL session
transcripts to [joe-store](https://joe-store-frontend.onrender.com).

## Install

```bash
npx skills add Kapperchino/joe-store-skills
```

The skill works with the agents supported by the
[skills CLI](https://skills.sh/docs). It requires Node.js 22 or newer and a web
browser (macOS, Linux, or Windows).

## What it does

The bundled zero-dependency Node.js script:

1. Opens the joe-store login page in the user's normal browser and receives the
   access token back over a local `127.0.0.1` loopback callback (a standard CLI
   OAuth flow — no browser profile, cookies, or storage are read).
2. Caches the resulting Supabase access token at `~/.joestore/token.json`.
3. Finds the current project's latest Claude Code or Cursor transcript, or
   accepts an explicit Claude Code, OpenAI, or Cursor JSONL transcript path.
4. Uploads the transcript to joe-store.

Review [SKILL.md](SKILL.md) for the complete agent workflow and configuration.
