// Cloudflare Worker adapter: one Worker serves both the static site and the
// API. The alternative is Pages Functions (../functions/api/[[path]].js) —
// same handler either way, so the hosting choice stays reversible.
//
// The site root is the repo root, so `assets.directory` in wrangler.toml is
// "." and the server source would otherwise be served as static files. Nothing
// there is secret — every credential comes from env — but there is no reason
// to publish it, so those paths are claimed here and refused. wrangler.toml
// lists them in run_worker_first so assets can't answer first.
import { handle } from "../leaderboard/handlers.js";

const PRIVATE = ["/leaderboard/", "/worker/", "/functions/"];

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return handle(request, env);
    }
    if (PRIVATE.some((p) => pathname.startsWith(p)) || pathname === "/wrangler.toml") {
      return new Response("Not found", { status: 404 });
    }
    return env.ASSETS.fetch(request);
  },
};
