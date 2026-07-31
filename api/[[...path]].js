const { Readable } = require("node:stream");

const UPSTREAM_BASE = "https://zenmux.ai";

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

module.exports = async function handler(req, res) {
  const url = new URL(req.url, "https://decentralizedcompute.company");

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  const proxyKey = process.env.PROXY_KEY;
  if (proxyKey) {
    const authHeader = req.headers.authorization || "";
    const sentKey = req.headers["x-proxy-key"] || authHeader.replace(/^Bearer\s+/i, "");
    if (sentKey !== proxyKey) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("Unauthorized: missing or invalid API key.");
      return;
    }
  }

  const apiKey = process.env.ZENMUX_API_KEY;
  if (!apiKey) {
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end("ZENMUX_API_KEY environment variable is not configured on Vercel.");
    return;
  }

  const upstreamUrl = UPSTREAM_BASE + url.pathname + url.search;

  const headers = { authorization: `Bearer ${apiKey}` };
  for (const [name, value] of Object.entries(req.headers)) {
    if (!value || HOP_BY_HOP.has(name.toLowerCase())) continue;
    if (name.toLowerCase() === "authorization") continue;
    if (name.toLowerCase() === "x-proxy-key") continue;
    headers[name] = value;
  }

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const upstream = await fetch(upstreamUrl, {
    method: req.method,
    headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: hasBody ? "half" : undefined,
  });

  const responseHeaders = { ...corsHeaders(req) };
  upstream.headers.forEach((value, name) => {
    if (!HOP_BY_HOP.has(name.toLowerCase())) responseHeaders[name] = value;
  });

  res.writeHead(upstream.status, responseHeaders);
  Readable.fromWeb(upstream.body).pipe(res);
};
