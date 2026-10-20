// GPU marketplace API. Runs inside the Cloudflare Worker (src/worker.js) and
// stores everything in the D1 database bound as `DB`.
//
// Security model, in short:
// - Passwords: PBKDF2-SHA256, per-user salt, constant-time comparison.
// - Sessions: 256-bit random token in an HttpOnly, Secure, SameSite=Lax
//   `__Host-` cookie. Only the SHA-256 of the token is stored.
// - CSRF: every state-changing browser request must carry an Origin header
//   that matches this site, plus a JSON body (which a plain HTML form cannot
//   send cross-site).
// - Node heartbeats use a separate bearer token per listing, also stored hashed.
// - Rate limits on sign-up, login, and writes. Bodies are capped at 16 KB.
// - Contact details are only revealed to the other side once a host accepts.
// - When email is configured: verified email is required to list or rent,
//   password reset links are single-use and expire in an hour, and both sides
//   are notified about requests. Admins (ADMIN_EMAILS) can hide listings and
//   suspend accounts that users report.

import { emailEnabled, sendEmail, siteUrl, templates } from "./email.js";

const SESSION_COOKIE = "__Host-tdcc_sid";
const SESSION_TTL = 30 * 24 * 3600;
const PBKDF2_ITER = 100_000; // Workers' WebCrypto upper bound for PBKDF2.
const MAX_BODY = 16 * 1024;
const NODE_ONLINE_WINDOW = 180;
const NODE_TOKEN_PREFIX = "tdcc_node_";
const VERIFY_TTL = 48 * 3600;
const RESET_TTL = 3600;

export const REGIONS = {
  "us-east": "US East",
  "us-west": "US West",
  "ca": "Canada",
  "sa-east": "South America",
  "eu-west": "Europe West",
  "eu-central": "Europe Central",
  "eu-north": "Europe North",
  "me-central": "Middle East",
  "af-south": "Africa",
  "ap-south": "Asia South",
  "ap-east": "Asia East",
  "oceania": "Oceania",
};
export const HOST_KINDS = { datacenter: "Data center", cluster: "Micro-cluster", independent: "Independent" };
// "model" means the renter uses the models the host serves (tdcc access).
const ENVIRONMENTS = ["pytorch", "vllm", "ubuntu", "custom", "model"];
// "tdcc": an OpenAI-compatible API over the tdcc mesh. The host's node admits
// the renter's tdcc owner id for exactly the rented hours (see tdcc market).
const ACCESS = ["ssh", "jupyter", "api", "tdcc"];

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const now = () => Math.floor(Date.now() / 1000);

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      ...headers,
    },
  });
}

// ---------- crypto ----------

const enc = new TextEncoder();

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(bytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function newId(prefix) {
  return prefix + "_" + randomToken(12);
}

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return b64url(new Uint8Array(digest));
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations }, key, 256);
  return b64url(new Uint8Array(bits));
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- two-factor codes (RFC 6238 TOTP, SHA-1, 6 digits, 30 s) ----------

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32(bytes) {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function unbase32(s) {
  let bits = 0, value = 0;
  const out = [];
  for (const c of s) {
    const i = B32.indexOf(c);
    if (i < 0) continue;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

export async function totpCode(secret, step) {
  const key = await crypto.subtle.importKey("raw", unbase32(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setUint32(4, step);
  new DataView(msg.buffer).setUint32(0, Math.floor(step / 2 ** 32));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const o = mac[19] & 15;
  const n = ((mac[o] & 127) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}

// Returns the matching time step (one step of clock drift either way), or 0.
async function totpStep(secret, code) {
  if (typeof code !== "string" || !/^\d{6}$/.test(code.replace(/\s/g, ""))) return 0;
  code = code.replace(/\s/g, "");
  const step = Math.floor(Date.now() / 30_000);
  for (const s of [step, step - 1, step + 1]) {
    if (safeEqual(await totpCode(secret, s), code)) return s;
  }
  return 0;
}

// ---------- input ----------

async function readJson(request) {
  const type = request.headers.get("content-type") || "";
  if (!type.toLowerCase().startsWith("application/json")) throw new HttpError(415, "Send the request body as JSON.");
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_BODY) throw new HttpError(413, "Request body is too large.");
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, "Request body is too large.");
  try {
    const body = JSON.parse(text || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, "The request body is not valid JSON.");
  }
}

function text(v, field, { min = 0, max = 200, multiline = false } = {}) {
  if (v === undefined || v === null) v = "";
  if (typeof v !== "string") throw new HttpError(400, `${field} must be text.`, { field });
  v = v.normalize("NFC").trim();
  // Strip control characters; keep newlines and tabs only where multi-line text is allowed.
  v = multiline ? v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "") : v.replace(/[\u0000-\u001F\u007F]/g, " ");
  if (v.length < min) throw new HttpError(400, min === 1 ? `${field} is required.` : `${field} must be at least ${min} characters.`, { field });
  if (v.length > max) throw new HttpError(400, `${field} must be at most ${max} characters.`, { field });
  return v;
}

function int(v, field, min, max) {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${field} must be a whole number from ${min} to ${max}.`, { field });
  return n;
}

function oneOf(v, field, allowed) {
  if (!allowed.includes(v)) throw new HttpError(400, `${field} is not one of the allowed options.`, { field });
  return v;
}

function money(v, field) {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0.01 || n > 1000) throw new HttpError(400, `${field} must be between $0.01 and $1,000 per GPU-hour.`, { field });
  return Math.round(n * 100);
}

function email(v) {
  const e = text(v, "Email", { min: 3, max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) throw new HttpError(400, "Enter a valid email address.", { field: "email" });
  return e;
}

function password(v, field = "Password") {
  if (typeof v !== "string" || v.length < 10) throw new HttpError(400, `${field} must be at least 10 characters.`, { field: "password" });
  if (v.length > 200) throw new HttpError(400, `${field} must be at most 200 characters.`, { field: "password" });
  return v;
}

function sshKey(v) {
  const k = text(v, "SSH key", { max: 4000 });
  if (!k) return "";
  if (!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/=]+( [^\r\n]{0,200})?$/.test(k)) {
    throw new HttpError(400, "That does not look like an SSH public key. Paste the single line from your .pub file.", { field: "ssh_key" });
  }
  return k;
}

function ownerId(v) {
  const id = text(v, "tdcc owner ID", { max: 64 }).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(id)) {
    throw new HttpError(400, "That is not a tdcc owner ID. Run `tdcc auth init` once, then copy the 64-character Owner ID from `tdcc auth status`.", { field: "owner_id" });
  }
  return id;
}

function joinToken(v) {
  if (typeof v !== "string" || !v || v.length > 8192 || !/^[A-Za-z0-9_\-+/=.]+$/.test(v)) {
    throw new HttpError(400, "The node sent an invalid join token.");
  }
  return v;
}

// Rentals end on their own: once the rented hours have passed, an accepted
// rental is completed (frees the GPUs; for tdcc access the node drops the
// renter on its next check-in, or sooner from its own copy of the expiry).
// Requests nobody answered in PENDING_TTL expire so renters are not left
// waiting (and, with payments, so card holds are released in time).
const PENDING_TTL = 6 * 86400;

async function expireRentals(env) {
  const t = now();
  await env.DB.prepare("UPDATE rentals SET status = 'completed', updated_at = ?1 WHERE status = 'accepted' AND access_expires_at <= ?1").bind(t).run();
  // Checkout sessions expire after 31 minutes; this catches a missed webhook.
  await env.DB.prepare("UPDATE rentals SET status = 'cancelled', host_note = 'Payment was not completed.', updated_at = ?1 WHERE status = 'awaiting_payment' AND created_at <= ?1 - 3600").bind(t).run();
  const stale = await env.DB.prepare("SELECT id, payment_intent_id FROM rentals WHERE status = 'pending' AND created_at <= ?").bind(t - PENDING_TTL).all();
  for (const r of stale.results) {
    const res = await env.DB.prepare("UPDATE rentals SET status = 'expired', host_note = 'The host did not answer in time.', updated_at = ? WHERE id = ? AND status = 'pending'").bind(t, r.id).run();
    if (res.meta.changes && r.payment_intent_id) await releasePayment(env, r.id).catch((err) => console.error("release failed", r.id, err && err.message));
  }
}

// Periodic cleanup, run by the cron trigger (see wrangler.toml) and, as a
// fallback, now and then on requests.
export async function housekeeping(env) {
  const t = now();
  await expireRentals(env);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(t),
    env.DB.prepare("DELETE FROM email_tokens WHERE expires_at < ?").bind(t),
    env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(t - 86400),
    env.DB.prepare("DELETE FROM node_uptime WHERE hour < ?").bind(Math.floor(t / 3600) - 24 * 30),
    env.DB.prepare("DELETE FROM audit_log WHERE created_at < ?").bind(t - 365 * 86400),
  ]);
}

function image(v) {
  const i = text(v, "Container image", { min: 1, max: 255 });
  if (!/^[a-z0-9][a-z0-9._\-/:@]*$/i.test(i)) throw new HttpError(400, "Container image may only contain letters, digits, and . _ - / : @", { field: "image" });
  return i;
}

// ---------- rate limiting ----------

async function limit(env, key, max, windowSec) {
  const t = now();
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN window_start <= ?2 - ?3 THEN 1 ELSE count + 1 END,
       window_start = CASE WHEN window_start <= ?2 - ?3 THEN ?2 ELSE window_start END
     RETURNING count, window_start`
  ).bind(key, t, windowSec).first();
  if (Math.random() < 0.01) {
    await env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(t - 86400).run();
  }
  if (row && row.count > max) {
    const retry = Math.max(1, row.window_start + windowSec - t);
    throw new HttpError(429, "Too many attempts. Please wait a moment and try again.", { retryAfter: retry });
  }
}

const clientIp = (request) => request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local";

// ---------- sessions ----------

function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function sessionCookie(token, maxAge) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

const userAgent = (request) => (request.headers.get("user-agent") || "").slice(0, 200);

async function createSession(env, userId, request) {
  const token = randomToken(32);
  const t = now();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(await sha256(token), userId, t, t + SESSION_TTL, userAgent(request), t).run();
  return sessionCookie(token, SESSION_TTL);
}

async function currentUser(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token || token.length > 100) return null;
  const hash = await sha256(token);
  const t = now();
  const user = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.created_at, u.email_verified_at, u.totp_secret, u.pending_email, s.last_seen_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.suspended_at IS NULL`
  ).bind(hash, t).first();
  if (!user) return null;
  // Cheap "last active" for the session list, written at most every 5 minutes.
  if (!user.last_seen_at || t - user.last_seen_at > 300) {
    await env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").bind(t, hash).run();
  }
  user.session_id = hash.slice(0, 16);
  return user;
}

async function audit(env, request, userId, event, detail = "") {
  await env.DB.prepare("INSERT INTO audit_log (user_id, event, detail, ip, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(userId, event, String(detail).slice(0, 200), clientIp(request).slice(0, 64), now()).run();
}

// Optional bot check (Cloudflare Turnstile) on sign-up and password reset.
// Enabled by setting TURNSTILE_SITE_KEY and the TURNSTILE_SECRET secret.
async function checkHuman(env, request, token) {
  if (!env.TURNSTILE_SECRET) return;
  if (typeof token !== "string" || !token || token.length > 4096) throw new HttpError(400, "Please complete the check that you are not a robot.", { field: "turnstile" });
  let ok = false;
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token, remoteip: clientIp(request) }),
      signal: AbortSignal.timeout(10_000),
    });
    ok = res.ok && (await res.json()).success === true;
  } catch { ok = false; }
  if (!ok) throw new HttpError(400, "The robot check failed or expired. Please try it again.", { field: "turnstile" });
}

async function requireUser(request, env) {
  const user = await currentUser(request, env);
  if (!user) throw new HttpError(401, "Please sign in first.");
  return user;
}

function isAdmin(env, u) {
  const admins = (env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  // Always require a confirmed address: otherwise whoever registers an admin
  // email first would become an admin. Without email set up, confirm the
  // admin account by hand (see README).
  return !!u && admins.includes(u.email) && !!u.email_verified_at;
}

const publicUser = (u, env) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  created_at: u.created_at,
  email_verified: !!u.email_verified_at,
  needs_verification: emailEnabled(env) && !u.email_verified_at,
  is_admin: isAdmin(env, u),
  two_factor: !!u.totp_secret,
  pending_email: u.pending_email || null,
});

// Listing or renting needs a confirmed email address once email is set up.
function requireVerified(env, user) {
  if (emailEnabled(env) && !user.email_verified_at) {
    throw new HttpError(403, `Confirm your email address first. We sent a link to ${user.email}; you can resend it from your account page.`, { field: "email_unverified" });
  }
}

async function issueEmailToken(env, userId, purpose, ttl) {
  const token = randomToken(32);
  const t = now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM email_tokens WHERE user_id = ? AND purpose = ?").bind(userId, purpose),
    env.DB.prepare("INSERT INTO email_tokens (token_hash, user_id, purpose, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .bind(await sha256(token), userId, purpose, t, t + ttl),
  ]);
  return token;
}

// Returns the user id the token belongs to and burns the token.
async function consumeEmailToken(env, token, purpose) {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return null;
  const hash = await sha256(token);
  const row = await env.DB.prepare("SELECT user_id, expires_at FROM email_tokens WHERE token_hash = ? AND purpose = ?").bind(hash, purpose).first();
  if (!row) return null;
  await env.DB.prepare("DELETE FROM email_tokens WHERE token_hash = ?").bind(hash).run();
  return row.expires_at > now() ? row.user_id : null;
}

async function sendVerification(env, request, user) {
  const token = await issueEmailToken(env, user.id, "verify", VERIFY_TTL);
  const { subject, text: body } = templates.verify(user.name, `${siteUrl(env, request)}/confirm.html#verify=${token}`);
  return sendEmail(env, { to: user.email, subject, text: body });
}

// Fire-and-forget where the runtime allows it, so a slow mail API never delays a reply.
function later(ctx, promise) {
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(promise);
  else return promise;
}

// ---------- auth handlers ----------

// A fixed hash used when the email is unknown, so a failed login takes the same
// time whether or not the account exists.
const DUMMY_SALT = "tdcc-dummy-salt-000000";

async function signup(request, env, ctx) {
  await limit(env, "signup:" + clientIp(request), 20, 3600);
  const body = await readJson(request);
  await checkHuman(env, request, body.turnstile);
  const e = email(body.email);
  const name = text(body.name, "Name", { min: 1, max: 80 });
  const pw = password(body.password);
  if (!body.accept_terms) throw new HttpError(400, "Please accept the terms to create an account.", { field: "accept_terms" });

  const exists = await env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(e).first();
  if (exists) throw new HttpError(409, "An account with this email already exists. Sign in instead.", { field: "email" });

  const salt = randomToken(16);
  const id = newId("usr");
  await env.DB.prepare("INSERT INTO users (id, email, name, pw_hash, pw_salt, pw_iter, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, e, name, await pbkdf2(pw, salt, PBKDF2_ITER), salt, PBKDF2_ITER, now()).run();
  const cookie = await createSession(env, id, request);
  await audit(env, request, id, "signup");
  const user = { id, email: e, name, created_at: now(), email_verified_at: null };
  if (emailEnabled(env)) await later(ctx, sendVerification(env, request, user));
  return json(201, { user: publicUser(user, env) }, { "set-cookie": cookie });
}

async function login(request, env) {
  const ip = clientIp(request);
  await limit(env, "login:" + ip, 10, 300);
  const body = await readJson(request);
  const e = email(body.email);
  await limit(env, "login-email:" + e, 10, 900);
  const pw = typeof body.password === "string" ? body.password.slice(0, 200) : "";

  const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(e).first();
  const hash = await pbkdf2(pw, user ? user.pw_salt : DUMMY_SALT, user ? user.pw_iter : PBKDF2_ITER);
  if (!user || !safeEqual(hash, user.pw_hash)) {
    if (user) await audit(env, request, user.id, "login_failed");
    throw new HttpError(401, "Email or password is incorrect.");
  }
  if (user.suspended_at) throw new HttpError(403, "This account is suspended. Contact anil@decentralizedcompute.company if you think this is a mistake.");

  if (user.totp_secret) {
    // Password was right; the session is only created after the second step.
    const challenge = await issueEmailToken(env, user.id, "2fa-login", 300);
    return json(200, { two_factor_required: true, challenge });
  }
  const cookie = await createSession(env, user.id, request);
  await audit(env, request, user.id, "login");
  return json(200, { user: publicUser(user, env) }, { "set-cookie": cookie });
}

// Accepts a 6-digit authenticator code or one of the single-use recovery codes.
async function checkSecondFactor(env, user, code) {
  if (typeof code !== "string") return false;
  const step = await totpStep(user.totp_secret, code);
  if (step) {
    // Each code works once, so a code seen over someone's shoulder is useless.
    const res = await env.DB.prepare("UPDATE users SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?").bind(step, user.id, step).run();
    return res.meta.changes > 0;
  }
  const recovery = code.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (recovery.length !== 10) return false;
  const res = await env.DB.prepare("DELETE FROM recovery_codes WHERE code_hash = ? AND user_id = ?").bind(await sha256(recovery), user.id).run();
  return res.meta.changes > 0;
}

async function loginSecondStep(request, env) {
  await limit(env, "2fa:" + clientIp(request), 20, 300);
  const body = await readJson(request);
  const challenge = typeof body.challenge === "string" && body.challenge.length < 100 ? body.challenge : "";
  const row = challenge && await env.DB.prepare("SELECT user_id, expires_at FROM email_tokens WHERE token_hash = ? AND purpose = '2fa-login'").bind(await sha256(challenge)).first();
  if (!row || row.expires_at <= now()) throw new HttpError(401, "This sign-in took too long. Enter your email and password again.");
  await limit(env, "2fa-user:" + row.user_id, 5, 300);
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ? AND suspended_at IS NULL").bind(row.user_id).first();
  if (!user || !user.totp_secret) throw new HttpError(401, "Enter your email and password again.");
  if (!(await checkSecondFactor(env, user, body.code))) {
    await audit(env, request, user.id, "2fa_failed");
    throw new HttpError(401, "That code is not right. Use the current code from your authenticator app, or a recovery code.", { field: "code" });
  }
  await env.DB.prepare("DELETE FROM email_tokens WHERE token_hash = ?").bind(await sha256(challenge)).run();
  const cookie = await createSession(env, user.id, request);
  await audit(env, request, user.id, "login", "with two-factor code");
  return json(200, { user: publicUser(user, env) }, { "set-cookie": cookie });
}

async function logout(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  return json(200, { ok: true }, { "set-cookie": sessionCookie("", 0) });
}

async function me(request, env) {
  const user = await currentUser(request, env);
  return json(200, {
    user: user ? publicUser(user, env) : null,
    email_enabled: emailEnabled(env),
    turnstile_site_key: env.TURNSTILE_SECRET && env.TURNSTILE_SITE_KEY ? env.TURNSTILE_SITE_KEY : null,
    payments: paymentsEnabled(env),
  });
}

async function resendVerification(request, env, ctx) {
  const user = await requireUser(request, env);
  if (!emailEnabled(env)) throw new HttpError(503, "Email is not set up on this deployment yet.");
  if (user.email_verified_at) return json(200, { ok: true, already: true });
  await limit(env, "verify-mail:" + user.id, 3, 3600);
  const sent = await sendVerification(env, request, user);
  if (!sent) throw new HttpError(502, "We could not send the email right now. Please try again in a few minutes.");
  return json(200, { ok: true });
}

async function verifyEmail(request, env) {
  await limit(env, "verify:" + clientIp(request), 30, 3600);
  const body = await readJson(request);
  const userId = await consumeEmailToken(env, body.token, "verify");
  if (!userId) throw new HttpError(400, "This confirmation link is invalid or has expired. Sign in and send a new one from your account page.");
  await env.DB.prepare("UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?").bind(now(), userId).run();
  return json(200, { ok: true });
}

async function forgotPassword(request, env, ctx) {
  if (!emailEnabled(env)) throw new HttpError(503, "Password reset by email is not set up yet. Email anil@decentralizedcompute.company from your account address and we will help.");
  await limit(env, "forgot:" + clientIp(request), 10, 3600);
  const body = await readJson(request);
  await checkHuman(env, request, body.turnstile);
  const e = email(body.email);
  await limit(env, "forgot-email:" + e, 3, 3600);
  const user = await env.DB.prepare("SELECT id, email, name FROM users WHERE email = ? AND suspended_at IS NULL").bind(e).first();
  if (user) {
    const token = await issueEmailToken(env, user.id, "reset", RESET_TTL);
    const { subject, text: msg } = templates.reset(user.name, `${siteUrl(env, request)}/confirm.html#reset=${token}`);
    await later(ctx, sendEmail(env, { to: user.email, subject, text: msg }));
  }
  // Same answer whether or not the account exists.
  return json(200, { ok: true });
}

async function resetPassword(request, env) {
  await limit(env, "reset:" + clientIp(request), 20, 3600);
  const body = await readJson(request);
  const next = password(body.password, "New password");
  const userId = await consumeEmailToken(env, body.token, "reset");
  if (!userId) throw new HttpError(400, "This reset link is invalid, already used, or expired. Ask for a new one from the sign-in window.");
  const salt = randomToken(16);
  const t = now();
  await env.DB.batch([
    // Clicking the emailed link also proves the address.
    env.DB.prepare("UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iter = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?")
      .bind(await pbkdf2(next, salt, PBKDF2_ITER), salt, PBKDF2_ITER, t, userId),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM email_tokens WHERE user_id = ? AND purpose = 'reset'").bind(userId),
  ]);
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
  await audit(env, request, userId, "password_reset");
  // A reset link alone must not get past two-factor sign-in.
  if (user.totp_secret) return json(200, { ok: true, sign_in: true });
  const cookie = await createSession(env, userId, request);
  return json(200, { user: publicUser(user, env) }, { "set-cookie": cookie });
}

async function changePassword(request, env) {
  const user = await requireUser(request, env);
  await limit(env, "pw:" + user.id, 5, 900);
  const body = await readJson(request);
  const row = await env.DB.prepare("SELECT pw_hash, pw_salt, pw_iter FROM users WHERE id = ?").bind(user.id).first();
  const current = typeof body.current_password === "string" ? body.current_password.slice(0, 200) : "";
  if (!safeEqual(await pbkdf2(current, row.pw_salt, row.pw_iter), row.pw_hash)) throw new HttpError(401, "Current password is incorrect.", { field: "current_password" });
  const next = password(body.new_password, "New password");
  const salt = randomToken(16);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iter = ? WHERE id = ?").bind(await pbkdf2(next, salt, PBKDF2_ITER), salt, PBKDF2_ITER, user.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
  ]);
  const cookie = await createSession(env, user.id, request);
  await audit(env, request, user.id, "password_changed");
  return json(200, { ok: true }, { "set-cookie": cookie });
}

async function checkPassword(env, userId, pw, field = "password") {
  const row = await env.DB.prepare("SELECT pw_hash, pw_salt, pw_iter FROM users WHERE id = ?").bind(userId).first();
  pw = typeof pw === "string" ? pw.slice(0, 200) : "";
  if (!safeEqual(await pbkdf2(pw, row.pw_salt, row.pw_iter), row.pw_hash)) throw new HttpError(401, "Password is incorrect.", { field });
}

// ---------- two-factor setup ----------

async function twoFactorSetup(request, env) {
  const user = await requireUser(request, env);
  if (user.totp_secret) throw new HttpError(409, "Two-factor sign-in is already on.");
  const secret = base32(crypto.getRandomValues(new Uint8Array(20)));
  const label = encodeURIComponent(`TDCC Marketplace:${user.email}`);
  return json(200, { secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent("TDCC Marketplace")}&algorithm=SHA1&digits=6&period=30` });
}

async function twoFactorEnable(request, env) {
  const user = await requireUser(request, env);
  await limit(env, "pw:" + user.id, 5, 900);
  if (user.totp_secret) throw new HttpError(409, "Two-factor sign-in is already on.");
  const body = await readJson(request);
  const secret = typeof body.secret === "string" && /^[A-Z2-7]{32}$/.test(body.secret) ? body.secret : null;
  if (!secret) throw new HttpError(400, "Start the setup again.");
  const step = await totpStep(secret, body.code);
  if (!step) throw new HttpError(400, "That code is not right. Check that your phone's clock is correct and use the newest code.", { field: "code" });
  const codes = Array.from({ length: 8 }, () => {
    const raw = base32(crypto.getRandomValues(new Uint8Array(7))).slice(0, 10).toLowerCase();
    return raw;
  });
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET totp_secret = ?, totp_last_step = ? WHERE id = ?").bind(secret, step, user.id),
    env.DB.prepare("DELETE FROM recovery_codes WHERE user_id = ?").bind(user.id),
    ...(await Promise.all(codes.map(async (c) => env.DB.prepare("INSERT INTO recovery_codes (code_hash, user_id) VALUES (?, ?)").bind(await sha256(c), user.id)))),
  ]);
  await audit(env, request, user.id, "2fa_enabled");
  return json(200, { ok: true, recovery_codes: codes.map((c) => c.slice(0, 5) + "-" + c.slice(5)) });
}

async function twoFactorDisable(request, env) {
  const user = await requireUser(request, env);
  await limit(env, "pw:" + user.id, 5, 900);
  if (!user.totp_secret) return json(200, { ok: true });
  const body = await readJson(request);
  await checkPassword(env, user.id, body.password);
  if (!(await checkSecondFactor(env, user, body.code))) throw new HttpError(401, "That code is not right.", { field: "code" });
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET totp_secret = NULL, totp_last_step = 0 WHERE id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM recovery_codes WHERE user_id = ?").bind(user.id),
  ]);
  await audit(env, request, user.id, "2fa_disabled");
  return json(200, { ok: true });
}

// ---------- sessions, activity, export ----------

async function listSessions(request, env) {
  const user = await requireUser(request, env);
  const rows = await env.DB.prepare("SELECT token_hash, user_agent, created_at, last_seen_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY COALESCE(last_seen_at, created_at) DESC LIMIT 50")
    .bind(user.id, now()).all();
  return json(200, {
    sessions: rows.results.map((s) => ({
      id: s.token_hash.slice(0, 16),
      user_agent: s.user_agent,
      created_at: s.created_at,
      last_seen_at: s.last_seen_at || s.created_at,
      current: s.token_hash.slice(0, 16) === user.session_id,
    })),
  });
}

async function revokeSessions(request, env) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  if (body.id === "others") {
    await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND substr(token_hash, 1, 16) != ?").bind(user.id, user.session_id).run();
  } else {
    const id = typeof body.id === "string" && /^[A-Za-z0-9_-]{16}$/.test(body.id) ? body.id : null;
    if (!id) throw new HttpError(400, "Unknown session.");
    await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND substr(token_hash, 1, 16) = ?").bind(user.id, id).run();
  }
  await audit(env, request, user.id, "sessions_revoked", body.id === "others" ? "all other devices" : "one device");
  return json(200, { ok: true });
}

async function activity(request, env) {
  const user = await requireUser(request, env);
  const rows = await env.DB.prepare("SELECT event, detail, ip, created_at FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT 50").bind(user.id).all();
  return json(200, { events: rows.results });
}

// Everything we store about the signed-in person, as one JSON file.
async function exportData(request, env) {
  const user = await requireUser(request, env);
  await limit(env, "export:" + user.id, 5, 3600);
  const q = (sql, ...args) => env.DB.prepare(sql).bind(...args).all().then((r) => r.results);
  const profile = await env.DB.prepare("SELECT id, email, name, created_at, email_verified_at, pending_email, payout_account_id FROM users WHERE id = ?").bind(user.id).first();
  const data = {
    exported_at: new Date().toISOString(),
    profile: { ...profile, two_factor: !!user.totp_secret },
    listings: await q("SELECT id, gpu_model, vram_gb, gpu_count, region, host_kind, price_cents, min_hours, description, status, node_version, node_gpus, created_at, updated_at FROM listings WHERE owner_id = ?", user.id),
    rentals_as_renter: await q("SELECT id, listing_id, gpu_count, hours, environment, image, access, ssh_key, renter_owner_id, message, price_cents, total_cents, status, host_note, start_at, access_starts_at, access_expires_at, payment_status, created_at, updated_at FROM rentals WHERE renter_id = ?", user.id),
    requests_as_host: await q("SELECT r.id, r.listing_id, r.gpu_count, r.hours, r.access, r.price_cents, r.total_cents, r.status, r.host_note, r.payment_status, r.created_at, r.updated_at FROM rentals r JOIN listings l ON l.id = r.listing_id WHERE l.owner_id = ?", user.id),
    messages_written: await q("SELECT rental_id, body, created_at FROM messages WHERE author_id = ?", user.id),
    reviews_written: await q("SELECT rental_id, role, rating, comment, created_at FROM reviews WHERE author_id = ?", user.id),
    reviews_about_you: await q("SELECT rental_id, role, rating, comment, created_at FROM reviews WHERE subject_id = ?", user.id),
    reports_filed: await q("SELECT listing_id, reason, created_at, resolved_at FROM reports WHERE reporter_id = ?", user.id),
    disputes_opened: await q("SELECT rental_id, reason, created_at, resolved_at, resolution FROM disputes WHERE opened_by = ?", user.id),
    sessions: await q("SELECT user_agent, created_at, last_seen_at, expires_at FROM sessions WHERE user_id = ?", user.id),
    activity: await q("SELECT event, detail, ip, created_at FROM audit_log WHERE user_id = ? ORDER BY id", user.id),
  };
  return json(200, data, { "content-disposition": `attachment; filename="tdcc-marketplace-${user.id}.json"` });
}

// ---------- email change ----------

async function changeEmail(request, env, ctx) {
  const user = await requireUser(request, env);
  await limit(env, "pw:" + user.id, 5, 900);
  const body = await readJson(request);
  await checkPassword(env, user.id, body.password);
  const next = email(body.email);
  if (next === user.email) throw new HttpError(400, "That is already your email address.", { field: "email" });
  if (await env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(next).first()) throw new HttpError(409, "Another account uses that email address.", { field: "email" });
  if (!emailEnabled(env)) {
    // Without mail the new address cannot be proven, so it starts unconfirmed.
    await env.DB.prepare("UPDATE users SET email = ?, email_verified_at = NULL, pending_email = NULL WHERE id = ?").bind(next, user.id).run();
    await audit(env, request, user.id, "email_changed", next);
    return json(200, { ok: true, changed: true });
  }
  await env.DB.prepare("UPDATE users SET pending_email = ? WHERE id = ?").bind(next, user.id).run();
  const token = await issueEmailToken(env, user.id, "email-change", VERIFY_TTL);
  const site = siteUrl(env, request);
  await later(ctx, Promise.all([
    sendEmail(env, { to: next, ...templates.emailChange(user.name, `${site}/confirm.html#email=${token}`) }),
    sendEmail(env, { to: user.email, ...templates.emailChangeNotice(user.name, next) }),
  ]));
  await audit(env, request, user.id, "email_change_requested", next);
  return json(200, { ok: true, changed: false });
}

async function confirmEmailChange(request, env) {
  await limit(env, "verify:" + clientIp(request), 30, 3600);
  const userId = await consumeEmailToken(env, (await readJson(request)).token, "email-change");
  const user = userId && await env.DB.prepare("SELECT id, pending_email FROM users WHERE id = ?").bind(userId).first();
  if (!user || !user.pending_email) throw new HttpError(400, "This link is invalid or has expired. Ask for the change again from your account page.");
  if (await env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(user.pending_email).first()) throw new HttpError(409, "Another account uses that email address now.");
  await env.DB.prepare("UPDATE users SET email = pending_email, pending_email = NULL, email_verified_at = ? WHERE id = ?").bind(now(), user.id).run();
  await audit(env, request, user.id, "email_changed", user.pending_email);
  return json(200, { ok: true });
}

async function deleteAccount(request, env) {
  const user = await requireUser(request, env);
  await limit(env, "pw:" + user.id, 5, 900);
  const body = await readJson(request);
  const row = await env.DB.prepare("SELECT pw_hash, pw_salt, pw_iter FROM users WHERE id = ?").bind(user.id).first();
  const pw = typeof body.password === "string" ? body.password.slice(0, 200) : "";
  if (!safeEqual(await pbkdf2(pw, row.pw_salt, row.pw_iter), row.pw_hash)) throw new HttpError(401, "Password is incorrect.", { field: "password" });
  const open = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM rentals r JOIN listings l ON l.id = r.listing_id
     WHERE r.status = 'accepted' AND (r.renter_id = ?1 OR l.owner_id = ?1)`
  ).bind(user.id).first();
  if (open.n > 0) throw new HttpError(409, "You have accepted rentals that are still running. Complete or cancel them first.");
  const owed = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM rentals r JOIN listings l ON l.id = r.listing_id
     WHERE l.owner_id = ? AND r.payout_status IN ('held', 'paying')`
  ).bind(user.id).first();
  if (owed.n > 0) throw new HttpError(409, "Payouts for your finished rentals are still on their way. You can delete your account once they are paid (about a day after each rental ends).");
  await releaseAll(env, "status IN ('pending', 'awaiting_payment') AND (renter_id = ?1 OR listing_id IN (SELECT id FROM listings WHERE owner_id = ?1))", user.id);
  await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id).run();
  return json(200, { ok: true }, { "set-cookie": sessionCookie("", 0) });
}

// ---------- listings ----------

// "Busy" GPUs are those in accepted rentals whose access window covers now.
const NOW_SQL = "CAST(strftime('%s', 'now') AS INTEGER)";
const LISTING_SELECT = `
  SELECT l.*, u.name AS host_name, u.payouts_enabled AS host_payouts_enabled,
    l.gpu_count - COALESCE((SELECT SUM(r.gpu_count) FROM rentals r WHERE r.listing_id = l.id AND r.status = 'accepted'
      AND COALESCE(r.access_starts_at, 0) <= ${NOW_SQL} AND COALESCE(r.access_expires_at, 9e15) > ${NOW_SQL}), 0) AS available,
    (SELECT COUNT(*) FROM rentals r JOIN listings l2 ON l2.id = r.listing_id WHERE l2.owner_id = l.owner_id AND r.status = 'completed') AS host_completed,
    (SELECT ROUND(AVG(v.rating), 2) FROM reviews v WHERE v.subject_id = l.owner_id AND v.role = 'renter') AS host_rating,
    (SELECT COUNT(*) FROM reviews v WHERE v.subject_id = l.owner_id AND v.role = 'renter') AS host_reviews,
    (SELECT COALESCE(SUM(MIN(b.beats, 60)), 0) FROM node_uptime b WHERE b.listing_id = l.id AND b.hour >= ${NOW_SQL} / 3600 - 168) AS uptime_beats
  FROM listings l JOIN users u ON u.id = l.owner_id`;

// Share of minutes in the last 7 days (or since the machine was linked) in
// which it checked in. null until there is a day of history.
function uptimePct(row, t) {
  if (!row.node_first_seen_at) return null;
  const since = Math.max(row.node_first_seen_at, t - 7 * 86400);
  const minutes = (t - since) / 60;
  if (minutes < 24 * 60) return null;
  return Math.min(100, Math.round((1000 * (row.uptime_beats || 0)) / minutes) / 10);
}

const normGpu = (s) => String(s || "").toLowerCase().replace(/nvidia|geforce|amd|radeon|\(r\)|\(tm\)/g, "").replace(/[^a-z0-9]/g, "");

// The listing's GPUs match what tdcc on the linked machine reported in the last day.
function hardwareVerified(row, gpus, t) {
  if (!row.node_seen_at || t - row.node_seen_at > 86400 || !gpus.length) return false;
  const want = normGpu(row.gpu_model);
  if (!want) return false;
  const matching = gpus.filter((g) => {
    const name = normGpu(g.name);
    return name && (name.includes(want) || want.includes(name)) && (!g.vram_gb || g.vram_gb + 2 >= row.vram_gb);
  });
  return matching.length >= row.gpu_count;
}

function listingOut(row, { owner = false } = {}) {
  const t = now();
  let gpus = [];
  try { gpus = row.node_gpus ? JSON.parse(row.node_gpus) : []; } catch { gpus = []; }
  const out = {
    id: row.id,
    gpu_model: row.gpu_model,
    vram_gb: row.vram_gb,
    gpu_count: row.gpu_count,
    available: Math.max(0, row.available ?? row.gpu_count),
    region: row.region,
    region_label: REGIONS[row.region] || row.region,
    host_kind: row.host_kind,
    host_kind_label: HOST_KINDS[row.host_kind] || row.host_kind,
    price_cents: row.price_cents,
    min_hours: row.min_hours,
    description: row.description,
    host_name: row.host_name ? row.host_name.split(/\s+/)[0] : "Host",
    host_completed: row.host_completed || 0,
    host_rating: row.host_rating ?? null,
    host_reviews: row.host_reviews || 0,
    uptime_7d: uptimePct(row, t),
    hardware_verified: hardwareVerified(row, gpus, t),
    online: !!row.node_seen_at && t - row.node_seen_at < NODE_ONLINE_WINDOW,
    // The node is online, the host consented, and it runs the allowlist policy.
    api_rentals: !!row.api_seen_at && t - row.api_seen_at < NODE_ONLINE_WINDOW && row.status === "active",
    // The node starts an isolated container for each SSH/Jupyter rental.
    machine_rentals: machineOffer(row, t) !== null,
    custom_images: machineOffer(row, t)?.custom_images ?? true,
    node_seen_at: row.node_seen_at || null,
    node_gpus: gpus,
    payouts_ready: !!row.host_payouts_enabled,
    status: row.status,
    created_at: row.created_at,
  };
  if (owner) {
    out.moderation_note = row.moderation_note || "";
    out.node_linked = !!row.node_token_hash;
    out.node_version = row.node_version || null;
  }
  return out;
}

function machineOffer(row, t) {
  if (!row.machines_seen_at || t - row.machines_seen_at >= NODE_ONLINE_WINDOW || row.status !== "active") return null;
  try { return JSON.parse(row.machines_offer); } catch { return null; }
}

function listingInput(body, partial = false) {
  const out = {};
  const has = (k) => !partial || body[k] !== undefined;
  if (has("gpu_model")) out.gpu_model = text(body.gpu_model, "GPU model", { min: 2, max: 60 });
  if (has("vram_gb")) out.vram_gb = int(body.vram_gb, "GPU memory (GB)", 1, 1024);
  if (has("gpu_count")) out.gpu_count = int(body.gpu_count, "Number of GPUs", 1, 512);
  if (has("region")) out.region = oneOf(body.region, "Region", Object.keys(REGIONS));
  if (has("host_kind")) out.host_kind = oneOf(body.host_kind, "Setting", Object.keys(HOST_KINDS));
  if (has("price")) out.price_cents = money(body.price, "Price");
  if (has("min_hours")) out.min_hours = body.min_hours === undefined || body.min_hours === "" ? 1 : int(body.min_hours, "Minimum hours", 1, 720);
  if (has("description")) out.description = text(body.description, "Description", { max: 600, multiline: true });
  if (body.status !== undefined) out.status = oneOf(body.status, "Status", ["active", "paused"]);
  return out;
}

const SORTS = {
  price: "l.price_cents ASC, l.created_at DESC",
  vram: "l.vram_gb DESC, l.price_cents ASC",
  rep: "host_completed DESC, l.price_cents ASC",
  rating: "COALESCE(host_rating, 0) DESC, host_reviews DESC, l.price_cents ASC",
  new: "l.created_at DESC",
};

// Public search. Filters run in the database so the page stays fast however
// many GPUs are listed; results come in pages of `limit`.
async function listListings(request, env) {
  const p = new URL(request.url).searchParams;
  const where = ["l.status = 'active'"];
  // With card payments on, only hosts who can be paid out are bookable.
  if (paymentsEnabled(env)) where.push("l.owner_id IN (SELECT id FROM users WHERE payouts_enabled = 1)");
  const args = [];
  const t = now();
  const q = (p.get("q") || "").trim().slice(0, 60).toLowerCase();
  if (q) { where.push("(lower(l.gpu_model) LIKE ? ESCAPE '\\' OR lower(l.description) LIKE ? ESCAPE '\\')"); const like = "%" + q.replace(/[\\%_]/g, (c) => "\\" + c) + "%"; args.push(like, like); }
  const region = p.get("region");
  if (region && REGIONS[region]) { where.push("l.region = ?"); args.push(region); }
  const minVram = Number(p.get("min_vram"));
  if (Number.isInteger(minVram) && minVram > 0) { where.push("l.vram_gb >= ?"); args.push(minVram); }
  const maxVram = Number(p.get("max_vram"));
  if (Number.isInteger(maxVram) && maxVram > 0) { where.push("l.vram_gb <= ?"); args.push(maxVram); }
  if (p.get("online") === "1") { where.push("l.node_seen_at > ?"); args.push(t - NODE_ONLINE_WINDOW); }
  if (p.get("api") === "1") { where.push("l.api_seen_at > ?"); args.push(t - NODE_ONLINE_WINDOW); }
  const order = SORTS[p.get("sort")] || SORTS.price;
  const lim = Math.min(100, Math.max(1, Number.parseInt(p.get("limit") || "60", 10) || 60));
  const offset = Math.min(100_000, Math.max(0, Number.parseInt(p.get("offset") || "0", 10) || 0));
  const filter = where.join(" AND ");
  const [rows, total, regions] = await Promise.all([
    env.DB.prepare(`${LISTING_SELECT} WHERE ${filter} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...args, lim, offset).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(MAX(available, 0)), 0) AS free FROM (${LISTING_SELECT} WHERE ${filter})`).bind(...args).first(),
    env.DB.prepare("SELECT DISTINCT region FROM listings WHERE status = 'active'").all(),
  ]);
  const next = offset + rows.results.length < total.n ? offset + rows.results.length : null;
  return json(200, {
    listings: rows.results.map((r) => listingOut(r)),
    total: total.n,
    free_gpus: total.free,
    next_offset: next,
    active_regions: regions.results.map((r) => r.region).sort(),
    regions: REGIONS,
    host_kinds: HOST_KINDS,
  }, { "cache-control": "no-store" });
}

async function getListing(env, id) {
  const row = await env.DB.prepare(`${LISTING_SELECT} WHERE l.id = ? AND l.status != 'removed'`).bind(id).first();
  if (!row) throw new HttpError(404, "This listing does not exist or was removed.");
  return row;
}

async function showListing(request, env, id) {
  const row = await getListing(env, id);
  if (row.status !== "active") {
    const user = await currentUser(request, env);
    if (!user || user.id !== row.owner_id) throw new HttpError(404, "This listing is not available right now.");
  }
  return json(200, { listing: listingOut(row) });
}

async function myListings(request, env) {
  const user = await requireUser(request, env);
  const rows = await env.DB.prepare(`${LISTING_SELECT} WHERE l.owner_id = ? AND l.status != 'removed' ORDER BY l.created_at DESC`).bind(user.id).all();
  return json(200, { listings: rows.results.map((r) => listingOut(r, { owner: true })) });
}

async function createListing(request, env) {
  const user = await requireUser(request, env);
  requireVerified(env, user);
  await limit(env, "write:" + user.id, 30, 60);
  const body = await readJson(request);
  const v = listingInput(body);
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM listings WHERE owner_id = ? AND status != 'removed'").bind(user.id).first();
  if (count.n >= 50) throw new HttpError(409, "You can have at most 50 listings. Remove one you no longer use.");
  const id = newId("gpu");
  const t = now();
  await env.DB.prepare(
    `INSERT INTO listings (id, owner_id, gpu_model, vram_gb, gpu_count, region, host_kind, price_cents, min_hours, description, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, user.id, v.gpu_model, v.vram_gb, v.gpu_count, v.region, v.host_kind, v.price_cents, v.min_hours, v.description, v.status || "active", t, t).run();
  const row = await getListing(env, id);
  return json(201, { listing: listingOut(row, { owner: true }) });
}

async function ownedListing(request, env, id) {
  const user = await requireUser(request, env);
  const row = await getListing(env, id);
  if (row.owner_id !== user.id) throw new HttpError(404, "This listing does not exist or was removed.");
  return { user, row };
}

async function updateListing(request, env, id) {
  const { user, row } = await ownedListing(request, env, id);
  await limit(env, "write:" + user.id, 30, 60);
  if (row.status === "hidden") throw new HttpError(403, "Moderators hid this listing, so it cannot be changed. Contact anil@decentralizedcompute.company to appeal.");
  const v = listingInput(await readJson(request), true);
  const keys = Object.keys(v);
  if (!keys.length) throw new HttpError(400, "Nothing to update.");
  if (v.gpu_count !== undefined) {
    const used = await env.DB.prepare("SELECT COALESCE(SUM(gpu_count), 0) AS n FROM rentals WHERE listing_id = ? AND status = 'accepted'").bind(id).first();
    if (v.gpu_count < used.n) throw new HttpError(409, `${used.n} GPUs are rented out right now, so the count cannot go below that.`, { field: "gpu_count" });
  }
  await env.DB.prepare(`UPDATE listings SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .bind(...keys.map((k) => v[k]), now(), id).run();
  return json(200, { listing: listingOut(await getListing(env, id), { owner: true }) });
}

async function removeListing(request, env, id) {
  const { user } = await ownedListing(request, env, id);
  await limit(env, "write:" + user.id, 30, 60);
  const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM rentals WHERE listing_id = ? AND status IN ('pending', 'accepted')").bind(id).first();
  if (open.n > 0) throw new HttpError(409, "This listing has open requests or running rentals. Answer or finish them first, or pause the listing instead.");
  await env.DB.prepare("UPDATE listings SET status = 'removed', node_token_hash = NULL, updated_at = ? WHERE id = ?").bind(now(), id).run();
  return json(200, { ok: true });
}

async function linkNode(request, env, id) {
  const { user } = await ownedListing(request, env, id);
  await limit(env, "write:" + user.id, 30, 60);
  const token = NODE_TOKEN_PREFIX + randomToken(32);
  await env.DB.prepare("UPDATE listings SET node_token_hash = ?, node_seen_at = NULL, node_first_seen_at = NULL, node_gpus = NULL, node_version = NULL, updated_at = ? WHERE id = ?")
    .bind(await sha256(token), now(), id).run();
  await env.DB.prepare("DELETE FROM node_uptime WHERE listing_id = ?").bind(id).run();
  return json(200, { token });
}

async function unlinkNode(request, env, id) {
  await ownedListing(request, env, id);
  await env.DB.prepare("UPDATE listings SET node_token_hash = NULL, node_seen_at = NULL, node_gpus = NULL, node_version = NULL, updated_at = ? WHERE id = ?")
    .bind(now(), id).run();
  return json(200, { ok: true });
}

// Renter usage deltas reported by the node since its last check-in.
function usageReport(v) {
  if (!Array.isArray(v)) return [];
  const n = (x) => (Number.isInteger(x) && x >= 0 && x <= 1e9 ? x : 0);
  return v.slice(0, 64)
    .filter((u) => u && typeof u.owner_id === "string" && /^[0-9a-f]{64}$/.test(u.owner_id))
    .map((u) => ({ owner_id: u.owner_id, streams: n(u.streams), refused: n(u.refused), active_secs: n(u.active_secs) }));
}

// Called by `tdcc` on the host machine (see `tdcc market` in tdcc-mesh).
async function nodeHeartbeat(request, env) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token.startsWith(NODE_TOKEN_PREFIX) || token.length > 120) throw new HttpError(401, "Missing or invalid node token.");
  const hash = await sha256(token);
  await limit(env, "node:" + hash, 20, 60);
  const listing = await env.DB.prepare("SELECT id, status FROM listings WHERE node_token_hash = ?").bind(hash).first();
  if (!listing || listing.status === "removed") throw new HttpError(401, "This node token is no longer valid. Link the node again from your account page.");
  const body = await readJson(request);
  const version = text(body.version, "Version", { max: 40 });
  const gpus = Array.isArray(body.gpus) ? body.gpus.slice(0, 16).map((g) => ({
    name: text(g && g.name, "GPU name", { max: 80 }),
    vram_gb: Number.isFinite(g && g.vram_gb) ? Math.max(0, Math.min(4096, Math.round(g.vram_gb))) : 0,
  })) : [];
  // Present only when the host ran `tdcc market api-rentals on` and serves
  // with --trust-policy allowlist.
  const api = body.api && typeof body.api === "object" && body.api.trust_policy === "allowlist" ? { join_token: joinToken(body.api.join_token) } : null;
  const usage = api ? usageReport(body.usage) : [];
  const machines = machinesOfferInput(body.machines);
  const machineStatus = machines ? machineStatusInput(body.machine_status) : [];
  const t = now();
  await env.DB.batch([
    // Usage goes to the renter's latest rental on this listing that has started.
    ...usage.map((u) => env.DB.prepare(
      `UPDATE rentals SET usage_streams = usage_streams + ?, usage_refused = usage_refused + ?, usage_active_secs = usage_active_secs + ?
       WHERE id = (SELECT id FROM rentals WHERE listing_id = ? AND access = 'tdcc' AND renter_owner_id = ? AND status IN ('accepted', 'completed')
         AND COALESCE(access_starts_at, 0) <= ? ORDER BY access_starts_at DESC LIMIT 1)`
    ).bind(u.streams, u.refused, u.active_secs, listing.id, u.owner_id, t)),
    env.DB.prepare("UPDATE listings SET machines_seen_at = ?, machines_offer = ? WHERE id = ?")
      .bind(machines ? t : null, machines ? JSON.stringify(machines) : null, listing.id),
    ...machineStatus.map((m) => env.DB.prepare(
      `UPDATE rentals SET machine_state = ?, machine_host = ?, machine_port = ?, machine_token = ?, machine_error = ?, machine_tls_fingerprint = ?
       WHERE id = ? AND listing_id = ? AND access IN ('ssh', 'jupyter') AND status = 'accepted'`
    ).bind(m.state, machines.ssh_host, m.port, m.jupyter_token, m.error, m.tls_fingerprint, m.rental_id, listing.id)),
    env.DB.prepare("UPDATE listings SET node_seen_at = ?, node_first_seen_at = COALESCE(node_first_seen_at, ?), node_version = ?, node_gpus = ?, api_join_token = ?, api_seen_at = ? WHERE id = ?")
      .bind(t, t, version, JSON.stringify(gpus), api ? api.join_token : null, api ? t : null, listing.id),
    env.DB.prepare(`INSERT INTO node_uptime (listing_id, hour, beats) VALUES (?, ?, 1)
       ON CONFLICT(listing_id, hour) DO UPDATE SET beats = MIN(beats + 1, 60)`).bind(listing.id, Math.floor(t / 3600)),
  ]);
  const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM rentals WHERE listing_id = ? AND status = 'pending'").bind(listing.id).first();
  const reply = { ok: true, listing_id: listing.id, listing_status: listing.status, pending_requests: pending.n, next_heartbeat_secs: 60 };
  const k = await marketKey(env);
  if (k) reply.market_key = k.public_key;
  if (api) {
    await expireRentals(env);
    // Only rentals whose start time has come; later ones appear on a later check-in.
    const rows = await env.DB.prepare(
      `SELECT id, renter_owner_id, access_expires_at FROM rentals
       WHERE listing_id = ? AND status = 'accepted' AND access = 'tdcc' AND access_expires_at > ? AND COALESCE(access_starts_at, 0) <= ?`
    ).bind(listing.id, t, t).all();
    reply.grants = await Promise.all(rows.results.map((r) => signGrant(env, { listing_id: listing.id, rental_id: r.id, owner_id: r.renter_owner_id, expires_at: r.access_expires_at })));
  }
  if (machines) reply.machines = await machineGrants(env, listing.id, t);
  return json(200, reply);
}

function machinesOfferInput(v) {
  if (!v || typeof v !== "object" || v.runtime !== "docker") return null;
  const host = typeof v.ssh_host === "string" ? v.ssh_host.trim() : "";
  if (!/^[A-Za-z0-9.:\[\]-]{1,253}$/.test(host)) return null;
  return {
    gpus: Number.isInteger(v.gpus) && v.gpus >= 0 && v.gpus <= 64 ? v.gpus : 0,
    custom_images: v.custom_images === true,
    ssh_host: host,
  };
}

const MACHINE_STATES = ["starting", "running", "failed"];
function machineStatusInput(v) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 64).filter((m) => m && typeof m.rental_id === "string" && /^rnt_[A-Za-z0-9_-]{1,40}$/.test(m.rental_id) && MACHINE_STATES.includes(m.state)).map((m) => ({
    rental_id: m.rental_id,
    state: m.state,
    port: Number.isInteger(m.port) && m.port > 0 && m.port < 65536 ? m.port : null,
    jupyter_token: typeof m.jupyter_token === "string" && /^[A-Za-z0-9_-]{8,100}$/.test(m.jupyter_token) ? m.jupyter_token : null,
    error: typeof m.error === "string" ? m.error.replace(/[\u0000-\u001F\u007F]/g, " ").slice(0, 300) : null,
    tls_fingerprint: typeof m.tls_fingerprint === "string" && /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(m.tls_fingerprint) ? m.tls_fingerprint : null,
  }));
}

// Accepted SSH/Jupyter rentals whose start time has come. The node refuses
// unsigned machine grants, so none are sent without a signing key.
async function machineGrants(env, listingId, t) {
  if (!(await marketKey(env))) return [];
  const rows = await env.DB.prepare(
    `SELECT id, access, environment, image, gpu_count, ssh_key, access_expires_at FROM rentals
     WHERE listing_id = ? AND status = 'accepted' AND access IN ('ssh', 'jupyter') AND access_expires_at > ? AND COALESCE(access_starts_at, 0) <= ?`
  ).bind(listingId, t, t).all();
  return Promise.all(rows.results.map((r) => signMachineGrant(env, listingId, {
    rental_id: r.id, access: r.access, environment: r.environment, image: r.image || "",
    gpu_count: r.gpu_count, ssh_key: r.ssh_key || "", expires_at: r.access_expires_at,
  })));
}

// ---------- signed access grants ----------
//
// With MARKET_SIGNING_KEY set (a base64url Ed25519 seed; `npm run keygen`),
// every grant sent to a node is signed. tdcc pins the public key on its first
// check-in and from then on ignores grants without a valid signature, so
// someone who can change the database alone cannot hand out access.

let signingKey = null;
async function marketKey(env) {
  if (!env.MARKET_SIGNING_KEY) return null;
  if (signingKey && signingKey.seed === env.MARKET_SIGNING_KEY) return signingKey;
  const seed = Uint8Array.from(atob(env.MARKET_SIGNING_KEY.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  if (seed.length !== 32) throw new Error("MARKET_SIGNING_KEY must be a 32-byte base64url Ed25519 seed");
  const pkcs8 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...seed]);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", key);
  signingKey = { seed: env.MARKET_SIGNING_KEY, key, public_key: jwk.x };
  return signingKey;
}

export const grantMessage = (g) => `tdcc-market-grant-v1\n${g.listing_id}\n${g.rental_id}\n${g.owner_id}\n${g.expires_at}`;

async function signGrant(env, g) {
  const out = { rental_id: g.rental_id, owner_id: g.owner_id, expires_at: g.expires_at };
  const k = await marketKey(env);
  if (k) out.sig = b64url(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, k.key, enc.encode(grantMessage(g)))));
  return out;
}

export const machineGrantMessage = (listingId, g) =>
  `tdcc-market-machine-v1\n${listingId}\n${g.rental_id}\n${g.access}\n${g.environment}\n${g.image}\n${g.gpu_count}\n${g.expires_at}\n${g.ssh_key}`;

async function signMachineGrant(env, listingId, g) {
  const k = await marketKey(env);
  return { ...g, sig: b64url(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, k.key, enc.encode(machineGrantMessage(listingId, g))))) };
}

async function publicMarketKey(env) {
  const k = await marketKey(env);
  return json(200, k ? { alg: "ed25519", public_key: k.public_key } : { alg: null, public_key: null });
}

// ---------- rentals ----------

const OPEN_STATUSES = ["accepted", "completed"];
const MAX_START_AHEAD = 60 * 86400;

function rentalOut(r, side) {
  const revealed = OPEN_STATUSES.includes(r.status);
  const t = now();
  const out = {
    id: r.id,
    listing_id: r.listing_id,
    gpu_model: r.gpu_model,
    vram_gb: r.vram_gb,
    region: r.region,
    region_label: REGIONS[r.region] || r.region,
    gpu_count: r.gpu_count,
    hours: r.hours,
    environment: r.environment,
    image: r.image,
    access: r.access,
    message: r.message,
    price_cents: r.price_cents,
    total_cents: r.total_cents,
    status: r.status,
    host_note: r.host_note,
    created_at: r.created_at,
    updated_at: r.updated_at,
    start_at: r.start_at || null,
    access_starts_at: r.access_starts_at || null,
    access_expires_at: r.access_expires_at || null,
    payment_status: r.payment_status || "none",
    refunded_cents: r.refunded_cents || 0,
    message_count: r.message_count || 0,
    usage: r.access === "tdcc" ? { connections: r.usage_streams || 0, refused: r.usage_refused || 0, active_secs: r.usage_active_secs || 0 } : null,
    dispute_open: !!r.dispute_open,
  };
  if (side === "renter") {
    out.host_name = r.host_name;
    out.host_email = revealed ? r.host_email : null;
    // How to connect: only while access is live.
    out.join_token = r.access === "tdcc" && r.status === "accepted" && (r.access_starts_at || 0) <= t ? r.api_join_token || null : null;
    out.reviewed = !!r.renter_reviewed;
    out.machine = machineOut(r, true);
  } else {
    out.machine = machineOut(r, false);
    out.renter_owner_id = r.access === "tdcc" ? r.renter_owner_id : null;
    out.renter_name = r.renter_name;
    out.renter_email = revealed ? r.renter_email : null;
    out.ssh_key = revealed ? r.ssh_key : null;
    out.renter_rating = r.renter_rating ?? null;
    out.renter_reviews = r.renter_reviews || 0;
    out.reviewed = !!r.host_reviewed;
    out.payout_status = r.payout_status || "none";
    out.fee_cents = r.fee_cents || 0;
  }
  out.can_review = r.status === "completed" && !out.reviewed;
  return out;
}

// How to reach the rental's container, while the rental runs.
function machineOut(r, renter) {
  if (!r.machine_state || r.status !== "accepted" || !["ssh", "jupyter"].includes(r.access)) return null;
  const out = { state: r.machine_state, error: r.machine_error || null };
  if (r.machine_state === "running" && r.machine_port && r.machine_host) {
    const host = r.machine_host.includes(":") && !r.machine_host.startsWith("[") ? `[${r.machine_host}]` : r.machine_host;
    out.port = r.machine_port;
    if (r.access === "ssh") out.ssh = `ssh -p ${r.machine_port} root@${r.machine_host}`;
    if (r.access === "jupyter" && renter && r.machine_token) {
      // tdcc 0.74+ serves Jupyter over HTTPS and reports the certificate's fingerprint.
      const scheme = r.machine_tls_fingerprint ? "https" : "http";
      out.jupyter_url = `${scheme}://${host}:${r.machine_port}/lab?token=${r.machine_token}`;
      out.tls_fingerprint = r.machine_tls_fingerprint || null;
    }
  }
  return out;
}

const RENTAL_SELECT = `
  SELECT r.*, l.gpu_model, l.vram_gb, l.region, l.owner_id, l.api_join_token,
    h.name AS host_name, h.email AS host_email, h.payout_account_id AS host_payout_account, u.name AS renter_name, u.email AS renter_email,
    (SELECT COUNT(*) FROM messages m WHERE m.rental_id = r.id) AS message_count,
    EXISTS (SELECT 1 FROM disputes d WHERE d.rental_id = r.id AND d.resolved_at IS NULL) AS dispute_open,
    EXISTS (SELECT 1 FROM reviews v WHERE v.rental_id = r.id AND v.role = 'renter') AS renter_reviewed,
    EXISTS (SELECT 1 FROM reviews v WHERE v.rental_id = r.id AND v.role = 'host') AS host_reviewed,
    (SELECT ROUND(AVG(v.rating), 2) FROM reviews v WHERE v.subject_id = r.renter_id AND v.role = 'host') AS renter_rating,
    (SELECT COUNT(*) FROM reviews v WHERE v.subject_id = r.renter_id AND v.role = 'host') AS renter_reviews
  FROM rentals r JOIN listings l ON l.id = r.listing_id JOIN users h ON h.id = l.owner_id JOIN users u ON u.id = r.renter_id`;

// GPUs of a listing not taken by accepted rentals overlapping [start, end).
async function freeGpus(env, listingId, start, end) {
  const row = await env.DB.prepare(
    `SELECT l.gpu_count - COALESCE((SELECT SUM(r.gpu_count) FROM rentals r WHERE r.listing_id = l.id AND r.status = 'accepted'
       AND COALESCE(r.access_starts_at, 0) < ?2 AND COALESCE(r.access_expires_at, 9e15) > ?1), 0) AS free
     FROM listings l WHERE l.id = ?3`
  ).bind(start, end, listingId).first();
  return row ? Math.max(0, row.free) : 0;
}

function startAt(v) {
  if (v === undefined || v === null || v === "") return null;
  const t = now();
  const n = int(v, "Start time", 0, 2 ** 40);
  if (n < t - 300 || n > t + MAX_START_AHEAD) throw new HttpError(400, "Pick a start time between now and 60 days from now.", { field: "start_at" });
  // "Now-ish" means as soon as the host accepts.
  return n <= t + 600 ? null : n;
}

async function notifyNewRequest(env, siteBase, ctx, r) {
  if (!emailEnabled(env)) return;
  const m = templates.newRequest(r.host_name, r, `${siteBase}/account.html#requests`);
  await later(ctx, sendEmail(env, { to: r.host_email, ...m }));
}

async function createRental(request, env, ctx) {
  const user = await requireUser(request, env);
  requireVerified(env, user);
  await limit(env, "rent:" + user.id, 10, 3600);
  const body = await readJson(request);
  const listingId = text(body.listing_id, "Listing", { min: 1, max: 40 });
  const row = await getListing(env, listingId);
  if (row.status !== "active") throw new HttpError(409, "This listing is paused and is not taking requests right now.");
  if (row.owner_id === user.id) throw new HttpError(409, "This is your own listing.");
  const paid = paymentsEnabled(env);
  if (paid && !row.host_payouts_enabled) throw new HttpError(409, "This host has not finished setting up payouts yet, so the listing cannot be booked.");

  const count = int(body.gpu_count, "Number of GPUs", 1, 512);
  const hours = int(body.hours, "Hours", row.min_hours, 2160);
  const start = startAt(body.start_at);
  const from = start || now();
  const free = await freeGpus(env, row.id, from, from + hours * 3600);
  if (count > free) throw new HttpError(409, free ? `Only ${free} GPU${free === 1 ? " is" : "s are"} free on this listing for that time.` : "All GPUs on this listing are booked for that time.", { field: "gpu_count" });
  const access = oneOf(body.access, "Access", ACCESS);
  // tdcc access uses the models the host already serves; nothing to set up.
  const environment = access === "tdcc" ? "model" : oneOf(body.environment, "Environment", ENVIRONMENTS.filter((e) => e !== "model"));
  const img = environment === "custom" ? image(body.image) : "";
  if (img && listingOut(row).machine_rentals && !listingOut(row).custom_images) {
    throw new HttpError(400, "This host starts machines only from the standard environments (PyTorch, vLLM, Ubuntu). Pick one of those.", { field: "environment" });
  }
  const key = access === "ssh" ? sshKey(body.ssh_key) : "";
  if (access === "ssh" && !key) throw new HttpError(400, "Paste your SSH public key so the host can give you access.", { field: "ssh_key" });
  let renterOwnerId = "";
  if (access === "tdcc") {
    if (!listingOut(row).api_rentals) throw new HttpError(409, "This host does not offer access through tdcc right now. Choose SSH, Jupyter, or API access instead.", { field: "access" });
    renterOwnerId = ownerId(body.owner_id);
  }
  const message = text(body.message, "Message", { max: 1000, multiline: true });

  const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM rentals WHERE renter_id = ? AND status IN ('pending', 'awaiting_payment')").bind(user.id).first();
  if (pending.n >= 10) throw new HttpError(409, "You already have 10 requests waiting for an answer. Cancel one or wait for hosts to reply.");

  const id = newId("rnt");
  const t = now();
  const total = row.price_cents * count * hours;
  if (paid && total < 50) throw new HttpError(400, "The total must be at least $0.50 for card payment.", { field: "hours" });
  await env.DB.prepare(
    `INSERT INTO rentals (id, listing_id, renter_id, gpu_count, hours, environment, image, access, ssh_key, renter_owner_id, message, price_cents, total_cents, status, start_at, payment_status, fee_cents, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, row.id, user.id, count, hours, environment, img, access, key, renterOwnerId, message, row.price_cents, total,
    paid ? "awaiting_payment" : "pending", start, paid ? "awaiting" : "none", paid ? platformFee(env, total) : 0, t, t).run();
  const r = await env.DB.prepare(`${RENTAL_SELECT} WHERE r.id = ?`).bind(id).first();
  const site = siteUrl(env, request);
  if (paid) {
    // The card is authorized now and only charged when the host accepts.
    const checkout = await startCheckout(env, site, r, user).catch(async (err) => {
      await env.DB.prepare("UPDATE rentals SET status = 'cancelled', payment_status = 'failed', updated_at = ? WHERE id = ?").bind(now(), id).run();
      throw err;
    });
    return json(201, { rental: rentalOut(r, "renter"), checkout_url: checkout.url });
  }
  await notifyNewRequest(env, site, ctx, r);
  return json(201, { rental: rentalOut(r, "renter") });
}

async function myRentals(request, env) {
  const user = await requireUser(request, env);
  await expireRentals(env);
  const rows = await env.DB.prepare(`${RENTAL_SELECT} WHERE r.renter_id = ? ORDER BY r.created_at DESC LIMIT 200`).bind(user.id).all();
  return json(200, { rentals: rows.results.map((r) => rentalOut(r, "renter")) });
}

async function myRequests(request, env) {
  const user = await requireUser(request, env);
  await expireRentals(env);
  const rows = await env.DB.prepare(`${RENTAL_SELECT} WHERE l.owner_id = ? AND r.status != 'awaiting_payment' ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'accepted' THEN 1 ELSE 2 END, r.created_at DESC LIMIT 200`).bind(user.id).all();
  return json(200, { requests: rows.results.map((r) => rentalOut(r, "host")) });
}

// Allowed transitions: who may move a rental from which status to which.
const TRANSITIONS = {
  accept: { by: "host", from: ["pending"], to: "accepted" },
  decline: { by: "host", from: ["pending"], to: "declined" },
  cancel: { by: "either", from: ["pending", "accepted", "awaiting_payment"], to: "cancelled" },
  // Only the renter can end a rental early; otherwise it completes when the
  // rented hours run out. A host who stops early cancels, which refunds.
  complete: { by: "renter", from: ["accepted"], to: "completed" },
};

async function transitionRental(request, env, ctx, id, action) {
  const rule = TRANSITIONS[action];
  if (!rule) throw new HttpError(404, "Not found.");
  const user = await requireUser(request, env);
  await limit(env, "write:" + user.id, 30, 60);
  const body = await readJson(request);
  const r = await env.DB.prepare(`${RENTAL_SELECT} WHERE r.id = ?`).bind(id).first();
  const isHost = r && r.owner_id === user.id;
  const isRenter = r && r.renter_id === user.id;
  if (!r || (!isHost && !isRenter) || (isHost && r.status === "awaiting_payment")) throw new HttpError(404, "This request does not exist.");
  if (rule.by === "host" && !isHost) throw new HttpError(403, "Only the host can do that.");
  if (rule.by === "renter" && !isRenter) throw new HttpError(403, "Only the renter can mark a rental finished. To stop early, cancel it.");
  if (!rule.from.includes(r.status)) throw new HttpError(409, `This request is already ${r.status}.`);
  const note = isHost ? text(body.note, "Note", { max: 1000, multiline: true }) : r.host_note;

  // Accepting starts the clock at the requested start (or now): access lasts
  // exactly the rented hours.
  const t = now();
  const starts = action === "accept" ? Math.max(t, r.start_at || 0) : r.access_starts_at ?? null;
  const expires = action === "accept" ? starts + r.hours * 3600 : r.access_expires_at ?? null;
  let sql = `UPDATE rentals SET status = ?, host_note = ?, updated_at = ?, access_starts_at = ?, access_expires_at = ? WHERE id = ? AND status IN (${rule.from.map(() => "?").join(", ")})`;
  const args = [rule.to, note, t, starts, expires, id, ...rule.from];
  if (action === "accept") {
    // Re-check capacity in the same statement so two accepts cannot overbook.
    sql += ` AND gpu_count <= (SELECT l.gpu_count - COALESCE((SELECT SUM(x.gpu_count) FROM rentals x WHERE x.listing_id = l.id AND x.status = 'accepted'
              AND COALESCE(x.access_starts_at, 0) < ? AND COALESCE(x.access_expires_at, 9e15) > ?), 0)
              FROM listings l WHERE l.id = rentals.listing_id)`;
    args.push(expires, starts);
  }
  const res = await env.DB.prepare(sql).bind(...args).run();
  if (!res.meta.changes) {
    if (action === "accept") throw new HttpError(409, "Not enough free GPUs left on this listing for that time to accept this request.");
    throw new HttpError(409, "This request changed in the meantime. Refresh and try again.");
  }

  if (r.payment_intent_id) {
    if (action === "accept") {
      const ok = await capturePayment(env, id);
      if (!ok) {
        await env.DB.prepare("UPDATE rentals SET status = 'cancelled', host_note = ?, updated_at = ? WHERE id = ?").bind("The renter's card payment could not be completed.", now(), id).run();
        throw new HttpError(402, "The renter's card could not be charged, so the request was cancelled. Nothing was booked.");
      }
    } else if (action === "decline" || (action === "cancel" && r.status === "pending")) {
      await releasePayment(env, id);
    } else if (action === "cancel" && r.status === "accepted") {
      await refundPayment(env, id, cancelRefund(r, isHost, t), isHost ? "Cancelled by the host" : "Cancelled by the renter");
    }
  }

  const updated = await env.DB.prepare(`${RENTAL_SELECT} WHERE r.id = ?`).bind(id).first();
  if (emailEnabled(env)) {
    const site = siteUrl(env, request);
    let mail = null;
    if (action === "accept") {
      const listing = await env.DB.prepare("SELECT machines_seen_at, machines_offer, status FROM listings WHERE id = ?").bind(updated.listing_id).first();
      const machine_offered = ["ssh", "jupyter"].includes(updated.access) && machineOffer(listing, now()) !== null;
      mail = { to: updated.renter_email, ...templates.accepted(updated.renter_name, { ...updated, machine_offered }, `${site}/account.html#rentals`) };
    }
    else if (action === "decline") mail = { to: updated.renter_email, ...templates.declined(updated.renter_name, updated, `${site}/marketplace.html`) };
    else if (action === "cancel" && r.status !== "awaiting_payment") {
      mail = isHost
        ? { to: updated.renter_email, ...templates.cancelled(updated.renter_name, updated, updated.host_name, `${site}/account.html#rentals`) }
        : { to: updated.host_email, ...templates.cancelled(updated.host_name, updated, updated.renter_name, `${site}/account.html#requests`) };
    }
    if (mail) await later(ctx, sendEmail(env, mail));
  }
  return json(200, { rental: rentalOut(updated, isHost ? "host" : "renter") });
}

// Refund on cancelling an accepted rental: everything if the host cancels or
// access has not started yet; otherwise the hours not yet begun.
function cancelRefund(r, byHost, t) {
  const paid = r.total_cents - (r.refunded_cents || 0);
  if (byHost || !r.access_starts_at || t < r.access_starts_at) return paid;
  const usedHours = Math.ceil((t - r.access_starts_at) / 3600);
  const left = Math.max(0, r.hours - usedHours);
  return Math.min(paid, Math.floor((r.total_cents * left) / r.hours));
}

// ---------- messages between host and renter ----------

async function rentalParty(request, env, id) {
  const user = await requireUser(request, env);
  const r = await env.DB.prepare(`${RENTAL_SELECT} WHERE r.id = ?`).bind(id).first();
  if (!r || r.status === "awaiting_payment" || (r.owner_id !== user.id && r.renter_id !== user.id)) throw new HttpError(404, "This request does not exist.");
  return { user, r, isHost: r.owner_id === user.id };
}

async function listMessages(request, env, id) {
  const { user } = await rentalParty(request, env, id);
  const rows = await env.DB.prepare(
    "SELECT m.id, m.body, m.created_at, m.author_id, u.name FROM messages m JOIN users u ON u.id = m.author_id WHERE m.rental_id = ? ORDER BY m.created_at, m.rowid LIMIT 500"
  ).bind(id).all();
  return json(200, { messages: rows.results.map((m) => ({ id: m.id, body: m.body, created_at: m.created_at, mine: m.author_id === user.id, author: m.name.split(/\s+/)[0] })) });
}

async function postMessage(request, env, ctx, id) {
  const { user, r, isHost } = await rentalParty(request, env, id);
  await limit(env, "msg:" + user.id, 30, 300);
  const body = text((await readJson(request)).body, "Message", { min: 1, max: 2000, multiline: true });
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE rental_id = ?").bind(id).first();
  if (count.n >= 500) throw new HttpError(409, "This conversation is full. Continue by email.");
  const t = now();
  const msgId = newId("msg");
  await env.DB.prepare("INSERT INTO messages (id, rental_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)").bind(msgId, id, user.id, body, t).run();
  if (emailEnabled(env)) {
    // At most one email per conversation every 15 minutes.
    const quiet = await env.DB.prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET count = CASE WHEN window_start <= ?2 - 900 THEN 1 ELSE count + 1 END,
         window_start = CASE WHEN window_start <= ?2 - 900 THEN ?2 ELSE window_start END
       RETURNING count`
    ).bind(`msgmail:${id}:${isHost ? "renter" : "host"}`, t).first();
    if (quiet && quiet.count === 1) {
      const to = isHost ? r.renter_email : r.host_email;
      const toName = isHost ? r.renter_name : r.host_name;
      const tab = isHost ? "rentals" : "requests";
      await later(ctx, sendEmail(env, { to, ...templates.message(toName, user.name, r, body, `${siteUrl(env, request)}/account.html#${tab}`) }));
    }
  }
  return json(201, { message: { id: msgId, body, created_at: t, mine: true, author: user.name.split(/\s+/)[0] } });
}

// ---------- reviews ----------

async function reviewRental(request, env, id) {
  const { user, r, isHost } = await rentalParty(request, env, id);
  await limit(env, "write:" + user.id, 30, 60);
  if (r.status !== "completed") throw new HttpError(409, "You can leave a review once the rental is finished.");
  const body = await readJson(request);
  const rating = int(body.rating, "Rating", 1, 5);
  const comment = text(body.comment, "Comment", { max: 1000, multiline: true });
  const role = isHost ? "host" : "renter";
  const res = await env.DB.prepare(
    `INSERT INTO reviews (id, rental_id, listing_id, author_id, subject_id, role, rating, comment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(rental_id, role) DO NOTHING`
  ).bind(newId("rev"), id, r.listing_id, user.id, isHost ? r.renter_id : r.owner_id, role, rating, comment, now()).run();
  if (!res.meta.changes) throw new HttpError(409, "You already reviewed this rental.");
  return json(201, { ok: true });
}

async function listingReviews(request, env, id) {
  const row = await getListing(env, id);
  const rows = await env.DB.prepare(
    `SELECT v.rating, v.comment, v.created_at, u.name, l.gpu_model FROM reviews v JOIN users u ON u.id = v.author_id JOIN listings l ON l.id = v.listing_id
     WHERE v.subject_id = ? AND v.role = 'renter' ORDER BY v.created_at DESC LIMIT 50`
  ).bind(row.owner_id).all();
  return json(200, { reviews: rows.results.map((v) => ({ rating: v.rating, comment: v.comment, created_at: v.created_at, author: v.name.split(/\s+/)[0], gpu_model: v.gpu_model })) });
}

// ---------- disputes ----------

async function openDispute(request, env, ctx, id) {
  const { user, r } = await rentalParty(request, env, id);
  await limit(env, "report:" + user.id, 10, 86400);
  if (!["accepted", "completed", "cancelled"].includes(r.status) || (r.status === "cancelled" && !r.access_starts_at)) {
    throw new HttpError(409, "Disputes are for rentals that were accepted. For a request, decline or cancel it instead.");
  }
  if (r.status === "completed" && r.updated_at < now() - 14 * 86400) throw new HttpError(409, "Disputes can be opened up to 14 days after a rental ends.");
  const reason = text((await readJson(request)).reason, "Reason", { min: 10, max: 2000, multiline: true });
  const res = await env.DB.prepare(
    "INSERT INTO disputes (id, rental_id, opened_by, reason, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(rental_id, opened_by) DO NOTHING"
  ).bind(newId("dsp"), id, user.id, reason, now()).run();
  if (!res.meta.changes) throw new HttpError(409, "You already opened a dispute for this rental. We will reply by email.");
  if (emailEnabled(env) && env.ADMIN_EMAILS) {
    const site = siteUrl(env, request);
    const admins = env.ADMIN_EMAILS.split(",").map((x) => x.trim()).filter(Boolean);
    await later(ctx, Promise.all(admins.map((to) => sendEmail(env, {
      to,
      subject: `Dispute opened: rental ${id}`,
      text: `${user.name} opened a dispute on rental ${id} (${r.gpu_count} × ${r.gpu_model}, ${r.hours} h, ${(r.total_cents / 100).toFixed(2)} USD):\n\n${reason}\n\nReview it at ${site}/admin.html`,
    }))));
  }
  return json(201, { ok: true });
}

// ---------- payments (Stripe Connect, optional) ----------
//
// Enabled by the STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET secrets. Without
// them the marketplace works as before: host and renter settle payment
// between themselves.
//
// Money flow ("separate charges and transfers", so the platform holds funds):
// 1. The renter's request opens Stripe Checkout. The card is authorized, not
//    charged; the request reaches the host once Stripe confirms.
// 2. Host accepts -> the payment is captured. Declined, cancelled, or
//    unanswered requests release the authorization.
// 3. Cancelling an accepted rental refunds the renter (all of it when the
//    host cancels or before the start, otherwise the hours not yet begun).
// 4. PAYOUT_HOLD after the rental ends with no open dispute, the host's share
//    (total minus PLATFORM_FEE_BPS) is transferred to their Stripe account.
//    Admins settle disputes by paying the host or refunding the renter.

const PAYOUT_HOLD = 24 * 3600;

const paymentsEnabled = (env) => !!(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);

function platformFee(env, total) {
  const bps = Number.isInteger(Number(env.PLATFORM_FEE_BPS)) ? Number(env.PLATFORM_FEE_BPS) : 1000;
  return Math.floor((total * Math.min(5000, Math.max(0, bps))) / 10_000);
}

function formEncode(obj, prefix = "", out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") formEncode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.join("&");
}

class StripeError extends Error {
  constructor(status, body) {
    super((body && body.error && body.error.message) || `Stripe request failed (${status})`);
    this.status = status;
    this.code = body && body.error && body.error.code;
  }
}

async function stripe(env, method, path, params, idempotencyKey) {
  const doFetch = env.STRIPE_FETCH || fetch;
  const headers = { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "stripe-version": "2024-06-20" };
  let url = `https://api.stripe.com/v1/${path}`;
  let body;
  if (method === "GET") {
    if (params) url += "?" + formEncode(params);
  } else {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = formEncode(params || {});
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  }
  const res = await doFetch(url, { method, headers, body, signal: AbortSignal.timeout(15_000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new StripeError(res.status, data);
  return data;
}

async function startCheckout(env, site, r, renter) {
  const session = await stripe(env, "POST", "checkout/sessions", {
    mode: "payment",
    customer_email: renter.email,
    client_reference_id: r.id,
    expires_at: now() + 31 * 60,
    line_items: { 0: { quantity: 1, price_data: { currency: "usd", unit_amount: r.total_cents, product_data: { name: `${r.gpu_count} × ${r.gpu_model} for ${r.hours} h`, description: `TDCC marketplace rental ${r.id}` } } } },
    payment_intent_data: { capture_method: "manual", transfer_group: r.id, metadata: { rental_id: r.id }, description: `TDCC rental ${r.id}` },
    metadata: { rental_id: r.id },
    success_url: `${site}/account.html#rentals`,
    cancel_url: `${site}/account.html#rentals`,
  }, `checkout-${r.id}`);
  await env.DB.prepare("UPDATE rentals SET checkout_session_id = ? WHERE id = ?").bind(session.id, r.id).run();
  return session;
}

async function capturePayment(env, id) {
  const r = await env.DB.prepare("SELECT payment_intent_id FROM rentals WHERE id = ?").bind(id).first();
  try {
    const pi = await stripe(env, "POST", `payment_intents/${r.payment_intent_id}/capture`, {}, `capture-${id}`);
    await env.DB.prepare("UPDATE rentals SET payment_status = 'captured', charge_id = ?, payout_status = 'held' WHERE id = ?").bind(pi.latest_charge || null, id).run();
    return true;
  } catch (err) {
    console.error("capture failed", id, err.message);
    await env.DB.prepare("UPDATE rentals SET payment_status = 'failed' WHERE id = ?").bind(id).run();
    return false;
  }
}

async function releasePayment(env, id) {
  const r = await env.DB.prepare("SELECT payment_intent_id, payment_status FROM rentals WHERE id = ?").bind(id).first();
  if (!r || !r.payment_intent_id || r.payment_status !== "authorized") return;
  try {
    await stripe(env, "POST", `payment_intents/${r.payment_intent_id}/cancel`, {}, `release-${id}`);
  } catch (err) {
    // Already cancelled or expired on Stripe's side: the hold is gone either way.
    if (err.code !== "payment_intent_unexpected_state") throw err;
  }
  await env.DB.prepare("UPDATE rentals SET payment_status = 'released' WHERE id = ?").bind(id).run();
}

async function refundPayment(env, id, amount, reason) {
  const r = await env.DB.prepare("SELECT payment_intent_id, payment_status, total_cents, refunded_cents, payout_status FROM rentals WHERE id = ?").bind(id).first();
  if (!r || r.payment_status !== "captured" && r.payment_status !== "partially_refunded") return 0;
  amount = Math.min(amount, r.total_cents - r.refunded_cents);
  if (amount <= 0) return 0;
  if (r.payout_status === "paid") throw new HttpError(409, "The host was already paid for this rental. An admin has to settle it.");
  await stripe(env, "POST", "refunds", { payment_intent: r.payment_intent_id, amount, metadata: { rental_id: id, reason } }, `refund-${id}-${r.refunded_cents}-${amount}`);
  const refunded = r.refunded_cents + amount;
  await env.DB.prepare("UPDATE rentals SET refunded_cents = ?, payment_status = ? WHERE id = ?")
    .bind(refunded, refunded >= r.total_cents ? "refunded" : "partially_refunded", id).run();
  return amount;
}

// The host's share of what the renter finally paid.
function hostShare(r) {
  const kept = r.total_cents - (r.refunded_cents || 0);
  const fee = Math.floor((r.fee_cents * kept) / Math.max(1, r.total_cents));
  return Math.max(0, kept - fee);
}

async function payHost(env, id) {
  const r = await env.DB.prepare(
    `SELECT r.*, u.payout_account_id FROM rentals r JOIN listings l ON l.id = r.listing_id JOIN users u ON u.id = l.owner_id WHERE r.id = ?`
  ).bind(id).first();
  if (!r || r.payout_status !== "held") return;
  const amount = hostShare(r);
  if (!r.payout_account_id || amount <= 0) {
    await env.DB.prepare("UPDATE rentals SET payout_status = ? WHERE id = ?").bind(amount <= 0 ? "none" : "failed", id).run();
    return;
  }
  // Claim the payout first so two runs cannot both transfer.
  const claim = await env.DB.prepare("UPDATE rentals SET payout_status = 'paying' WHERE id = ? AND payout_status = 'held'").bind(id).run();
  if (!claim.meta.changes) return;
  try {
    const tr = await stripe(env, "POST", "transfers", {
      amount, currency: "usd", destination: r.payout_account_id, transfer_group: id,
      ...(r.charge_id ? { source_transaction: r.charge_id } : {}),
      metadata: { rental_id: id },
    }, `payout-${id}`);
    await env.DB.prepare("UPDATE rentals SET payout_status = 'paid', transfer_id = ? WHERE id = ?").bind(tr.id, id).run();
  } catch (err) {
    console.error("payout failed", id, err.message);
    await env.DB.prepare("UPDATE rentals SET payout_status = 'held' WHERE id = ?").bind(id).run();
  }
}

// Pays hosts for finished rentals once the dispute window has passed.
async function runPayouts(env) {
  if (!paymentsEnabled(env)) return;
  const due = await env.DB.prepare(
    `SELECT r.id FROM rentals r WHERE r.payout_status = 'held' AND r.status IN ('completed', 'cancelled')
       AND r.updated_at <= ? AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.rental_id = r.id AND d.resolved_at IS NULL) LIMIT 50`
  ).bind(now() - PAYOUT_HOLD).all();
  for (const r of due.results) await payHost(env, r.id);
}

// ---------- host payout account ----------

async function payoutStatus(request, env) {
  const user = await requireUser(request, env);
  if (!paymentsEnabled(env)) return json(200, { enabled: false });
  const row = await env.DB.prepare("SELECT payout_account_id, payouts_enabled FROM users WHERE id = ?").bind(user.id).first();
  let ready = !!row.payouts_enabled;
  if (row.payout_account_id && !ready) {
    const acct = await stripe(env, "GET", `accounts/${row.payout_account_id}`);
    ready = !!(acct.charges_enabled || acct.payouts_enabled) && !!acct.details_submitted;
    if (ready) await env.DB.prepare("UPDATE users SET payouts_enabled = 1 WHERE id = ?").bind(user.id).run();
  }
  const earnings = await env.DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN r.payout_status = 'paid' THEN 1 ELSE 0 END), 0) AS paid_count,
       COALESCE(SUM(CASE WHEN r.payout_status IN ('held', 'paying') THEN r.total_cents - r.refunded_cents - r.fee_cents ELSE 0 END), 0) AS pending_cents,
       COALESCE(SUM(CASE WHEN r.payout_status = 'paid' THEN r.total_cents - r.refunded_cents - r.fee_cents ELSE 0 END), 0) AS paid_cents
     FROM rentals r JOIN listings l ON l.id = r.listing_id WHERE l.owner_id = ?`
  ).bind(user.id).first();
  return json(200, { enabled: true, account: !!row.payout_account_id, ready, fee_bps: platformFee(env, 10_000), ...earnings });
}

async function payoutOnboard(request, env) {
  const user = await requireUser(request, env);
  requireVerified(env, user);
  if (!paymentsEnabled(env)) throw new HttpError(503, "Card payments are not set up on this deployment.");
  await limit(env, "payout:" + user.id, 10, 3600);
  const site = siteUrl(env, request);
  const row = await env.DB.prepare("SELECT payout_account_id, payouts_enabled FROM users WHERE id = ?").bind(user.id).first();
  let acct = row.payout_account_id;
  if (!acct) {
    const a = await stripe(env, "POST", "accounts", {
      type: "express", email: user.email,
      capabilities: { transfers: { requested: true } },
      metadata: { user_id: user.id },
    }, `account-${user.id}`);
    acct = a.id;
    await env.DB.prepare("UPDATE users SET payout_account_id = ? WHERE id = ? AND payout_account_id IS NULL").bind(acct, user.id).run();
  }
  if (row.payouts_enabled) {
    const login = await stripe(env, "POST", `accounts/${acct}/login_links`, {});
    return json(200, { url: login.url });
  }
  const link = await stripe(env, "POST", "account_links", {
    account: acct, type: "account_onboarding",
    refresh_url: `${site}/account.html#listings`, return_url: `${site}/account.html#listings`,
  });
  await audit(env, request, user.id, "payout_setup_started");
  return json(200, { url: link.url });
}

// ---------- Stripe webhook ----------

async function verifyStripeSignature(env, header, payload) {
  const parts = Object.fromEntries((header || "").split(",").map((kv) => kv.split("=")).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const sigs = (header || "").split(",").filter((kv) => kv.trim().startsWith("v1=")).map((kv) => kv.trim().slice(3));
  const ts = Number(parts.t);
  if (!ts || !sigs.length || Math.abs(now() - ts) > 300) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(env.STRIPE_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${ts}.${payload}`)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.some((s) => safeEqual(s, hex));
}

async function stripeWebhook(request, env, ctx) {
  if (!paymentsEnabled(env)) throw new HttpError(404, "Not found.");
  const payload = await request.text();
  if (payload.length > 512 * 1024) throw new HttpError(413, "Too large.");
  if (!(await verifyStripeSignature(env, request.headers.get("stripe-signature"), payload))) throw new HttpError(400, "Bad signature.");
  const event = JSON.parse(payload);
  // Stripe retries deliveries; handle each event once.
  const fresh = await env.DB.prepare("INSERT INTO stripe_events (id, type, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING").bind(event.id, event.type, now()).run();
  if (!fresh.meta.changes) return json(200, { ok: true, duplicate: true });
  try {
    return await handleStripeEvent(request, env, ctx, event);
  } catch (err) {
    // Forget the event so Stripe's retry is processed instead of ignored.
    await env.DB.prepare("DELETE FROM stripe_events WHERE id = ?").bind(event.id).run();
    throw err;
  }
}

async function handleStripeEvent(request, env, ctx, event) {
  const obj = event.data && event.data.object || {};
  const t = now();
  if (event.type === "checkout.session.completed") {
    const id = obj.metadata && obj.metadata.rental_id;
    const res = await env.DB.prepare(
      "UPDATE rentals SET status = 'pending', payment_status = 'authorized', payment_intent_id = ?, updated_at = ? WHERE id = ? AND status = 'awaiting_payment' AND checkout_session_id = ?"
    ).bind(obj.payment_intent, t, id, obj.id).run();
    if (res.meta.changes) {
      const r = await env.DB.prepare(`${RENTAL_SELECT} WHERE r.id = ?`).bind(id).first();
      await notifyNewRequest(env, siteUrl(env, request), ctx, r);
    } else if (obj.payment_intent) {
      // The request was cancelled while the renter was paying: let the hold go.
      await env.DB.prepare("UPDATE rentals SET payment_intent_id = ?, payment_status = 'authorized' WHERE id = ? AND payment_intent_id IS NULL").bind(obj.payment_intent, id).run();
      await releasePayment(env, id).catch(() => {});
    }
  } else if (event.type === "checkout.session.expired") {
    await env.DB.prepare("UPDATE rentals SET status = 'cancelled', payment_status = 'none', host_note = 'Payment was not completed.', updated_at = ? WHERE checkout_session_id = ? AND status = 'awaiting_payment'")
      .bind(t, obj.id).run();
  } else if (event.type === "account.updated") {
    const ready = !!(obj.charges_enabled || obj.payouts_enabled) && !!obj.details_submitted;
    await env.DB.prepare("UPDATE users SET payouts_enabled = ? WHERE payout_account_id = ?").bind(ready ? 1 : 0, obj.id).run();
  } else if (event.type === "charge.dispute.created") {
    // A card chargeback freezes the host payout until an admin looks at it.
    const id = obj.payment_intent && (await env.DB.prepare("SELECT id FROM rentals WHERE payment_intent_id = ?").bind(obj.payment_intent).first())?.id;
    const renter = id && (await env.DB.prepare("SELECT renter_id FROM rentals WHERE id = ?").bind(id).first())?.renter_id;
    if (renter) {
      await env.DB.prepare("INSERT INTO disputes (id, rental_id, opened_by, reason, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(rental_id, opened_by) DO NOTHING")
        .bind(newId("dsp"), id, renter, `Card chargeback opened with the bank (${obj.reason || "no reason given"}).`, t).run();
    }
  }
  return json(200, { ok: true });
}

// ---------- reports and moderation ----------

async function reportListing(request, env, ctx, id) {
  const user = await requireUser(request, env);
  await limit(env, "report:" + user.id, 10, 86400);
  const row = await getListing(env, id);
  if (row.owner_id === user.id) throw new HttpError(409, "This is your own listing.");
  const reason = text((await readJson(request)).reason, "Reason", { min: 5, max: 1000, multiline: true });
  await env.DB.prepare(
    `INSERT INTO reports (id, listing_id, reporter_id, reason, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(listing_id, reporter_id) DO UPDATE SET reason = excluded.reason, created_at = excluded.created_at, resolved_at = NULL, resolution = ''`
  ).bind(newId("rpt"), id, user.id, reason, now()).run();
  if (emailEnabled(env) && env.ADMIN_EMAILS) {
    const site = siteUrl(env, request);
    const admins = env.ADMIN_EMAILS.split(",").map((x) => x.trim()).filter(Boolean);
    await later(ctx, Promise.all(admins.map((to) => sendEmail(env, {
      to,
      subject: `Listing reported: ${row.gpu_model}`,
      text: `${user.name} reported listing ${id} (${row.gpu_model}):\n\n${reason}\n\nReview it at ${site}/admin.html`,
    }))));
  }
  return json(200, { ok: true });
}

// Lets card holds go for requests that were closed in bulk (moderation, account deletion).
async function releaseAll(env, sql, ...args) {
  if (!paymentsEnabled(env)) return;
  const rows = await env.DB.prepare(`SELECT id FROM rentals WHERE payment_status = 'authorized' AND ${sql}`).bind(...args).all();
  for (const r of rows.results) await releasePayment(env, r.id).catch((err) => console.error("release failed", r.id, err.message));
}

async function requireAdmin(request, env) {
  const user = await requireUser(request, env);
  if (!isAdmin(env, user)) throw new HttpError(404, "Not found.");
  return user;
}

async function adminOverview(request, env) {
  await requireAdmin(request, env);
  const reports = await env.DB.prepare(
    `SELECT r.id, r.listing_id, r.reason, r.created_at, u.name AS reporter_name, u.email AS reporter_email,
       l.gpu_model, l.status AS listing_status, l.owner_id, o.name AS owner_name, o.email AS owner_email, o.suspended_at AS owner_suspended_at
     FROM reports r JOIN users u ON u.id = r.reporter_id JOIN listings l ON l.id = r.listing_id JOIN users o ON o.id = l.owner_id
     WHERE r.resolved_at IS NULL ORDER BY r.created_at DESC LIMIT 200`
  ).all();
  const listings = await env.DB.prepare(
    `SELECT l.id, l.gpu_model, l.vram_gb, l.gpu_count, l.region, l.price_cents, l.status, l.moderation_note, l.created_at, l.owner_id,
       o.name AS owner_name, o.email AS owner_email, o.suspended_at AS owner_suspended_at,
       (SELECT COUNT(*) FROM reports r WHERE r.listing_id = l.id AND r.resolved_at IS NULL) AS open_reports
     FROM listings l JOIN users o ON o.id = l.owner_id WHERE l.status != 'removed' ORDER BY l.created_at DESC LIMIT 500`
  ).all();
  const stats = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM listings WHERE status = 'active') AS active_listings,
       (SELECT COUNT(*) FROM rentals WHERE status = 'pending') AS pending_rentals, (SELECT COUNT(*) FROM rentals WHERE status = 'accepted') AS running_rentals`
  ).first();
  const disputes = await env.DB.prepare(
    `SELECT d.id, d.rental_id, d.reason, d.created_at, d.opened_by, o.name AS opened_by_name, o.email AS opened_by_email,
       r.status AS rental_status, r.total_cents, r.refunded_cents, r.payment_status, r.payout_status, r.hours, r.gpu_count,
       l.gpu_model, h.name AS host_name, h.email AS host_email, u.name AS renter_name, u.email AS renter_email
     FROM disputes d JOIN users o ON o.id = d.opened_by JOIN rentals r ON r.id = d.rental_id JOIN listings l ON l.id = r.listing_id
       JOIN users h ON h.id = l.owner_id JOIN users u ON u.id = r.renter_id
     WHERE d.resolved_at IS NULL ORDER BY d.created_at DESC LIMIT 200`
  ).all();
  return json(200, { reports: reports.results, listings: listings.results, disputes: disputes.results, stats, payments: paymentsEnabled(env) });
}

// Settle a dispute: "dismiss" (nothing changes), "refund" (amount in cents
// back to the renter), or "pay_host" (release the held payout now).
async function adminDispute(request, env, id) {
  const admin = await requireAdmin(request, env);
  const body = await readJson(request);
  const action = oneOf(body.action, "Action", ["dismiss", "refund", "pay_host"]);
  const note = text(body.note, "Note", { max: 500, multiline: true });
  const d = await env.DB.prepare("SELECT d.rental_id, r.total_cents, r.refunded_cents FROM disputes d JOIN rentals r ON r.id = d.rental_id WHERE d.id = ? AND d.resolved_at IS NULL").bind(id).first();
  if (!d) throw new HttpError(404, "Dispute not found or already settled.");
  let outcome = `dismissed by ${admin.email}`;
  if (action === "refund") {
    const amount = int(body.amount_cents, "Refund amount", 1, d.total_cents - d.refunded_cents);
    const done = await refundPayment(env, d.rental_id, amount, "Dispute settled by TDCC");
    if (!done) throw new HttpError(409, "There is no card payment on this rental to refund. Settle it with both sides by email.");
    outcome = `refunded ${(done / 100).toFixed(2)} USD by ${admin.email}`;
  }
  const t = now();
  await env.DB.prepare("UPDATE disputes SET resolved_at = ?, resolution = ? WHERE rental_id = ? AND resolved_at IS NULL").bind(t, note ? `${outcome}: ${note}` : outcome, d.rental_id).run();
  if (action === "pay_host") {
    await env.DB.prepare("UPDATE rentals SET updated_at = ? WHERE id = ?").bind(t - PAYOUT_HOLD, d.rental_id).run();
    await payHost(env, d.rental_id);
  }
  return json(200, { ok: true });
}

async function adminListing(request, env, id, action) {
  const admin = await requireAdmin(request, env);
  const note = text((await readJson(request)).note, "Note", { max: 500, multiline: true });
  const row = await env.DB.prepare("SELECT id, status FROM listings WHERE id = ?").bind(id).first();
  if (!row || row.status === "removed") throw new HttpError(404, "Listing not found.");
  const t = now();
  if (action === "hide") {
    await releaseAll(env, "listing_id = ? AND status = 'pending'", id);
    await env.DB.batch([
      env.DB.prepare("UPDATE listings SET status = 'hidden', moderation_note = ?, node_token_hash = NULL, updated_at = ? WHERE id = ?").bind(note || "Hidden by moderators.", t, id),
      env.DB.prepare("UPDATE rentals SET status = 'declined', host_note = 'This listing was removed by moderators.', updated_at = ? WHERE listing_id = ? AND status = 'pending'").bind(t, id),
      env.DB.prepare("UPDATE reports SET resolved_at = ?, resolution = ? WHERE listing_id = ? AND resolved_at IS NULL").bind(t, `hidden by ${admin.email}`, id),
    ]);
  } else {
    await env.DB.prepare("UPDATE listings SET status = 'paused', moderation_note = '', updated_at = ? WHERE id = ? AND status = 'hidden'").bind(t, id).run();
  }
  return json(200, { ok: true });
}

async function adminDismissReport(request, env, id) {
  const admin = await requireAdmin(request, env);
  await env.DB.prepare("UPDATE reports SET resolved_at = ?, resolution = ? WHERE id = ? AND resolved_at IS NULL").bind(now(), `dismissed by ${admin.email}`, id).run();
  return json(200, { ok: true });
}

async function adminUser(request, env, id, action) {
  const admin = await requireAdmin(request, env);
  if (id === admin.id) throw new HttpError(409, "You cannot suspend your own account.");
  const t = now();
  if (action === "suspend") {
    await releaseAll(env, "status = 'pending' AND (renter_id = ?1 OR listing_id IN (SELECT id FROM listings WHERE owner_id = ?1))", id);
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET suspended_at = ? WHERE id = ?").bind(t, id),
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id),
      env.DB.prepare("UPDATE listings SET status = 'hidden', moderation_note = 'Account suspended.', node_token_hash = NULL, updated_at = ? WHERE owner_id = ? AND status IN ('active', 'paused')").bind(t, id),
      env.DB.prepare("UPDATE rentals SET status = 'cancelled', updated_at = ? WHERE status = 'pending' AND (renter_id = ? OR listing_id IN (SELECT id FROM listings WHERE owner_id = ?))").bind(t, id, id),
    ]);
  } else {
    await env.DB.prepare("UPDATE users SET suspended_at = NULL WHERE id = ?").bind(id).run();
  }
  return json(200, { ok: true });
}

// ---------- error reporting ----------
//
// With SENTRY_DSN set, unexpected errors are sent to Sentry (no request
// bodies, cookies, or user details: only the error, route, and method).
export async function reportError(env, err, request) {
  if (!env.SENTRY_DSN) return;
  try {
    const dsn = new URL(env.SENTRY_DSN);
    const project = dsn.pathname.replace(/^\//, "");
    const eventId = crypto.randomUUID().replace(/-/g, "");
    const event = {
      event_id: eventId,
      timestamp: new Date().toISOString(),
      platform: "javascript",
      level: "error",
      environment: env.SENTRY_ENVIRONMENT || "production",
      exception: { values: [{ type: (err && err.name) || "Error", value: String((err && err.message) || err).slice(0, 1000), stacktrace: err && err.stack ? { frames: String(err.stack).split("\n").slice(1, 30).reverse().map((l) => ({ function: l.trim().slice(0, 200) })) } : undefined }] },
      request: request ? { method: request.method, url: new URL(request.url).pathname } : undefined,
    };
    const envelope = `${JSON.stringify({ event_id: eventId, dsn: env.SENTRY_DSN })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}`;
    await fetch(`${dsn.protocol}//${dsn.host}/api/${project}/envelope/`, {
      method: "POST",
      headers: { "content-type": "application/x-sentry-envelope", "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${dsn.username}, sentry_client=tdcc-landing/1` },
      body: envelope,
      signal: AbortSignal.timeout(5_000),
    });
  } catch { /* reporting must never fail the request */ }
}

// Cron trigger entry (see wrangler.toml).
export async function scheduled(env) {
  await housekeeping(env);
  await runPayouts(env);
}

// ---------- router ----------

function sameOrigin(request, env) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const self = new URL(request.url).origin;
  if (origin === self) return true;
  const extra = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return extra.includes(origin);
}

export async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;

  try {
    if (!env.DB) throw new HttpError(503, "The marketplace database is not configured on this deployment.");
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: { allow: "GET, POST, PATCH, DELETE" } });

    if (path === "/api/node/heartbeat" && method === "POST") return await nodeHeartbeat(request, env);
    if (path === "/api/stripe/webhook" && method === "POST") return await stripeWebhook(request, env, ctx);
    if (path === "/api/market/key" && method === "GET") return await publicMarketKey(env);

    if (method !== "GET" && method !== "HEAD" && !sameOrigin(request, env)) {
      throw new HttpError(403, "This request did not come from the marketplace page.");
    }

    const seg = path.split("/").slice(2); // ["listings", ":id", ...]
    const isId = (x) => /^(gpu|rnt|usr|rpt|dsp)_[A-Za-z0-9_-]{1,40}$/.test(x);
    const route = `${method} /${seg.map((x) => (isId(x) ? ":id" : x)).join("/")}`;
    const id = seg.find(isId);

    switch (route) {
      case "GET /health": return json(200, { ok: true });
      case "GET /me": return await me(request, env);
      case "DELETE /me": return await deleteAccount(request, env);
      case "POST /me/password": return await changePassword(request, env);
      case "POST /me/verify-email": return await resendVerification(request, env, ctx);
      case "POST /me/email": return await changeEmail(request, env, ctx);
      case "GET /me/2fa": return await twoFactorSetup(request, env);
      case "POST /me/2fa": return await twoFactorEnable(request, env);
      case "DELETE /me/2fa": return await twoFactorDisable(request, env);
      case "GET /me/sessions": return await listSessions(request, env);
      case "POST /me/sessions/revoke": return await revokeSessions(request, env);
      case "GET /me/activity": return await activity(request, env);
      case "GET /me/export": return await exportData(request, env);
      case "GET /me/payouts": return await payoutStatus(request, env);
      case "POST /me/payouts": return await payoutOnboard(request, env);
      case "POST /auth/login/2fa": return await loginSecondStep(request, env);
      case "POST /auth/email-change": return await confirmEmailChange(request, env);
      case "GET /listings/:id/reviews": return await listingReviews(request, env, id);
      case "GET /rentals/:id/messages": return await listMessages(request, env, id);
      case "POST /rentals/:id/messages": return await postMessage(request, env, ctx, id);
      case "POST /rentals/:id/review": return await reviewRental(request, env, id);
      case "POST /rentals/:id/dispute": return await openDispute(request, env, ctx, id);
      case "POST /admin/disputes/:id": return await adminDispute(request, env, id);
      case "POST /auth/signup": return await signup(request, env, ctx);
      case "POST /auth/verify": return await verifyEmail(request, env);
      case "POST /auth/forgot": return await forgotPassword(request, env, ctx);
      case "POST /auth/reset": return await resetPassword(request, env);
      case "POST /auth/login": return await login(request, env);
      case "POST /auth/logout": return await logout(request, env);
      case "GET /listings": return await listListings(request, env);
      case "POST /listings": return await createListing(request, env);
      case "GET /listings/:id": return await showListing(request, env, id);
      case "PATCH /listings/:id": return await updateListing(request, env, id);
      case "DELETE /listings/:id": return await removeListing(request, env, id);
      case "POST /listings/:id/node-token": return await linkNode(request, env, id);
      case "DELETE /listings/:id/node-token": return await unlinkNode(request, env, id);
      case "GET /my/listings": return await myListings(request, env);
      case "GET /my/rentals": return await myRentals(request, env);
      case "GET /my/requests": return await myRequests(request, env);
      case "POST /rentals": return await createRental(request, env, ctx);
      case "POST /listings/:id/report": return await reportListing(request, env, ctx, id);
      case "GET /admin": return await adminOverview(request, env);
      case "POST /admin/reports/:id/dismiss": return await adminDismissReport(request, env, id);
    }
    let m = route.match(/^POST \/rentals\/:id\/(accept|decline|cancel|complete)$/);
    if (m) return await transitionRental(request, env, ctx, id, m[1]);
    m = route.match(/^POST \/admin\/listings\/:id\/(hide|restore)$/);
    if (m) return await adminListing(request, env, id, m[1]);
    m = route.match(/^POST \/admin\/users\/:id\/(suspend|unsuspend)$/);
    if (m) return await adminUser(request, env, id, m[1]);
    throw new HttpError(404, "Not found.");
  } catch (err) {
    if (err instanceof HttpError) {
      const headers = err.extra?.retryAfter ? { "retry-after": String(err.extra.retryAfter) } : {};
      return json(err.status, { error: err.message, field: err.extra?.field }, headers);
    }
    if (err instanceof StripeError) {
      console.error("stripe error", err.status, err.message);
      return json(502, { error: "The payment provider did not accept this right now. Nothing was charged; please try again in a minute." });
    }
    console.error("marketplace api error", err && err.stack ? err.stack : err);
    later(ctx, reportError(env, err, request));
    return json(500, { error: "Something went wrong on our side. Please try again." });
  }
}
