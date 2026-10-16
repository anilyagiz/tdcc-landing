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

const SESSION_COOKIE = "__Host-tdcc_sid";
const SESSION_TTL = 30 * 24 * 3600;
const PBKDF2_ITER = 100_000; // Workers' WebCrypto upper bound for PBKDF2.
const MAX_BODY = 16 * 1024;
const NODE_ONLINE_WINDOW = 180;
const NODE_TOKEN_PREFIX = "tdcc_node_";

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
const ENVIRONMENTS = ["pytorch", "vllm", "ubuntu", "custom"];
const ACCESS = ["ssh", "jupyter", "api"];

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

async function createSession(env, userId) {
  const token = randomToken(32);
  const t = now();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), userId, t, t + SESSION_TTL).run();
  if (Math.random() < 0.05) await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(t).run();
  return sessionCookie(token, SESSION_TTL);
}

async function currentUser(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token || token.length > 100) return null;
  return env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`
  ).bind(await sha256(token), now()).first();
}

async function requireUser(request, env) {
  const user = await currentUser(request, env);
  if (!user) throw new HttpError(401, "Please sign in first.");
  return user;
}

const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, created_at: u.created_at });

// ---------- auth handlers ----------

// A fixed hash used when the email is unknown, so a failed login takes the same
// time whether or not the account exists.
const DUMMY_SALT = "tdcc-dummy-salt-000000";

async function signup(request, env) {
  await limit(env, "signup:" + clientIp(request), 20, 3600);
  const body = await readJson(request);
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
  const cookie = await createSession(env, id);
  return json(201, { user: { id, email: e, name } }, { "set-cookie": cookie });
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
  if (!user || !safeEqual(hash, user.pw_hash)) throw new HttpError(401, "Email or password is incorrect.");

  const cookie = await createSession(env, user.id);
  return json(200, { user: publicUser(user) }, { "set-cookie": cookie });
}

async function logout(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  return json(200, { ok: true }, { "set-cookie": sessionCookie("", 0) });
}

async function me(request, env) {
  const user = await currentUser(request, env);
  return json(200, { user: user ? publicUser(user) : null });
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
  const cookie = await createSession(env, user.id);
  return json(200, { ok: true }, { "set-cookie": cookie });
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
  await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id).run();
  return json(200, { ok: true }, { "set-cookie": sessionCookie("", 0) });
}

// ---------- listings ----------

const LISTING_SELECT = `
  SELECT l.*, u.name AS host_name,
    l.gpu_count - COALESCE((SELECT SUM(r.gpu_count) FROM rentals r WHERE r.listing_id = l.id AND r.status = 'accepted'), 0) AS available,
    (SELECT COUNT(*) FROM rentals r JOIN listings l2 ON l2.id = r.listing_id WHERE l2.owner_id = l.owner_id AND r.status = 'completed') AS host_completed
  FROM listings l JOIN users u ON u.id = l.owner_id`;

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
    online: !!row.node_seen_at && t - row.node_seen_at < NODE_ONLINE_WINDOW,
    node_seen_at: row.node_seen_at || null,
    node_gpus: gpus,
    status: row.status,
    created_at: row.created_at,
  };
  if (owner) {
    out.node_linked = !!row.node_token_hash;
    out.node_version = row.node_version || null;
  }
  return out;
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

async function listListings(request, env) {
  const rows = await env.DB.prepare(`${LISTING_SELECT} WHERE l.status = 'active' ORDER BY l.price_cents ASC LIMIT 500`).all();
  return json(200, { listings: rows.results.map((r) => listingOut(r)), regions: REGIONS, host_kinds: HOST_KINDS }, { "cache-control": "no-store" });
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
  const { user } = await ownedListing(request, env, id);
  await limit(env, "write:" + user.id, 30, 60);
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
  await env.DB.prepare("UPDATE listings SET node_token_hash = ?, node_seen_at = NULL, node_gpus = NULL, node_version = NULL, updated_at = ? WHERE id = ?")
    .bind(await sha256(token), now(), id).run();
  return json(200, { token });
}

async function unlinkNode(request, env, id) {
  await ownedListing(request, env, id);
  await env.DB.prepare("UPDATE listings SET node_token_hash = NULL, node_seen_at = NULL, node_gpus = NULL, node_version = NULL, updated_at = ? WHERE id = ?")
    .bind(now(), id).run();
  return json(200, { ok: true });
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
  await env.DB.prepare("UPDATE listings SET node_seen_at = ?, node_version = ?, node_gpus = ? WHERE id = ?")
    .bind(now(), version, JSON.stringify(gpus), listing.id).run();
  const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM rentals WHERE listing_id = ? AND status = 'pending'").bind(listing.id).first();
  return json(200, { ok: true, listing_id: listing.id, listing_status: listing.status, pending_requests: pending.n, next_heartbeat_secs: 60 });
}

// ---------- rentals ----------

const OPEN_STATUSES = ["accepted", "completed"];

function rentalOut(r, side) {
  const revealed = OPEN_STATUSES.includes(r.status);
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
  };
  if (side === "renter") {
    out.host_name = r.host_name;
    out.host_email = revealed ? r.host_email : null;
  } else {
    out.renter_name = r.renter_name;
    out.renter_email = revealed ? r.renter_email : null;
    out.ssh_key = revealed ? r.ssh_key : null;
  }
  return out;
}

const RENTAL_SELECT = `
  SELECT r.*, l.gpu_model, l.vram_gb, l.region, l.owner_id,
    h.name AS host_name, h.email AS host_email, u.name AS renter_name, u.email AS renter_email
  FROM rentals r JOIN listings l ON l.id = r.listing_id JOIN users h ON h.id = l.owner_id JOIN users u ON u.id = r.renter_id`;

async function createRental(request, env) {
  const user = await requireUser(request, env);
  await limit(env, "rent:" + user.id, 10, 3600);
  const body = await readJson(request);
  const listingId = text(body.listing_id, "Listing", { min: 1, max: 40 });
  const row = await getListing(env, listingId);
  if (row.status !== "active") throw new HttpError(409, "This listing is paused and is not taking requests right now.");
  if (row.owner_id === user.id) throw new HttpError(409, "This is your own listing.");

  const count = int(body.gpu_count, "Number of GPUs", 1, 512);
  if (count > row.available) throw new HttpError(409, row.available ? `Only ${row.available} GPU${row.available === 1 ? " is" : "s are"} free on this listing right now.` : "All GPUs on this listing are rented out right now.", { field: "gpu_count" });
  const hours = int(body.hours, "Hours", row.min_hours, 2160);
  const environment = oneOf(body.environment, "Environment", ENVIRONMENTS);
  const img = environment === "custom" ? image(body.image) : "";
  const access = oneOf(body.access, "Access", ACCESS);
  const key = sshKey(body.ssh_key);
  if (access === "ssh" && !key) throw new HttpError(400, "Paste your SSH public key so the host can give you access.", { field: "ssh_key" });
  const message = text(body.message, "Message", { max: 1000, multiline: true });

  const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM rentals WHERE renter_id = ? AND status = 'pending'").bind(user.id).first();
  if (pending.n >= 10) throw new HttpError(409, "You already have 10 requests waiting for an answer. Cancel one or wait for hosts to reply.");

  const id = newId("rnt");
  const t = now();
  await env.DB.prepare(
    `INSERT INTO rentals (id, listing_id, renter_id, gpu_count, hours, environment, image, access, ssh_key, message, price_cents, total_cents, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).bind(id, row.id, user.id, count, hours, environment, img, access, key, message, row.price_cents, row.price_cents * count * hours, t, t).run();
  const r = await env.DB.prepare(`${RENTAL_SELECT} WHERE r.id = ?`).bind(id).first();
  return json(201, { rental: rentalOut(r, "renter") });
}

async function myRentals(request, env) {
  const user = await requireUser(request, env);
  const rows = await env.DB.prepare(`${RENTAL_SELECT} WHERE r.renter_id = ? ORDER BY r.created_at DESC LIMIT 200`).bind(user.id).all();
  return json(200, { rentals: rows.results.map((r) => rentalOut(r, "renter")) });
}

async function myRequests(request, env) {
  const user = await requireUser(request, env);
  const rows = await env.DB.prepare(`${RENTAL_SELECT} WHERE l.owner_id = ? ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'accepted' THEN 1 ELSE 2 END, r.created_at DESC LIMIT 200`).bind(user.id).all();
  return json(200, { requests: rows.results.map((r) => rentalOut(r, "host")) });
}

// Allowed transitions: who may move a rental from which status to which.
const TRANSITIONS = {
  accept: { by: "host", from: ["pending"], to: "accepted" },
  decline: { by: "host", from: ["pending"], to: "declined" },
  cancel: { by: "either", from: ["pending", "accepted"], to: "cancelled" },
  complete: { by: "either", from: ["accepted"], to: "completed" },
};

async function transitionRental(request, env, id, action) {
  const rule = TRANSITIONS[action];
  if (!rule) throw new HttpError(404, "Not found.");
  const user = await requireUser(request, env);
  await limit(env, "write:" + user.id, 30, 60);
  const body = await readJson(request);
  const r = await env.DB.prepare(`${RENTAL_SELECT} WHERE r.id = ?`).bind(id).first();
  const isHost = r && r.owner_id === user.id;
  const isRenter = r && r.renter_id === user.id;
  if (!r || (!isHost && !isRenter)) throw new HttpError(404, "This request does not exist.");
  if (rule.by === "host" && !isHost) throw new HttpError(403, "Only the host can do that.");
  if (!rule.from.includes(r.status)) throw new HttpError(409, `This request is already ${r.status}.`);
  const note = isHost ? text(body.note, "Note", { max: 1000, multiline: true }) : r.host_note;

  let sql = `UPDATE rentals SET status = ?, host_note = ?, updated_at = ? WHERE id = ? AND status IN (${rule.from.map(() => "?").join(", ")})`;
  if (action === "accept") {
    // Re-check capacity in the same statement so two accepts cannot overbook.
    sql += ` AND gpu_count <= (SELECT l.gpu_count - COALESCE((SELECT SUM(x.gpu_count) FROM rentals x WHERE x.listing_id = l.id AND x.status = 'accepted'), 0)
              FROM listings l WHERE l.id = rentals.listing_id)`;
  }
  const res = await env.DB.prepare(sql).bind(rule.to, note, now(), id, ...rule.from).run();
  if (!res.meta.changes) {
    if (action === "accept") throw new HttpError(409, "Not enough free GPUs left on this listing to accept this request.");
    throw new HttpError(409, "This request changed in the meantime. Refresh and try again.");
  }
  const updated = await env.DB.prepare(`${RENTAL_SELECT} WHERE r.id = ?`).bind(id).first();
  return json(200, { rental: rentalOut(updated, isHost ? "host" : "renter") });
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

export async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;

  try {
    if (!env.DB) throw new HttpError(503, "The marketplace database is not configured on this deployment.");
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: { allow: "GET, POST, PATCH, DELETE" } });

    if (path === "/api/node/heartbeat" && method === "POST") return await nodeHeartbeat(request, env);

    if (method !== "GET" && method !== "HEAD" && !sameOrigin(request, env)) {
      throw new HttpError(403, "This request did not come from the marketplace page.");
    }

    const seg = path.split("/").slice(2); // ["listings", ":id", ...]
    const route = `${method} /${seg.map((s, i) => (i === 1 && /^(gpu|rnt)_/.test(s) ? ":id" : s)).join("/")}`;
    const id = seg[1];

    switch (route) {
      case "GET /health": return json(200, { ok: true });
      case "GET /me": return await me(request, env);
      case "DELETE /me": return await deleteAccount(request, env);
      case "POST /me/password": return await changePassword(request, env);
      case "POST /auth/signup": return await signup(request, env);
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
      case "POST /rentals": return await createRental(request, env);
    }
    const m = route.match(/^POST \/rentals\/:id\/(accept|decline|cancel|complete)$/);
    if (m) return await transitionRental(request, env, id, m[1]);
    throw new HttpError(404, "Not found.");
  } catch (err) {
    if (err instanceof HttpError) {
      const headers = err.extra?.retryAfter ? { "retry-after": String(err.extra.retryAfter) } : {};
      return json(err.status, { error: err.message, field: err.extra?.field }, headers);
    }
    console.error("marketplace api error", err && err.stack ? err.stack : err);
    return json(500, { error: "Something went wrong on our side. Please try again." });
  }
}
