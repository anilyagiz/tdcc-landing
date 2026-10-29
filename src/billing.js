// Prepaid balance, USDC top-ups on Solana, API keys, and the metered
// OpenAI-compatible API (/v1) plus the signed-in web chat (/api/chat).
// See docs/billing-api.md for the contract and configuration.
//
// Money model: integer micro-dollars everywhere (1 USD = 1,000,000), which is
// also the base unit of USDC (6 decimals). Every change to a balance is a row
// in `ledger` with a unique `ref`, written in the same D1 batch as the balance
// update, so a payment or a request can never be counted twice.
//
// Top-ups use Solana Pay transfer requests: each deposit gets a random
// reference key that the wallet adds to the transfer. We look the reference up
// on chain, load the transaction at `finalized` commitment and credit only the
// USDC (configured mint) that reached token accounts owned by the treasury.
//
// The provider behind the API is never exposed: responses are rewritten to the
// public model id and provider-specific fields and errors are dropped.

import { HttpError, json, readJson, requireUser, limit, newId, randomToken, sha256, now } from "./api.js";

const MICRO = 1_000_000;
const MIN_TOPUP = 5 * MICRO;
const MAX_TOPUP = 10_000 * MICRO;
const DEPOSIT_TTL = 24 * 3600;
const DEPOSIT_WATCH = 7 * 24 * 3600; // late payments are still credited for a week
const KEY_PREFIX = "sk-tdcc-";
const MAX_KEYS = 20;
const USDC_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// ---------- config ----------

function cfg(env) {
  const num = (v, d) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? d : Number(v));
  return {
    treasury: (env.SOLANA_TREASURY || "").trim(),
    rpc: (env.SOLANA_RPC_URL || "").trim(),
    mint: (env.SOLANA_USDC_MINT || USDC_MAINNET).trim(),
    cluster: env.SOLANA_CLUSTER || "mainnet-beta",
    upstreamBase: (env.UPSTREAM_BASE_URL || "").replace(/\/+$/, ""),
    upstreamKeys: (env.UPSTREAM_API_KEYS || "").split(",").map((s) => s.trim()).filter(Boolean),
    priceIn: num(env.UPSTREAM_PRICE_IN, NaN),
    priceOut: num(env.UPSTREAM_PRICE_OUT, NaN),
    markup: num(env.PRICE_MARKUP, 1.5),
    maxTokens: num(env.MAX_TOKENS_CAP, 8192),
    site: (env.SITE_URL || "https://decentralizedcompute.company").replace(/\/+$/, ""),
  };
}

const paymentsReady = (c) => !!(c.treasury && c.rpc && c.mint);

// Public catalogue. `upstream` never leaves the server.
function models(env) {
  const c = cfg(env);
  return [{
    id: "tdcc-chat",
    name: "TDCC Chat",
    upstream: env.UPSTREAM_MODEL || "",
    context_length: 128000,
    created: 1761177600,
    // micro-dollars per token = USD per 1M tokens
    in: c.priceIn * c.markup,
    out: c.priceOut * c.markup,
  }];
}
const findModel = (env, id) => {
  const all = models(env);
  if (!id) return all[0];
  const q = String(id).toLowerCase();
  return all.find((m) => m.id === q || m.name.toLowerCase() === q) || null;
};
const priced = (m) => Number.isFinite(m.in) && Number.isFinite(m.out) && m.in >= 0 && m.out >= 0;
const perMillion = (microPerToken) => (Math.round(microPerToken * 100) / 100).toFixed(2);

// ---------- money ----------

export function microToUsd(micro) {
  const n = BigInt(Math.trunc(Number(micro) || 0));
  const neg = n < 0n;
  const a = neg ? -n : n;
  const s = `${a / 1_000_000n}.${String(a % 1_000_000n).padStart(6, "0")}`;
  return neg ? "-" + s : s;
}

export function usdToMicro(v) {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(s)) return null;
  const [w, f = ""] = s.split(".");
  return Number(w) * MICRO + Number(f.padEnd(6, "0"));
}

const usd2 = (micro) => (Math.round(Number(micro) / 10_000) / 100).toFixed(2);

async function balanceOf(env, userId) {
  const row = await env.DB.prepare("SELECT micro FROM balances WHERE user_id = ?").bind(userId).first();
  return row ? Number(row.micro) : 0;
}

const balanceJson = (micro) => ({ micro, usd: microToUsd(micro) });

// Apply a ledger entry and the balance change atomically. Returns false when
// `ref` was already applied (the batch rolls back on the unique violation).
async function applyLedger(env, userId, micro, kind, ref, detail = "") {
  const t = now();
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO ledger (user_id, micro, kind, ref, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(userId, micro, kind, ref, String(detail).slice(0, 200), t),
      env.DB.prepare(
        `INSERT INTO balances (user_id, micro, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(user_id) DO UPDATE SET micro = micro + ?2, updated_at = ?3`
      ).bind(userId, micro, t),
    ]);
    return true;
  } catch (err) {
    if (/UNIQUE/i.test(String(err && err.message))) return false;
    throw err;
  }
}

// ---------- base58 (Solana keys) ----------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = "1" + out; }
  return out;
}
const isBase58Key = (s) => typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

// ---------- Solana ----------

class RpcError extends Error {}

async function rpc(c, method, params) {
  let res;
  try {
    res = await fetch(c.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new RpcError("rpc unreachable");
  }
  if (!res.ok) throw new RpcError(`rpc ${res.status}`);
  const body = await res.json();
  if (body.error) throw new RpcError(`rpc error ${body.error.code}`);
  return body.result;
}

function payUrl(c, dep) {
  const q = new URLSearchParams({
    amount: microToUsd(dep.amount_micro).replace(/\.?0+$/, ""),
    "spl-token": c.mint,
    reference: dep.reference,
    label: "TDCC",
    message: "TDCC balance top-up",
  });
  return `solana:${c.treasury}?${q.toString().replace(/\+/g, "%20")}`;
}

// USDC (configured mint) that reached token accounts owned by the treasury in
// this transaction, in micro-units.
export function receivedByTreasury(tx, treasury, mint) {
  const meta = tx && tx.meta;
  if (!meta || meta.err) return 0;
  const pre = new Map((meta.preTokenBalances || []).map((b) => [b.accountIndex, b]));
  let delta = 0n;
  for (const post of meta.postTokenBalances || []) {
    if (post.owner !== treasury || post.mint !== mint) continue;
    const before = pre.get(post.accountIndex);
    const was = before && before.mint === mint ? BigInt(before.uiTokenAmount.amount) : 0n;
    delta += BigInt(post.uiTokenAmount.amount) - was;
  }
  return delta > 0n ? Number(delta) : 0;
}

const mentions = (tx, key) => {
  const keys = tx?.transaction?.message?.accountKeys || [];
  return keys.some((k) => (typeof k === "string" ? k : k.pubkey) === key);
};

// Look the deposit up on chain and credit whatever arrived. Idempotent.
async function settleDeposit(env, dep) {
  const c = cfg(env);
  if (!paymentsReady(c) || dep.status === "confirmed") return dep;
  const t = now();
  if (t - dep.created_at > DEPOSIT_WATCH) return dep;

  const sigs = await rpc(c, "getSignaturesForAddress", [dep.reference, { limit: 20, commitment: "finalized" }]);
  let credited = 0, firstSig = null;
  for (const s of sigs || []) {
    if (s.err) continue;
    const tx = await rpc(c, "getTransaction", [s.signature, { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 }]);
    if (!tx || !mentions(tx, dep.reference)) continue;
    const got = receivedByTreasury(tx, c.treasury, c.mint);
    if (got <= 0) continue;
    if (await applyLedger(env, dep.user_id, got, "deposit", `sol:${s.signature}`, dep.id)) {
      credited += got;
      firstSig = firstSig || s.signature;
    }
  }

  if (credited > 0) {
    await env.DB.prepare(
      `UPDATE deposits SET status = 'confirmed', signature = COALESCE(signature, ?), credited_micro = COALESCE(credited_micro, 0) + ?, checked_at = ?
       WHERE id = ?`
    ).bind(firstSig, credited, t, dep.id).run();
  } else {
    const status = t > dep.expires_at ? "expired" : dep.status;
    await env.DB.prepare("UPDATE deposits SET status = ?, checked_at = ? WHERE id = ? AND status != 'confirmed'").bind(status, t, dep.id).run();
  }
  return await env.DB.prepare("SELECT * FROM deposits WHERE id = ?").bind(dep.id).first();
}

const depositJson = (c, d) => ({
  id: d.id,
  amount_usd: usd2(d.amount_micro),
  status: d.status,
  reference: d.reference,
  pay_url: payUrl(c, d),
  recipient: c.treasury,
  mint: c.mint,
  signature: d.signature || null,
  credited_usd: d.credited_micro == null ? null : microToUsd(d.credited_micro),
  created_at: d.created_at,
  expires_at: d.expires_at,
});

// Cron: watch pending (and recently expired) deposits.
export async function watchDeposits(env) {
  if (!paymentsReady(cfg(env))) return;
  const t = now();
  const { results } = await env.DB.prepare(
    `SELECT * FROM deposits WHERE status != 'confirmed' AND created_at > ? AND (checked_at IS NULL OR checked_at < ?)
     ORDER BY created_at DESC LIMIT 50`
  ).bind(t - DEPOSIT_WATCH, t - 60).all();
  for (const d of results) {
    try { await settleDeposit(env, d); } catch (err) { console.warn("deposit check failed", d.id, err && err.message); }
  }
}

// ---------- browser endpoints ----------

const keyJson = (k) => ({ id: k.id, name: k.name, prefix: k.prefix, rpm: k.rpm, created_at: k.created_at, last_used_at: k.last_used_at });

export async function billingOverview(request, env) {
  const user = await requireUser(request, env);
  const c = cfg(env);
  const t = now();
  const [bal, keys, deps, use, totals] = await Promise.all([
    balanceOf(env, user.id),
    env.DB.prepare("SELECT * FROM api_keys WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC").bind(user.id).all(),
    env.DB.prepare("SELECT * FROM deposits WHERE user_id = ? ORDER BY created_at DESC LIMIT 20").bind(user.id).all(),
    env.DB.prepare(
      `SELECT u.*, k.prefix AS key_prefix FROM usage u LEFT JOIN api_keys k ON k.id = u.key_id
       WHERE u.user_id = ? ORDER BY u.created_at DESC LIMIT 50`
    ).bind(user.id).all(),
    env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tok, COALESCE(SUM(cost_micro), 0) AS spent
       FROM usage WHERE user_id = ? AND created_at > ?`
    ).bind(user.id, t - 30 * 86400).first(),
  ]);
  return json(200, {
    balance: balanceJson(bal),
    min_topup_usd: MIN_TOPUP / MICRO,
    payments: { method: "solana-usdc", configured: paymentsReady(c), cluster: c.cluster, treasury: c.treasury || null, mint: c.mint },
    pricing: models(env).filter(priced).map((m) => ({ id: m.id, name: m.name, context_length: m.context_length, input_per_m_usd: perMillion(m.in), output_per_m_usd: perMillion(m.out) })),
    api_base: `${c.site}/v1`,
    keys: keys.results.map(keyJson),
    deposits: deps.results.map((d) => depositJson(c, d)),
    usage: use.results.map((u) => ({ created_at: u.created_at, model: u.model, source: u.source, key_prefix: u.key_prefix || null, prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, cost_usd: microToUsd(u.cost_micro) })),
    totals: { requests_30d: Number(totals.n), tokens_30d: Number(totals.tok), spent_30d_usd: microToUsd(totals.spent) },
  });
}

export async function createDeposit(request, env) {
  const user = await requireUser(request, env);
  const c = cfg(env);
  if (!paymentsReady(c)) throw new HttpError(503, "Top-ups are not available on this deployment yet.");
  await limit(env, `deposit:${user.id}`, 10, 3600);
  const body = await readJson(request);
  const amount = usdToMicro(body.amount_usd);
  if (amount === null || amount < MIN_TOPUP || amount > MAX_TOPUP) {
    throw new HttpError(400, `Enter an amount between $${MIN_TOPUP / MICRO} and $${MAX_TOPUP / MICRO}.`, { field: "amount_usd" });
  }
  const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM deposits WHERE user_id = ? AND status = 'pending' AND expires_at > ?").bind(user.id, now()).first();
  if (Number(open.n) >= 5) throw new HttpError(429, "You already have five open payments. Finish or let one expire first.");
  const t = now();
  const dep = {
    id: newId("dep"),
    user_id: user.id,
    amount_micro: amount,
    reference: base58(crypto.getRandomValues(new Uint8Array(32))),
    status: "pending",
    signature: null,
    credited_micro: null,
    created_at: t,
    expires_at: t + DEPOSIT_TTL,
  };
  await env.DB.prepare("INSERT INTO deposits (id, user_id, amount_micro, reference, status, created_at, expires_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)")
    .bind(dep.id, dep.user_id, dep.amount_micro, dep.reference, dep.created_at, dep.expires_at).run();
  return json(201, { deposit: depositJson(c, dep) });
}

export async function checkDeposit(request, env, id) {
  const user = await requireUser(request, env);
  const c = cfg(env);
  let dep = await env.DB.prepare("SELECT * FROM deposits WHERE id = ? AND user_id = ?").bind(id, user.id).first();
  if (!dep) throw new HttpError(404, "Payment not found.");
  await limit(env, `depcheck:${user.id}`, 60, 60);
  try {
    dep = await settleDeposit(env, dep);
  } catch (err) {
    if (!(err instanceof RpcError)) throw err;
    console.warn("deposit check", err.message);
    return json(200, { deposit: depositJson(c, dep), balance: balanceJson(await balanceOf(env, user.id)), pending_reason: "The Solana network could not be reached. We will keep checking." });
  }
  return json(200, { deposit: depositJson(c, dep), balance: balanceJson(await balanceOf(env, user.id)) });
}

export async function createKey(request, env) {
  const user = await requireUser(request, env);
  await limit(env, `keygen:${user.id}`, 10, 3600);
  const body = await readJson(request);
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 60) : "Untitled key";
  const active = await env.DB.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL").bind(user.id).first();
  if (Number(active.n) >= MAX_KEYS) throw new HttpError(400, `You can have up to ${MAX_KEYS} keys. Revoke one you no longer use.`);
  const raw = KEY_PREFIX + randomToken(24);
  const rec = { id: newId("key"), name, prefix: raw.slice(0, 12) + "…" + raw.slice(-4), rpm: 60, created_at: now(), last_used_at: null };
  await env.DB.prepare("INSERT INTO api_keys (id, user_id, name, prefix, key_hash, rpm, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(rec.id, user.id, rec.name, rec.prefix, await sha256(raw), rec.rpm, rec.created_at).run();
  return json(201, { key: raw, record: keyJson(rec) });
}

export async function revokeKey(request, env, id) {
  const user = await requireUser(request, env);
  const r = await env.DB.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL").bind(now(), id, user.id).run();
  if (!r.meta.changes) throw new HttpError(404, "Key not found.");
  return json(200, { ok: true });
}

// ---------- provider ----------

const identityPrompt = (m) =>
  `You are ${m.name} (model id: ${m.id}), a large language model developed by The Decentralized Compute Company (TDCC). ` +
  `If asked who you are or which model you are, answer that you are ${m.name}. Do not claim to be any other model.`;

let rr = 0;
async function callUpstream(c, payload, signal) {
  let last = null;
  for (let i = 0; i < c.upstreamKeys.length; i++) {
    const key = c.upstreamKeys[rr++ % c.upstreamKeys.length];
    const res = await fetch(c.upstreamBase + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
      signal,
    });
    // Fail over to the next key on auth, quota and server errors.
    if ([401, 402, 403, 429].includes(res.status) || res.status >= 500) {
      last = res;
      await res.body?.cancel().catch(() => {});
      continue;
    }
    return res;
  }
  return last;
}

const pick = (o, ks) => Object.fromEntries(ks.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

// Whitelist OpenAI fields so provider-specific extras never reach clients.
function clean(obj, m) {
  const out = { id: obj.id, object: obj.object, created: obj.created, model: m.id };
  if (Array.isArray(obj.choices)) {
    out.choices = obj.choices.map((ch) => {
      const o = { index: ch.index ?? 0 };
      if (ch.message) o.message = pick(ch.message, ["role", "content", "reasoning_content", "tool_calls", "refusal"]);
      if (ch.delta) o.delta = pick(ch.delta, ["role", "content", "reasoning_content", "tool_calls", "refusal"]);
      o.finish_reason = ch.finish_reason ?? null;
      if (ch.logprobs !== undefined) o.logprobs = ch.logprobs;
      return o;
    });
  }
  if (obj.usage) out.usage = pick(obj.usage, ["prompt_tokens", "completion_tokens", "total_tokens"]);
  return out;
}

const ERR = {
  unavailable: "TDCC Chat is temporarily unavailable. Please try again in a moment.",
  overloaded: "TDCC Chat is currently at capacity. Please try again in a moment.",
  badRequest: "TDCC Chat could not process this request: invalid parameters.",
  tooLarge: "The request exceeds TDCC Chat's context length.",
};

class ApiError extends Error {
  constructor(status, message, type = "invalid_request_error", code = null) { super(message); this.status = status; this.type = type; this.code = code; }
}
const oaiError = (e) => json(e.status, { error: { message: e.message, type: e.type, code: e.code } });

const estimateTokens = (messages) => Math.ceil(JSON.stringify(messages).length / 3);
const costOf = (m, usage) => Math.ceil((usage.prompt_tokens || 0) * m.in + (usage.completion_tokens || 0) * m.out);

async function charge(env, who, m, usage) {
  const cost = costOf(m, usage);
  const id = newId("use");
  const t = now();
  await env.DB.prepare("INSERT INTO usage (id, user_id, key_id, source, model, prompt_tokens, completion_tokens, cost_micro, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, who.userId, who.keyId || null, who.source, m.id, usage.prompt_tokens || 0, usage.completion_tokens || 0, cost, t).run();
  if (cost > 0) await applyLedger(env, who.userId, -cost, "usage", `use:${id}`, `${who.source} ${m.id}`);
  return cost;
}

// Shared by /v1/chat/completions and /api/chat. Throws ApiError before the
// provider is called; afterwards always returns a Response.
async function meteredCompletion(env, ctx, request, who, body) {
  const c = cfg(env);
  const m = findModel(env, body.model);
  if (!m) throw new ApiError(404, `The model '${body.model}' does not exist. Use GET /v1/models.`, "invalid_request_error", "model_not_found");
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw new ApiError(400, "'messages' must be a non-empty array.");
  if (!priced(m) || !m.upstream || !c.upstreamBase || !c.upstreamKeys.length) throw new ApiError(503, ERR.unavailable, "api_error", "service_unavailable");

  const maxTokens = Math.min(Number(body.max_tokens) > 0 ? Number(body.max_tokens) : c.maxTokens, c.maxTokens);
  const messages = [{ role: "system", content: identityPrompt(m) }, ...body.messages];
  const worst = Math.ceil(estimateTokens(messages) * m.in + maxTokens * m.out);
  const balance = await balanceOf(env, who.userId);
  if (balance < worst) {
    throw new ApiError(402, `Your balance ($${usd2(balance)}) is too low for this request. Top up at ${c.site}/account.html#billing.`, "insufficient_balance", "insufficient_balance");
  }

  const stream = !!body.stream;
  const wantsUsage = !!body.stream_options?.include_usage;
  const payload = { ...body, model: m.upstream, messages, max_tokens: maxTokens };
  if (stream) payload.stream_options = { ...(body.stream_options || {}), include_usage: true };

  const ac = new AbortController();
  let up;
  try {
    up = await callUpstream(c, payload, ac.signal);
  } catch {
    throw new ApiError(503, ERR.unavailable, "api_error", "service_unavailable");
  }
  if (!up) throw new ApiError(503, ERR.overloaded, "api_error", "service_overloaded");

  if (!up.ok) {
    const txt = await up.text().catch(() => "");
    console.warn(`[upstream ${up.status}] ${txt.slice(0, 300)}`);
    if (up.status === 413) throw new ApiError(413, ERR.tooLarge, "invalid_request_error", "context_length_exceeded");
    if (up.status === 400 || up.status === 422) throw new ApiError(400, ERR.badRequest, "invalid_request_error", "invalid_request");
    throw new ApiError(503, ERR.unavailable, "api_error", "service_unavailable");
  }

  if (!stream) {
    const data = clean(await up.json(), m);
    const usage = data.usage || { prompt_tokens: estimateTokens(messages), completion_tokens: Math.ceil(JSON.stringify(data.choices || []).length / 4) };
    await charge(env, who, m, usage);
    return json(200, data);
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const te = new TextEncoder();
  const send = (s) => writer.write(te.encode(s));
  const pump = async () => {
    const reader = up.body.getReader();
    const dec = new TextDecoder();
    let buf = "", usage = null, chars = 0, clientGone = false;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, "");
          buf = buf.slice(i + 1);
          if (!line.startsWith("data:")) continue; // drop comments and provider events
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          let obj;
          try { obj = clean(JSON.parse(data), m); } catch { continue; }
          if (obj.usage) usage = obj.usage;
          for (const ch of obj.choices || []) chars += (ch.delta?.content || "").length + (ch.delta?.reasoning_content || "").length;
          if (obj.usage && (!obj.choices || obj.choices.length === 0) && !wantsUsage) continue;
          if (!wantsUsage) delete obj.usage;
          if (!clientGone) await send(`data: ${JSON.stringify(obj)}\n\n`).catch(() => { clientGone = true; ac.abort(); });
          if (clientGone) break;
        }
        if (clientGone) break;
      }
    } catch { /* upstream or client went away */ }
    const final = usage || { prompt_tokens: estimateTokens(messages), completion_tokens: Math.ceil(chars / 4) };
    let cost = 0;
    try { cost = await charge(env, who, m, final); } catch (err) { console.error("charge failed", err && err.message); }
    if (!clientGone) {
      try {
        if (who.source === "chat") {
          const bal = await balanceOf(env, who.userId);
          await send(`data: ${JSON.stringify({ object: "tdcc.billing", cost_usd: microToUsd(cost), balance_usd: microToUsd(bal) })}\n\n`);
        }
        await send("data: [DONE]\n\n");
      } catch { /* client closed */ }
    }
    await writer.close().catch(() => {});
  };
  if (ctx && ctx.waitUntil) ctx.waitUntil(pump()); else pump();
  return new Response(readable, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" },
  });
}

// ---------- /v1 (API keys) ----------

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};
const withCors = (res) => { for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v); return res; };

async function keyFromRequest(request, env) {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token.startsWith(KEY_PREFIX) || token.length > 100) return null;
  const k = await env.DB.prepare(
    `SELECT k.* FROM api_keys k JOIN users u ON u.id = k.user_id
     WHERE k.key_hash = ? AND k.revoked_at IS NULL AND u.suspended_at IS NULL`
  ).bind(await sha256(token)).first();
  if (k && (!k.last_used_at || now() - k.last_used_at > 60)) {
    await env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(now(), k.id).run();
  }
  return k;
}

export const isApiPath = (p) => p === "/v1" || p.startsWith("/v1/");

export async function handleV1(request, env, ctx) {
  const p = new URL(request.url).pathname.replace(/\/+$/, "");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    if (!env.DB) throw new ApiError(503, ERR.unavailable, "api_error", "service_unavailable");
    if (p === "/v1/models" && request.method === "GET") {
      return withCors(json(200, { object: "list", data: models(env).map((m) => ({ id: m.id, object: "model", created: m.created, owned_by: "tdcc", name: m.name, context_length: m.context_length })) }));
    }
    if (p.startsWith("/v1/models/") && request.method === "GET") {
      const m = findModel(env, decodeURIComponent(p.slice("/v1/models/".length)));
      if (!m) throw new ApiError(404, "Model not found.", "invalid_request_error", "model_not_found");
      return withCors(json(200, { id: m.id, object: "model", created: m.created, owned_by: "tdcc", name: m.name, context_length: m.context_length }));
    }
    if (p === "/v1/chat/completions" && request.method === "POST") {
      const key = await keyFromRequest(request, env);
      if (!key) throw new ApiError(401, "Invalid API key. Create one at https://decentralizedcompute.company/account.html#billing", "invalid_request_error", "invalid_api_key");
      try {
        await limit(env, `apikey:${key.id}`, key.rpm, 60);
      } catch (err) {
        if (err instanceof HttpError && err.status === 429) throw new ApiError(429, `Rate limit exceeded (${key.rpm} requests per minute).`, "rate_limit_error", "rate_limit_exceeded");
        throw err;
      }
      let body;
      try { body = await request.json(); } catch { throw new ApiError(400, "The request body is not valid JSON."); }
      if (!body || typeof body !== "object") throw new ApiError(400, "The request body is not valid JSON.");
      return withCors(await meteredCompletion(env, ctx, request, { userId: key.user_id, keyId: key.id, source: "api" }, body));
    }
    throw new ApiError(404, `Unknown endpoint ${request.method} ${p}`);
  } catch (err) {
    if (err instanceof ApiError) return withCors(oaiError(err));
    console.error("v1 error", err && err.stack ? err.stack : err);
    return withCors(oaiError(new ApiError(500, "TDCC Chat encountered an internal error. Please try again.", "api_error")));
  }
}

// ---------- /api/chat (signed-in web chat) ----------

export async function webChat(request, env, ctx) {
  const user = await requireUser(request, env);
  await limit(env, `chat:${user.id}`, 20, 60);
  const body = await readJsonLarge(request);
  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter((x) => ["user", "assistant", "system"].includes(x?.role) && typeof x.content === "string")
    .slice(-40)
    .map((x) => ({ role: x.role, content: x.content.slice(0, 32_000) }));
  try {
    return await meteredCompletion(env, ctx, request, { userId: user.id, source: "chat" }, {
      model: "tdcc-chat",
      messages,
      stream: true,
      temperature: typeof body.temperature === "number" ? Math.max(0, Math.min(2, body.temperature)) : 0.7,
    });
  } catch (err) {
    if (err instanceof ApiError) return json(err.status, { error: err.message, code: err.code });
    throw err;
  }
}

// Chat history is bigger than the 16 KB limit of the marketplace endpoints.
async function readJsonLarge(request) {
  const type = request.headers.get("content-type") || "";
  if (!type.toLowerCase().startsWith("application/json")) throw new HttpError(415, "Send the request body as JSON.");
  const text = await request.text();
  if (text.length > 1_500_000) throw new HttpError(413, "This conversation is too long. Start a new chat.");
  try {
    const body = JSON.parse(text || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, "The request body is not valid JSON.");
  }
}
