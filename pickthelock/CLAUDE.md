# PICK THE LOCK — notes for Claude

Browser recreation of Dota 2's Dark Carnival lockpicking minigame.
Vanilla JS + vendored Three.js, no build step. Two files matter:

- **`engine.js`** — the game. A fixed-timestep, seeded, side-effect-free
  simulation with no DOM, audio or rendering. A run is fully described by
  a seed plus tick-stamped inputs, and replaying it must reproduce the
  score exactly; that is what will let a leaderboard verify submitted runs
  instead of trusting a client-reported score.
- **`index.html`** — the host. Drives and draws the sim, and owns
  everything the sim must not know about (sound, particles, screens,
  input devices). **It must never make a gameplay decision of its own.**

### Rules for editing `engine.js`

The header comment states these in full; the short version is: fixed
timestep only, no `Math.random()`, no `Math.sin/cos/asin/pow` (an ULP of
disagreement between JS engines can flip a hit into a miss), no `Date` or
`performance.now()`. Constants derived from transcendentals are written
out as literals with the expression in the comment.

Run **`node engine.test.mjs`** after any change to it. The host also
re-simulates every finished run in the browser and logs to the console if
the replay diverges, so watch devtools while playing.

## Parameters

The game's design and every tunable parameter are documented in
**`DESIGN.md`**. The gameplay constants sit at the top of `engine.js`,
annotated with the original `m_*` field names from the game's vdata where
applicable.

**Any change to a gameplay parameter must also be reflected in
`DESIGN.md`** — keep the two in sync, including which tier the value
belongs to (exact from vdata / interpreted / tuned by feel).

## Working on the game

- ES modules don't load over `file://`: serve the repo root and open
  `/pickthelock/`. `npm run dev` (from the repo root) serves the site and the
  leaderboard API together; `python3 -m http.server` also works if only the
  game matters. See `../DEPLOY.md`.
- `#autostart` hash skips the menu (used for automated screenshots);
  `#calibrate` turns clicks into background-image coordinate readouts
  for positioning scene props.
- `window.__lockpick` exposes the run, the last result and start/pick for
  automation. Exposing it is deliberate: a browser game can't keep its own
  state secret anyway, which is exactly why the replay design never trusts
  a reported score.
- Note that hash-only navigation doesn't reload the document; force a
  real reload when scripting screenshots across hashes.
- Scene props (Slark, arm, candle flames) are anchored in the
  1200×1600 background-image coordinate space; UI layout is in stage
  units. Headless Chrome enforces a ~500px minimum window width, so
  narrow-viewport screenshots lay out wider than requested.
- `canvas2d.html` is a frozen pre-Three.js version; don't extend it.
- localStorage keys: `lockpick_sfx`, `lockpick_music`,
  `lockpick_boostlock` (preference toggles), `lockpick_best`
  (high score).

## Assets

Art, audio, and fonts under `assets/` are extracted from a local
Dota 2 installation and are © Valve Corporation (fan use; the game
displays an attribution notice). Don't copy them elsewhere or ship
them in other projects. The extraction pipeline and tooling are
documented in `EXTRACTION.md`.
