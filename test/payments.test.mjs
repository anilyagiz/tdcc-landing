import { test } from "node:test";
import assert from "node:assert/strict";
import { handleApi, scheduled } from "../src/api.js";
import { account, newEnv, age, ORIGIN, LISTING, RENT } from "./helpers.mjs";

const WEBHOOK_SECRET = "whsec_test";

// A tiny fake of the Stripe endpoints the marketplace uses.
function fakeStripe() {
  const calls = [];
  // sessions: checkout session id -> { status, payment_intent } for GETs.
  // lostCapture: the capture went through but the reply was lost (500).
  const state = { failCapture: false, lostCapture: false, failRefund: false, failCancel: false, sessions: new Map(), n: 0 };
  const fetch = async (url, init) => {
    const path = new URL(url).pathname.replace("/v1/", "");
    const params = Object.fromEntries(new URLSearchParams(init.body || new URL(url).search));
    calls.push({ method: init.method, path, params, idem: init.headers["idempotency-key"] });
    const ok = (o) => new Response(JSON.stringify(o), { status: 200 });
    const id = (p) => `${p}_${++state.n}`;
    if (path === "accounts" && init.method === "POST") return ok({ id: id("acct") });
    if (path.startsWith("accounts/") && path.endsWith("login_links")) return ok({ url: "https://connect.stripe.test/express" });
    if (path.startsWith("accounts/")) return ok({ id: path.split("/")[1], charges_enabled: true, payouts_enabled: true, details_submitted: true });
    if (path === "account_links") return ok({ url: "https://connect.stripe.test/onboard" });
    const fail = (status, message) => new Response(JSON.stringify({ error: { message } }), { status });
    if (path === "checkout/sessions") return ok({ id: id("cs"), url: "https://checkout.stripe.test/pay" });
    if (path.startsWith("checkout/sessions/") && path.endsWith("/expire")) return ok({ id: path.split("/")[2], status: "expired" });
    if (path.startsWith("checkout/sessions/") && init.method === "GET") return ok({ id: path.split("/")[2], status: "open", ...state.sessions.get(path.split("/")[2]) });
    if (path.endsWith("/capture")) {
      if (state.failCapture) return new Response(JSON.stringify({ error: { message: "card declined", code: "card_declined" } }), { status: 402 });
      if (state.lostCapture) return fail(500, "lost reply");
      return ok({ id: path.split("/")[1], latest_charge: id("ch") });
    }
    if (path.startsWith("payment_intents/") && init.method === "GET") {
      return ok({ id: path.split("/")[1], status: state.lostCapture ? "succeeded" : "requires_capture", latest_charge: "ch_lost" });
    }
    if (path.endsWith("/cancel")) return state.failCancel ? fail(500, "try later") : ok({ id: path.split("/")[1], status: "canceled" });
    if (path === "refunds") return state.failRefund ? fail(500, "try later") : ok({ id: id("re") });
    if (path === "transfers") return ok({ id: id("tr") });
    return new Response(JSON.stringify({ error: { message: "unexpected " + path } }), { status: 400 });
  };
  return { fetch, calls, state };
}

async function webhook(env, event) {
  const payload = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`))).toString("hex");
  const res = await handleApi(new Request(ORIGIN + "/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": `t=${t},v1=${sig}`, "content-type": "application/json" }, body: payload }), env);
  return { status: res.status, body: await res.json() };
}

let ev = 0;
const paid = (rental, session, pi) => ({ id: `evt_${++ev}`, type: "checkout.session.completed", data: { object: { id: session, payment_intent: pi, metadata: { rental_id: rental } } } });

async function setup() {
  const stripe = fakeStripe();
  const env = newEnv({ STRIPE_SECRET_KEY: "sk_test", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_FETCH: stripe.fetch, PLATFORM_FEE_BPS: "1000", EMAIL_OUTBOX: [] });
  const host = await account(env, "Host");
  const renter = await account(env, "Renter");
  await env.DB.prepare("UPDATE users SET email_verified_at = 1").run();
  const { listing } = (await host.call("POST", "/api/listings", { ...LISTING, gpu_count: 1, price: 2 })).body;
  return { env, stripe, host, renter, listing };
}

async function book(ctx, extra = {}) {
  const r = await ctx.renter.call("POST", "/api/rentals", { ...RENT, listing_id: ctx.listing.id, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const row = await ctx.env.DB.prepare("SELECT checkout_session_id FROM rentals WHERE id = ?").bind(r.body.rental.id).first();
  return { id: r.body.rental.id, session: row.checkout_session_id, checkout: r.body.checkout_url };
}

test("hosts must set up payouts before their GPUs can be booked", async () => {
  const ctx = await setup();
  assert.equal((await ctx.renter.call("GET", "/api/listings")).body.total, 0);
  assert.equal((await ctx.renter.call("POST", "/api/rentals", { ...RENT, listing_id: ctx.listing.id })).status, 409);
  const r = await ctx.host.call("POST", "/api/me/payouts", {});
  assert.equal(r.body.url, "https://connect.stripe.test/onboard");
  const acct = (await ctx.env.DB.prepare("SELECT payout_account_id FROM users WHERE id = ?").bind(ctx.host.id).first()).payout_account_id;
  assert.match(acct, /^acct_/);
  assert.equal((await webhook(ctx.env, { id: "evt_acct", type: "account.updated", data: { object: { id: acct, charges_enabled: true, payouts_enabled: true, details_submitted: true } } })).status, 200);
  assert.equal((await ctx.host.call("GET", "/api/me/payouts")).body.ready, true);
  assert.equal((await ctx.renter.call("GET", "/api/listings")).body.total, 1);
});

test("webhooks with a bad signature are rejected and duplicates ignored", async () => {
  const ctx = await setup();
  const res = await handleApi(new Request(ORIGIN + "/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": "t=1,v1=00" }, body: "{}" }), ctx.env);
  assert.equal(res.status, 400);
  const e = { id: "evt_same", type: "account.updated", data: { object: { id: "acct_x" } } };
  assert.equal((await webhook(ctx.env, e)).body.duplicate, undefined);
  assert.equal((await webhook(ctx.env, e)).body.duplicate, true);
});

async function readyHost(ctx) {
  await ctx.host.call("POST", "/api/me/payouts", {});
  await ctx.env.DB.prepare("UPDATE users SET payouts_enabled = 1 WHERE id = ?").bind(ctx.host.id).run();
}

test("card is authorized on request, captured on accept, host paid a day after the end", async () => {
  const ctx = await setup();
  await readyHost(ctx);
  const b = await book(ctx);
  assert.equal(b.checkout, "https://checkout.stripe.test/pay");
  const co = ctx.stripe.calls.find((c) => c.path === "checkout/sessions");
  assert.equal(co.params["payment_intent_data[capture_method]"], "manual");
  assert.equal(co.params["line_items[0][price_data][unit_amount]"], "400");
  // Not visible to the host until paid.
  assert.equal((await ctx.host.call("GET", "/api/my/requests")).body.requests.length, 0);
  ctx.env.EMAIL_OUTBOX.length = 0;
  await webhook(ctx.env, paid(b.id, b.session, "pi_1"));
  const req = (await ctx.host.call("GET", "/api/my/requests")).body.requests[0];
  assert.equal(req.status, "pending");
  assert.equal(req.payment_status, "authorized");
  assert.equal(ctx.env.EMAIL_OUTBOX[0].to, ctx.host.email, "host notified once paid");

  assert.equal((await ctx.host.call("POST", `/api/rentals/${b.id}/accept`, {})).status, 200);
  assert.ok(ctx.stripe.calls.some((c) => c.path === "payment_intents/pi_1/capture"));
  let row = await ctx.env.DB.prepare("SELECT * FROM rentals WHERE id = ?").bind(b.id).first();
  assert.equal(row.payment_status, "captured");
  assert.equal(row.payout_status, "held");
  assert.equal(row.fee_cents, 40);

  await ctx.renter.call("POST", `/api/rentals/${b.id}/complete`, {});
  await scheduled(ctx.env);
  assert.ok(!ctx.stripe.calls.some((c) => c.path === "transfers"), "held during the dispute window");
  await age(ctx.env, "rentals", "updated_at", 25 * 3600);
  await scheduled(ctx.env);
  const tr = ctx.stripe.calls.filter((c) => c.path === "transfers");
  assert.equal(tr.length, 1);
  assert.equal(tr[0].params.amount, "360");
  assert.equal(tr[0].params.idem, undefined);
  assert.equal(tr[0].idem, `payout-${b.id}`);
  await scheduled(ctx.env);
  assert.equal(ctx.stripe.calls.filter((c) => c.path === "transfers").length, 1, "paid once");
  row = await ctx.env.DB.prepare("SELECT payout_status FROM rentals WHERE id = ?").bind(b.id).first();
  assert.equal(row.payout_status, "paid");
  const earn = (await ctx.host.call("GET", "/api/me/payouts")).body;
  assert.equal(earn.paid_cents, 360);
});

test("declined requests release the card hold; failed capture books nothing", async () => {
  const ctx = await setup();
  await readyHost(ctx);
  let b = await book(ctx);
  await webhook(ctx.env, paid(b.id, b.session, "pi_d"));
  await ctx.host.call("POST", `/api/rentals/${b.id}/decline`, {});
  assert.ok(ctx.stripe.calls.some((c) => c.path === "payment_intents/pi_d/cancel"));

  b = await book(ctx);
  await webhook(ctx.env, paid(b.id, b.session, "pi_f"));
  ctx.stripe.state.failCapture = true;
  const r = await ctx.host.call("POST", `/api/rentals/${b.id}/accept`, {});
  assert.equal(r.status, 402);
  const row = await ctx.env.DB.prepare("SELECT status FROM rentals WHERE id = ?").bind(b.id).first();
  assert.equal(row.status, "cancelled");
  assert.equal((await ctx.renter.call("GET", `/api/listings/${ctx.listing.id}`)).body.listing.available, 1);
});

test("cancelling refunds: host cancels -> all; renter mid-rental -> hours not begun", async () => {
  const ctx = await setup();
  await readyHost(ctx);
  let b = await book(ctx, { hours: 4 });
  await webhook(ctx.env, paid(b.id, b.session, "pi_h"));
  await ctx.host.call("POST", `/api/rentals/${b.id}/accept`, {});
  await ctx.host.call("POST", `/api/rentals/${b.id}/cancel`, {});
  let refund = ctx.stripe.calls.findLast((c) => c.path === "refunds");
  assert.equal(refund.params.amount, "800");
  assert.equal(refund.params.payment_intent, "pi_h");

  b = await book(ctx, { hours: 4 });
  await webhook(ctx.env, paid(b.id, b.session, "pi_r"));
  await ctx.host.call("POST", `/api/rentals/${b.id}/accept`, {});
  await age(ctx.env, "rentals", "access_starts_at", 90 * 60, `id = '${b.id}'`); // 1.5 h in -> 2 h used
  await ctx.renter.call("POST", `/api/rentals/${b.id}/cancel`, {});
  refund = ctx.stripe.calls.findLast((c) => c.path === "refunds");
  assert.equal(refund.params.amount, "400");
  const row = await ctx.env.DB.prepare("SELECT payment_status, refunded_cents, payout_status FROM rentals WHERE id = ?").bind(b.id).first();
  assert.deepEqual({ ...row }, { payment_status: "partially_refunded", refunded_cents: 400, payout_status: "held" });
  await age(ctx.env, "rentals", "updated_at", 25 * 3600, `id = '${b.id}'`);
  await scheduled(ctx.env);
  assert.equal(ctx.stripe.calls.findLast((c) => c.path === "transfers").params.amount, "360", "host gets 90% of what was kept");
});

test("an open dispute holds the payout until an admin settles it", async () => {
  const ctx = await setup();
  ctx.env.ADMIN_EMAILS = "boss@example.com";
  await readyHost(ctx);
  const b = await book(ctx);
  await webhook(ctx.env, paid(b.id, b.session, "pi_x"));
  await ctx.host.call("POST", `/api/rentals/${b.id}/accept`, {});
  await ctx.renter.call("POST", `/api/rentals/${b.id}/complete`, {});
  assert.equal((await ctx.renter.call("POST", `/api/rentals/${b.id}/dispute`, { reason: "The GPU was much slower than listed." })).status, 201);
  await age(ctx.env, "rentals", "updated_at", 3 * 86400);
  await scheduled(ctx.env);
  assert.ok(!ctx.stripe.calls.some((c) => c.path === "transfers"));
  const admin = await account(ctx.env, "Boss");
  await ctx.env.DB.prepare("UPDATE users SET email = 'boss@example.com', email_verified_at = 1 WHERE id = ?").bind(admin.id).run();
  const d = (await admin.call("GET", "/api/admin")).body.disputes[0];
  assert.equal((await admin.call("POST", `/api/admin/disputes/${d.id}`, { action: "refund", amount_cents: 200 })).status, 200);
  assert.equal(ctx.stripe.calls.findLast((c) => c.path === "refunds").params.amount, "200");
  await scheduled(ctx.env);
  assert.equal(ctx.stripe.calls.findLast((c) => c.path === "transfers").params.amount, "180");
});

test("unpaid checkouts are cancelled and do not block capacity", async () => {
  const ctx = await setup();
  await readyHost(ctx);
  const b = await book(ctx);
  await webhook(ctx.env, { id: "evt_exp", type: "checkout.session.expired", data: { object: { id: b.session } } });
  const row = await ctx.env.DB.prepare("SELECT status FROM rentals WHERE id = ?").bind(b.id).first();
  assert.equal(row.status, "cancelled");
  const late = await book(ctx);
  await webhook(ctx.env, paid(late.id, late.session, "pi_l"));
  await ctx.renter.call("POST", `/api/rentals/${late.id}/cancel`, {});
  assert.ok(ctx.stripe.calls.some((c) => c.path === "payment_intents/pi_l/cancel"));
});

// ---------- recovering from failed or missed Stripe calls ----------

async function acceptedRental(ctx, pi, extra = {}) {
  const b = await book(ctx, extra);
  await webhook(ctx.env, paid(b.id, b.session, pi));
  assert.equal((await ctx.host.call("POST", `/api/rentals/${b.id}/accept`, {})).status, 200);
  return b;
}

test("a failed refund changes nothing, so the cancel can be retried", async () => {
  const ctx = await setup();
  await readyHost(ctx);
  const b = await acceptedRental(ctx, "pi_rf", { hours: 4 });
  ctx.stripe.state.failRefund = true;
  assert.equal((await ctx.renter.call("POST", `/api/rentals/${b.id}/cancel`, {})).status, 502);
  let row = await ctx.env.DB.prepare("SELECT status, refunded_cents FROM rentals WHERE id = ?").bind(b.id).first();
  assert.deepEqual({ ...row }, { status: "accepted", refunded_cents: 0 }, "still running, nothing lost");
  ctx.stripe.state.failRefund = false;
  assert.equal((await ctx.renter.call("POST", `/api/rentals/${b.id}/cancel`, {})).status, 200);
  row = await ctx.env.DB.prepare("SELECT status, refunded_cents FROM rentals WHERE id = ?").bind(b.id).first();
  assert.deepEqual({ ...row }, { status: "cancelled", refunded_cents: 800 });
});

test("a capture whose reply was lost is confirmed with Stripe instead of cancelled", async () => {
  const ctx = await setup();
  await readyHost(ctx);
  const b = await book(ctx);
  await webhook(ctx.env, paid(b.id, b.session, "pi_lost"));
  ctx.stripe.state.lostCapture = true;
  assert.equal((await ctx.host.call("POST", `/api/rentals/${b.id}/accept`, {})).status, 200);
  const row = await ctx.env.DB.prepare("SELECT status, payment_status, payout_status, charge_id FROM rentals WHERE id = ?").bind(b.id).first();
  assert.deepEqual({ ...row }, { status: "accepted", payment_status: "captured", payout_status: "held", charge_id: "ch_lost" });
});

test("a paid rental cannot be finished early by the host, only cancelled with a refund", async () => {
  const ctx = await setup();
  await readyHost(ctx);
  const b = await acceptedRental(ctx, "pi_early");
  assert.equal((await ctx.host.call("POST", `/api/rentals/${b.id}/complete`, {})).status, 409);
  // Once the hours are up the host may close it.
  await age(ctx.env, "rentals", "access_expires_at", 3 * 3600, `id = '${b.id}'`);
  await ctx.env.DB.prepare("UPDATE rentals SET status = 'accepted' WHERE id = ?").bind(b.id).run();
  assert.equal((await ctx.host.call("POST", `/api/rentals/${b.id}/complete`, {})).status, 200);
});

test("checkouts whose webhook never arrived are picked up from Stripe", async () => {
  const ctx = await setup();
  await readyHost(ctx);
  const b = await book(ctx);
  ctx.stripe.state.sessions.set(b.session, { status: "complete", payment_intent: "pi_missed" });
  // The renter comes back from Checkout before the webhook: their page finds it.
  const mine = (await ctx.renter.call("GET", "/api/my/rentals")).body.rentals[0];
  assert.equal(mine.status, "pending");
  assert.equal(mine.payment_status, "authorized");
  assert.equal(ctx.env.EMAIL_OUTBOX.at(-1).to, ctx.host.email);

  // The cron does the same for anyone who never came back.
  const c = await book(ctx);
  ctx.stripe.state.sessions.set(c.session, { status: "complete", payment_intent: "pi_cron" });
  await age(ctx.env, "rentals", "created_at", 300, `id = '${c.id}'`);
  await scheduled(ctx.env);
  const row = await ctx.env.DB.prepare("SELECT status, payment_intent_id FROM rentals WHERE id = ?").bind(c.id).first();
  assert.deepEqual({ ...row }, { status: "pending", payment_intent_id: "pi_cron" });
  // A late webhook for the same checkout changes nothing.
  await webhook(ctx.env, paid(c.id, c.session, "pi_cron"));
  assert.equal(ctx.stripe.calls.filter((x) => x.path === "payment_intents/pi_cron/cancel").length, 0);
});

test("a card hold that could not be released is released by the cron", async () => {
  const ctx = await setup();
  await readyHost(ctx);
  const b = await book(ctx);
  await webhook(ctx.env, paid(b.id, b.session, "pi_hold"));
  ctx.stripe.state.failCancel = true;
  assert.equal((await ctx.host.call("POST", `/api/rentals/${b.id}/decline`, {})).status, 200, "the host's answer does not fail");
  let row = await ctx.env.DB.prepare("SELECT status, payment_status FROM rentals WHERE id = ?").bind(b.id).first();
  assert.deepEqual({ ...row }, { status: "declined", payment_status: "authorized" });
  ctx.stripe.state.failCancel = false;
  await scheduled(ctx.env);
  row = await ctx.env.DB.prepare("SELECT payment_status FROM rentals WHERE id = ?").bind(b.id).first();
  assert.equal(row.payment_status, "released");
});

test("a webhook that fails halfway is handled again on Stripe's retry", async () => {
  const ctx = await setup();
  await readyHost(ctx);
  const b = await book(ctx);
  // Cancelled while paying; the database fails while the webhook handles it.
  await ctx.renter.call("POST", `/api/rentals/${b.id}/cancel`, {});
  assert.ok(ctx.stripe.calls.some((c) => c.path === `checkout/sessions/${b.session}/expire`), "checkout closed on cancel");
  const realPrepare = ctx.env.DB.prepare;
  let broken = true;
  ctx.env.DB.prepare = (sql) => {
    if (broken && sql.startsWith("UPDATE rentals SET payment_intent_id")) throw new Error("D1 went away");
    return realPrepare(sql);
  };
  const event = paid(b.id, b.session, "pi_retry");
  assert.equal((await webhook(ctx.env, event)).status, 500);
  broken = false;
  const again = await webhook(ctx.env, event);
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, undefined, "the retry is processed, not skipped");
  assert.ok(ctx.stripe.calls.some((c) => c.path === "payment_intents/pi_retry/cancel"));
});

test("suspended hosts are not paid out", async () => {
  const ctx = await setup();
  await readyHost(ctx);
  const b = await acceptedRental(ctx, "pi_sus");
  await ctx.renter.call("POST", `/api/rentals/${b.id}/complete`, {});
  await ctx.env.DB.prepare("UPDATE users SET suspended_at = 1 WHERE id = ?").bind(ctx.host.id).run();
  await age(ctx.env, "rentals", "updated_at", 25 * 3600);
  await scheduled(ctx.env);
  assert.ok(!ctx.stripe.calls.some((c) => c.path === "transfers"));
  await ctx.env.DB.prepare("UPDATE users SET suspended_at = NULL WHERE id = ?").bind(ctx.host.id).run();
  await scheduled(ctx.env);
  assert.equal(ctx.stripe.calls.filter((c) => c.path === "transfers").length, 1);
});

test("checkout is card-only and totals above Stripe's limit are refused", async () => {
  const ctx = await setup();
  await readyHost(ctx);
  await book(ctx);
  assert.equal(ctx.stripe.calls.find((c) => c.path === "checkout/sessions").params["payment_method_types[0]"], "card");
  await ctx.host.call("PATCH", `/api/listings/${ctx.listing.id}`, { price: 1000, gpu_count: 512 });
  const r = await ctx.renter.call("POST", "/api/rentals", { ...RENT, listing_id: ctx.listing.id, gpu_count: 512, hours: 2000 });
  assert.equal(r.status, 400);
});
