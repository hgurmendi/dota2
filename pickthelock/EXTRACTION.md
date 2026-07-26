# Asset extraction — how `assets/` was produced

All game art, audio, data, and fonts were extracted from a locally installed
Dota 2 client on macOS. This documents the pipeline so it can be reproduced.

## Sources

- **VPK archives** — most assets live in Valve Pak files:
  `~/Library/Application Support/Steam/steamapps/common/dota 2 beta/game/dota/pak01_dir.vpk`
  (the `_dir` index plus numbered data chunks).
- **Loose files** — fonts ship uncompiled in
  `game/dota/panorama/fonts/` (`.otf`), copied directly.
- **dota2.com** — `favicon.ico` was downloaded from the official site.

## Tools

| Tool | Purpose |
|---|---|
| [`vpk`](https://pypi.org/project/vpk/) (Python, via pip) | List the VPK index and extract files by path |
| [ValveResourceFormat](https://github.com/ValveResourceFormat/ValveResourceFormat) — Source2Viewer-CLI 19.2 (macOS arm64) | Decompile Source 2 compiled formats |
| Pillow (Python) | Measurements (sprite bounds, anchor positions) and sheet assembly |

Source 2 ships everything compiled; the CLI (`-i <in> --recursive -o <out> -d`)
converts:

| Compiled | Decompiled | Used for |
|---|---|---|
| `.vtex_c` | PNG | All textures/sprites |
| `.vsnd_c` | MP3 | Music, stingers, SFX, voice lines |
| `.vdata_c` | KV3 text | Gameplay parameters (see `DESIGN.md`) |
| `.vpcf_c` | text | Reading particle systems to find which sprite textures they reference |
| `.vxml_c` / `.vcss_c` | XML / CSS | Inspecting the original popup's layout and font choices |

## What came from where

- `panorama/images/events/dark_carnival/lockpicking/` — lock body, dial,
  shackle, sign, dungeon background, Slark head (8×8 flipbook sheet, cropped
  to 2×2 here — see Post-processing) and arm.
- `panorama/images/events/dark_carnival/overworld/minigames/` — the icon each
  minigame shows on the event's minigame board. `encounter_pick_the_lock_icon`
  is this game's, used on the site's game card; its siblings name the other
  four minigames (`whack_a_mole`, `jail_break`, `blimp_jump`, `assembly`).
- `panorama/images/events/dark_carnival/overworld/encounter_node_container` —
  the hexagonal frame those icons sit in on the board. Kept separate rather
  than pre-composited so every game's card can reuse it.
- `sounds/misc/dark_carnival/` — lockpick SFX (`lockpick_*`), minigame music
  (`minigame_mus_lp_01..05`), win/lose stingers (`minigame_mus_win/lose_*`).
- `sounds/vo/event_dark_carnival_slark_games/` — Slark voice lines
  (`slark_lockpick_gameover_*`, `slark_lockpick_unlocked_*`).
- `materials/particle/` — `yellowflare2` (miss spark star) and `softglow_tra`
  (glows, needle tip, candle halos); found by decompiling the lockpicking
  `.vpcf_c` particle systems and reading their texture references.
- `scripts/events/dark_carnival/lockpicking/game.vdata_c` — the
  `CDOTALockpickingGameDefinition` tuning data (not shipped; transcribed into
  `DESIGN.md` and the constants in `index.html`).
- `panorama/fonts/` — `radiance-semibold.otf` (UI text) and
  `radiancem-semibold.otf` (digits-only monospace-numbers face). The original
  popup's CSS names the alias `monospaceNumbersFont`, which maps to RadianceM.

## Post-processing

Decompilation yields PNGs. The scene art is painted, so PNG stored it at roughly
15× the necessary size; everything except the two small additive effect textures
(`yellowflare2`, `softglow_tra`, left as PNG so lossy banding can't show in the
glows) is re-encoded to WebP, taking `assets/` from 3.9 MB to 226 KB with no
visible difference:

```bash
# scene art, no alpha to preserve
cwebp -q 88 lockpicking_background_psd.png -o lockpicking_background.webp
# sprites with alpha
cwebp -q 90 -alpha_q 100 lock_background_psd.png -o lock_background.webp
# Slark: the extracted flipbook is 8x8 (64 blink/eye variants) but the game
# shows only three of them, so crop to the top-left 2x2 block —
# idle (0,0), blink (1,0), capture reaction (0,1)
cwebp -q 90 -alpha_q 100 -crop 0 0 840 1000 slark_head_psd.png -o slark_head.webp
```

The `_psd.png` originals are not kept in the repo; regenerate them with the
steps above if the art ever needs re-cutting.

## Reproducing

```bash
pip install vpk pillow
python3 - <<'EOF'
import vpk
pak = vpk.open("/path/to/dota 2 beta/game/dota/pak01_dir.vpk")
pak["panorama/images/events/dark_carnival/lockpicking/lock_dial_psd.vtex_c"].save("out/lock_dial_psd.vtex_c")
EOF
# then decompile:
./Source2Viewer-CLI -i out -o decompiled --recursive -d
```

## Note

All extracted material is © Valve Corporation, used here as a personal fan
project with an in-game attribution notice. Don't reuse these assets outside
this project.
