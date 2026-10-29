import { test } from "node:test";
import assert from "node:assert/strict";
import { machineGrantMessage } from "../src/api.js";
import { account, client, newEnv, beat, LISTING } from "./helpers.mjs";

const SEED = Buffer.alloc(32, 7).toString("base64url");
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq me@laptop";
const OFFER = { runtime: "docker", gpus: 2, custom_images: false, ssh_host: "gpu.example.com" };

async function setup(extra = {}) {
  const env = newEnv({ MARKET_SIGNING_KEY: SEED, ...extra });
  const host = await account(env, "Host");
  const renter = await account(env, "Renter");
  const { listing } = (await host.call("POST", "/api/listings", { ...LISTING, gpu_count: 2 })).body;
  const { token } = (await host.call("POST", `/api/listings/${listing.id}/node-token`, {})).body;
  return { env, host, renter, listing, hb: (body) => beat(env, token, body) };
}

test("a node offering machines gets signed grants for accepted SSH rentals", async () => {
  const { env, host, renter, listing, hb } = await setup();
  let r = await hb({ machines: OFFER });
  assert.deepEqual(r.body.machines, []);
  const pub = (await renter.call("GET", `/api/listings/${listing.id}`)).body.listing;
  assert.equal(pub.machine_rentals, true);
  assert.equal(pub.custom_images, false);
  assert.equal((await renter.call("POST", "/api/rentals", { listing_id: listing.id, gpu_count: 1, hours: 2, environment: "custom", image: "evil/img:1", access: "ssh", ssh_key: KEY })).status, 400);
  const { rental } = (await renter.call("POST", "/api/rentals", { listing_id: listing.id, gpu_count: 1, hours: 2, environment: "pytorch", access: "ssh", ssh_key: KEY })).body;
  r = await hb({ machines: OFFER });
  assert.deepEqual(r.body.machines, [], "nothing before acceptance");
  await host.call("POST", `/api/rentals/${rental.id}/accept`, {});
  r = await hb({ machines: OFFER });
  const g = r.body.machines[0];
  assert.equal(g.rental_id, rental.id);
  assert.equal(g.ssh_key, KEY);
  assert.equal(g.environment, "pytorch");
  const pubKey = (await client(env).call("GET", "/api/market/key")).body.public_key;
  const key = await crypto.subtle.importKey("raw", Buffer.from(pubKey, "base64url"), { name: "Ed25519" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, Buffer.from(g.sig, "base64url"), new TextEncoder().encode(machineGrantMessage(listing.id, g)));
  assert.equal(ok, true);

  // The node reports the container; the renter gets the SSH command.
  await hb({ machines: OFFER, machine_status: [{ rental_id: rental.id, state: "starting" }] });
  assert.equal((await renter.call("GET", "/api/my/rentals")).body.rentals[0].machine.state, "starting");
  await hb({ machines: OFFER, machine_status: [{ rental_id: rental.id, state: "running", port: 22001 }, { rental_id: "rnt_someoneelse", state: "running", port: 1 }] });
  const mine = (await renter.call("GET", "/api/my/rentals")).body.rentals[0].machine;
  assert.deepEqual(mine, { state: "running", error: null, port: 22001, ssh: "ssh -p 22001 root@gpu.example.com" });
  assert.equal((await host.call("GET", "/api/my/requests")).body.requests[0].machine.state, "running");

  // Finished: no more grant, no more address.
  await renter.call("POST", `/api/rentals/${rental.id}/complete`, {});
  r = await hb({ machines: OFFER });
  assert.deepEqual(r.body.machines, []);
  assert.equal((await renter.call("GET", "/api/my/rentals")).body.rentals[0].machine, null);
});

test("Jupyter tokens are shown to the renter only", async () => {
  const { host, renter, listing, hb } = await setup();
  await hb({ machines: OFFER });
  const { rental } = (await renter.call("POST", "/api/rentals", { listing_id: listing.id, gpu_count: 1, hours: 2, environment: "ubuntu", access: "jupyter" })).body;
  await host.call("POST", `/api/rentals/${rental.id}/accept`, {});
  await hb({ machines: OFFER, machine_status: [{ rental_id: rental.id, state: "running", port: 22002, jupyter_token: "tok_abcdefghijkl" }] });
  let m = (await renter.call("GET", "/api/my/rentals")).body.rentals[0].machine;
  assert.equal(m.jupyter_url, "http://gpu.example.com:22002/lab?token=tok_abcdefghijkl", "older nodes without TLS");
  const fp = Array.from({ length: 32 }, (_, i) => (i * 7 % 256).toString(16).toUpperCase().padStart(2, "0")).join(":");
  await hb({ machines: OFFER, machine_status: [{ rental_id: rental.id, state: "running", port: 22002, jupyter_token: "tok_abcdefghijkl", tls_fingerprint: fp }] });
  m = (await renter.call("GET", "/api/my/rentals")).body.rentals[0].machine;
  assert.equal(m.jupyter_url, "https://gpu.example.com:22002/lab?token=tok_abcdefghijkl");
  assert.equal(m.tls_fingerprint, fp);
  await hb({ machines: OFFER, machine_status: [{ rental_id: rental.id, state: "running", port: 22002, jupyter_token: "tok_abcdefghijkl", tls_fingerprint: "<script>" }] });
  assert.equal((await renter.call("GET", "/api/my/rentals")).body.rentals[0].machine.tls_fingerprint, null, "junk fingerprints are dropped");
  const h = (await host.call("GET", "/api/my/requests")).body.requests[0].machine;
  assert.equal(h.jupyter_url, undefined);
  assert.ok(!JSON.stringify(h).includes("tok_abcdefghijkl"));
});

test("without a signing key no machine grants are sent", async () => {
  const { host, renter, listing, hb } = await setup({ MARKET_SIGNING_KEY: undefined });
  await hb({ machines: OFFER });
  const { rental } = (await renter.call("POST", "/api/rentals", { listing_id: listing.id, gpu_count: 1, hours: 2, environment: "ubuntu", access: "ssh", ssh_key: KEY })).body;
  await host.call("POST", `/api/rentals/${rental.id}/accept`, {});
  assert.deepEqual((await hb({ machines: OFFER })).body.machines, []);
});

test("a junk offer is ignored", async () => {
  const { renter, listing, hb } = await setup();
  await hb({ machines: { runtime: "docker", ssh_host: "bad host;rm" } });
  assert.equal((await renter.call("GET", `/api/listings/${listing.id}`)).body.listing.machine_rentals, false);
});
