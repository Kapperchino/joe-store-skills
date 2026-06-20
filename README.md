# joe-store upload session skill

[![skills.sh](https://skills.sh/b/Kapperchino/joe-store-skills)](https://skills.sh/Kapperchino/joe-store-skills)

An agent skill for uploading Claude Code and OpenAI JSONL session transcripts
to [joe-store](https://joe-store-frontend.onrender.com).

## Install

```bash
npx skills add Kapperchino/joe-store-skills
```

The skill works with the agents supported by the
[skills CLI](https://skills.sh/docs). It requires macOS, Node.js 22 or newer,
and Brave Browser installed in `/Applications`.

## What it does

The bundled zero-dependency Node.js script:

1. Opens the joe-store login page in a temporary Brave profile when
   authentication is required.
2. Caches the resulting Supabase access token at `~/.joestore/token.json`.
3. Finds the current project's latest Claude Code transcript, or accepts an
   explicit Claude Code or OpenAI JSONL transcript path.
4. Uploads the transcript to joe-store.

Review [SKILL.md](SKILL.md) for the complete agent workflow and configuration.
