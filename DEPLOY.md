# Deploying

The site runs as a single Cloudflare Worker at `dota2.gurmen.com.ar`:
`worker/index.js` serves the leaderboard API under `/api/*` and hands
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
| `.github/workflows/test.yml` | runs both suites on push and PR |

`.assetsignore` is load-bearing, not cosmetic: without it Wrangler tries to
upload `node_modules/` and fails on the 25 MiB asset limit. It is what keeps
`leaderboard/*.js` off the public site.

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

## First deploy

Each step is one command; nothing here is reversible-by-accident.

1. **Authenticate.** `npx wrangler login`

2. **Create the database.**
   ```bash
   npx wrangler d1 create dota2
   ```
   Paste the printed `database_id` into the `[[d1_databases]]` block in
   `wrangler.toml` and uncomment it. The id is an identifier, not a
   credential — it belongs in the repo.

3. **Apply the schema.** `npm run db:init`

4. **Set the secrets.** These are the only two values not in version control.
   ```bash
   openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET
   npx wrangler secret put STEAM_API_KEY   # steamcommunity.com/dev/apikey
   ```
   Rotating `SESSION_SECRET` signs every user out — that is the intended
   revocation mechanism, since sessions are stateless signed cookies.

5. **Deploy.** `npm run deploy`
   The `[build]` command runs both test suites first; a failure stops the
   deploy. The Worker lands on `dota2.<subdomain>.workers.dev` — check
   the game loads and `/api/status` reports `auth: true`.

6. **Attach the domain.** Uncomment the `[[routes]]` block in `wrangler.toml`
   with the real hostname and deploy again.

7. **Connect Git so the Worker tracks `main`.** Workers dashboard → the
   Worker → Settings → Builds → connect `hgurmendi/dota2`, branch `main`.
   Cloudflare then runs `npm test` (build + type-check + all suites) on every
   push and deploys only if it passes.

   Set `NODE_VERSION` = `22` under **Builds → Build configuration →
   Environment variables**, not under Settings → Variables. The test scripts
   run TypeScript through `node --experimental-strip-types`, which needs Node
   22+. The two are different settings and only the build one is read at build
   time.

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
  is ~1.1 ms, which is why the simulation runs at 120 Hz — see `engine.js`.
- Without `SESSION_SECRET` the auth endpoints return 503 and `/api/status`
  reports `auth: false`, rather than half-working. Deploying before step 4 is
  safe.
