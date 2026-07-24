# PICK THE LOCK — notes for Claude

Browser recreation of Dota 2's Dark Carnival lockpicking minigame.
Single-file game: all logic and rendering live in `index.html`
(vanilla JS + vendored Three.js, no build step).

## Parameters

The game's design and every tunable parameter are documented in
**`DESIGN.md`**. The gameplay constants sit at the top of the
`<script type="module">` in `index.html`, annotated with the original
`m_*` field names from the game's vdata where applicable.

**Any change to a gameplay parameter must also be reflected in
`DESIGN.md`** — keep the two in sync, including which tier the value
belongs to (exact from vdata / interpreted / tuned by feel).

## Working on the game

- ES modules don't load over `file://`: serve the repo root
  (`python3 -m http.server`) and open `/dota2/pickthelock/`.
- `#autostart` hash skips the menu (used for automated screenshots);
  `#calibrate` turns clicks into background-image coordinate readouts
  for positioning scene props.
- Scene props (Slark, arm, candle flames) are anchored in the
  1200×1600 background-image coordinate space; UI layout is in stage
  units. Headless Chrome enforces a ~500px minimum window width, so
  narrow-viewport screenshots lay out wider than requested.
- `canvas2d.html` is a frozen pre-Three.js version; don't extend it.

## Assets

Art, audio, and fonts under `assets/` are extracted from a local
Dota 2 installation and are © Valve Corporation (fan use; the game
displays an attribution notice). Don't copy them elsewhere or ship
them in other projects. The extraction pipeline and tooling are
documented in `EXTRACTION.md`.
