// OpenAI- and Anthropic-compatible gateway, the Worker twin of
// api/[[...path]].js on Vercel: /api/v1/* and /api/anthropic/* are forwarded
// to the upstream with our key, limited to the free model and to 30 requests a
// minute per IP (per /64 for IPv6). Needs the ZENMUX_API_KEY secret;
// PROXY_KEY, when set, is required from callers. With the D1 binding the limits are shared by every
// isolate (rate_limits table): 30/minute and GATEWAY_IP_DAILY_CAP a day per
// IP, plus GATEWAY_DAILY_CAP a day in total. Without it, an in-memory
// per-isolate counter is the only limit.

import { limit } from "./api.js";

const UPSTREAM_BASE = "https://zenmux.ai";
export const ALLOWED_MODELS = new Set(["deepseek/deepseek-v4-flash-free"]);

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;
const hits = new Map();
const DAY_SEC = 86_400;
const IP_DAILY_CAP = 500;
const DAILY_CAP = 20_000;

const HOP_BY_HOP = new Set([
  "host", "connection", "content-length", "content-encoding", "transfer-encoding", "keep-alive",
  "proxy-authenticate", "proxy-authorization", "te", "trailer", "upgrade",
  // Cloudflare adds these; the upstream does not need to see our edge.
  "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "x-forwarded-proto", "x-real-ip",
]);

// Only these upstream endpoints are reachable. Each one takes a JSON body
// with a `model`, which must be in ALLOWED_MODELS; anything else (other
// endpoints, multipart uploads, bodies without a model) would let callers
// spend our key on paid models.
const POST_PATHS = new Set(["/api/v1/chat/completions", "/api/v1/completions", "/api/v1/responses", "/api/anthropic/v1/messages", "/api/anthropic/v1/messages/count_tokens"]);
const GET_PATHS = new Set(["/api/v1/models", "/api/anthropic/v1/models"]);
const MAX_GATEWAY_BODY = 2 * 1024 * 1024;

export const isGatewayPath = (pathname) =>
  pathname === "/api/v1" || pathname.startsWith("/api/v1/") ||
  pathname === "/api/anthropic" || pathname.startsWith("/api/anthropic/");

function cors(request) {
  const origin = request.headers.get("origin");
  return {
    "access-control-allow-origin": origin || "*",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "*",
    "access-control-max-age": "86400",
    vary: origin ? "Origin" : "Accept-Encoding",
  };
}

function limited(ip, now = Date.now()) {
  if (hits.size > 10_000) for (const [k, e] of hits) if (now - e.start >= RATE_WINDOW_MS) hits.delete(k);
  const e = hits.get(ip);
  if (!e || now - e.start >= RATE_WINDOW_MS) { hits.set(ip, { start: now, count: 1 }); return false; }
  e.count += 1;
  return e.count > RATE_MAX;
}

const cap = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : fallback);

// Shared counter via the API's limit(): null when allowed, else seconds to wait.
// Database errors are rethrown so the caller can fall back.
async function dbLimited(env, key, max, windowSec) {
  try {
    await limit(env, key, max, windowSec);
    return null;
  } catch (e) {
    if (e && e.status === 429) return e.extra?.retryAfter || windowSec;
    throw e;
  }
}

// The address the limits count against. IPv4 stays as-is; an IPv6 client
// usually holds a whole /64 and could rotate through it for fresh buckets, so
// IPv6 is cut to its /64 prefix (IPv4-mapped addresses count as IPv4).
export function limitKey(ip) {
  if (!ip.includes(":")) return ip;
  let addr = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const v4 = addr.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b, c, d] = v4.slice(2).map(Number);
    addr = v4[1] + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const [left, right, extra] = addr.split("::");
  const l = left ? left.split(":") : [];
  const r = right ? right.split(":") : [];
  const groups = right === undefined ? l : [...l, ...Array(Math.max(0, 8 - l.length - r.length)).fill("0"), ...r];
  if (extra !== undefined || groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return addr;
  const n = groups.map((g) => parseInt(g, 16));
  if (n.slice(0, 5).every((x) => x === 0) && n[5] === 0xffff) return [n[6] >> 8, n[6] & 255, n[7] >> 8, n[7] & 255].join(".");
  return n.slice(0, 4).map((x) => x.toString(16)).join(":") + "::/64";
}

const text = (status, body, headers) => new Response(body, { status, headers: { ...headers, "content-type": "text/plain; charset=utf-8" } });

export async function handleGateway(request, env, upstreamFetch = fetch) {
  const url = new URL(request.url);
  const head = cors(request);

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: head });

  const ip = limitKey(request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown");
  const tooMany = (retry) => text(429, "Too many requests. Try again in a minute.", { ...head, "retry-after": String(retry) });
  let useDb = Boolean(env.DB);
  if (useDb) {
    try {
      const retry = await dbLimited(env, `gw:min:${ip}`, RATE_MAX, RATE_WINDOW_MS / 1000);
      if (retry) return tooMany(retry);
    } catch {
      useDb = false;
    }
  }
  if (!useDb && limited(ip)) return tooMany(60);

  if (env.PROXY_KEY) {
    const sent = request.headers.get("x-proxy-key") || (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (sent !== env.PROXY_KEY) return text(401, "Unauthorized: missing or invalid API key.", head);
  }

  if (!env.ZENMUX_API_KEY) return text(503, "The gateway is not configured on this deployment.", head);

  const path = url.pathname.replace(/\/+$/, "");
  const isRead = request.method === "GET" || request.method === "HEAD";
  if (isRead ? !GET_PATHS.has(path) : request.method !== "POST" || !POST_PATHS.has(path)) {
    return text(404, `${request.method} ${path} is not available on this gateway.`, head);
  }

  let body;
  if (!isRead) {
    if (Number(request.headers.get("content-length") || 0) > MAX_GATEWAY_BODY) return text(413, "Request body is too large.", head);
    body = await request.arrayBuffer();
    if (body.byteLength > MAX_GATEWAY_BODY) return text(413, "Request body is too large.", head);
    let parsed = null;
    try { parsed = JSON.parse(new TextDecoder().decode(body)); } catch { /* not JSON */ }
    if (!parsed || typeof parsed !== "object" || typeof parsed.model !== "string") {
      return text(400, `Send a JSON body with a "model". Allowed: ${[...ALLOWED_MODELS].join(", ")}`, head);
    }
    if (!ALLOWED_MODELS.has(parsed.model)) {
      return text(403, `Model '${parsed.model}' is not available on this gateway. Allowed: ${[...ALLOWED_MODELS].join(", ")}`, head);
    }
  }

  // Daily caps count only requests that would reach the upstream. The UTC date
  // in the key makes them reset at midnight.
  if (useDb) {
    const day = new Date().toISOString().slice(0, 10);
    const untilMidnight = Math.max(1, Math.ceil((Date.parse(day) + DAY_SEC * 1000 - Date.now()) / 1000));
    try {
      if (await dbLimited(env, `gw:day:${day}:${ip}`, cap(env.GATEWAY_IP_DAILY_CAP, IP_DAILY_CAP), DAY_SEC)) {
        return text(429, "Daily request limit reached for this address. Try again tomorrow.", { ...head, "retry-after": String(untilMidnight) });
      }
      if (await dbLimited(env, `gw:day:${day}`, cap(env.GATEWAY_DAILY_CAP, DAILY_CAP), DAY_SEC)) {
        return text(503, "The free gateway is at capacity for today. Please try again tomorrow.", head);
      }
    } catch { /* database unavailable: the per-minute check above still applied */ }
  }

  const headers = new Headers({ authorization: `Bearer ${env.ZENMUX_API_KEY}` });
  for (const [name, value] of request.headers) {
    const n = name.toLowerCase();
    if (HOP_BY_HOP.has(n) || n === "authorization" || n === "x-proxy-key" || n === "cookie") continue;
    headers.set(name, value);
  }

  // Limit only the wait for headers; streamed answers may run longer.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 120_000);
  let upstream;
  try {
    upstream = await upstreamFetch(UPSTREAM_BASE + path + url.search, {
      method: request.method,
      headers,
      body: body && body.byteLength ? body : undefined,
      signal: ac.signal,
    });
  } catch {
    return text(502, "The upstream did not answer. Please try again.", head);
  } finally {
    clearTimeout(timer);
  }

  const out = new Headers(head);
  upstream.headers.forEach((value, name) => { if (!HOP_BY_HOP.has(name.toLowerCase())) out.set(name, value); });
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

// Test hook: forget the per-IP counters.
export const resetGatewayLimits = () => hits.clear();
