# Frontend change: CLI loopback callback

The `joestore.mjs` skill authenticates with the standard CLI loopback-OAuth
pattern (like `gh auth login` / `gcloud`): the frontend hands the access token
back to a small local server, instead of the CLI reading it out of the browser.

1. The CLI starts a one-shot HTTP server on a random `127.0.0.1` port.
2. It opens the login page with two query params:
   - `cli_redirect` — e.g. `http://127.0.0.1:53124/callback`
   - `state` — a random hex string for CSRF protection
3. After the user signs in, **the frontend must redirect the browser back to
   `cli_redirect`**, appending the access token and echoing `state`:

   ```
   http://127.0.0.1:53124/callback?access_token=<JWT>&state=<same state>
   ```

The CLI's loopback server validates `state`, reads `access_token`, shows a
"you can close this tab" page, and caches the token. The token never leaves the
machine.

## Implementation (joe-store-frontend)

This is implemented in the SvelteKit frontend:

- `src/lib/auth.ts` — `captureCliLoginRequest(search)` stashes a valid loopback
  `cli_redirect` + `state` in `sessionStorage` (so it survives the Supabase OAuth
  round-trip), and `takeCliLoginRedirect(session)` returns the loopback URL with
  `access_token` + `state` attached. `isLoopbackCallback()` is the security guard.
- `src/routes/login/+page.svelte` — calls `captureCliLoginRequest(window.location.search)`
  on mount, and once `getSession()` yields a session, `window.location.replace()`s
  to the loopback callback returned by `takeCliLoginRedirect(session)` (falling back
  to the normal in-app redirect when there is no pending CLI request).

The CLI params are stashed in `sessionStorage` on first load, so they persist
across the Google/GitHub OAuth navigation without being forwarded through the
provider's `redirectTo`.

## Why loopback-only matters

`cli_redirect` is attacker-influenceable (it's a URL param). If the page
redirected to *any* host, someone could craft a login link that ships the user's
token to their own server. Restricting the redirect target to
`http://127.0.0.1|localhost/callback` keeps the token on the user's machine.

## Optional hardening

- **Fragment instead of query.** Put the token in the URL fragment
  (`#access_token=...`) and have a tiny page on the loopback server read it via
  JS, so the token isn't in a URL that could be logged. For a purely local
  loopback server this is optional; the query form above is acceptable.
- **Short-lived / single-use.** If the backend can mint a short-lived,
  single-use token specifically for the CLI exchange, prefer that over handing
  back the full Supabase session JWT.
