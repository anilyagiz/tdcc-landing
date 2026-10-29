// OpenAI- and Anthropic-compatible gateway, the Worker twin of
// api/[[...path]].js on Vercel: /api/v1/* and /api/anthropic/* are forwarded
// to the upstream with our key, limited to the free model and to 30 requests a
// minute per IP. Needs the ZENMUX_API_KEY secret; PROXY_KEY, when set, is
// required from callers.

const UPSTREAM_BASE = "https://zenmux.ai";
export const ALLOWED_MODELS = new Set(["deepseek/deepseek-v4-flash-free"]);

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;
const hits = new Map();

const HOP_BY_HOP = new Set([
  "host", "connection", "content-length", "content-encoding", "transfer-encoding", "keep-alive",
  "proxy-authenticate", "proxy-authorization", "te", "trailer", "upgrade",
  // Cloudflare adds these; the upstream does not need to see our edge.
  "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "x-forwarded-proto", "x-real-ip",
]);

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

const text = (status, body, headers) => new Response(body, { status, headers: { ...headers, "content-type": "text/plain; charset=utf-8" } });

export async function handleGateway(request, env, upstreamFetch = fetch) {
  const url = new URL(request.url);
  const head = cors(request);

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: head });

  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  if (limited(ip)) return text(429, "Too many requests. Try again in a minute.", { ...head, "retry-after": "60" });

  if (env.PROXY_KEY) {
    const sent = request.headers.get("x-proxy-key") || (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (sent !== env.PROXY_KEY) return text(401, "Unauthorized: missing or invalid API key.", head);
  }

  if (!env.ZENMUX_API_KEY) return text(503, "The gateway is not configured on this deployment.", head);

  let body;
  if (request.method !== "GET" && request.method !== "HEAD") {
    body = await request.arrayBuffer();
    let parsed = null;
    try { parsed = JSON.parse(new TextDecoder().decode(body)); } catch { /* not JSON */ }
    if (parsed && typeof parsed.model === "string" && !ALLOWED_MODELS.has(parsed.model)) {
      return text(403, `Model '${parsed.model}' is not available on this gateway. Allowed: ${[...ALLOWED_MODELS].join(", ")}`, head);
    }
  }

  const headers = new Headers({ authorization: `Bearer ${env.ZENMUX_API_KEY}` });
  for (const [name, value] of request.headers) {
    const n = name.toLowerCase();
    if (HOP_BY_HOP.has(n) || n === "authorization" || n === "x-proxy-key" || n === "cookie") continue;
    headers.set(name, value);
  }

  const upstream = await upstreamFetch(UPSTREAM_BASE + url.pathname + url.search, {
    method: request.method,
    headers,
    body: body && body.byteLength ? body : undefined,
  });

  const out = new Headers(head);
  upstream.headers.forEach((value, name) => { if (!HOP_BY_HOP.has(name.toLowerCase())) out.set(name, value); });
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

// Test hook: forget the per-IP counters.
export const resetGatewayLimits = () => hits.clear();
