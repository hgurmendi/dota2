/**
 * Signed session cookies.
 *
 * A session is an HMAC-SHA256-signed token, not an opaque id looked up in a
 * table: there is no session state to store or expire server-side, and a
 * Worker can validate one without touching the database. The cost is that a
 * session can't be revoked individually — rotating SESSION_SECRET logs
 * everyone out, which is the right blast radius for a leaderboard.
 *
 * Uses only Web Crypto and base64, so it runs unchanged in a Cloudflare
 * Worker, in Node, and in the test suite.
 */

export interface SessionPayload {
  /** steamid64 */
  sub: string;
  iat: number;
  exp: number;
}

export interface CookieOptions {
  maxAge?: number;
  secure?: boolean;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export const SESSION_COOKIE = "lp_session";
export const STATE_COOKIE = "lp_login_state";
export const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days
export const STATE_TTL = 60 * 10;             // a login round-trip, generously

// ---------- base64url ----------
function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(str)) throw new Error("not base64url");
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error("SESSION_SECRET is not set");
  return crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

// ---------- tokens ----------

/** Sign a session for `steamid`. `now` is injectable so tests can control expiry. */
export async function mintSession(secret: string, steamid: string,
                                  now: number = Date.now(), ttl: number = SESSION_TTL): Promise<string> {
  const iat = Math.floor(now / 1000);
  const payload = JSON.stringify({ sub: String(steamid), iat, exp: iat + ttl });
  const body = b64urlEncode(enc.encode(payload));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body)));
  return `v1.${body}.${b64urlEncode(sig)}`;
}

/**
 * Validate a token and return its payload, or null. Returns null for every
 * failure mode rather than throwing or distinguishing between them — a caller
 * that can tell "bad signature" from "expired" leaks more than it needs to.
 *
 * Signature verification runs before the payload is parsed, so unsigned input
 * never reaches JSON.parse.
 */
export async function readSession(secret: string, token: unknown,
                                  now: number = Date.now()): Promise<SessionPayload | null> {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const [, body, sig] = parts;

  let ok: boolean;
  try {
    ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), b64urlDecode(sig), enc.encode(body));
  } catch {
    return null;
  }
  if (!ok) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(dec.decode(b64urlDecode(body)));
  } catch {
    return null;
  }
  if (!payload || typeof payload.sub !== "string" || !/^\d{17}$/.test(payload.sub)) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= now) return null;
  return payload;
}

// ---------- cookies ----------

/**
 * Serialize a cookie. `secure` is on unless the origin is plainly http://,
 * so a local dev server over http still works while production never
 * accidentally ships a cookie without it.
 */
export function serializeCookie(name: string, value: string,
                                { maxAge, secure = true }: CookieOptions = {}): string {
  const bits: string[] = [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (secure) bits.push("Secure");
  if (maxAge !== undefined) bits.push(`Max-Age=${maxAge}`);
  return bits.join("; ");
}

export function clearCookie(name: string, { secure = true }: CookieOptions = {}): string {
  return serializeCookie(name, "", { maxAge: 0, secure });
}

/** Read one cookie out of a request's Cookie header. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** A random, URL-safe value for CSRF state. */
export function randomToken(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return b64urlEncode(b);
}

/** Length-independent comparison, for the login state check. */
export function timingSafeEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
