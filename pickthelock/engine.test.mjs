/**
 * Determinism tests for the simulation core.  `node engine.test.mjs`
 *
 * These guard the property the leaderboard depends on: a run is fully
 * described by its seed plus its input trace, and replaying it anywhere
 * reproduces the score exactly. Run this after touching engine.js.
 */
import {
  createRun, step, pick, setBoost, drain, simulate, summary, sameResult,
  encodeInputs, decodeInputs, wedgeUnderNeedle,
  TICK, MAX_RUN_TIME, MAX_TICKS, HIT_SCORE, PICK, BOOST_ON, BOOST_OFF,
} from "./engine.js";

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "  — " + detail : "")); }
}
function section(name) { console.log("\n" + name); }

// A deterministic stand-in for Math.random so the test itself is reproducible.
function lcg(seed) {
  let x = seed >>> 0;
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
}

/**
 * Drive a run with a policy and record the input trace the host would record.
 * policy(state) -> "P" | "B" | "R" | null, called once per tick.
 */
function play(seed, policy) {
  const s = createRun(seed);
  const inputs = [];
  while (!s.over && s.tick < MAX_TICKS) {
    const a = policy(s);
    if (a) { inputs.push({ t: s.tick, a }); applyOne(s, a); }
    drain(s);
    step(s);
  }
  return { inputs, result: summary(s) };
}
function applyOne(s, a) {
  if (a === PICK) pick(s);
  else if (a === BOOST_ON) setBoost(s, true);
  else if (a === BOOST_OFF) setBoost(s, false);
}

// Plays like a bot: boost pinned on, press the instant a wedge is under the
// needle. This is the upper bound on what any input trace can achieve.
const perfect = (s) => {
  if (!s.boostHeld) return BOOST_ON;
  return wedgeUnderNeedle(s) >= 0 ? PICK : null;
};

// Plays like a person: presses near the wedge but with reaction lag and
// jitter, and occasionally mashes at nothing.
function human(seed) {
  const r = lcg(seed);
  let cooldown = 0;
  return (s) => {
    if (s.tick === 0) return BOOST_ON;
    if (cooldown > 0) { cooldown--; return null; }
    if (wedgeUnderNeedle(s) >= 0 && r() < 0.06) { cooldown = 12; return PICK; }
    if (r() < 0.0015) { cooldown = 30; return PICK; }        // mistimed press
    if (r() < 0.001) return s.boostHeld ? BOOST_OFF : BOOST_ON;
    return null;
  };
}

section("replay reproduces the run");
{
  for (const seed of [1, 2, 12345, 0x7fffffff, -99]) {
    const { inputs, result } = play(seed, human(seed));
    const replay = simulate(seed, inputs);
    check(`seed ${seed}: live vs replay (score ${result.score}, ${inputs.length} inputs)`,
      sameResult(result, replay),
      JSON.stringify(result) + " != " + JSON.stringify(replay));
  }
}

section("replay is stable across repeats");
{
  const { inputs } = play(4242, human(4242));
  const a = simulate(4242, inputs);
  const b = simulate(4242, inputs);
  const c = simulate(4242, encodeInputs(inputs));
  check("three replays agree", sameResult(a, b) && sameResult(a, c));
}

section("different seeds are different games");
{
  const policy = () => null;   // do nothing: only the board differs
  const a = play(1, policy).result;
  const b = play(2, policy).result;
  const s1 = createRun(1), s2 = createRun(2);
  for (let i = 0; i < 600; i++) { step(s1); step(s2); }
  check("idle runs both score zero", a.score === 0 && b.score === 0);
  check("boards diverge", JSON.stringify(s1.arcs.map(x => x.center)) !==
                          JSON.stringify(s2.arcs.map(x => x.center)));
}

section("input trace encoding");
{
  const { inputs } = play(777, human(777));
  const enc = encodeInputs(inputs);
  check("round trips", JSON.stringify(decodeInputs(enc)) === JSON.stringify(inputs));
  check(`compact (${inputs.length} inputs -> ${enc.length} bytes)`, enc.length < inputs.length * 5);
  for (const bad of ["1X", "P", "zzP1", "1P1", "!!"]) {
    let threw = false;
    try { decodeInputs(bad); } catch (e) { threw = true; }
    check(`rejects ${JSON.stringify(bad)}`, threw);
  }
}

section("malformed traces are rejected, not simulated");
{
  const cases = [
    [[{ t: 5, a: PICK }, { t: 3, a: PICK }], "out of order"],
    [[{ t: 0, a: "Z" }], "unknown code"],
    [[{ t: MAX_TICKS + 50, a: PICK }], "input past end of run"],
  ];
  for (const [inputs, label] of cases) {
    let threw = false;
    try { simulate(1, inputs); } catch (e) { threw = true; }
    check(`rejects ${label}`, threw);
  }
}

section("score is always captures * " + HIT_SCORE);
{
  let ok = true, worst = null;
  for (let seed = 1; seed <= 40; seed++) {
    const r = play(seed, human(seed)).result;
    if (r.score !== r.captures * HIT_SCORE) { ok = false; worst = r; }
  }
  check("holds over 40 runs", ok, worst && JSON.stringify(worst));
}

section("runs always terminate within the cap");
{
  let maxDur = 0, maxScore = 0;
  for (let seed = 1; seed <= 25; seed++) {
    const r = play(seed, perfect).result;
    maxDur = Math.max(maxDur, r.duration);
    maxScore = Math.max(maxScore, r.score);
    if (!r.over) { check(`seed ${seed} terminated`, false, "hit MAX_TICKS without ending"); break; }
  }
  check(`perfect play ends by itself (longest ${maxDur.toFixed(1)}s of ${MAX_RUN_TIME}s cap)`,
    maxDur <= MAX_RUN_TIME + 1e-6);
  console.log(`       perfect-play ceiling: ${maxScore.toLocaleString()} points`);
}

section("fuzz: random traces never hang or throw");
{
  let ok = true, detail = "";
  for (let seed = 1; seed <= 200; seed++) {
    const r = lcg(seed);
    try {
      const res = play(seed, () => {
        const v = r();
        if (v < 0.02) return PICK;
        if (v < 0.024) return BOOST_ON;
        if (v < 0.028) return BOOST_OFF;
        return null;
      }).result;
      if (!res.over) { ok = false; detail = `seed ${seed} never ended`; break; }
      if (!(res.duration <= MAX_RUN_TIME + 1e-6)) { ok = false; detail = `seed ${seed} ran ${res.duration}s`; break; }
    } catch (e) { ok = false; detail = `seed ${seed}: ${e.message}`; break; }
  }
  check("200 random runs", ok, detail);
}

section("timebase");
{
  const s = createRun(1);
  for (let i = 0; i < TICK; i++) step(s);
  check("one second of ticks burns one second of clock",
    Math.abs(s.elapsed - 1) < 1e-9, `elapsed=${s.elapsed}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
