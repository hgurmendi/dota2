#!/usr/bin/env node
/**
 * Builds the browser bundles. Wrangler compiles the Worker separately, from
 * the same sources at the same target.
 *
 * engine.js is emitted as its own module, deliberately, and is NOT inlined
 * into game.js. It is the one artifact both sides of the leaderboard run:
 * the browser imports it directly, and the Worker that verifies submitted
 * runs will import this built file rather than re-compiling engine.ts. One
 * compilation means the two cannot drift — which matters, because the whole
 * design rests on a run replaying to the same score in both places.
 *
 * Three.js stays external too: it is vendored and resolved by the importmap
 * in pickthelock/index.html at runtime, so bundling it would duplicate it and
 * break that mapping.
 *
 * Outputs are gitignored build artifacts. `npm run build` regenerates them.
 */
import { build } from "esbuild";

const common = {
  bundle: true,
  format: "esm",
  // ES2022 on purpose: engine.js runs in the browser and in the Worker, and
  // the leaderboard depends on both producing identical results.
  // Downlevelling could change how the arithmetic evaluates.
  target: "es2022",
  logLevel: "info",
};

await Promise.all([
  // the shared simulation, built once
  build({ ...common, entryPoints: ["pickthelock/engine.ts"], outfile: "pickthelock/engine.js" }),
  // the game, importing that artifact rather than inlining a second copy
  build({
    ...common,
    entryPoints: ["pickthelock/game.ts"],
    outfile: "pickthelock/game.js",
    external: ["three", "three/addons/*", "./engine.js"],
  }),
  build({ ...common, entryPoints: ["shared/home.ts"], outfile: "shared/home.js" }),
]);
