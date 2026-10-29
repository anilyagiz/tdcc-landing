import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { account, newEnv, ORIGIN } from "./helpers.mjs";
import { handleV1, microToUsd, usdToMicro, base58, receivedByTreasury } from "../src/billing.js";

const TREASURY = "TreasuryWa11et1111111111111111111111111111";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RPC = "https://rpc.example/solana";
const UPSTREAM = "https://upstream.example/v1";

const billingEnv = (extra = {}) => newEnv({
  SOLANA_TREASURY: TREASURY,
  SOLANA_RPC_URL: RPC,
  UPSTREAM_BASE_URL: UPSTREAM,
  UPSTREAM_API_KEYS: "up-key-1",
  UPSTREAM_MODEL: "secret-provider-model",
  UPSTREAM_PRICE_IN: "0.30",   // USD per 1M tokens
  UPSTREAM_PRICE_OUT: "1.20",
  ...extra,
});

// A finalized USDC transfer of `amount` micro-USDC to the treasury.
function transferTx(reference, amount, { owner = TREASURY, mint = USDC, err = null } = {}) {
  return {
    meta: {
      err,
      preTokenBalances: [{ accountIndex: 2, mint, owner, uiTokenAmount: { amount: "1000000" } }],
      postTokenBalances: [{ accountIndex: 2, mint, owner, uiTokenAmount: { amount: String(1_000_000 + amount) } }],
    },
    transaction: { message: { accountKeys: [{ pubkey: "Payer111" }, { pubkey: reference }, { pubkey: "Ata111" }] } },
  };
}

// Routes fetch calls: Solana RPC answers from `chain`, the provider from `provider`.
let chain, provider, upstreamCalls, realFetch;
beforeEach(() => {
  chain = new Map(); // reference -> [{ signature, tx }]
  provider = null;
  upstreamCalls = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (url === RPC) {
      const { method, params } = JSON.parse(init.body);
      let result = null;
      if (method === "getSignaturesForAddress") result = (chain.get(params[0]) || []).map((e) => ({ signature: e.signature, err: e.tx.meta.err }));
      if (method === "getTransaction") {
        for (const list of chain.values()) for (const e of list) if (e.signature === params[0]) result = e.tx;
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { headers: { "content-type": "application/json" } });
    }
    if (String(url).startsWith(UPSTREAM)) {
      upstreamCalls.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return provider(JSON.parse(init.body));
    }
    throw new Error("unexpected fetch " + url);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const pay = (dep, amount, opts, signature = "sig_" + Math.random().toString(36).slice(2)) => {
  const list = chain.get(dep.reference) || [];
  list.push({ signature, tx: transferTx(dep.reference, amount, opts) });
  chain.set(dep.reference, list);
  return signature;
};

async function funded(env, usd = "20") {
  const c = await account(env, "Payer");
  const d = await c.call("POST", "/api/billing/deposits", { amount_usd: usd });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  pay(d.body.deposit, usdToMicro(usd));
  const chk = await c.call("POST", `/api/billing/deposits/${d.body.deposit.id}/check`, {});
  assert.equal(chk.body.deposit.status, "confirmed");
  return c;
}

const v1 = (env, path, { key, body, method = body ? "POST" : "GET" } = {}) =>
  handleV1(new Request(ORIGIN + path, {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), env, { waitUntil: (p) => p });

const okCompletion = (usage) => () => new Response(JSON.stringify({
  id: "chatcmpl-1", object: "chat.completion", created: 1, model: "secret-provider-model", system_fingerprint: "fp_provider", provider: "secret",
  choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
  usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens, cost: 1 },
}), { headers: { "content-type": "application/json" } });

// ---------- money ----------

test("money is exact micro-dollars", () => {
  assert.equal(usdToMicro("20"), 20_000_000);
  assert.equal(usdToMicro("5.5"), 5_500_000);
  assert.equal(usdToMicro(0.000001), 1);
  assert.equal(usdToMicro("1.0000001"), null);
  assert.equal(usdToMicro("-5"), null);
  assert.equal(usdToMicro("1e3"), null);
  assert.equal(microToUsd(12_345_678), "12.345678");
  assert.equal(microToUsd(-41), "-0.000041");
  assert.equal(base58(new Uint8Array([0, 0, 1])), "112");
  assert.match(base58(crypto.getRandomValues(new Uint8Array(32))), /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
});

test("only USDC that reached the treasury counts", () => {
  assert.equal(receivedByTreasury(transferTx("r", 5_000_000), TREASURY, USDC), 5_000_000);
  assert.equal(receivedByTreasury(transferTx("r", 5_000_000, { owner: "SomeoneElse111" }), TREASURY, USDC), 0);
  assert.equal(receivedByTreasury(transferTx("r", 5_000_000, { mint: "FakeUsdcMint111" }), TREASURY, USDC), 0);
  assert.equal(receivedByTreasury(transferTx("r", 5_000_000, { err: { InstructionError: [0, "x"] } }), TREASURY, USDC), 0);
});

// ---------- deposits ----------

test("a USDC payment is credited once, at the amount that arrived", async () => {
  const env = billingEnv();
  const c = await account(env, "Alice");
  const d = await c.call("POST", "/api/billing/deposits", { amount_usd: 20 });
  assert.equal(d.status, 201);
  const dep = d.body.deposit;
  assert.match(dep.pay_url, new RegExp(`^solana:${TREASURY}\\?amount=20&spl-token=${USDC}&reference=${dep.reference}&label=TDCC`));

  let chk = await c.call("POST", `/api/billing/deposits/${dep.id}/check`, {});
  assert.equal(chk.body.deposit.status, "pending");
  assert.equal(chk.body.balance.micro, 0);

  const sig = pay(dep, 19_500_000); // wallet fee rounding: credit what actually arrived
  chk = await c.call("POST", `/api/billing/deposits/${dep.id}/check`, {});
  assert.equal(chk.body.deposit.status, "confirmed");
  assert.equal(chk.body.deposit.signature, sig);
  assert.equal(chk.body.deposit.credited_usd, "19.500000");
  assert.equal(chk.body.balance.usd, "19.500000");

  chk = await c.call("POST", `/api/billing/deposits/${dep.id}/check`, {});
  assert.equal(chk.body.balance.micro, 19_500_000, "checking again must not credit twice");
});

test("one on-chain transfer cannot be credited to two deposits", async () => {
  const env = billingEnv();
  const a = await account(env, "Bob");
  const d1 = (await a.call("POST", "/api/billing/deposits", { amount_usd: 10 })).body.deposit;
  const d2 = (await a.call("POST", "/api/billing/deposits", { amount_usd: 10 })).body.deposit;
  const sig = pay(d1, 10_000_000);
  // The same transaction also mentions the second reference.
  chain.set(d2.reference, [{ signature: sig, tx: transferTx(d2.reference, 10_000_000) }]);
  await a.call("POST", `/api/billing/deposits/${d1.id}/check`, {});
  const r = await a.call("POST", `/api/billing/deposits/${d2.id}/check`, {});
  assert.equal(r.body.balance.micro, 10_000_000);
});

test("other people's deposits and bad amounts are refused", async () => {
  const env = billingEnv();
  const a = await account(env, "Carol");
  const b = await account(env, "Dave");
  const dep = (await a.call("POST", "/api/billing/deposits", { amount_usd: 5 })).body.deposit;
  assert.equal((await b.call("POST", `/api/billing/deposits/${dep.id}/check`, {})).status, 404);
  assert.equal((await a.call("POST", "/api/billing/deposits", { amount_usd: 4.99 })).status, 400);
  assert.equal((await a.call("POST", "/api/billing/deposits", { amount_usd: "abc" })).status, 400);
  assert.equal((await a.call("POST", "/api/billing/deposits", { amount_usd: 10001 })).status, 400);
});

test("top-ups answer 503 until a treasury and RPC are configured", async () => {
  const env = billingEnv({ SOLANA_TREASURY: "", SOLANA_RPC_URL: "" });
  const a = await account(env, "Erin");
  assert.equal((await a.call("POST", "/api/billing/deposits", { amount_usd: 5 })).status, 503);
  const o = await a.call("GET", "/api/billing");
  assert.equal(o.body.payments.configured, false);
});

test("billing overview shows balance, pricing with markup and recent deposits", async () => {
  const env = billingEnv();
  const c = await funded(env, "20");
  const o = await c.call("GET", "/api/billing");
  assert.equal(o.status, 200);
  assert.equal(o.body.balance.usd, "20.000000");
  assert.deepEqual(o.body.pricing.map((p) => [p.id, p.input_per_m_usd, p.output_per_m_usd]), [["tdcc-chat", "0.45", "1.80"]]);
  assert.equal(o.body.deposits[0].status, "confirmed");
  assert.equal(o.body.api_base, "https://decentralizedcompute.company/v1");
  assert.ok(!JSON.stringify(o.body).includes("secret-provider-model"));
});

// ---------- keys and the metered API ----------

test("an API key spends the balance at cost x markup and hides the provider", async () => {
  const env = billingEnv();
  const c = await funded(env, "20");
  const k = await c.call("POST", "/api/billing/keys", { name: "Script" });
  assert.equal(k.status, 201);
  assert.match(k.body.key, /^sk-tdcc-/);
  assert.ok(!k.body.record.prefix.includes(k.body.key.slice(12, -4)));

  provider = okCompletion({ prompt_tokens: 1000, completion_tokens: 2000 });
  const res = await v1(env, "/v1/chat/completions", { key: k.body.key, body: { model: "tdcc-chat", messages: [{ role: "user", content: "hi" }] } });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.model, "tdcc-chat");
  assert.equal(data.system_fingerprint, undefined);
  assert.equal(data.provider, undefined);
  assert.equal(upstreamCalls[0].body.model, "secret-provider-model");
  assert.equal(upstreamCalls[0].headers.authorization, "Bearer up-key-1");

  // 1000 * 0.45 + 2000 * 1.80 = 4050 micro-dollars
  const o = await c.call("GET", "/api/billing");
  assert.equal(o.body.balance.micro, 20_000_000 - 4050);
  assert.equal(o.body.usage[0].cost_usd, "0.004050");
  assert.equal(o.body.usage[0].source, "api");
  assert.equal(o.body.totals.requests_30d, 1);
});

test("requests that the balance cannot cover get 402 before the provider is called", async () => {
  const env = billingEnv();
  const c = await account(env, "Frank");
  const k = (await c.call("POST", "/api/billing/keys", { name: "x" })).body.key;
  provider = okCompletion({ prompt_tokens: 1, completion_tokens: 1 });
  const res = await v1(env, "/v1/chat/completions", { key: k, body: { messages: [{ role: "user", content: "hi" }] } });
  assert.equal(res.status, 402);
  assert.equal((await res.json()).error.code, "insufficient_balance");
  assert.equal(upstreamCalls.length, 0);
});

test("missing, wrong and revoked keys are rejected", async () => {
  const env = billingEnv();
  const c = await funded(env);
  provider = okCompletion({ prompt_tokens: 1, completion_tokens: 1 });
  const body = { messages: [{ role: "user", content: "hi" }] };
  assert.equal((await v1(env, "/v1/chat/completions", { body })).status, 401);
  assert.equal((await v1(env, "/v1/chat/completions", { key: "sk-tdcc-nope", body })).status, 401);
  const k = await c.call("POST", "/api/billing/keys", { name: "x" });
  assert.equal((await c.call("DELETE", `/api/billing/keys/${k.body.record.id}`)).status, 200);
  assert.equal((await v1(env, "/v1/chat/completions", { key: k.body.key, body })).status, 401);
});

test("the API refuses to run unpriced instead of serving for free", async () => {
  const env = billingEnv({ UPSTREAM_PRICE_IN: "", UPSTREAM_PRICE_OUT: "" });
  const c = await funded(env);
  const k = (await c.call("POST", "/api/billing/keys", { name: "x" })).body.key;
  provider = okCompletion({ prompt_tokens: 1, completion_tokens: 1 });
  assert.equal((await v1(env, "/v1/chat/completions", { key: k, body: { messages: [{ role: "user", content: "hi" }] } })).status, 503);
  assert.equal(upstreamCalls.length, 0);
});

test("/v1/models lists the public model only", async () => {
  const res = await v1(billingEnv(), "/v1/models");
  const data = await res.json();
  assert.deepEqual(data.data.map((m) => m.id), ["tdcc-chat"]);
  assert.ok(!JSON.stringify(data).includes("secret-provider-model"));
});

function sseProvider(chunks, usage) {
  return () => {
    const lines = [": provider keep-alive", ...chunks.map((t) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "secret-provider-model", provider: "x", choices: [{ index: 0, delta: { content: t }, finish_reason: null }] })}`),
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "secret-provider-model", choices: [], usage })}`, "data: [DONE]"];
    return new Response(lines.map((l) => l + "\n\n").join(""), { headers: { "content-type": "text/event-stream" } });
  };
}

test("streaming is billed from the final usage chunk and stays clean", async () => {
  const env = billingEnv();
  const c = await funded(env);
  const k = (await c.call("POST", "/api/billing/keys", { name: "x" })).body.key;
  provider = sseProvider(["Hel", "lo"], { prompt_tokens: 100, completion_tokens: 10 });
  const res = await v1(env, "/v1/chat/completions", { key: k, body: { stream: true, messages: [{ role: "user", content: "hi" }] } });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes('"content":"Hel"'));
  assert.ok(!text.includes("secret-provider-model") && !text.includes("keep-alive") && !text.includes('"provider"'));
  assert.ok(!text.includes("tdcc.billing"), "API clients get plain OpenAI chunks");
  assert.ok(text.trimEnd().endsWith("data: [DONE]"));
  assert.equal(upstreamCalls[0].body.stream_options.include_usage, true);
  await new Promise((r) => setTimeout(r, 10));
  const o = await c.call("GET", "/api/billing");
  assert.equal(o.body.balance.micro, 20_000_000 - Math.ceil(100 * 0.45 + 10 * 1.8));
});

test("the web chat needs a session, bills the account and reports the cost", async () => {
  const env = billingEnv();
  const c = await funded(env);
  provider = sseProvider(["Hi"], { prompt_tokens: 10, completion_tokens: 5 });
  const anon = await (await import("../src/api.js")).handleApi(new Request(ORIGIN + "/api/chat", {
    method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  }), env, { waitUntil: (p) => p });
  assert.equal(anon.status, 401);

  const { handleApi } = await import("../src/api.js");
  const res = await handleApi(new Request(ORIGIN + "/api/chat", {
    method: "POST",
    headers: { origin: ORIGIN, cookie: c.cookie, "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }, { role: "tool", content: "dropped" }] }),
  }), env, { waitUntil: (p) => p });
  assert.equal(res.status, 200);
  const text = await res.text();
  const billing = text.split("\n\n").map((l) => l.replace(/^data: /, "")).filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)).find((o) => o.object === "tdcc.billing");
  assert.equal(billing.cost_usd, microToUsd(Math.ceil(10 * 0.45 + 5 * 1.8)));
  assert.equal(billing.balance_usd, microToUsd(20_000_000 - Math.ceil(10 * 0.45 + 5 * 1.8)));
  assert.ok(!upstreamCalls[0].body.messages.some((m) => m.role === "tool"));
});
