/**
 * Local dev server: serves the static site and routes /api/* through the same
 * handler Cloudflare will run.  `npm run dev`
 *
 * Steam accepts an http://localhost return_to, so a real end-to-end login can
 * be tested here with a Steam Web API key:
 *
 *   SESSION_SECRET=dev-secret STEAM_API_KEY=<key> npm run dev
 *
 * D1 is not emulated. Without it login still works and /api/me returns the
 * steamid without a persona — use `wrangler dev` when the database matters.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handle } from "./handlers.ts";
import type { Env } from "./handlers.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url) as any);
const PORT = Number(process.env.PORT || 8787);

const env: Env = {
  SESSION_SECRET: process.env.SESSION_SECRET || "dev-only-insecure-secret",
  STEAM_API_KEY: process.env.STEAM_API_KEY || "",
  SITE_ORIGIN: process.env.SITE_ORIGIN || `http://localhost:${PORT}`,
};

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webp": "image/webp", ".png": "image/png",
  ".mp3": "audio/mpeg", ".otf": "font/otf", ".ico": "image/x-icon",
  ".svg": "image/svg+xml", ".map": "application/json",
};

/**
 * What the deploy never publishes, read from .assetsignore itself rather than
 * restated here.
 *
 * The point of blocking anything locally is that local matches production, and
 * a hand-copied list only matches on the day it is written. The copy this
 * replaced had drifted far enough to serve `.dev.vars` — the file holding the
 * Steam API key and session secret — along with `.git/`, because both were
 * covered in .assetsignore and neither had been mirrored across.
 *
 * Only the subset of gitignore syntax .assetsignore actually uses is
 * implemented: `dir/` matches that directory at any depth, everything else
 * matches a filename, with `*` standing in for any run of characters.
 */
function parseAssetsIgnore(text: string) {
  const dirs: string[] = [];
  const files: RegExp[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.endsWith("/")) { dirs.push(line.slice(0, -1)); continue; }
    const escaped = line.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
    files.push(new RegExp(`^${escaped}$`));
  }
  return { dirs, files };
}
const IGNORE = parseAssetsIgnore(await readFile(join(ROOT, ".assetsignore"), "utf8"));

function isPrivate(rel: string): boolean {
  const segments = rel.split("/").filter(Boolean);
  // Everything dot-prefixed, at any depth: .git, .dev.vars, .env, .wrangler.
  // Stricter than the deploy, which names them one by one — a denylist that has
  // to be extended for each new dotfile is one that is eventually a file behind,
  // and every miss in that direction leaks something.
  if (segments.some((s) => s.startsWith("."))) return true;
  if (segments.some((s) => IGNORE.dirs.includes(s))) return true;
  const base = segments[segments.length - 1] ?? "";
  return IGNORE.files.some((re) => re.test(base));
}

async function serveStatic(pathname: string): Promise<Response> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return new Response("bad request", { status: 400 }); // a malformed %-escape
  }

  // Normalize before testing, not after: the URL parser has already collapsed
  // any literal ../, but %2e%2e survives it and only becomes ../ here. Testing
  // the raw pathname would let /x/%2e%2e/leaderboard/session.ts through the
  // check and then resolve it back to the file the check exists to protect.
  const rel = normalize(decoded).replace(/^[/\\]+/, "");
  if (isPrivate(rel)) return new Response("not found", { status: 404 });

  let file = resolve(ROOT, rel);
  const inside = relative(ROOT, file);
  if (inside.startsWith("..") || resolve(ROOT, inside) !== file) {
    return new Response("not found", { status: 404 });
  }

  try {
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
  } catch {
    return new Response("not found", { status: 404 });
  }
  try {
    const body = await readFile(file);
    return new Response(body, {
      headers: { "content-type": TYPES[extname(file)] || "application/octet-stream" },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

createServer(async (req, res) => {
  // Nothing in here may throw past this point. A rejected promise from a
  // request listener is an unhandled rejection, which Node treats as fatal by
  // default — so a single bad request kills the server for everyone. It took
  // exactly one malformed %-escape in a URL to do it.
  try {
    const url = new URL(req.url ?? "/", env.SITE_ORIGIN);

    let body: Buffer | undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c);
      body = Buffer.concat(chunks);
    }
    const request = new Request(url, {
      method: req.method,
      headers: req.headers,
      body: body as any,
      ...(body ? { duplex: "half" } : {}),
    } as RequestInit);

    const response = url.pathname.startsWith("/api/")
      ? await handle(request, env)
      : await serveStatic(url.pathname);

    res.statusCode = response.status;
    for (const [k, v] of response.headers) {
      if (k === "set-cookie") continue;                 // appended below, may repeat
      res.setHeader(k, v);
    }
    const cookies = response.headers.getSetCookie?.() ?? [];
    if (cookies.length) res.setHeader("set-cookie", cookies);

    res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
  } catch (err) {
    console.error("[dev-server]", req.method, req.url, err);
    if (!res.headersSent) res.statusCode = 500;
    res.end(res.headersSent ? undefined : "internal error");
  }
}).listen(PORT, () => {
  console.log(`dota2 dev server  http://localhost:${PORT}/`);
  console.log(`  api      http://localhost:${PORT}/api/status`);
  console.log(`  steam    ${env.STEAM_API_KEY ? "api key set" : "no STEAM_API_KEY — login works, no persona/avatar"}`);
  if (env.SESSION_SECRET === "dev-only-insecure-secret") {
    console.log("  warning  using the default dev SESSION_SECRET");
  }
});
