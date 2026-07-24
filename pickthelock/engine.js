"use strict";
/**
 * PICK THE LOCK — deterministic simulation core.
 *
 * This module is the authoritative game. It has no DOM, audio, rendering or
 * timing dependencies: the same (seed, inputs) pair must produce the same
 * result in a browser, in Node, and in a Cloudflare Worker. That property is
 * what lets a leaderboard verify a run server-side instead of trusting a score
 * the client reports.
 *
 * DETERMINISM RULES — read before editing:
 *
 *  1. Fixed timestep only. The sim advances in whole TICK ticks of DT seconds.
 *     Never pass a wall-clock delta in here.
 *
 *  2. No Math.random(). Gameplay randomness comes from rnd(), a seeded
 *     integer PRNG. Cosmetic randomness (particles, voice lines, blinking)
 *     belongs in the host, not here.
 *
 *  3. No transcendental functions. IEEE-754 pins down + - * / % and
 *     abs/min/max to the last bit on every engine, but Math.sin/cos/asin/pow
 *     are allowed to differ by an ULP between V8, SpiderMonkey and JSC. A
 *     one-ULP drift can flip a hit into a miss, which would fail an honest
 *     player's run on a browser we didn't verify on. Constants derived from
 *     transcendentals are written out as literals below, with the expression
 *     that produced them kept in the comment.
 *     Math.PI is exempt: the spec pins it to one exact double, so multiplying
 *     and dividing by it is reproducible.
 *
 *  4. No iteration over object/Map key order, no Date, no performance.now().
 *
 * Parameters are documented in DESIGN.md — keep the two in sync.
 */

// ---------- Timebase ----------
// 120Hz. It divides evenly into the two common display rates (60 and 120), so
// the usual case is a whole number of ticks per frame; the 8.3ms input quantum
// sits well under human timing precision (tens of ms); and at max boost the
// needle advances ~1 degree per tick, so even a nearly-expired wedge — whose
// hit window is only a few degrees wide including grace — still gets several
// ticks of opportunity. Going higher mostly costs server verification time,
// which is the binding constraint (see MAX_TICKS); going to 60 makes the input
// quantum a whole display frame and thin wedges start to feel lumpy.
export const TICK = 120;                 // simulation ticks per second
export const DT = 1 / TICK;              // seconds per tick (exact same double everywhere)

// ---------- Tunables ----------
// From Dota 2's scripts/events/dark_carnival/lockpicking/game.vdata
// (CDOTALockpickingGameDefinition, TIME_ATTACK stage). Angles in degrees
// there, radians here.
const DEG = Math.PI / 180;
export const START_TIME      = 30;          // m_flTimeLimit
export const HIT_SCORE       = 1000;        // m_nScorePerUnlock
export const WIN_SCORE       = 6000;        // observed minimum score to open the lock
const BLUE_TIME_BONUS = 1.5;                // m_flTimerIncreasePerUnlock
const BASE_SPEED      = 40 * DEG;           // m_flInitialSpeed (deg/s)
export const MAX_SPEED_MULT  = 3.2;         // m_flMaxSpeedMultiplier (boost cap)
const BOOST_RAMP      = 6 * 0.12 * 1.4;     // m_flSpeedBoostRate * m_flSpeedBoostPercentage,
                                            // scaled 1.4x by feel: ~1x/s compounding,
                                            // hits the 3.2x cap in ~1.1s
const BOOST_DECAY     = 2.5;                // release decay (not in vdata; tuned)
const MISS_STALL      = 0.5;                // seconds crawling after a miss (tuned)
const MISS_CRAWL      = BASE_SPEED * 0.35;  // crawl speed while penalized
const MISS_COOLDOWN   = 0.8;                // min seconds between misses (decoupled from
                                            // the speed penalty so recovery stays snappy)
const RECOVER_ACCEL   = 460 * DEG;          // deg/s^2 back up to speed
// m_nUnlockRadius=40 is a circle radius in board units (m_nBoardRadius=180):
// 2*asin(40/180) = 25.679 deg of arc. Verified by measuring wedges in a
// gameplay screenshot. Written out as a literal per determinism rule 3.
export const WEDGE_SIZE = 0.4481861846027417; // === 2 * Math.asin(40 / 180)
export const WEDGE_HALF = WEDGE_SIZE / 2;
const WEDGE_SHRINK    = 3 * DEG;            // m_flUnlockDegreeDecreaseRate (deg/s per side)
const WEDGE_MIN_HALF  = 0.25 * DEG;         // sliver-thin before vanishing
const MIN_GAP         = 20 * DEG;           // m_flMinDegreesBetweenUnlocks (center-to-center)
const SPAWN_BASE      = 1.4;                // m_flBaseUnlockAppearRate (s between spawns)
const SPAWN_RAMP      = 0.04;               // m_flUnlockAppearIncreaseRate (interval shrink /s)
const SPAWN_MIN       = 0.3;                // floor for the spawn interval
const SPAWN_FIRST     = 0.4;                // delay before the first wedge
const SPAWN_CLEARANCE = 0.25;               // keep spawns this far off the needle (rad)
export const MAX_ARCS = 6;                  // m_nMaxUnlocksOnBoard
const SPAWN_TRIES     = 12;                 // placement attempts before giving up this tick
const BLUE_BASE_CHANCE = 0.15;              // m_flTimerIncreaseUnlockChance
const BLUE_ESCALATION  = 0.04;              // m_flTimerIncreaseUnlockEscalatingChance
const NEEDLE_GRACE     = 2.0 * DEG;         // hit tolerance beyond wedge edges

// Hard ceiling on a single run, in seconds of simulated time. Past it, blue
// wedges still score, they just stop adding time, so the clock always drains.
//
// Blue wedges add 1.5s and the pity counter makes roughly one spawn in four
// blue, so a capture is worth ~0.36s of time, while the spawn interval floors
// out at 0.3s. Comparing those two numbers alone suggests a player who
// captures everything gains time faster than the clock burns it and never
// stops. That turns out to be wrong: capturing reverses the needle, sending it
// back over track it just cleared, and that caps the achievable capture rate
// (~1.4/s) well under the ~2.75/s break-even. Optimal play measured over 500
// seeds ends on its own at a median of 68s and a maximum of 126s.
//
// So this is a safety bound, not a fix for a live exploit: it keeps a hostile
// trace from costing the verifier unbounded work, and it caps replay size. It
// sits above every measured bot run, so it can never truncate a real one.
export const MAX_RUN_TIME = 180;
export const MAX_TICKS = MAX_RUN_TIME * TICK;

const TAU = Math.PI * 2;

// ---------- PRNG ----------
// mulberry32: 32-bit integer ops plus one division by 2^32, all exactly
// specified, so the stream is identical on every JS engine.
function rnd(s) {
  s.rng = (s.rng + 0x6d2b79f5) | 0;
  let t = s.rng;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ---------- Angle helpers ----------
function norm(a) {
  a %= TAU;
  return a < 0 ? a + TAU : a;
}
function angDist(a, b) {
  const d = Math.abs(norm(a) - norm(b));
  return Math.min(d, TAU - d);
}

// ---------- Input codes ----------
export const PICK = "P";        // primary press: try to capture
export const BOOST_ON = "B";    // boost held down
export const BOOST_OFF = "R";   // boost released
const CODES = { P: 1, B: 1, R: 1 };

// ---------- Run state ----------

/**
 * Create a run. `seed` is any 32-bit integer; for ranked runs the server issues
 * it so the client can't shop for a favourable board.
 *
 * A run always starts with boost off. The boost-lock toggle persists across
 * runs, so a run can begin with boost already held — but that arrives as a
 * BOOST_ON input on tick 0 like any other press, which keeps a run described by
 * nothing but its seed and its trace. No out-of-band starting state means no
 * way for a client and a verifier to disagree about one.
 */
export function createRun(seed) {
  return {
    seed: seed | 0,
    rng: seed | 0,
    tick: 0,
    over: false,
    won: false,

    timeLeft: START_TIME,
    elapsed: 0,
    score: 0,

    angle: Math.PI / 2,   // needle starts at 12 o'clock like the original
    dir: -1,              // and moves clockwise first
    curSpeed: BASE_SPEED,
    boostMult: 1,
    boostHeld: false,

    missState: 0,         // 0 = normal, 2 = stalled, 3 = recovering
    stallTimer: 0,
    missCd: 0,            // lockout before another miss can register

    blueChance: BLUE_BASE_CHANCE,
    spawnTimer: SPAWN_FIRST,
    arcs: [],             // {id, center, half, color}
    nextArcId: 0,

    captures: 0,
    misses: 0,
    blues: 0,
    picks: 0,

    events: [],           // host drains these for sound and particles
  };
}

/** Take the events accumulated since the last call. */
export function drain(s) {
  if (!s.events.length) return s.events;
  const out = s.events;
  s.events = [];
  return out;
}

function needleOnArc(s, arc) {
  return angDist(s.angle, arc.center) <= arc.half + NEEDLE_GRACE;
}

/**
 * Index of the wedge the needle is currently over, or -1. This is what pick()
 * tests against, exposed so callers can reason about a run without replaying
 * the hit logic: the test bot uses it, and the leaderboard's bot detection
 * will use it to measure how far each press landed from the ideal moment.
 */
export function wedgeUnderNeedle(s) {
  for (let i = 0; i < s.arcs.length; i++) {
    if (needleOnArc(s, s.arcs[i])) return i;
  }
  return -1;
}

// ---------- Inputs ----------

/** Primary press. Captures the wedge under the needle, or takes the miss penalty. */
export function pick(s) {
  if (s.over) return;
  s.picks++;

  let hit = -1;
  for (let i = 0; i < s.arcs.length; i++) {
    if (needleOnArc(s, s.arcs[i])) { hit = i; break; }
  }

  if (hit >= 0) {
    const arc = s.arcs[hit];
    s.score += HIT_SCORE;
    s.captures++;
    if (arc.color === "blue") {
      s.blues++;
      // clamped so the run can't extend past MAX_RUN_TIME (see the constant)
      const room = MAX_RUN_TIME - (s.elapsed + s.timeLeft);
      const gain = Math.min(BLUE_TIME_BONUS, Math.max(0, room));
      s.timeLeft += gain;
      if (gain > 0) s.events.push({ k: "bonus", amount: gain });
    }
    s.dir = -s.dir;                            // reverse, same speed
    s.missState = 0;                           // capturing clears any slow penalty
    s.curSpeed = BASE_SPEED * s.boostMult;
    s.events.push({ k: "capture", angle: s.angle, color: arc.color });
    s.arcs.splice(hit, 1);
    return;
  }

  // Miss: instant drop to a crawl, brief hold, then quick recovery. Boost is
  // forfeited and must recompound from 1x. Presses during an active penalty or
  // inside the cooldown are swallowed, so failures can't chain faster than
  // MISS_COOLDOWN. (Swallowed presses are still recorded by the host, so a
  // replay makes the identical decision here.)
  if (s.missState !== 0 || s.missCd > 0) return;
  s.curSpeed = MISS_CRAWL;
  s.missState = 2;
  s.stallTimer = MISS_STALL;
  s.boostMult = 1;
  s.misses++;
  s.missCd = MISS_COOLDOWN;
  s.events.push({ k: "miss", angle: s.angle });
}

/** Boost held / released (RMB, S, or the boost-lock toggle). */
export function setBoost(s, held) {
  if (s.over) return;
  s.boostHeld = !!held;
}

/** Apply one recorded input code. */
export function applyInput(s, code) {
  if (code === PICK) pick(s);
  else if (code === BOOST_ON) setBoost(s, true);
  else if (code === BOOST_OFF) setBoost(s, false);
}

// ---------- Spawning ----------
function trySpawnArc(s) {
  if (s.arcs.length >= MAX_ARCS) return;
  const half = WEDGE_HALF;
  for (let attempt = 0; attempt < SPAWN_TRIES; attempt++) {
    const center = rnd(s) * TAU;
    // keep new wedges from spawning right under the needle
    if (angDist(center, s.angle) < half + SPAWN_CLEARANCE) continue;
    let clear = true;
    for (const a of s.arcs) {
      // MIN_GAP is center-to-center (wedges may spawn touching edge-to-edge);
      // the max() only prevents actual overlap with wider neighbours
      if (angDist(center, a.center) < Math.max(half + a.half, MIN_GAP)) { clear = false; break; }
    }
    if (!clear) continue;
    // escalating pity: each yellow spawn raises the blue chance until one lands
    const isBlue = rnd(s) < s.blueChance;
    s.blueChance = isBlue ? BLUE_BASE_CHANCE : s.blueChance + BLUE_ESCALATION;
    s.arcs.push({ id: s.nextArcId++, center, half, color: isBlue ? "blue" : "yellow" });
    return;
  }
}

// ---------- Step ----------

/** Advance exactly one tick. Inputs for this tick must be applied first. */
export function step(s) {
  if (s.over) return;
  s.tick++;

  s.missCd = Math.max(0, s.missCd - DT);
  s.elapsed += DT;
  s.timeLeft -= DT;

  if (s.timeLeft <= 0) {
    s.timeLeft = 0;
    s.over = true;
    s.won = s.score >= WIN_SCORE;
    s.events.push({ k: "end", won: s.won, score: s.score });
    return;
  }

  // boost compounds while held, decays when released, pinned at 1x during
  // the miss penalty
  if (s.missState === 0) {
    if (s.boostHeld) {
      s.boostMult = Math.min(MAX_SPEED_MULT, s.boostMult * (1 + BOOST_RAMP * DT));
    } else {
      s.boostMult = Math.max(1, s.boostMult * (1 - BOOST_DECAY * DT));
    }
  }
  const targetSpeed = BASE_SPEED * s.boostMult;

  if (s.missState === 2) {
    s.stallTimer -= DT;
    if (s.stallTimer <= 0) s.missState = 3;
  } else if (s.missState === 3) {
    s.curSpeed += RECOVER_ACCEL * DT;          // constant acceleration back up
    if (s.curSpeed >= targetSpeed) { s.curSpeed = targetSpeed; s.missState = 0; }
  } else {
    s.curSpeed = targetSpeed;
  }
  s.angle = norm(s.angle + s.dir * s.curSpeed * DT);

  // wedges shrink from both sides and expire (~4.3s life at full size)
  for (let i = s.arcs.length - 1; i >= 0; i--) {
    const a = s.arcs[i];
    a.half -= WEDGE_SHRINK * DT;
    if (a.half <= WEDGE_MIN_HALF) s.arcs.splice(i, 1);
  }

  // spawn rate ramps up over the run
  s.spawnTimer -= DT;
  if (s.spawnTimer <= 0) {
    trySpawnArc(s);
    s.spawnTimer = Math.max(SPAWN_MIN, SPAWN_BASE - s.elapsed * SPAWN_RAMP);
  }
}

// ---------- Input trace encoding ----------
// A run is a seed plus a list of {t, a}: tick index and input code. Encoded as
// base36 tick deltas each terminated by its uppercase code letter, e.g.
// "1cP2sB9P". Lowercase digits never collide with the uppercase codes, so the
// string needs no separators. A 60s run is a few hundred bytes.

export function encodeInputs(inputs) {
  let prev = 0, out = "";
  for (const e of inputs) {
    out += (e.t - prev).toString(36) + e.a;
    prev = e.t;
  }
  return out;
}

export function decodeInputs(str) {
  const out = [];
  if (!str) return out;
  let prev = 0;
  const re = /([0-9a-z]+)([PBR])/g;
  let m, consumed = 0;
  while ((m = re.exec(str))) {
    if (m.index !== consumed) throw new Error("bad input trace");
    consumed = re.lastIndex;
    const t = prev + parseInt(m[1], 36);
    if (!(t >= prev)) throw new Error("bad input trace");
    out.push({ t, a: m[2] });
    prev = t;
  }
  if (consumed !== str.length) throw new Error("bad input trace");
  return out;
}

// ---------- Replay ----------

/**
 * Re-run a recorded game and report what actually happened. This is the
 * function a leaderboard server calls: the client's claimed score is never
 * read, only the seed and the inputs, and the score below is the truth.
 *
 * Throws on a malformed trace. Never trusts the caller for termination — the
 * MAX_TICKS bound holds even if the tunables are later changed badly.
 */
export function simulate(seed, inputs) {
  const list = typeof inputs === "string" ? decodeInputs(inputs) : inputs;
  const s = createRun(seed);
  let i = 0;

  while (!s.over && s.tick < MAX_TICKS) {
    while (i < list.length && list[i].t === s.tick) {
      const code = list[i].a;
      if (!CODES[code]) throw new Error("bad input code: " + code);
      applyInput(s, code);
      i++;
    }
    if (i < list.length && list[i].t < s.tick) throw new Error("inputs out of order");
    s.events.length = 0;
    step(s);
  }

  if (i < list.length) throw new Error("inputs past end of run");
  return summary(s);
}

/** The canonical, comparable result of a run. */
export function summary(s) {
  return {
    seed: s.seed,
    score: s.score,
    captures: s.captures,
    misses: s.misses,
    blues: s.blues,
    picks: s.picks,
    ticks: s.tick,
    duration: s.elapsed,
    won: s.won,
    over: s.over,
  };
}

/** True if two summaries describe the same run. */
export function sameResult(a, b) {
  return a.score === b.score && a.captures === b.captures && a.misses === b.misses &&
         a.blues === b.blues && a.picks === b.picks && a.ticks === b.ticks &&
         a.won === b.won;
}
