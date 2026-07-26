/**
 * Local dev server: serves the static site and routes /api/* through the same
 * handler Cloudflare will run.  `node leaderboard/dev-server.mjs`
 *
 * Steam accepts an http://localhost return_to, so a real end-to-end login can
 * be tested here with a Steam Web API key:
 *
 *   SESSION_SECRET=dev-secret STEAM_API_KEY=<key> node leaderboard/dev-server.mjs
 *
 * D1 is not emulated. Without it login still works and /api/me returns the
 * steamid without a persona — use `wrangler dev` when the database matters.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
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
 * Paths the deploy never publishes (see .assetsignore). Mirrored here so local
 * testing matches production — otherwise the TypeScript sources are reachable
 * locally but 404 once deployed, which is exactly the kind of difference that
 * only shows up after a deploy.
 */
const PRIVATE = [/\.ts$/, /^\/(worker|leaderboard)\//, /^\/tsconfig/, /\.md$/,
                 /^\/(package|package-lock)\.json$/, /^\/build\.mjs$/,
                 /^\/wrangler\.toml$/, /^\/\.assetsignore$/, /\.sql$/];

async function serveStatic(pathname: string): Promise<Response> {
  if (PRIVATE.some((re) => re.test(pathname))) {
    return new Response("not found", { status: 404 });
  }
  // normalize() collapses ../ before it can escape ROOT
  let rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(ROOT, rel);
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
}).listen(PORT, () => {
  console.log(`dota2 dev server  http://localhost:${PORT}/`);
  console.log(`  api      http://localhost:${PORT}/api/status`);
  console.log(`  steam    ${env.STEAM_API_KEY ? "api key set" : "no STEAM_API_KEY — login works, no persona/avatar"}`);
  if (env.SESSION_SECRET === "dev-only-insecure-secret") {
    console.log("  warning  using the default dev SESSION_SECRET");
  }
});
