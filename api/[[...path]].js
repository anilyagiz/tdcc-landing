import { Readable } from "node:stream";

const UPSTREAM_BASE = "https://zenmux.ai";
const ALLOWED_MODELS = new Set(["deepseek/deepseek-v4-flash-free"]);

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;
const hitCounts = new Map();

const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "upgrade",
]);

function corsHeaders(req) {
  const origin = req.headers.origin;
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Max-Age": "86400",
    Vary: origin ? "Origin" : "Accept-Encoding",
  };
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers["x-real-ip"] || "unknown";
}

function isRateLimited(ip) {
  const now = Date.now();
  const entry = hitCounts.get(ip);
  if (hitCounts.size > 10_000) {
    for (const [key, e] of hitCounts) {
      if (now - e.start >= RATE_WINDOW_MS) hitCounts.delete(key);
    }
  }
  if (!entry || now - entry.start >= RATE_WINDOW_MS) {
    hitCounts.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_MAX;
}

function tryParseJson(buffer) {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  const url = new URL(req.url, "https://decentralizedcompute.company");
  const cors = corsHeaders(req);

  // Only the OpenAI / Anthropic surfaces belong to this gateway. Marketplace
  // paths (/api/listings, /api/me, ...) live in the Cloudflare Worker.
  const p = url.pathname;
  const gateway = p === "/api/v1" || p.startsWith("/api/v1/") || p === "/api/anthropic" || p.startsWith("/api/anthropic/");
  if (!gateway) {
    res.writeHead(404, { ...cors, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "The marketplace service is not available on this deployment yet." }));
    return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  if (isRateLimited(clientIp(req))) {
    res.writeHead(429, { ...cors, "Content-Type": "text/plain", "Retry-After": "60" });
    res.end("Too many requests. Try again in a minute.");
    return;
  }

  const proxyKey = process.env.PROXY_KEY;
  if (proxyKey) {
    const authHeader = req.headers.authorization || "";
    const sentKey = req.headers["x-proxy-key"] || authHeader.replace(/^Bearer\s+/i, "");
    if (sentKey !== proxyKey) {
      res.writeHead(401, { ...cors, "Content-Type": "text/plain" });
      res.end("Unauthorized: missing or invalid API key.");
      return;
    }
  }

  const apiKey = process.env.ZENMUX_API_KEY;
  if (!apiKey) {
    res.writeHead(503, { ...cors, "Content-Type": "text/plain" });
    res.end("ZENMUX_API_KEY environment variable is not configured on Vercel.");
    return;
  }

  let rawBody = null;
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  if (hasBody) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    rawBody = Buffer.concat(chunks);

    const parsed = tryParseJson(rawBody);
    if (parsed && typeof parsed.model === "string" && !ALLOWED_MODELS.has(parsed.model)) {
      res.writeHead(403, { ...cors, "Content-Type": "text/plain" });
      res.end(`Model '${parsed.model}' is not available on this gateway. Allowed: ${[...ALLOWED_MODELS].join(", ")}`);
      return;
    }
  }

  const upstreamUrl = UPSTREAM_BASE + url.pathname + url.search;

  const headers = { authorization: `Bearer ${apiKey}` };
  for (const [name, value] of Object.entries(req.headers)) {
    if (!value || HOP_BY_HOP.has(name.toLowerCase())) continue;
    if (name.toLowerCase() === "authorization") continue;
    if (name.toLowerCase() === "x-proxy-key") continue;
    headers[name] = value;
  }

  const upstream = await fetch(upstreamUrl, {
    method: req.method,
    headers,
    body: rawBody && rawBody.length ? rawBody : undefined,
  });

  const responseHeaders = { ...cors };
  upstream.headers.forEach((value, name) => {
    if (!HOP_BY_HOP.has(name.toLowerCase())) responseHeaders[name] = value;
  });

  res.writeHead(upstream.status, responseHeaders);
  Readable.fromWeb(upstream.body).pipe(res);
}
