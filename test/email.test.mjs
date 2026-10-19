import { test } from "node:test";
import assert from "node:assert/strict";
import { handleApi } from "../src/api.js";
import { createD1 } from "./d1.mjs";

const ORIGIN = "https://decentralizedcompute.company";

function client(env) {
  let cookie = "";
  const call = async (method, path, body) => {
    const h = { origin: ORIGIN };
    if (cookie) h.cookie = cookie;
    if (body !== undefined) h["content-type"] = "application/json";
    const res = await handleApi(new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0].endsWith("=") ? "" : set.split(";")[0];
    return { status: res.status, body: await res.json() };
  };
  return { call };
}

const linkToken = (mail, kind) => mail.text.match(new RegExp(`#${kind}=([A-Za-z0-9_-]+)`))[1];
const LISTING = { gpu_model: "RTX 4090", vram_gb: 24, gpu_count: 1, region: "eu-central", host_kind: "independent", price: 0.4 };
const RENT = { gpu_count: 1, hours: 2, environment: "pytorch", access: "api" };

async function signup(env, name, mail) {
  const c = client(env);
  const r = await c.call("POST", "/api/auth/signup", { email: mail, name, password: "a long enough password", accept_terms: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return c;
}

async function verified(env, name, mail) {
  const c = await signup(env, name, mail);
  const msg = env.EMAIL_OUTBOX.findLast((m) => m.to === mail && /Confirm/.test(m.subject));
  assert.equal((await c.call("POST", "/api/auth/verify", { token: linkToken(msg, "verify") })).status, 200);
  return c;
}

test("signup sends a verification link and unverified users cannot list or rent", async () => {
  const env = { DB: createD1(), EMAIL_OUTBOX: [] };
  const c = await signup(env, "Vera", "vera@example.com");
  assert.equal(env.EMAIL_OUTBOX.length, 1);
  assert.match(env.EMAIL_OUTBOX[0].text, /https:\/\/decentralizedcompute\.company\/confirm\.html#verify=/);
  const me = (await c.call("GET", "/api/me")).body;
  assert.equal(me.user.needs_verification, true);
  const r = await c.call("POST", "/api/listings", LISTING);
  assert.equal(r.status, 403);
  assert.equal(r.body.field, "email_unverified");

  const token = linkToken(env.EMAIL_OUTBOX[0], "verify");
  assert.equal((await c.call("POST", "/api/auth/verify", { token })).status, 200);
  assert.equal((await c.call("POST", "/api/auth/verify", { token })).status, 400, "links are single use");
  assert.equal((await c.call("GET", "/api/me")).body.user.email_verified, true);
  assert.equal((await c.call("POST", "/api/listings", LISTING)).status, 201);
});

test("password reset: generic answer, single use, revokes sessions", async () => {
  const env = { DB: createD1(), EMAIL_OUTBOX: [] };
  const a = await signup(env, "Rita", "rita@example.com");
  const anon = client(env);
  assert.equal((await anon.call("POST", "/api/auth/forgot", { email: "nobody@example.com" })).status, 200);
  assert.equal(env.EMAIL_OUTBOX.length, 1, "no mail for unknown address");
  assert.equal((await anon.call("POST", "/api/auth/forgot", { email: "RITA@example.com" })).status, 200);
  const mail = env.EMAIL_OUTBOX.at(-1);
  assert.equal(mail.to, "rita@example.com");
  const token = linkToken(mail, "reset");

  assert.equal((await anon.call("POST", "/api/auth/reset", { token, password: "short" })).status, 400);
  const r = await anon.call("POST", "/api/auth/reset", { token, password: "a brand new password" });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.email_verified, true, "the reset link proves the address");
  assert.equal((await anon.call("GET", "/api/me")).body.user.name, "Rita", "signed in after reset");
  assert.equal((await a.call("GET", "/api/me")).body.user, null, "old session revoked");
  assert.equal((await client(env).call("POST", "/api/auth/reset", { token, password: "another new password" })).status, 400, "single use");
  assert.equal((await client(env).call("POST", "/api/auth/login", { email: "rita@example.com", password: "a long enough password" })).status, 401);
  assert.equal((await client(env).call("POST", "/api/auth/login", { email: "rita@example.com", password: "a brand new password" })).status, 200);
});

test("without email configured, reset says so and nobody is blocked", async () => {
  const env = { DB: createD1() };
  const c = await signup(env, "Nia", "nia@example.com");
  assert.equal((await c.call("POST", "/api/listings", LISTING)).status, 201);
  assert.equal((await client(env).call("POST", "/api/auth/forgot", { email: "nia@example.com" })).status, 503);
});

test("hosts and renters are notified by email", async () => {
  const env = { DB: createD1(), EMAIL_OUTBOX: [] };
  const host = await verified(env, "Hana", "hana@example.com");
  const renter = await verified(env, "Rob", "rob@example.com");
  const { listing } = (await host.call("POST", "/api/listings", LISTING)).body;
  const { rental } = (await renter.call("POST", "/api/rentals", { ...RENT, listing_id: listing.id })).body;
  const toHost = env.EMAIL_OUTBOX.at(-1);
  assert.equal(toHost.to, "hana@example.com");
  assert.match(toHost.subject, /New rental request/);
  assert.match(toHost.text, /account\.html#requests/);
  assert.doesNotMatch(toHost.text, /rob@example\.com/, "renter email stays private until accept");

  await host.call("POST", `/api/rentals/${rental.id}/accept`, { note: "Starting at 9" });
  const toRenter = env.EMAIL_OUTBOX.at(-1);
  assert.equal(toRenter.to, "rob@example.com");
  assert.match(toRenter.subject, /^Accepted/);
  assert.match(toRenter.text, /Starting at 9/);

  await renter.call("POST", `/api/rentals/${rental.id}/cancel`, {});
  assert.equal(env.EMAIL_OUTBOX.at(-1).to, "hana@example.com");
  assert.match(env.EMAIL_OUTBOX.at(-1).subject, /^Cancelled/);
});

test("reports, hiding listings, and suspending accounts", async () => {
  const env = { DB: createD1(), EMAIL_OUTBOX: [], ADMIN_EMAILS: "admin@example.com" };
  const admin = await verified(env, "Ada Admin", "admin@example.com");
  const host = await verified(env, "Sam Scam", "sam@example.com");
  const renter = await verified(env, "Rob", "rob@example.com");
  const { listing } = (await host.call("POST", "/api/listings", LISTING)).body;
  await renter.call("POST", "/api/rentals", { ...RENT, listing_id: listing.id });

  assert.equal((await renter.call("GET", "/api/admin")).status, 404, "admin area is invisible to others");
  assert.equal((await renter.call("POST", `/api/listings/${listing.id}/report`, { reason: "bad" })).status, 400);
  assert.equal((await renter.call("POST", `/api/listings/${listing.id}/report`, { reason: "This GPU does not exist." })).status, 200);
  assert.equal(env.EMAIL_OUTBOX.at(-1).to, "admin@example.com");

  const overview = (await admin.call("GET", "/api/admin")).body;
  assert.equal(overview.reports.length, 1);
  assert.equal(overview.reports[0].owner_email, "sam@example.com");
  assert.equal(overview.stats.active_listings, 1);

  assert.equal((await admin.call("POST", `/api/admin/listings/${listing.id}/hide`, { note: "Fake listing" })).status, 200);
  assert.equal((await client(env).call("GET", "/api/listings")).body.listings.length, 0);
  const mine = (await host.call("GET", "/api/my/listings")).body.listings[0];
  assert.equal(mine.status, "hidden");
  assert.equal(mine.moderation_note, "Fake listing");
  assert.equal((await host.call("PATCH", `/api/listings/${listing.id}`, { status: "active" })).status, 403, "owner cannot unhide");
  assert.equal((await renter.call("GET", "/api/my/rentals")).body.rentals[0].status, "declined");
  assert.equal((await admin.call("GET", "/api/admin")).body.reports.length, 0, "reports resolved");

  const hostId = (await host.call("GET", "/api/me")).body.user.id;
  assert.equal((await admin.call("POST", `/api/admin/users/${hostId}/suspend`, {})).status, 200);
  assert.equal((await host.call("GET", "/api/me")).body.user, null, "suspended user is signed out");
  assert.equal((await client(env).call("POST", "/api/auth/login", { email: "sam@example.com", password: "a long enough password" })).status, 403);
  assert.equal((await admin.call("POST", `/api/admin/users/${hostId}/unsuspend`, {})).status, 200);
  assert.equal((await client(env).call("POST", "/api/auth/login", { email: "sam@example.com", password: "a long enough password" })).status, 200);
});
