/**
 * Steam sign-in — OpenID 2.0, not OAuth and not OIDC. There is no client
 * secret and no token exchange: Steam redirects the user back with signed
 * parameters, and we ask Steam whether it really signed them.
 *
 * The whole security of the flow rests on a handful of checks that are easy
 * to omit, so they are spelled out and individually tested in steam.test.mjs.
 * The load-bearing one is that verification is always POSTed to the hardcoded
 * endpoint below. A response carries its own `openid.op_endpoint`, and an
 * implementation that verifies against *that* can be handed a URL the
 * attacker controls, which will happily answer "is_valid:true" for a forged
 * identity. Never use it as the verification target.
 */

export const STEAM_OPENID = "https://steamcommunity.com/openid/login";
const NS = "http://specs.openid.net/auth/2.0";
const IDENTIFIER_SELECT = NS + "/identifier_select";
const ID_PREFIX = "https://steamcommunity.com/openid/id/";
const STEAM_API = "https://api.steampowered.com";
const DOTA2_APPID = 570;

/** Where to send the browser to start a login. */
export function loginUrl(returnTo, realm) {
  const p = new URLSearchParams({
    "openid.ns": NS,
    "openid.mode": "checkid_setup",
    "openid.claimed_id": IDENTIFIER_SELECT,
    "openid.identity": IDENTIFIER_SELECT,
    "openid.return_to": returnTo,
    "openid.realm": realm,
  });
  return `${STEAM_OPENID}?${p}`;
}

/** Pull a 17-digit steamid64 out of a claimed_id, or null if it isn't one. */
export function steamIdFrom(claimedId) {
  if (typeof claimedId !== "string" || !claimedId.startsWith(ID_PREFIX)) return null;
  const id = claimedId.slice(ID_PREFIX.length);
  return /^\d{17}$/.test(id) ? id : null;
}

/**
 * Validate a callback from Steam. Returns {ok:true, steamid} or
 * {ok:false, reason}. `expectedReturnTo` must be the exact URL we put in the
 * login request — it is covered by Steam's signature, so checking it stops a
 * response minted for some other site (or some other login attempt) being
 * replayed here.
 *
 * `fetchImpl` is injectable purely so the tests can exercise this without
 * talking to Steam.
 */
export async function verifyCallback(params, expectedReturnTo, fetchImpl = fetch) {
  if (params.get("openid.mode") === "cancel") return { ok: false, reason: "cancelled" };
  if (params.get("openid.mode") !== "id_res") return { ok: false, reason: "mode" };

  // Reject anything not claiming to come from Steam before spending a request
  // on it. This is a sanity check, not the defence — the defence is that the
  // POST below goes to STEAM_OPENID regardless of what this field says.
  if (params.get("openid.op_endpoint") !== STEAM_OPENID) return { ok: false, reason: "op_endpoint" };

  const steamid = steamIdFrom(params.get("openid.claimed_id"));
  if (!steamid) return { ok: false, reason: "claimed_id" };
  if (steamIdFrom(params.get("openid.identity")) !== steamid) return { ok: false, reason: "identity" };
  if (params.get("openid.return_to") !== expectedReturnTo) return { ok: false, reason: "return_to" };
  if (!params.get("openid.sig") || !params.get("openid.signed")) return { ok: false, reason: "unsigned" };

  const body = new URLSearchParams(params);
  body.set("openid.mode", "check_authentication");

  let res;
  try {
    res = await fetchImpl(STEAM_OPENID, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch {
    return { ok: false, reason: "verify_unreachable" };
  }
  if (!res.ok) return { ok: false, reason: "verify_http" };

  // Steam answers with a small key:value document; require an exact
  // "is_valid:true" line rather than a substring match, so that a body
  // containing "is_valid:false" can never be read as a pass.
  const text = (await res.text()).replace(/\r\n/g, "\n");
  const valid = text.split("\n").some((line) => line.trim() === "is_valid:true");
  if (!valid) return { ok: false, reason: "is_valid" };

  return { ok: true, steamid };
}

/** Persona name and avatar for a steamid, or null. Never fatal to a login. */
export async function fetchProfile(apiKey, steamid, fetchImpl = fetch) {
  if (!apiKey) return null;
  const url = `${STEAM_API}/ISteamUser/GetPlayerSummaries/v2/` +
              `?key=${encodeURIComponent(apiKey)}&steamids=${encodeURIComponent(steamid)}`;
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const data = await res.json();
    const p = data?.response?.players?.[0];
    if (!p || p.steamid !== steamid) return null;
    return {
      steamid: p.steamid,
      persona: typeof p.personaname === "string" ? p.personaname : "",
      avatar: typeof p.avatarfull === "string" ? p.avatarfull : "",
      profile: typeof p.profileurl === "string" ? p.profileurl : "",
      visibility: p.communityvisibilitystate ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Whether the account owns Dota 2, with playtime. Issue #2 proposes this as an
 * eventual gate on submitting scores: a Steam account that owns the game the
 * minigame comes from is meaningfully more expensive to farm than a throwaway.
 * Returns null when it cannot be determined — a private profile hides this, so
 * null must never be treated as "doesn't own it".
 */
export async function fetchDota2Ownership(apiKey, steamid, fetchImpl = fetch) {
  if (!apiKey) return null;
  const url = `${STEAM_API}/IPlayerService/GetOwnedGames/v1/` +
              `?key=${encodeURIComponent(apiKey)}&steamid=${encodeURIComponent(steamid)}` +
              `&appids_filter[0]=${DOTA2_APPID}&include_played_free_games=1`;
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const data = await res.json();
    const games = data?.response?.games;
    if (!Array.isArray(games)) return null;   // private profile
    const dota = games.find((g) => g.appid === DOTA2_APPID);
    return { owns: !!dota, minutes: dota?.playtime_forever ?? 0 };
  } catch {
    return null;
  }
}
