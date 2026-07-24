# PICK THE LOCK — design notes

A browser recreation (vanilla JS + Three.js, no build step) of the lockpicking
minigame from Dota 2's Dark Carnival event. Gameplay parameters were taken from
the game's own data file (`scripts/events/dark_carnival/lockpicking/game.vdata`,
class `CDOTALockpickingGameDefinition`); where the data was ambiguous, values
were verified empirically (screenshot measurements) or tuned by feel.

## Core loop

A needle sweeps around a ring at constant speed, starting at 12 o'clock moving
clockwise. Colored wedges spawn on the ring and shrink until they vanish.
Clicking (or tapping, or Space) while the needle is over a wedge **captures**
it: +1,000 points and the needle reverses direction. Blue wedges also grant
+1.5 s. Clicking empty track is a **miss**: the needle drops to a crawl before
recovering, and the boost is forfeited. When the clock runs out the run ends:
**≥ 6,000 points opens the lock** (win); less is a loss.

## Parameters

### From the game's vdata (exact)

| Parameter | Value | vdata field |
|---|---|---|
| Time limit | 30 s | `m_flTimeLimit` |
| Points per capture | 1,000 | `m_nScorePerUnlock` |
| Time per blue capture | +1.5 s | `m_flTimerIncreasePerUnlock` |
| Needle base speed | 40°/s | `m_flInitialSpeed` |
| Boost cap (hold RMB / lock) | 3.2× | `m_flMaxSpeedMultiplier` |
| Speed gain per capture | 0 | `m_flSpeedIncrementPerUnlock` |
| Wedge width at spawn | 2·asin(40/180) ≈ 25.7° | `m_nUnlockRadius` on `m_nBoardRadius` (geometric reading, verified by measuring gameplay screenshots) |
| Min gap between wedges | 20° center-to-center | `m_flMinDegreesBetweenUnlocks` |
| Max wedges on board | 6 | `m_nMaxUnlocksOnBoard` |
| Blue chance | 15% + 4% pity per yellow spawn, reset on blue | `m_flTimerIncreaseUnlockChance`, `m_flTimerIncreaseUnlockEscalatingChance` |

### Interpreted (semantics not recoverable from data)

| Behavior | Value | Basis |
|---|---|---|
| Wedge shrink | 3°/s per side (~4.3 s life) | `m_flUnlockDegreeDecreaseRate`, read as per-side to match observed pacing |
| Spawn interval | 1.4 s at start, −0.04 s per second, floor 0.3 s | `m_flBaseUnlockAppearRate`, `m_flUnlockAppearIncreaseRate` read as interval |
| Boost ramp | multiplier compounds ~1×/s (cap in ~1.1 s) | `m_flSpeedBoostRate × m_flSpeedBoostPercentage`, scaled 1.4× by feel |

### Tuned by feel (not in the data)

| Behavior | Value |
|---|---|
| Win threshold | 6,000 points (observed in-game) |
| Miss: crawl speed / duration | 35% of base speed for 0.5 s |
| Miss: recovery acceleration | 460°/s² |
| Miss: cooldown between misses | 0.8 s (decoupled from the penalty) |
| Miss: shock effect | 0.22 s judder + red wash |
| Boost decay on release | ~2.5×/s |
| Click grace beyond wedge edge | 2° |
| Restart misclick guard after game over | 2 s (R and the ↻ button bypass it) |
| Maximum run length | 180 s of simulated time (see below) |

## Simulation

The game proper lives in `engine.js`: a fixed-timestep, seeded, side-effect-free
core. `index.html` drives and draws it but makes no gameplay decisions of its
own. A run is fully described by **a seed plus a list of tick-stamped inputs**,
so it can be replayed anywhere and reproduce the same score exactly — which is
what lets a leaderboard verify a submitted run instead of trusting a number the
client reports. A typical run's inputs encode to well under 200 bytes.

Three properties hold that together, and breaking any of them breaks replay:

- **Fixed 120 Hz timestep.** Wall-clock time only decides how many ticks to run,
  so the game plays identically on a 60 Hz phone, a 120 Hz ProMotion screen and
  a 144 Hz monitor; previously it did not, and a stuttering tab literally ran
  the clock slow. A frame gap longer than 250 ms is dropped rather than
  fast-forwarded, so a stalled tab loses simulated time instead of teleporting
  the needle. 120 Hz divides evenly into the two common display rates, keeps the
  input quantum (8.3 ms) well under human timing precision, and moves the needle
  ~1° per tick at max boost so nearly-expired wedges stay hittable. The binding
  constraint on going higher is server verification cost, not the client: a tick
  is ~50 ns, but a worst-case run doubles from ~1 ms to ~2 ms of verifier CPU,
  against a 10 ms budget per request on Cloudflare's free tier.
- **Seeded randomness.** Wedge placement and the blue roll come from a seeded
  integer PRNG. Cosmetic randomness (particles, voice lines, blinking) stays in
  the host and never touches the sim. A leaderboard would have to issue seeds: a
  client that picks its own seed can reroll until it gets a favourable board.
- **No transcendental functions in the sim.** IEEE-754 pins `+ - * / %` and
  `abs/min/max` to the last bit on every engine, but `Math.sin/asin` may differ
  by an ULP between V8, SpiderMonkey and JSC — and one ULP can flip a hit into a
  miss, failing an honest player's run. Constants derived from transcendentals
  are written out as literals. Verified: a run recorded in Chrome replays
  identically in Node and in JavaScriptCore, down to the full-precision duration.

`MAX_RUN_TIME` (180 s) caps a run: past it, blue wedges still score but stop
adding time. Comparing the ~0.36 s a capture is worth against the 0.3 s spawn
floor suggests perfect play could extend a run forever, but that ignores the
forced direction reversal on capture, which sends the needle back over cleared
track and holds the achievable rate (~1.4 captures/s) under the ~2.75/s
break-even. Measured over 500 seeds, optimal play ends by itself at a median of
68 s and a maximum of 126 s. The cap is therefore a safety bound — it keeps a
hostile trace from costing a verifier unbounded work — not a fix for a live
exploit, and it sits above every measured run so it never truncates a real one.

`engine.test.mjs` (`node engine.test.mjs`) guards all of this. Every finished
run is also replayed in the browser and logged to the console if it diverges, so
a change that quietly breaks determinism surfaces on the next run.

There is no leaderboard and no ranked mode: the game is single-player and scores
stay on the device. The replayability above exists so that adding one later is a
matter of issuing seeds and verifying traces server-side, rather than a rewrite.

## Presentation

- Fixed-aspect stage (0.76, the original popup's shape) letterboxed into any
  viewport; the letterbox shows a dimmed, magnified copy of the stage art.
  All layout is in stage units; scene props (Slark, arm, candle flames) are
  anchored in background-image coordinates.
- Needle, sparks, and candle flames are additive shader effects; wedges are
  GLSL ring segments with the lock texture composited in. Blue wedges pulsate.
- Fonts, art, and audio are extracted from the game's files (Radiance /
  RadianceM for text; music, stingers, and Slark voice lines for audio).
- Inputs: LMB/tap/Space = pick, RMB/S hold = boost, T or the on-screen
  toggle = boost lock, R / ↻ = restart, P = pause. Separate mute toggles
  for effects and music/voice. The mute toggles, the boost lock, and the
  best score persist in localStorage; the menu shows the personal best.

## Attribution

Fan recreation for personal use. Dota 2 art, audio, and fonts © Valve
Corporation. Not affiliated with or endorsed by Valve.
