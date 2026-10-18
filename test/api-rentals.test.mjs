import { test } from "node:test";
import assert from "node:assert/strict";
import { handleApi } from "../src/api.js";
import { createD1 } from "./d1.mjs";

const ORIGIN = "https://decentralizedcompute.company";
const RENTER_ID = "a".repeat(64);

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

let n = 0;
async function account(env, name) {
  const c = client(env);
  await c.call("POST", "/api/auth/signup", { email: `${name}${++n}@example.com`, name, password: "long enough password", accept_terms: true });
  return c;
}

async function setup() {
  const env = { DB: createD1() };
  const host = await account(env, "host");
  const renter = await account(env, "renter");
  const { listing } = (await host.call("POST", "/api/listings", { gpu_model: "RTX 4090", vram_gb: 24, gpu_count: 1, region: "eu-central", host_kind: "independent", price: 0.5 })).body;
  const { token } = (await host.call("POST", `/api/listings/${listing.id}/node-token`, {})).body;
  const beat = async (api) => {
    const res = await handleApi(new Request(ORIGIN + "/api/node/heartbeat", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ version: "0.74.0", gpus: [], ...(api ? { api } : {}) }),
    }), env);
    return { status: res.status, body: await res.json() };
  };
  return { env, host, renter, listing, beat };
}

const API = { join_token: "eyJpZCI6Im5vZGUifQ", trust_policy: "allowlist" };
const RENT = { gpu_count: 1, hours: 2, access: "tdcc", owner_id: RENTER_ID };

test("tdcc access is only offered while the node offers it", async () => {
  const { renter, listing, beat } = await setup();
  await beat(null);
  let pub = (await renter.call("GET", "/api/listings")).body.listings[0];
  assert.equal(pub.api_rentals, false);
  assert.equal((await renter.call("POST", "/api/rentals", { ...RENT, listing_id: listing.id })).status, 409);

  const r = await beat(API);
  assert.deepEqual(r.body.grants, [], "grants are reported once the node offers API access");
  pub = (await renter.call("GET", "/api/listings")).body.listings[0];
  assert.equal(pub.api_rentals, true);
  assert.equal(JSON.stringify(pub).includes(API.join_token), false, "the join token is never public");
});

test("owner id is validated", async () => {
  const { renter, listing, beat } = await setup();
  await beat(API);
  const bad = await renter.call("POST", "/api/rentals", { ...RENT, owner_id: "not-an-id", listing_id: listing.id });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.field, "owner_id");
  const ok = await renter.call("POST", "/api/rentals", { ...RENT, owner_id: RENTER_ID.toUpperCase(), listing_id: listing.id });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.rental.environment, "model");
  assert.equal(ok.body.rental.join_token, null, "no join token before acceptance");
});

test("accepting grants the renter for the rented hours; ending the rental removes the grant", async () => {
  const { host, renter, listing, beat } = await setup();
  await beat(API);
  const { rental } = (await renter.call("POST", "/api/rentals", { ...RENT, listing_id: listing.id })).body;
  assert.deepEqual((await beat(API)).body.grants, [], "pending rentals grant nothing");

  const before = Math.floor(Date.now() / 1000);
  const accepted = (await host.call("POST", `/api/rentals/${rental.id}/accept`, {})).body.rental;
  assert.equal(accepted.renter_owner_id, RENTER_ID);
  assert.ok(accepted.access_expires_at >= before + 2 * 3600 && accepted.access_expires_at <= before + 2 * 3600 + 5);

  const grants = (await beat(API)).body.grants;
  assert.deepEqual(grants, [{ rental_id: rental.id, owner_id: RENTER_ID, expires_at: accepted.access_expires_at }]);

  const mine = (await renter.call("GET", "/api/my/rentals")).body.rentals[0];
  assert.equal(mine.join_token, API.join_token, "the renter gets the join token after acceptance");

  await renter.call("POST", `/api/rentals/${rental.id}/complete`, {});
  assert.deepEqual((await beat(API)).body.grants, []);
  assert.equal((await renter.call("GET", "/api/my/rentals")).body.rentals[0].join_token, null);
});

test("rentals expire on their own and free the GPU", async () => {
  const { env, host, renter, listing, beat } = await setup();
  await beat(API);
  const { rental } = (await renter.call("POST", "/api/rentals", { ...RENT, listing_id: listing.id })).body;
  await host.call("POST", `/api/rentals/${rental.id}/accept`, {});
  assert.equal((await renter.call("GET", "/api/listings")).body.listings[0].available, 0);
  await env.DB.prepare("UPDATE rentals SET access_expires_at = 1 WHERE id = ?").bind(rental.id).run();
  assert.deepEqual((await beat(API)).body.grants, []);
  assert.equal((await renter.call("GET", "/api/my/rentals")).body.rentals[0].status, "completed");
  assert.equal((await renter.call("GET", "/api/listings")).body.listings[0].available, 1);
});

test("a malformed join token is refused", async () => {
  const { beat } = await setup();
  assert.equal((await beat({ join_token: "bad token <script>", trust_policy: "allowlist" })).status, 400);
});
