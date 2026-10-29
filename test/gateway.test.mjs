import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { handleGateway, isGatewayPath, resetGatewayLimits } from "../src/gateway.js";

const BASE = "https://decentralizedcompute.company";
const ENV = { ZENMUX_API_KEY: "upstream-key" };

function upstream(status = 200, body = '{"ok":true}') {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return new Response(body, { status, headers: { "content-type": "application/json", connection: "keep-alive" } });
  };
  fn.calls = calls;
  return fn;
}

const req = (path, init = {}) => new Request(BASE + path, init);

beforeEach(() => resetGatewayLimits());

test("only the OpenAI and Anthropic surfaces are gateway paths", () => {
  for (const p of ["/api/v1", "/api/v1/chat/completions", "/api/anthropic/v1/messages"]) assert.ok(isGatewayPath(p), p);
  for (const p of ["/api/listings", "/api/me", "/api/v10", "/api/anthropicx", "/"]) assert.ok(!isGatewayPath(p), p);
});

test("requests are forwarded with our key, not the caller's credentials", async () => {
  const up = upstream();
  const res = await handleGateway(req("/api/v1/chat/completions?x=1", {
    method: "POST",
    headers: { authorization: "Bearer caller-key", cookie: "tdcc_session=secret", "content-type": "application/json", "cf-connecting-ip": "1.2.3.4" },
    body: JSON.stringify({ model: "deepseek/deepseek-v4-flash-free", messages: [] }),
  }), ENV, up);
  assert.equal(res.status, 200);
  assert.equal(up.calls[0].url, "https://zenmux.ai/api/v1/chat/completions?x=1");
  const h = up.calls[0].init.headers;
  assert.equal(h.get("authorization"), "Bearer upstream-key");
  assert.equal(h.get("cookie"), null);
  assert.equal(h.get("cf-connecting-ip"), null);
  assert.equal(res.headers.get("connection"), null);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

test("other models are refused before reaching the upstream", async () => {
  const up = upstream();
  const res = await handleGateway(req("/api/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "gpt-5.5" }) }), ENV, up);
  assert.equal(res.status, 403);
  assert.equal(up.calls.length, 0);
});

test("missing key answers 503, and PROXY_KEY is enforced when set", async () => {
  assert.equal((await handleGateway(req("/api/v1/models"), {}, upstream())).status, 503);
  const env = { ...ENV, PROXY_KEY: "pk" };
  assert.equal((await handleGateway(req("/api/v1/models"), env, upstream())).status, 401);
  assert.equal((await handleGateway(req("/api/v1/models", { headers: { "x-proxy-key": "pk" } }), env, upstream())).status, 200);
});

test("each IP gets 30 requests a minute", async () => {
  const up = upstream();
  const call = () => handleGateway(req("/api/v1/models", { headers: { "cf-connecting-ip": "9.9.9.9" } }), ENV, up);
  for (let i = 0; i < 30; i++) assert.equal((await call()).status, 200);
  assert.equal((await call()).status, 429);
  const other = await handleGateway(req("/api/v1/models", { headers: { "cf-connecting-ip": "8.8.8.8" } }), ENV, up);
  assert.equal(other.status, 200);
});

test("the worker routes gateway paths before the marketplace API", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = upstream();
  try {
    const res = await worker.fetch(req("/api/v1/models"), ENV, {});
    assert.equal(res.status, 200);
    assert.equal(globalThis.fetch.calls[0].url, "https://zenmux.ai/api/v1/models");
    // Marketplace paths still reach handleApi, which reports the missing database.
    const market = await worker.fetch(req("/api/listings"), ENV, {});
    assert.equal(market.status, 503);
  } finally {
    globalThis.fetch = realFetch;
  }
});
