/**
 * Client-side session helper, shared by the root page and every minigame.
 *
 * All of this works because the games live under one origin as paths
 * (dota2.gurmen.com.ar/pickthelock/, .../othergame/) rather than on separate
 * subdomains. The session cookie is HttpOnly and Path=/, so it is sent with
 * every request from every game without anything being passed around — no
 * CORS, no tokens in localStorage, no cookie scoped wider than this site.
 *
 * Nothing here can be trusted for scoring. It reports who the server says you
 * are so the UI can react; a submitted run is still verified server-side from
 * its seed and inputs.
 */

/**
 * Who is signed in, or null. Never throws and never blocks a game from
 * starting: if the API is unreachable, the answer is simply "signed out".
 *
 * @returns {Promise<null | {steamid, persona, avatar, expires}>}
 */
export async function getSession() {
  try {
    const res = await fetch("/api/me", { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) return null;                       // 401 signed out, 403 banned
    const body = await res.json();
    return body.authenticated ? body : null;
  } catch {
    return null;
  }
}

/**
 * URL that starts a Steam login and returns here afterwards. `next` is
 * validated server-side and only same-origin paths are honoured, so a caller
 * cannot turn this into an open redirect.
 */
export function signInUrl(next = location.pathname + location.search + location.hash) {
  return `/api/auth/steam?next=${encodeURIComponent(next)}`;
}

/** Drop the session cookie. Resolves once the server has cleared it. */
export async function signOut() {
  try {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
  } catch {
    // a failed logout still shouldn't wedge the page
  }
}

/**
 * Whether the leaderboard is accepting submissions at all. A game should treat
 * a false here as "practice only" and stay completely playable — the API being
 * down must never stop someone playing.
 *
 * @returns {Promise<{auth: boolean, submissions: boolean}>}
 */
export async function leaderboardStatus() {
  try {
    const res = await fetch("/api/status", { cache: "no-store" });
    if (!res.ok) throw new Error("unavailable");
    const body = await res.json();
    return { auth: !!body.auth, submissions: !!body.submissions };
  } catch {
    return { auth: false, submissions: false };
  }
}
