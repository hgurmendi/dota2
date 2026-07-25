/**
 * The leaderboard API, as one platform-agnostic function.
 *
 * `handle(request, env)` takes a standard Request and returns a standard
 * Response, so the same code runs under Cloudflare Pages Functions, a Worker
 * with static assets, or the local test harness. The platform adapters in
 * ../functions and ../worker are a few lines each; the hosting choice is
 * deliberately not baked in here.
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
} from "./session.js";
import * as steam from "./steam.js";

// Where a login lands when nothing better is asked for. The root page carries
// the sign-in UI and the game index; every game sits under it on the same
// origin, which is what lets one session cover all of them.
const HOME_PATH = "/";

const json = (data, init = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8",
               "cache-control": "no-store", ...(init.headers || {}) },
  });

const redirect = (location, cookies = []) => {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
};

/** The origin to build absolute URLs from. */
function siteOrigin(request, env) {
  return env.SITE_ORIGIN || new URL(request.url).origin;
}

/**
 * Where to send the browser after login. Only same-origin paths are honoured:
 * taking a full URL from the query string here would make this an open
 * redirect, and a login endpoint is exactly where that gets abused.
 */
function safeNext(url) {
  const next = url.searchParams.get("next");
  if (typeof next !== "string") return HOME_PATH;
  if (!next.startsWith("/") || next.startsWith("//")) return HOME_PATH;
  return next;
}

async function currentSession(request, env) {
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (!token) return null;
  return readSession(env.SESSION_SECRET, token);
}

async function upsertPlayer(env, profile) {
  if (!env.DB) return;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO players (steamid, persona, avatar, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT(steamid) DO UPDATE SET
       persona = excluded.persona, avatar = excluded.avatar, updated_at = excluded.updated_at`
  ).bind(profile.steamid, profile.persona, profile.avatar, now).run();
}

async function loadPlayer(env, steamid) {
  if (!env.DB) return null;
  return env.DB.prepare(
    `SELECT steamid, persona, avatar, banned FROM players WHERE steamid = ?1`
  ).bind(steamid).first();
}

// ---------- routes ----------

export async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const origin = siteOrigin(request, env);
  const secure = new URL(origin).protocol === "https:";

  // The game probes this to decide whether to offer ranked play at all. It
  // must stay cheap and must never require a session.
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
                     `&next=${encodeURIComponent(safeNext(url))}`;
    return redirect(steam.loginUrl(returnTo, origin + "/"),
                    [serializeCookie(STATE_COOKIE, state, { maxAge: STATE_TTL, secure })]);
  }

  if (path === "/api/auth/steam/callback" && request.method === "GET") {
    if (!env.SESSION_SECRET) return json({ error: "auth_unconfigured" }, { status: 503 });

    const state = url.searchParams.get("state") || "";
    const cookieState = readCookie(request.headers.get("cookie"), STATE_COOKIE) || "";
    if (!state || !timingSafeEqual(state, cookieState)) {
      return json({ error: "bad_state" }, { status: 400 });
    }

    // Reconstruct return_to exactly as it was sent; Steam signed it, so any
    // mismatch means this response was not minted for this login attempt.
    const next = safeNext(url);
    const expectedReturnTo = `${origin}/api/auth/steam/callback?state=${encodeURIComponent(state)}` +
                             `&next=${encodeURIComponent(next)}`;

    const result = await steam.verifyCallback(url.searchParams, expectedReturnTo);
    if (!result.ok) {
      const status = result.reason === "cancelled" ? 302 : 401;
      if (status === 302) return redirect(next, [clearCookie(STATE_COOKIE, { secure })]);
      return json({ error: "auth_failed", reason: result.reason }, { status });
    }

    const profile = await steam.fetchProfile(env.STEAM_API_KEY, result.steamid);
    if (profile) await upsertPlayer(env, profile);

    const token = await mintSession(env.SESSION_SECRET, result.steamid);
    return redirect(next, [
      serializeCookie(SESSION_COOKIE, token, { maxAge: SESSION_TTL, secure }),
      clearCookie(STATE_COOKIE, { secure }),
    ]);
  }

  if (path === "/api/auth/logout" && request.method === "POST") {
    return json({ ok: true }, { headers: { "set-cookie": clearCookie(SESSION_COOKIE, { secure }) } });
  }

  if (path === "/api/me" && request.method === "GET") {
    const session = await currentSession(request, env);
    if (!session) return json({ authenticated: false }, { status: 401 });
    const player = await loadPlayer(env, session.sub);
    if (player?.banned) return json({ authenticated: false, banned: true }, { status: 403 });
    return json({
      authenticated: true,
      steamid: session.sub,
      persona: player?.persona ?? null,
      avatar: player?.avatar ?? null,
      expires: session.exp,
    });
  }

  return json({ error: "not_found" }, { status: 404 });
}
