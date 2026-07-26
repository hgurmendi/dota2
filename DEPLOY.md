# Deploying

The site runs as a single Cloudflare Worker at `dota2.gurmen.com.ar`:
`worker/index.ts` serves the leaderboard API under `/api/*` and hands
everything else — the root page and every minigame — to the static asset
server. Configuration lives in `wrangler.toml` and is version-controlled.

The two secrets are the only things that cannot be: Cloudflare stores them
encrypted and never returns them, so they are set once with
`wrangler secret put` and never appear in the repo.

## What is where

| | |
|---|---|
| `wrangler.toml` | Worker name, entry point, assets, bindings, build+test gate |
| `tsconfig.*.json` | browser and Worker are checked separately; see the base config |
| `build.mjs` | esbuild step for the browser bundles |
| `.assetsignore` | what is **not** uploaded — server code, docs, tests, tooling |
| `leaderboard/schema.sql` | D1 schema (players + per-game runs) |
| `.dev.vars.example` | template for local secrets; copy to `.dev.vars` |
| `.github/workflows/test.yml` | builds, type-checks and runs every suite on push and PR |

`.assetsignore` is load-bearing, not cosmetic: without it Wrangler tries to
upload `node_modules/` and fails on the 25 MiB asset limit. It is what keeps
`leaderboard/*.ts` off the public site — and `leaderboard/dev-server.ts` reads
it directly, so the local server blocks the same set instead of a copy of the
list that drifts.

## Local development

```bash
npm install
npm run build             # browser bundles (gitignored artifacts)
npm test                  # type-check both projects, then both suites
npm run dev               # builds, then serves on plain node
npm run dev:wrangler      # wrangler dev — closer to production, emulates D1
```

The sources are TypeScript. Wrangler compiles the Worker itself; `npm run
build` produces the browser bundles with esbuild. Both target ES2022 —
`pickthelock/engine.ts` runs on both sides and the leaderboard depends on
them agreeing, so neither may be downlevelled.

`npm run dev` serves <http://localhost:8787/>. Steam accepts
an `http://localhost` `return_to`, so a real end-to-end login can be tested
locally once `STEAM_API_KEY` is set:

```bash
SESSION_SECRET=dev STEAM_API_KEY=<key> npm run dev
```

## Standing it up from scratch

The runbook for a fresh Cloudflare account. `wrangler.toml` already carries the
real values for the account this deploys to, so nothing here is commented out
waiting to be enabled — on an existing checkout only steps 1, 3 and 4 apply.

1. **Authenticate.** `npx wrangler login`

2. **Create the database.**
   ```bash
   npx wrangler d1 create dota2
   ```
   Paste the printed `database_id` over the one already in the
   `[[d1_databases]]` block in `wrangler.toml`. The id is an identifier, not a
   credential — it belongs in the repo.

3. **Apply the schema.** `npm run db:init`

4. **Set the secrets.** These are the only two values not in version control.
   ```bash
   openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET
   npx wrangler secret put STEAM_API_KEY   # steamcommunity.com/dev/apikey
   ```
   Rotating `SESSION_SECRET` signs every user out — that is the intended
   revocation mechanism, since sessions are stateless signed cookies.

5. **Point `[[routes]]` at a hostname you hold.** The block names
   `dota2.gurmen.com.ar`. `custom_domain = true` has Cloudflare create the DNS
   record on deploy, so the zone must belong to the account. Leave
   `workers_dev = false` alone — the reason is in `wrangler.toml`, and it is a
   security property, not a preference.

6. **Deploy.** `npm run deploy`
   The `[build]` command runs `npm test` first — build, type-check, all three
   suites — and a failure stops the deploy. The Worker lands on the hostname
   from step 5; check the game loads and `/api/status` reports `auth: true`.

7. **Connect Git so the Worker tracks `main`.** Workers dashboard → the
   Worker → Settings → Builds → connect `hgurmendi/dota2`, branch `main`.
   Cloudflare then runs `npm test` (build + type-check + all suites) on every
   push and deploys only if it passes.

   Set `NODE_VERSION` = `24` under **Builds → Build configuration →
   Environment variables**, not under Settings → Variables. The two are
   different settings and only the build one is read at build time.

   24 is the active LTS; 22 went to maintenance in March 2026. `.nvmrc` pins
   the same version locally. The scripts still pass `--experimental-strip-types`
   so they keep working on 22 — on 24 the flag is a no-op, since type stripping
   is on by default there.

   Once this is connected, prefer pushing over `npm run deploy` — a CLI deploy
   puts the Worker ahead of `main`, which is the drift the connection exists to
   prevent. `wrangler deployments list` shows what is actually live and where
   it came from.

## A trap worth knowing

`wrangler deploy` treats this repo as the source of truth for *plaintext*
variables and routes, and overwrites whatever the dashboard has:

```
vars: { -  NODE_VERSION: "22" }
Uploading the Worker will override the remote configuration with your local one.
```

That is a real deploy, not a hypothetical — a CLI deploy silently deleted a
`NODE_VERSION` that had been set in the dashboard. **Secrets survive deploys;
plaintext vars do not.** So anything that must persist belongs either in
`[vars]` here, or in a setting `wrangler deploy` does not manage, such as the
build environment.

## Notes

- Static asset requests are free and unlimited; only `/api/*` invokes the
  Worker and counts against the quota (100k/day free).
- The free tier allows 10 ms CPU per invocation. Worst-case run verification
  is ~1.1 ms, which is why the simulation runs at 120 Hz — see `engine.ts`.
- Without `SESSION_SECRET` the auth endpoints return 503 and `/api/status`
  reports `auth: false`, rather than half-working. Deploying before step 4 is
  safe.
