/**
 * The leaderboard API, as one platform-agnostic function.
 *
 * `handle(request, env)` takes a standard Request and returns a standard
 * Response, so the same code runs under a Worker with static assets or the
 * local test harness. The platform adapter in ../worker is a few lines; the
 * hosting choice is deliberately not baked in here.
 *
 * Phase 1 (issue #2) is identity only: sign in with Steam, hold a session,
 * report who you are. Nothing scores or submits yet.
 *
 * env:
 *   SESSION_SECRET  required, secret. HMAC key for session cookies.
 *   STEAM_API_KEY   optional, secret. Without it login still works, but
 *                   there is no persona name or avatar.
 *   SITE_ORIGIN     optional. Overrides the request origin when building the
 *                   OpenID return_to, for when the public URL differs.
 *   DB              optional D1 binding. Without it, login works and /api/me
 *                   returns just the steamid.
 */

import {
  SESSION_COOKIE, STATE_COOKIE, SESSION_TTL, STATE_TTL,
  mintSession, readSession, serializeCookie, clearCookie, readCookie,
  randomToken, timingSafeEqual,
} from "./session.ts";
import * as steam from "./steam.ts";
import type { SteamProfile } from "./steam.ts";
import type { SessionPayload } from "./session.ts";

/** Bindings and secrets the Worker is given. Everything but SESSION_SECRET is optional. */
export interface Env {
  SESSION_SECRET?: string;
  STEAM_API_KEY?: string;
  SITE_ORIGIN?: string;
  DB?: D1Database;
}

interface PlayerRow {
  steamid: string;
  persona: string;
  avatar: string;
  banned: number;
}

// Where a login lands when nothing better is asked for. The root page carries
// the sign-in UI and the game index; every game sits under it on the same
// origin, which is what lets one session cover all of them.
const HOME_PATH = "/";

const json = (data: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8",
               "cache-control": "no-store", ...(init.headers || {}) },
  });

const redirect = (location: string, cookies: string[] = []): Response => {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
};

/** The origin to build absolute URLs from, normalized so it has no trailing path. */
function siteOrigin(request: Request, env: Env): string {
  return new URL(env.SITE_ORIGIN || request.url).origin;
}

/**
 * Where to send the browser after login. Only same-origin paths are honoured:
 * taking a full URL from the query string here would make this an open
 * redirect, and a login endpoint — where the user has just been bounced
 * through a third party and expects to land somewhere else — is exactly where
 * that gets abused.
 *
 * Resolving against our own origin and comparing is the check, rather than a
 * prefix test on the raw string. A prefix test has to enumerate every spelling
 * of "leaves this site", and it will miss one: browsers follow the URL spec,
 * where a backslash is simply another slash, so "/\evil.test" is an authority
 * and makes the same off-site jump "//evil.test" does. Asking the URL parser
 * the question directly means anything it would treat as off-origin is caught,
 * including spellings nobody thought of.
 */
function safeNext(url: URL, origin: string): string {
  const next = url.searchParams.get("next");
  if (typeof next !== "string" || !next.startsWith("/")) return HOME_PATH;
  let resolved: URL;
  try {
    resolved = new URL(next, origin);
  } catch {
    return HOME_PATH;
  }
  if (resolved.origin !== origin) return HOME_PATH;
  return resolved.pathname + resolved.search + resolved.hash;
}

/**
 * Record a player, or refresh their persona and avatar.
 *
 * A database failure is logged and swallowed: the row is a cache of what Steam
 * told us, and losing it must not cost the user their login. `banned` is never
 * written here, so the upsert cannot clear a ban.
 */
async function upsertPlayer(env: Env, profile: SteamProfile): Promise<void> {
  if (!env.DB) return;
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(
      `INSERT INTO players (steamid, persona, avatar, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?4)
       ON CONFLICT(steamid) DO UPDATE SET
         persona = excluded.persona, avatar = excluded.avatar, updated_at = excluded.updated_at`
    ).bind(profile.steamid, profile.persona, profile.avatar, now).run();
  } catch (err) {
    console.error("[leaderboard] player upsert failed", err);
  }
}

/**
 * Read a player row.
 *
 * `ok:false` means specifically that the database could not be reached, which
 * callers must tell apart from "no such player": the ban flag lives in this
 * row, so a caller that reads a failed lookup as "not banned" turns a D1 blip
 * into an authorization bypass. No DB binding configured at all is not a
 * failure — running without one is supported, and returns {ok:true, null}.
 */
async function loadPlayer(env: Env, steamid: string): Promise<{ ok: boolean; player: PlayerRow | null }> {
  if (!env.DB) return { ok: true, player: null };
  try {
    const player = await env.DB.prepare(
      `SELECT steamid, persona, avatar, banned FROM players WHERE steamid = ?1`
    ).bind(steamid).first<PlayerRow>();
    return { ok: true, player };
  } catch (err) {
    console.error("[leaderboard] player lookup failed", err);
    return { ok: false, player: null };
  }
}

/** A caller who got past the session cookie and the ban check. */
type Authenticated = { ok: true; steamid: string; session: SessionPayload; player: PlayerRow | null };
type AuthResult = Authenticated | { ok: false; response: Response };

/**
 * Resolve who is calling, and refuse them if they are banned.
 *
 * Every authenticated route goes through here, and this is the only thing that
 * hands a handler a steamid. That is the point: a ban enforced by each route
 * remembering to check it is a ban that one route will eventually not check.
 * Today there is a single caller and the indirection looks like overhead; by
 * the time submissions land there will be several, and adding the choke point
 * then means auditing them all.
 *
 * The session token cannot carry ban state — it is a stateless signature, so
 * it knows nothing that happened after it was minted — which is why this costs
 * a row read rather than being free.
 *
 * `onDbError` decides what happens when the ban flag cannot be read at all:
 *
 *   "open"   — carry on without a player row. For read-only routes like
 *              /api/me, where degrading to a bare steamid is the documented
 *              behaviour and refusing would break the page over a blip.
 *   "closed" — 503. For anything that writes or ranks: a run whose submitter
 *              cannot be ban-checked must not be accepted, and a leaderboard
 *              that is briefly unavailable is cheaper than one that is wrong.
 */
async function authenticate(request: Request, env: Env, onDbError: "open" | "closed",
                            secure: boolean): Promise<AuthResult> {
  const signedOut = () => ({ ok: false as const, response: json({ authenticated: false }, { status: 401 }) });

  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (!token) return signedOut();
  const session = await readSession(env.SESSION_SECRET ?? "", token);
  if (!session) return signedOut();

  const { ok, player } = await loadPlayer(env, session.sub);
  if (!ok && onDbError === "closed") {
    return { ok: false, response: json({ error: "unavailable" }, { status: 503 }) };
  }
  if (player?.banned) {
    // Drop the cookie on the way out. It does not revoke anything — they can
    // sign in again — but the callback refuses a banned player too, so the
    // round trip ends where it started instead of in a half-signed-in UI.
    return { ok: false, response: json({ authenticated: false, banned: true },
      { status: 403, headers: { "set-cookie": clearCookie(SESSION_COOKIE, { secure }) } }) };
  }
  return { ok: true, steamid: session.sub, session, player };
}

// ---------- routes ----------

export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const origin = siteOrigin(request, env);
  const secure = new URL(origin).protocol === "https:";

  // The game probes this to decide whether to offer ranked play at all. It
  // must stay cheap and must never require a session — no database read here,
  // deliberately, so it answers even when D1 is unhappy.
  if (path === "/api/status" && request.method === "GET") {
    return json({
      ok: true,
      phase: 1,
      auth: !!env.SESSION_SECRET,
      submissions: false,   // phase 2
    });
  }

  if (path === "/api/auth/steam" && request.method === "GET") {
    if (!env.SESSION_SECRET) return json({ error: "auth_unconfigured" }, { status: 503 });
    const state = randomToken();
    // The state is carried in return_to, which Steam signs, and mirrored in a
    // short-lived cookie. An attacker who can start a login can't then get a
    // victim's browser to complete it into the attacker's account.
    const returnTo = `${origin}/api/auth/steam/callback?state=${encodeURIComponent(state)}` +
                     `&next=${encodeURIComponent(safeNext(url, origin))}`;
    return redirect(steam.loginUrl(returnTo, origin + "/"),
                    [serializeCookie(STATE_COOKIE, state, { maxAge: STATE_TTL, secure })]);
  }

  if (path === "/api/auth/steam/callback" && request.method === "GET") {
    if (!env.SESSION_SECRET) return json({ error: "auth_unconfigured" }, { status: 503 });

    const state = url.searchParams.get("state") || "";
    const cookieState = readCookie(request.headers.get("cookie"), STATE_COOKIE) || "";
    if (!state || !timingSafeEqual(state, cookieState)) {
      return json({ error: "bad_state" }, { status: 400,
                    headers: { "set-cookie": clearCookie(STATE_COOKIE, { secure }) } });
    }

    // Reconstruct return_to exactly as it was sent; Steam signed it, so any
    // mismatch means this response was not minted for this login attempt.
    const next = safeNext(url, origin);
    const expectedReturnTo = `${origin}/api/auth/steam/callback?state=${encodeURIComponent(state)}` +
                             `&next=${encodeURIComponent(next)}`;

    const result = await steam.verifyCallback(url.searchParams, expectedReturnTo);
    if (!result.ok) {
      const status = result.reason === "cancelled" ? 302 : 401;
      if (status === 302) return redirect(next, [clearCookie(STATE_COOKIE, { secure })]);
      return json({ error: "auth_failed", reason: result.reason }, { status });
    }

    // Refuse a banned player a fresh session. Without this the ban is only
    // enforced on the routes that read the row, so signing out and back in
    // clears it — the one thing a banned player is certain to try.
    //
    // A database that cannot be reached fails open here, deliberately: signing
    // in is not a ranked action, and the routes where a ban actually matters
    // fail closed on their own. The alternative locks everyone out of the site
    // whenever D1 hiccups, to delay a ban by one lookup.
    const known = await loadPlayer(env, result.steamid);
    if (known.player?.banned) return json({ error: "banned" }, { status: 403 });

    const profile = await steam.fetchProfile(env.STEAM_API_KEY, result.steamid);
    if (profile) await upsertPlayer(env, profile);

    const token = await mintSession(env.SESSION_SECRET!, result.steamid);
    return redirect(next, [
      serializeCookie(SESSION_COOKIE, token, { maxAge: SESSION_TTL, secure }),
      clearCookie(STATE_COOKIE, { secure }),
    ]);
  }

  if (path === "/api/auth/logout" && request.method === "POST") {
    return json({ ok: true }, { headers: { "set-cookie": clearCookie(SESSION_COOKIE, { secure }) } });
  }

  if (path === "/api/me" && request.method === "GET") {
    // "open": this only echoes back an identity the caller already proved with
    // a signed cookie, so a database outage should cost the persona and avatar,
    // not the sign-in.
    const auth = await authenticate(request, env, "open", secure);
    if (!auth.ok) return auth.response;
    return json({
      authenticated: true,
      steamid: auth.steamid,
      persona: auth.player?.persona ?? null,
      avatar: auth.player?.avatar ?? null,
      expires: auth.session.exp,
    });
  }

  return json({ error: "not_found" }, { status: 404 });
}
