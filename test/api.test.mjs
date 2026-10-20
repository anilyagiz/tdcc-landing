import { test } from "node:test";
import assert from "node:assert/strict";
import { handleApi } from "../src/api.js";
import { createD1 } from "./d1.mjs";

const ORIGIN = "https://decentralizedcompute.company";

function client(env) {
  let cookie = "";
  const call = async (method, path, body, headers = {}) => {
    const h = { origin: ORIGIN, ...headers };
    if (cookie) h.cookie = cookie;
    if (body !== undefined) h["content-type"] = "application/json";
    const res = await handleApi(new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0].endsWith("=") ? "" : set.split(";")[0];
    return { status: res.status, body: await res.json(), headers: res.headers };
  };
  return { call, get cookie() { return cookie; } };
}

let n = 0;
async function account(env, name = "Host") {
  const c = client(env);
  const r = await c.call("POST", "/api/auth/signup", { email: `${name.split(" ")[0].toLowerCase()}${++n}@example.com`, name, password: "correct horse battery", accept_terms: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return c;
}

const LISTING = { gpu_model: "RTX 4090", vram_gb: 24, gpu_count: 2, region: "eu-central", host_kind: "independent", price: 0.35, description: "Home rig" };
const RENT = { gpu_count: 1, hours: 4, environment: "pytorch", access: "ssh", ssh_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq me@laptop" };

test("signup, session, logout, login", async () => {
  const env = { DB: createD1() };
  const c = client(env);
  let r = await c.call("POST", "/api/auth/signup", { email: "Ada@Example.com", name: "Ada", password: "short", accept_terms: true });
  assert.equal(r.status, 400);
  r = await c.call("POST", "/api/auth/signup", { email: "Ada@Example.com", name: "Ada", password: "long enough password", accept_terms: true });
  assert.equal(r.status, 201);
  assert.match(r.headers.get("set-cookie"), /^__Host-tdcc_sid=.+HttpOnly; Secure; SameSite=Lax/);
  assert.equal((await c.call("GET", "/api/me")).body.user.email, "ada@example.com");
  r = await c.call("POST", "/api/auth/signup", { email: "ada@example.com", name: "Ada", password: "long enough password", accept_terms: true });
  assert.equal(r.status, 409);
  await c.call("POST", "/api/auth/logout", {});
  assert.equal((await c.call("GET", "/api/me")).body.user, null);
  assert.equal((await c.call("POST", "/api/auth/login", { email: "ada@example.com", password: "wrong password!" })).status, 401);
  assert.equal((await c.call("POST", "/api/auth/login", { email: "ADA@example.com", password: "long enough password" })).status, 200);
  assert.equal((await c.call("GET", "/api/me")).body.user.name, "Ada");
  // Passwords are never stored in clear.
  const row = await env.DB.prepare("SELECT pw_hash FROM users").first();
  assert.notEqual(row.pw_hash, "long enough password");
});

test("cross-site writes are rejected", async () => {
  const env = { DB: createD1() };
  const c = client(env);
  const r = await c.call("POST", "/api/auth/signup", { email: "x@example.com", name: "X", password: "long enough password", accept_terms: true }, { origin: "https://evil.example" });
  assert.equal(r.status, 403);
  const form = await handleApi(new Request(ORIGIN + "/api/auth/login", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: "email=a" }), env);
  assert.equal(form.status, 415);
});

test("login is rate limited", async () => {
  const env = { DB: createD1() };
  const c = client(env);
  let last;
  for (let i = 0; i < 12; i++) last = await c.call("POST", "/api/auth/login", { email: "nobody@example.com", password: "whatever12345" });
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get("retry-after")) > 0);
});

test("host lists a GPU, renter requests it, host accepts, contacts are revealed", async () => {
  const env = { DB: createD1() };
  const host = await account(env, "Hana Host");
  const renter = await account(env, "Rob Renter");

  assert.equal((await renter.call("POST", "/api/listings", { ...LISTING, region: "mars" })).status, 400);
  let r = await host.call("POST", "/api/listings", LISTING);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const listing = r.body.listing;
  assert.equal(listing.price_cents, 35);
  assert.equal(listing.available, 2);

  r = await client(env).call("GET", "/api/listings");
  assert.equal(r.body.listings.length, 1);
  assert.equal(r.body.listings[0].host_name, "Hana");
  assert.equal(r.body.listings[0].owner_id, undefined);
  assert.equal(JSON.stringify(r.body).includes("@example.com"), false, "public listing must not leak emails");

  assert.equal((await host.call("POST", "/api/rentals", { ...RENT, listing_id: listing.id })).status, 409, "cannot rent own listing");
  assert.equal((await client(env).call("POST", "/api/rentals", { ...RENT, listing_id: listing.id })).status, 401);
  assert.equal((await renter.call("POST", "/api/rentals", { ...RENT, listing_id: listing.id, gpu_count: 3 })).status, 409);
  assert.equal((await renter.call("POST", "/api/rentals", { ...RENT, listing_id: listing.id, ssh_key: "" })).status, 400);
  assert.equal((await renter.call("POST", "/api/rentals", { ...RENT, listing_id: listing.id, environment: "custom", image: "bad image; rm -rf" })).status, 400);

  r = await renter.call("POST", "/api/rentals", { ...RENT, listing_id: listing.id, message: "Need it for a LoRA run" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const rental = r.body.rental;
  assert.equal(rental.total_cents, 35 * 4);
  assert.equal(rental.host_email, null);

  r = await host.call("GET", "/api/my/requests");
  assert.equal(r.body.requests[0].renter_email, null, "email hidden before accept");
  assert.equal(r.body.requests[0].ssh_key, null);

  assert.equal((await renter.call("POST", `/api/rentals/${rental.id}/accept`, {})).status, 403, "renter cannot accept");
  r = await host.call("POST", `/api/rentals/${rental.id}/accept`, { note: "Ready at 9:00 UTC" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.rental.renter_email, /@example\.com$/);
  assert.match(r.body.rental.ssh_key, /^ssh-ed25519/);

  r = await renter.call("GET", "/api/my/rentals");
  assert.equal(r.body.rentals[0].status, "accepted");
  assert.match(r.body.rentals[0].host_email, /@example\.com$/);
  assert.equal(r.body.rentals[0].host_note, "Ready at 9:00 UTC");

  r = await client(env).call("GET", "/api/listings");
  assert.equal(r.body.listings[0].available, 1);

  assert.equal((await host.call("DELETE", `/api/listings/${listing.id}`)).status, 409, "cannot remove with running rental");
  assert.equal((await host.call("PATCH", `/api/listings/${listing.id}`, { gpu_count: 0 })).status, 400);
  assert.equal((await renter.call("PATCH", `/api/listings/${listing.id}`, { price: 0.01 })).status, 404, "non-owner cannot edit");

  assert.equal((await host.call("POST", `/api/rentals/${rental.id}/complete`, {})).status, 403, "host cannot end a rental early as completed");
  r = await renter.call("POST", `/api/rentals/${rental.id}/complete`, {});
  assert.equal(r.status, 200);
  assert.equal((await renter.call("POST", `/api/rentals/${rental.id}/cancel`, {})).status, 409);

  r = await client(env).call("GET", "/api/listings");
  assert.equal(r.body.listings[0].available, 2);
  assert.equal(r.body.listings[0].host_completed, 1);

  assert.equal((await host.call("DELETE", `/api/listings/${listing.id}`)).status, 200);
  assert.equal((await client(env).call("GET", "/api/listings")).body.listings.length, 0);
});

test("accepting cannot overbook", async () => {
  const env = { DB: createD1() };
  const host = await account(env, "Host");
  const a = await account(env, "Alice");
  const b = await account(env, "Bob");
  const { body: { listing } } = await host.call("POST", "/api/listings", { ...LISTING, gpu_count: 1 });
  const r1 = (await a.call("POST", "/api/rentals", { ...RENT, listing_id: listing.id })).body.rental;
  const r2 = (await b.call("POST", "/api/rentals", { ...RENT, listing_id: listing.id })).body.rental;
  assert.equal((await host.call("POST", `/api/rentals/${r1.id}/accept`, {})).status, 200);
  assert.equal((await host.call("POST", `/api/rentals/${r2.id}/accept`, {})).status, 409);
  assert.equal((await host.call("POST", `/api/rentals/${r2.id}/decline`, { note: "Booked, sorry" })).status, 200);
  assert.equal((await b.call("GET", "/api/my/rentals")).body.rentals[0].host_email, null, "declined renter never sees host email");
});

test("paused listings are hidden and not rentable", async () => {
  const env = { DB: createD1() };
  const host = await account(env, "Host");
  const renter = await account(env, "Renter");
  const { body: { listing } } = await host.call("POST", "/api/listings", LISTING);
  assert.equal((await host.call("PATCH", `/api/listings/${listing.id}`, { status: "paused" })).status, 200);
  assert.equal((await client(env).call("GET", "/api/listings")).body.listings.length, 0);
  assert.equal((await renter.call("POST", "/api/rentals", { ...RENT, listing_id: listing.id })).status, 409);
  assert.equal((await host.call("GET", "/api/my/listings")).body.listings[0].status, "paused");
});

test("node token links a running tdcc node", async () => {
  const env = { DB: createD1() };
  const host = await account(env, "Host");
  const { body: { listing } } = await host.call("POST", "/api/listings", LISTING);
  const { body: { token } } = await host.call("POST", `/api/listings/${listing.id}/node-token`, {});
  assert.match(token, /^tdcc_node_/);

  const beat = (t, body = { version: "0.73.0", gpus: [{ name: "NVIDIA GeForce RTX 4090", vram_gb: 24 }] }) =>
    handleApi(new Request(ORIGIN + "/api/node/heartbeat", { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: JSON.stringify(body) }), env);

  assert.equal((await beat("tdcc_node_wrong")).status, 401);
  const res = await beat(token);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).listing_id, listing.id);

  const pub = (await client(env).call("GET", "/api/listings")).body.listings[0];
  assert.equal(pub.online, true);
  assert.equal(pub.node_gpus[0].name, "NVIDIA GeForce RTX 4090");

  await host.call("DELETE", `/api/listings/${listing.id}/node-token`);
  assert.equal((await beat(token)).status, 401);
});

test("password change revokes other sessions; account deletion", async () => {
  const env = { DB: createD1() };
  const a = client(env);
  await a.call("POST", "/api/auth/signup", { email: "pw@example.com", name: "Pat", password: "first password!", accept_terms: true });
  const b = client(env);
  await b.call("POST", "/api/auth/login", { email: "pw@example.com", password: "first password!" });
  assert.equal((await a.call("POST", "/api/me/password", { current_password: "nope nope nope", new_password: "second password!" })).status, 401);
  assert.equal((await a.call("POST", "/api/me/password", { current_password: "first password!", new_password: "second password!" })).status, 200);
  assert.equal((await b.call("GET", "/api/me")).body.user, null, "other session revoked");
  assert.equal((await a.call("GET", "/api/me")).body.user.name, "Pat");
  assert.equal((await a.call("DELETE", "/api/me", { password: "second password!" })).status, 200);
  assert.equal((await a.call("POST", "/api/auth/login", { email: "pw@example.com", password: "second password!" })).status, 401);
});

test("missing database yields a clear 503", async () => {
  const res = await handleApi(new Request(ORIGIN + "/api/listings"), {});
  assert.equal(res.status, 503);
});
