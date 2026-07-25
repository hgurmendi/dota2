// The Worker: one deployment serving both the static game and the leaderboard
// API. All the logic lives in ../leaderboard/handlers.js as a plain
// (Request, env) -> Response, so nothing here is Cloudflare-specific beyond
// the ASSETS binding.
//
// Server source is kept off the public site by .assetsignore, which excludes
// it from the upload entirely — there is deliberately no path-blocking code
// here. A guard would only fire if the Worker ran before assets, and making
// that happen (run_worker_first) would bill an invocation for every static
// request it covered, to protect files that are already not published.

import { handle } from "../leaderboard/handlers.js";

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return handle(request, env);
    }
    // Anything else: a static asset, or a 404 from the asset server.
    return env.ASSETS.fetch(request);
  },
};
