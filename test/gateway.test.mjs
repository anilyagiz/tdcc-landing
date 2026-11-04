import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { handleGateway, isGatewayPath, resetGatewayLimits, limitKey } from "../src/gateway.js";
import { newEnv, age } from "./helpers.mjs";

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

test("bodies without an allowed model and unknown endpoints never reach the upstream", async () => {
  const up = upstream();
  const post = (path, body, headers = {}) => handleGateway(req(path, { method: "POST", headers, body }), ENV, up);
  // No model: the free-model check would otherwise be skipped.
  assert.equal((await post("/api/v1/chat/completions", JSON.stringify({ messages: [] }))).status, 400);
  // Multipart (not JSON) upload naming a paid model.
  const form = new FormData(); form.set("model", "openai/gpt-image-1"); form.set("prompt", "x");
  assert.equal((await handleGateway(req("/api/v1/images/generations", { method: "POST", body: form }), ENV, up)).status, 404);
  assert.equal((await post("/api/v1/embeddings", JSON.stringify({ model: "deepseek/deepseek-v4-flash-free", input: "x" }))).status, 404);
  assert.equal((await handleGateway(req("/api/v1/generation?id=1"), ENV, up)).status, 404);
  assert.equal((await handleGateway(req("/api/v1/chat/completions", { method: "PUT", body: "{}" }), ENV, up)).status, 404);
  assert.equal(up.calls.length, 0);
  // The Anthropic surface still works for the free model.
  assert.equal((await post("/api/anthropic/v1/messages", JSON.stringify({ model: "deepseek/deepseek-v4-flash-free", messages: [] }))).status, 200);
  assert.equal(up.calls[0].url, "https://zenmux.ai/api/anthropic/v1/messages");
});

// ---------- shared limits in D1 ----------

const ok = JSON.stringify({ model: "deepseek/deepseek-v4-flash-free", messages: [] });
const chat = (env, ip, up) => handleGateway(req("/api/v1/chat/completions", {
  method: "POST", headers: { "cf-connecting-ip": ip, "content-type": "application/json" }, body: ok,
}), env, up);

test("with D1 the per-IP minute limit holds across isolates", async () => {
  const env = newEnv(ENV);
  const up = upstream();
  // A fresh in-memory map before every call stands in for a different isolate.
  for (let i = 0; i < 30; i++) { resetGatewayLimits(); assert.equal((await chat(env, "7.7.7.7", up)).status, 200); }
  resetGatewayLimits();
  const res = await chat(env, "7.7.7.7", up);
  assert.equal(res.status, 429);
  const retry = Number(res.headers.get("retry-after"));
  assert.ok(retry >= 1 && retry <= 60, String(retry));
  assert.equal(up.calls.length, 30);
  assert.equal((await chat(env, "6.6.6.6", up)).status, 200);
  // A minute later the window opens again.
  await age(env, "rate_limits", "window_start", 61, "key = 'gw:min:7.7.7.7'");
  resetGatewayLimits();
  assert.equal((await chat(env, "7.7.7.7", up)).status, 200);
});

test("with D1 each IP has a daily cap", async () => {
  const env = newEnv({ ...ENV, GATEWAY_IP_DAILY_CAP: "3" });
  const up = upstream();
  for (let i = 0; i < 3; i++) assert.equal((await chat(env, "5.5.5.5", up)).status, 200);
  const res = await chat(env, "5.5.5.5", up);
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get("retry-after")) > 60);
  assert.equal(up.calls.length, 3);
  assert.equal((await chat(env, "4.4.4.4", up)).status, 200);
});

test("with D1 the global daily cap answers 503", async () => {
  const env = newEnv({ ...ENV, GATEWAY_DAILY_CAP: "2" });
  const up = upstream();
  assert.equal((await chat(env, "3.3.3.1", up)).status, 200);
  assert.equal((await chat(env, "3.3.3.2", up)).status, 200);
  const res = await chat(env, "3.3.3.3", up);
  assert.equal(res.status, 503);
  assert.match(await res.text(), /at capacity for today/);
  assert.equal(up.calls.length, 2);
});

test("refused requests do not use up the daily caps", async () => {
  const env = newEnv({ ...ENV, GATEWAY_DAILY_CAP: "1", PROXY_KEY: "pk" });
  const up = upstream();
  for (let i = 0; i < 5; i++) assert.equal((await chat(env, "2.2.2.2", up)).status, 401);
  const res = await handleGateway(req("/api/v1/models", { headers: { "cf-connecting-ip": "2.2.2.2", "x-proxy-key": "pk" } }), env, up);
  assert.equal(res.status, 200);
});

test("without D1 the in-memory limiter is the fallback", async () => {
  const up = upstream();
  for (let i = 0; i < 30; i++) assert.equal((await chat(ENV, "1.1.1.1", up)).status, 200);
  assert.equal((await chat(ENV, "1.1.1.1", up)).status, 429);
  // Per isolate only: a fresh map starts over.
  resetGatewayLimits();
  assert.equal((await chat(ENV, "1.1.1.1", up)).status, 200);
});

test("IPv6 addresses are limited per /64, IPv4 per address", async () => {
  assert.equal(limitKey("203.0.113.9"), "203.0.113.9");
  assert.equal(limitKey("2001:db8:1:2::1"), "2001:db8:1:2::/64");
  assert.equal(limitKey("2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
  assert.equal(limitKey("2001:db8::"), "2001:db8:0:0::/64");
  assert.equal(limitKey("::ffff:198.51.100.7"), "198.51.100.7");
  assert.notEqual(limitKey("2001:db8:1:2::1"), limitKey("2001:db8:1:3::1"));

  const env = newEnv({ ...ENV, GATEWAY_IP_DAILY_CAP: "3" });
  const up = upstream();
  // Rotating through one /64 does not get fresh buckets.
  for (let i = 1; i <= 3; i++) assert.equal((await chat(env, `2001:db8:1:2::${i}`, up)).status, 200);
  assert.equal((await chat(env, "2001:db8:1:2:ffff::9", up)).status, 429);
  assert.equal((await chat(env, "2001:db8:1:3::1", up)).status, 200);
  for (let i = 0; i < 26; i++) { resetGatewayLimits(); await chat(env, `2001:db8:9:9::${i + 1}`, up); }
  for (let i = 0; i < 4; i++) { resetGatewayLimits(); await handleGateway(req("/api/v1/models", { headers: { "cf-connecting-ip": `2001:db8:9:9::a${i}` } }), env, up); }
  resetGatewayLimits();
  assert.equal((await handleGateway(req("/api/v1/models", { headers: { "cf-connecting-ip": "2001:db8:9:9:1::1" } }), env, up)).status, 429);
});

test("without D1 the in-memory limiter also groups IPv6 by /64", async () => {
  const up = upstream();
  for (let i = 0; i < 30; i++) assert.equal((await handleGateway(req("/api/v1/models", { headers: { "cf-connecting-ip": `2001:db8:5:5::${i.toString(16)}` } }), ENV, up)).status, 200);
  assert.equal((await handleGateway(req("/api/v1/models", { headers: { "cf-connecting-ip": "2001:db8:5:5::ffff" } }), ENV, up)).status, 429);
});
