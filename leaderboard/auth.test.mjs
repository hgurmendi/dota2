/**
 * Tests for session signing and the Steam OpenID flow.  `node auth.test.mjs`
 *
 * Everything here runs offline: Steam is a stub, so the checks that matter
 * (a forged verification endpoint, a replayed return_to, a tampered cookie)
 * can be exercised directly rather than hoped about.
 */
import {
  mintSession, readSession, serializeCookie, clearCookie, readCookie,
  randomToken, timingSafeEqual, SESSION_COOKIE, STATE_COOKIE,
} from "./session.js";
import * as steam from "./steam.js";
import { handle } from "./handlers.js";

let passed = 0, failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "  — " + detail : "")); }
};
const section = (n) => console.log("\n" + n);

const SECRET = "test-secret-not-a-real-one";
const STEAMID = "76561198012345678";
const ORIGIN = "https://example.test";
const CLAIMED = "https://steamcommunity.com/openid/id/" + STEAMID;

// ---------- a stub Steam ----------
function steamStub({ valid = true, profile = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith("https://steamcommunity.com/openid/login")) {
      return new Response(`ns:http://specs.openid.net/auth/2.0\nis_valid:${valid}\n`, { status: 200 });
    }
    if (String(url).includes("GetPlayerSummaries")) {
      if (!profile) return new Response("nope", { status: 500 });
      return new Response(JSON.stringify({ response: { players: [{
        steamid: STEAMID, personaname: "Test Player",
        avatarfull: "https://avatars.test/a.jpg", profileurl: "https://steamcommunity.com/id/test/",
      }] } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("unexpected", { status: 404 });
  };
  return { fetchImpl, calls };
}

function callbackParams(overrides = {}, returnTo) {
  const p = new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "id_res",
    "openid.op_endpoint": "https://steamcommunity.com/openid/login",
    "openid.claimed_id": CLAIMED,
    "openid.identity": CLAIMED,
    "openid.return_to": returnTo,
    "openid.response_nonce": "2026-07-24T00:00:00Zabc",
    "openid.assoc_handle": "1234567890",
    "openid.signed": "signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle",
    "openid.sig": "ZmFrZXNpZ25hdHVyZQ==",
  });
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) p.delete(k); else p.set(k, v);
  }
  return p;
}

// ---------- sessions ----------
section("session tokens");
{
  const t = await mintSession(SECRET, STEAMID);
  const s = await readSession(SECRET, t);
  check("round trips", s?.sub === STEAMID, JSON.stringify(s));

  check("rejects a different secret", (await readSession("other-secret", t)) === null);

  const [v, body, sig] = t.split(".");
  const tamperedBody = Buffer.from(JSON.stringify({ sub: "76561190000000000", exp: 9e9 }))
    .toString("base64url");
  check("rejects a swapped payload", (await readSession(SECRET, `${v}.${tamperedBody}.${sig}`)) === null);
  check("rejects a truncated signature", (await readSession(SECRET, `${v}.${body}.${sig.slice(0, -4)}`)) === null);

  for (const bad of ["", "garbage", "v1.a", "v2." + body + "." + sig, null, undefined, 42]) {
    check(`rejects ${JSON.stringify(bad)}`, (await readSession(SECRET, bad)) === null);
  }

  const expired = await mintSession(SECRET, STEAMID, Date.now() - 40 * 86400_000);
  check("rejects an expired token", (await readSession(SECRET, expired)) === null);
  check("accepts one that is still valid",
    (await readSession(SECRET, await mintSession(SECRET, STEAMID, Date.now() - 60_000))) !== null);

  // a signed token whose subject isn't a steamid must not pass
  const weird = await mintSession(SECRET, "not-a-steamid");
  check("rejects a non-steamid subject", (await readSession(SECRET, weird)) === null);
}

section("cookies");
{
  const c = serializeCookie("a", "b", { maxAge: 60 });
  check("sets HttpOnly, Secure, SameSite and Path",
    c.includes("HttpOnly") && c.includes("Secure") && c.includes("SameSite=Lax") && c.includes("Path=/"), c);
  check("omits Secure for local http", !serializeCookie("a", "b", { secure: false }).includes("Secure"));
  check("clearing expires immediately", clearCookie("a").includes("Max-Age=0"));
  check("reads one of several", readCookie("x=1; lp_session=abc; y=2", "lp_session") === "abc");
  check("returns null when absent", readCookie("x=1", "lp_session") === null);
  check("is not fooled by a prefix", readCookie("xlp_session=abc", "lp_session") === null);
  check("tolerates no header", readCookie(null, "lp_session") === null);
  check("random tokens differ", randomToken() !== randomToken());
  check("timingSafeEqual matches", timingSafeEqual("abc", "abc"));
  check("timingSafeEqual rejects", !timingSafeEqual("abc", "abd") && !timingSafeEqual("abc", "ab"));
}

// ---------- Steam OpenID ----------
section("steam login url");
{
  const u = new URL(steam.loginUrl(ORIGIN + "/cb", ORIGIN + "/"));
  check("points at Steam", u.origin + u.pathname === "https://steamcommunity.com/openid/login");
  check("asks for identifier_select",
    u.searchParams.get("openid.identity") === "http://specs.openid.net/auth/2.0/identifier_select");
  check("carries return_to", u.searchParams.get("openid.return_to") === ORIGIN + "/cb");
}

section("steamid parsing");
{
  check("accepts a real claimed_id", steam.steamIdFrom(CLAIMED) === STEAMID);
  for (const bad of [
    "https://steamcommunity.com/openid/id/123",                       // too short
    "https://steamcommunity.com/openid/id/7656119801234567a",         // not digits
    "https://evil.test/openid/id/" + STEAMID,                         // wrong host
    "http://steamcommunity.com/openid/id/" + STEAMID,                 // not https
    null, "",
  ]) check(`rejects ${JSON.stringify(bad)}`, steam.steamIdFrom(bad) === null);
}

section("callback verification");
{
  const RT = ORIGIN + "/api/auth/steam/callback?state=abc";

  {
    const { fetchImpl, calls } = steamStub();
    const r = await steam.verifyCallback(callbackParams({}, RT), RT, fetchImpl);
    check("accepts a genuine callback", r.ok && r.steamid === STEAMID, JSON.stringify(r));
    check("verifies by POST to Steam", calls[0].init.method === "POST");
    check("asks check_authentication", calls[0].init.body.includes("openid.mode=check_authentication"));
  }

  {
    // The attack this whole design turns on: a response pointing verification
    // at a server the attacker runs. It must never be contacted.
    const { fetchImpl, calls } = steamStub();
    const r = await steam.verifyCallback(
      callbackParams({ "openid.op_endpoint": "https://evil.test/openid/login" }, RT), RT, fetchImpl);
    check("rejects a forged op_endpoint", !r.ok && r.reason === "op_endpoint");
    check("and never contacts it", calls.length === 0);
  }

  {
    const { fetchImpl } = steamStub({ valid: false });
    const r = await steam.verifyCallback(callbackParams({}, RT), RT, fetchImpl);
    check("rejects is_valid:false", !r.ok && r.reason === "is_valid");
  }

  {
    const { fetchImpl } = steamStub();
    const r = await steam.verifyCallback(callbackParams({}, RT), ORIGIN + "/api/auth/steam/callback?state=zzz", fetchImpl);
    check("rejects a replayed return_to", !r.ok && r.reason === "return_to");
  }

  for (const [label, ov, reason] of [
    ["a cancelled login", { "openid.mode": "cancel" }, "cancelled"],
    ["a non-id_res mode", { "openid.mode": "setup_needed" }, "mode"],
    ["a mismatched identity", { "openid.identity": "https://steamcommunity.com/openid/id/76561198999999999" }, "identity"],
    ["a junk claimed_id", { "openid.claimed_id": "https://evil.test/x" }, "claimed_id"],
    ["a missing signature", { "openid.sig": null }, "unsigned"],
  ]) {
    const { fetchImpl } = steamStub();
    const r = await steam.verifyCallback(callbackParams(ov, RT), RT, fetchImpl);
    check(`rejects ${label}`, !r.ok && r.reason === reason, JSON.stringify(r));
  }

  {
    // "is_valid:false" must not be read as containing "is_valid:true"
    const fetchImpl = async () => new Response("ns:x\nis_valid:false\nnote:is_valid:true is not here\n");
    const r = await steam.verifyCallback(callbackParams({}, RT), RT, fetchImpl);
    check("is not fooled by a substring", !r.ok && r.reason === "is_valid");
  }

  {
    const fetchImpl = async () => { throw new Error("network down"); };
    const r = await steam.verifyCallback(callbackParams({}, RT), RT, fetchImpl);
    check("survives Steam being unreachable", !r.ok && r.reason === "verify_unreachable");
  }
}

section("profile lookup");
{
  const { fetchImpl } = steamStub();
  const p = await steam.fetchProfile("key", STEAMID, fetchImpl);
  check("reads persona and avatar", p?.persona === "Test Player" && p.avatar.startsWith("https://"));
  check("returns null without an api key", (await steam.fetchProfile("", STEAMID, fetchImpl)) === null);
  const bad = steamStub({ profile: false });
  check("returns null on an API error", (await steam.fetchProfile("key", STEAMID, bad.fetchImpl)) === null);
  const mismatched = async () => new Response(JSON.stringify(
    { response: { players: [{ steamid: "76561198000000001", personaname: "Someone Else" }] } }),
    { headers: { "content-type": "application/json" } });
  check("rejects a profile for a different steamid",
    (await steam.fetchProfile("key", STEAMID, mismatched)) === null);
}

// ---------- routes ----------
section("routes");
{
  const env = { SESSION_SECRET: SECRET, SITE_ORIGIN: ORIGIN };
  const get = (p, headers = {}) => new Request(ORIGIN + p, { headers });

  {
    const r = await handle(get("/api/status"), env);
    check("status is public and ok", r.status === 200 && (await r.json()).ok === true);
  }
  {
    const r = await handle(get("/api/me"), env);
    check("me is 401 when signed out", r.status === 401);
  }
  {
    const token = await mintSession(SECRET, STEAMID);
    const r = await handle(get("/api/me", { cookie: `${SESSION_COOKIE}=${token}` }), env);
    const body = await r.json();
    check("me reports the signed-in steamid", r.status === 200 && body.steamid === STEAMID, JSON.stringify(body));
  }
  {
    const r = await handle(get("/api/me", { cookie: `${SESSION_COOKIE}=v1.forged.forged` }), env);
    check("me rejects a forged cookie", r.status === 401);
  }
  {
    const r = await handle(get("/api/auth/steam"), env);
    const loc = new URL(r.headers.get("location"));
    const setCookie = r.headers.get("set-cookie") || "";
    check("login redirects to Steam", r.status === 302 && loc.host === "steamcommunity.com");
    check("login sets a state cookie", setCookie.includes(STATE_COOKIE));
    const state = setCookie.split("=")[1].split(";")[0];
    const rt = new URL(loc.searchParams.get("openid.return_to"));
    check("state is carried in the signed return_to", rt.searchParams.get("state") === state);
  }
  {
    const r = await handle(get("/api/auth/steam/callback?state=abc"), env);
    check("callback rejects a missing state cookie", r.status === 400);
  }
  {
    const r = await handle(get("/api/auth/steam/callback?state=abc",
      { cookie: `${STATE_COOKIE}=different` }), env);
    check("callback rejects a mismatched state", r.status === 400);
  }
  {
    const r = await handle(new Request(ORIGIN + "/api/auth/logout", { method: "POST" }), env);
    check("logout clears the session cookie",
      r.status === 200 && (r.headers.get("set-cookie") || "").includes("Max-Age=0"));
  }
  {
    const r = await handle(get("/api/nope"), env);
    check("unknown routes 404", r.status === 404);
  }
  {
    const r = await handle(get("/api/auth/steam"), { SITE_ORIGIN: ORIGIN });
    check("login refuses to run unconfigured", r.status === 503);
  }
  {
    // open-redirect guard on ?next=
    const r = await handle(get("/api/auth/steam?next=https://evil.test/steal"), env);
    const rt = new URL(new URL(r.headers.get("location")).searchParams.get("openid.return_to"));
    check("next= cannot point off-origin", rt.searchParams.get("next") === "/dota2/pickthelock/");
    const r2 = await handle(get("/api/auth/steam?next=//evil.test/steal"), env);
    const rt2 = new URL(new URL(r2.headers.get("location")).searchParams.get("openid.return_to"));
    check("next= rejects protocol-relative", rt2.searchParams.get("next") === "/dota2/pickthelock/");
    const r3 = await handle(get("/api/auth/steam?next=/dota2/pickthelock/%23autostart"), env);
    const rt3 = new URL(new URL(r3.headers.get("location")).searchParams.get("openid.return_to"));
    check("next= keeps a same-origin path", rt3.searchParams.get("next") === "/dota2/pickthelock/#autostart");
  }
}

// ---------- the whole flow ----------
section("end to end: sign in, then use the session");
{
  // an in-memory stand-in for the D1 binding
  const rows = new Map();
  const DB = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              if (/INSERT INTO players/.test(sql)) {
                const [steamid, persona, avatar, now] = args;
                rows.set(steamid, { steamid, persona, avatar, banned: 0, created_at: now, updated_at: now });
              }
              return { success: true };
            },
            async first() { return rows.get(args[0]) ?? null; },
          };
        },
      };
    },
  };
  const env = { SESSION_SECRET: SECRET, STEAM_API_KEY: "key", SITE_ORIGIN: ORIGIN, DB };

  // 1. start a login and keep the state cookie Steam will sign back to us
  const start = await handle(new Request(ORIGIN + "/api/auth/steam"), env);
  const state = (start.headers.get("set-cookie") || "").split("=")[1].split(";")[0];
  const returnTo = new URL(new URL(start.headers.get("location")).searchParams.get("openid.return_to"));

  // 2. Steam sends the browser back. Route the module's bare `fetch` at the stub.
  const { fetchImpl } = steamStub();
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  let done;
  try {
    const cb = new URL(returnTo);
    for (const [k, v] of callbackParams({}, returnTo.toString())) cb.searchParams.set(k, v);
    done = await handle(new Request(cb, { headers: { cookie: `${STATE_COOKIE}=${state}` } }), env);
  } finally {
    globalThis.fetch = realFetch;
  }

  const cookies = done.headers.getSetCookie?.() ?? [done.headers.get("set-cookie")];
  const sessionCookie = cookies.find((c) => c && c.startsWith(SESSION_COOKIE + "="));
  check("callback redirects back into the game",
    done.status === 302 && done.headers.get("location") === "/dota2/pickthelock/",
    `${done.status} -> ${done.headers.get("location")}`);
  check("callback issues a session cookie", !!sessionCookie);
  check("and clears the state cookie",
    cookies.some((c) => c && c.startsWith(STATE_COOKIE + "=") && c.includes("Max-Age=0")));
  check("the player was persisted", rows.get(STEAMID)?.persona === "Test Player");

  // 3. the freshly issued cookie identifies the player
  const token = sessionCookie.slice((SESSION_COOKIE + "=").length).split(";")[0];
  const me = await handle(new Request(ORIGIN + "/api/me", { headers: { cookie: `${SESSION_COOKIE}=${token}` } }), env);
  const body = await me.json();
  check("me now returns the full profile",
    me.status === 200 && body.steamid === STEAMID && body.persona === "Test Player",
    JSON.stringify(body));

  // 4. a banned player holds a valid session but is refused
  rows.get(STEAMID).banned = 1;
  const banned = await handle(new Request(ORIGIN + "/api/me", { headers: { cookie: `${SESSION_COOKIE}=${token}` } }), env);
  check("a banned player is refused despite a good session", banned.status === 403);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
