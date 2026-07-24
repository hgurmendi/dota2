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
  for effects and music/voice.

## Attribution

Fan recreation for personal use. Dota 2 art, audio, and fonts © Valve
Corporation. Not affiliated with or endorsed by Valve.
