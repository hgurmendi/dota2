/**
 * Proves the built engine matches its source.  `npm test` runs this.
 *
 * The browser and the Worker both load `pickthelock/engine.js`, the artifact
 * esbuild produces; the unit tests and the type checker only ever see
 * `engine.ts`. Those are two different files, and the leaderboard's whole
 * premise is that a run replays to the same score wherever it is checked — so
 * "the build didn't change the simulation" is an assumption worth testing
 * rather than assuming.
 *
 * It is not hypothetical. An earlier build had game.ts importing the engine by
 * two different specifiers, one of which esbuild inlined, so a second copy of
 * the simulation shipped inside game.js without anything failing.
 */
import * as SRC from "./engine.ts";
import type { InputEvent, InputCode } from "./engine.ts";

// Imported through a URL so TypeScript cannot fold it back to engine.ts — this
// has to be the real built file, not the source under a different name.
const BUILT = await import(new URL("./engine.js", import.meta.url).href) as typeof SRC;

let passed = 0, failed = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "  — " + detail : "")); }
};

function lcg(seed: number) {
  let x = seed >>> 0;
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
}

console.log("\nbuilt engine vs source");

check("the built file exists and exports simulate", typeof BUILT.simulate === "function");
check("constants agree",
  BUILT.TICK === SRC.TICK && BUILT.MAX_RUN_TIME === SRC.MAX_RUN_TIME &&
  BUILT.WEDGE_SIZE === SRC.WEDGE_SIZE && BUILT.HIT_SCORE === SRC.HIT_SCORE,
  `TICK ${BUILT.TICK}/${SRC.TICK}, WEDGE_SIZE ${BUILT.WEDGE_SIZE}/${SRC.WEDGE_SIZE}`);

let mismatch: string | null = null;
for (let seed = 1; seed <= 80 && !mismatch; seed++) {
  // build a trace against the source, then replay it through both
  const r = lcg(seed);
  const s = SRC.createRun(seed);
  const inputs: InputEvent[] = [];
  while (!s.over && s.tick < SRC.MAX_TICKS) {
    const v = r();
    const a: InputCode | null = v < 0.02 ? "P" : v < 0.025 ? "B" : v < 0.03 ? "R" : null;
    if (a) { inputs.push({ t: s.tick, a }); SRC.applyInput(s, a); }
    SRC.drain(s);
    SRC.step(s);
  }
  const fromSource = SRC.simulate(seed, inputs);
  const fromBuilt = BUILT.simulate(seed, inputs);
  if (JSON.stringify(fromSource) !== JSON.stringify(fromBuilt)) {
    mismatch = `seed ${seed}\n     source: ${JSON.stringify(fromSource)}\n     built:  ${JSON.stringify(fromBuilt)}`;
  }
}
check("80 runs replay identically through both", mismatch === null, mismatch ?? "");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
