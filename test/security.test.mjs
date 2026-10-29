import { test } from "node:test";
import assert from "node:assert/strict";
import { account, client, newEnv, beat, LISTING } from "./helpers.mjs";
import { totpCode, grantMessage } from "../src/api.js";

const codeNow = (secret, drift = 0) => totpCode(secret, Math.floor(Date.now() / 30_000) + drift);

test("two-factor sign-in: setup, login, replay protection, recovery codes, disable", async () => {
  const env = newEnv();
  const c = await account(env, "Tess");
  const setup = (await c.call("GET", "/api/me/2fa")).body;
  assert.match(setup.secret, /^[A-Z2-7]{32}$/);
  assert.match(setup.uri, /^otpauth:\/\/totp\/TDCC%20Marketplace%3Atess\d+%40example\.com\?secret=/);
  assert.equal((await c.call("POST", "/api/me/2fa", { secret: setup.secret, code: "000000" })).status, 400);
  const on = await c.call("POST", "/api/me/2fa", { secret: setup.secret, code: await codeNow(setup.secret) });
  assert.equal(on.status, 200);
  assert.equal(on.body.recovery_codes.length, 8);
  assert.equal((await c.call("GET", "/api/me")).body.user.two_factor, true);

  // Password alone no longer signs in.
  const d = client(env);
  let r = await d.call("POST", "/api/auth/login", { email: c.email, password: "a long enough password" });
  assert.equal(r.body.two_factor_required, true);
  assert.equal(d.cookie, "");
  assert.equal((await d.call("POST", "/api/auth/login/2fa", { challenge: r.body.challenge, code: "123456" })).status, 401);
  // The code used during setup cannot be used again.
  assert.equal((await d.call("POST", "/api/auth/login/2fa", { challenge: r.body.challenge, code: await codeNow(setup.secret) })).status, 401);
  r = await d.call("POST", "/api/auth/login/2fa", { challenge: r.body.challenge, code: await codeNow(setup.secret, 1) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await d.call("GET", "/api/me")).body.user.email, c.email);

  // A recovery code works once.
  const e = client(env);
  const rc = on.body.recovery_codes[0];
  let ch = (await e.call("POST", "/api/auth/login", { email: c.email, password: "a long enough password" })).body.challenge;
  assert.equal((await e.call("POST", "/api/auth/login/2fa", { challenge: ch, code: rc.toUpperCase() })).status, 200);
  ch = (await e.call("POST", "/api/auth/login", { email: c.email, password: "a long enough password" })).body.challenge;
  assert.equal((await e.call("POST", "/api/auth/login/2fa", { challenge: ch, code: rc })).status, 401);

  // Turning it off needs the password and a code.
  assert.equal((await c.call("DELETE", "/api/me/2fa", { password: "wrong password!", code: on.body.recovery_codes[1] })).status, 401);
  assert.equal((await c.call("DELETE", "/api/me/2fa", { password: "a long enough password", code: on.body.recovery_codes[1] })).status, 200);
  assert.equal((await c.call("GET", "/api/me")).body.user.two_factor, false);
  const events = (await c.call("GET", "/api/me/activity")).body.events.map((x) => x.event);
  for (const ev of ["2fa_enabled", "2fa_failed", "2fa_disabled", "login"]) assert.ok(events.includes(ev), ev);
});

test("second step is rate limited per account", async () => {
  const env = newEnv();
  const c = await account(env, "Rita");
  const { secret } = (await c.call("GET", "/api/me/2fa")).body;
  await c.call("POST", "/api/me/2fa", { secret, code: await codeNow(secret) });
  const d = client(env);
  const ch = (await d.call("POST", "/api/auth/login", { email: c.email, password: "a long enough password" })).body.challenge;
  let last;
  for (let i = 0; i < 7; i++) last = await d.call("POST", "/api/auth/login/2fa", { challenge: ch, code: "111111" });
  assert.equal(last.status, 429);
});

test("password reset does not bypass two-factor sign-in", async () => {
  const env = newEnv({ EMAIL_OUTBOX: [] });
  const c = await account(env, "Pia");
  const { secret } = (await c.call("GET", "/api/me/2fa")).body;
  await c.call("POST", "/api/me/2fa", { secret, code: await codeNow(secret) });
  const d = client(env);
  await d.call("POST", "/api/auth/forgot", { email: c.email });
  const token = env.EMAIL_OUTBOX.findLast((m) => /Reset/.test(m.subject)).text.match(/#reset=([A-Za-z0-9_-]+)/)[1];
  const r = await d.call("POST", "/api/auth/reset", { token, password: "another long password" });
  assert.equal(r.status, 200);
  assert.equal(r.body.sign_in, true);
  assert.equal(d.cookie, "");
});

test("sessions can be listed and signed out", async () => {
  const env = newEnv();
  const c = await account(env, "Sam");
  const other = client(env);
  await other.call("POST", "/api/auth/login", { email: c.email, password: "a long enough password" }, { "user-agent": "Phone" });
  let s = (await c.call("GET", "/api/me/sessions")).body.sessions;
  assert.equal(s.length, 2);
  assert.equal(s.filter((x) => x.current).length, 1);
  assert.ok(s.some((x) => x.user_agent === "Phone"));
  assert.equal((await c.call("POST", "/api/me/sessions/revoke", { id: "others" })).status, 200);
  assert.equal((await other.call("GET", "/api/me")).body.user, null);
  assert.equal((await c.call("GET", "/api/me")).body.user.email, c.email);
  s = (await c.call("GET", "/api/me/sessions")).body.sessions;
  assert.equal(s.length, 1);
});

test("email change is confirmed from the new address", async () => {
  const env = newEnv({ EMAIL_OUTBOX: [] });
  const c = await account(env, "Eve");
  const taken = await account(env, "Tom");
  assert.equal((await c.call("POST", "/api/me/email", { email: "new@example.com", password: "nope nope nope" })).status, 401);
  assert.equal((await c.call("POST", "/api/me/email", { email: taken.email, password: "a long enough password" })).status, 409);
  const r = await c.call("POST", "/api/me/email", { email: "New@Example.com", password: "a long enough password" });
  assert.equal(r.body.changed, false);
  assert.equal((await c.call("GET", "/api/me")).body.user.pending_email, "new@example.com");
  const confirm = env.EMAIL_OUTBOX.find((m) => m.to === "new@example.com");
  assert.ok(env.EMAIL_OUTBOX.find((m) => m.to === c.email && /about to change/.test(m.subject)), "old address is warned");
  const token = confirm.text.match(/#email=([A-Za-z0-9_-]+)/)[1];
  assert.equal((await client(env).call("POST", "/api/auth/email-change", { token })).status, 200);
  const me = (await c.call("GET", "/api/me")).body.user;
  assert.equal(me.email, "new@example.com");
  assert.equal(me.email_verified, true);
  assert.equal((await client(env).call("POST", "/api/auth/email-change", { token })).status, 400, "single use");
});

test("without email, a changed address starts unconfirmed", async () => {
  const env = newEnv();
  const c = await account(env, "Max");
  await env.DB.prepare("UPDATE users SET email_verified_at = 1").run();
  assert.equal((await c.call("POST", "/api/me/email", { email: "max@new.example", password: "a long enough password" })).body.changed, true);
  const me = (await c.call("GET", "/api/me")).body.user;
  assert.equal(me.email, "max@new.example");
  assert.equal(me.email_verified, false);
});

test("data export contains the account's data and nothing secret", async () => {
  const env = newEnv();
  const c = await account(env, "Dora");
  await c.call("POST", "/api/listings", LISTING);
  const r = await c.call("GET", "/api/me/export");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-disposition"), /attachment/);
  assert.equal(r.body.profile.email, c.email);
  assert.equal(r.body.listings.length, 1);
  const raw = JSON.stringify(r.body);
  assert.ok(!raw.includes("pw_hash") && !raw.includes("token_hash") && !raw.includes("totp_secret"));
});

test("robot check is required on sign-up when Turnstile is configured", async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    const ok = JSON.parse(init.body).response === "good-token";
    return new Response(JSON.stringify({ success: ok }), { status: 200 });
  };
  try {
    const env = newEnv({ TURNSTILE_SECRET: "s", TURNSTILE_SITE_KEY: "site" });
    const c = client(env);
    assert.equal((await c.call("GET", "/api/me")).body.turnstile_site_key, "site");
    const body = { email: "bot@example.com", name: "Bot", password: "a long enough password", accept_terms: true };
    assert.equal((await c.call("POST", "/api/auth/signup", body)).status, 400);
    assert.equal((await c.call("POST", "/api/auth/signup", { ...body, turnstile: "bad" })).status, 400);
    assert.equal((await c.call("POST", "/api/auth/signup", { ...body, turnstile: "good-token" })).status, 201);
    assert.ok(calls.every((u) => u.startsWith("https://challenges.cloudflare.com/")));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("grants sent to nodes are signed with the marketplace key", async () => {
  const seed = Buffer.alloc(32, 7).toString("base64url");
  const env = newEnv({ MARKET_SIGNING_KEY: seed });
  const host = await account(env, "Host");
  const renter = await account(env, "Renter");
  const { listing } = (await host.call("POST", "/api/listings", { ...LISTING, gpu_count: 1 })).body;
  const { token } = (await host.call("POST", `/api/listings/${listing.id}/node-token`, {})).body;
  const api = { join_token: "eyJpZCI6Im5vZGUifQ", trust_policy: "allowlist" };
  let r = await beat(env, token, { api });
  const pub = (await client(env).call("GET", "/api/market/key")).body;
  assert.equal(pub.alg, "ed25519");
  assert.equal(r.body.market_key, pub.public_key);
  const { rental } = (await renter.call("POST", "/api/rentals", { listing_id: listing.id, gpu_count: 1, hours: 1, access: "tdcc", owner_id: "b".repeat(64) })).body;
  await host.call("POST", `/api/rentals/${rental.id}/accept`, {});
  r = await beat(env, token, { api });
  const g = r.body.grants[0];
  assert.ok(g.sig);
  const key = await crypto.subtle.importKey("raw", Buffer.from(pub.public_key, "base64url"), { name: "Ed25519" }, false, ["verify"]);
  const msg = new TextEncoder().encode(grantMessage({ listing_id: listing.id, ...g }));
  assert.equal(await crypto.subtle.verify({ name: "Ed25519" }, key, Buffer.from(g.sig, "base64url"), msg), true);
  const forged = new TextEncoder().encode(grantMessage({ listing_id: listing.id, ...g, expires_at: g.expires_at + 3600 }));
  assert.equal(await crypto.subtle.verify({ name: "Ed25519" }, key, Buffer.from(g.sig, "base64url"), forged), false);
});
