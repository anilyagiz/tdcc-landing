import { test } from "node:test";
import assert from "node:assert/strict";
import { account, newEnv, beat, age, LISTING, RENT } from "./helpers.mjs";
import { housekeeping } from "../src/api.js";

async function rented(env) {
  const host = await account(env, "Host");
  const renter = await account(env, "Renter");
  const { listing } = (await host.call("POST", "/api/listings", LISTING)).body;
  const { rental } = (await renter.call("POST", "/api/rentals", { ...RENT, listing_id: listing.id })).body;
  return { host, renter, listing, rental };
}

test("host and renter can message each other, strangers cannot", async () => {
  const env = newEnv();
  const { host, renter, rental } = await rented(env);
  const stranger = await account(env, "Stranger");
  assert.equal((await renter.call("POST", `/api/rentals/${rental.id}/messages`, { body: "Can we start at 9?" })).status, 201);
  assert.equal((await host.call("POST", `/api/rentals/${rental.id}/messages`, { body: "Sure." })).status, 201);
  assert.equal((await stranger.call("GET", `/api/rentals/${rental.id}/messages`)).status, 404);
  assert.equal((await stranger.call("POST", `/api/rentals/${rental.id}/messages`, { body: "hi" })).status, 404);
  assert.equal((await host.call("POST", `/api/rentals/${rental.id}/messages`, { body: "" })).status, 400);
  const { messages } = (await host.call("GET", `/api/rentals/${rental.id}/messages`)).body;
  assert.deepEqual(messages.map((m) => [m.body, m.mine]), [["Can we start at 9?", false], ["Sure.", true]]);
  const mine = (await renter.call("GET", "/api/my/rentals")).body.rentals[0];
  assert.equal(mine.message_count, 2);
});

test("messages notify the other side by email at most every 15 minutes", async () => {
  const env = newEnv({ EMAIL_OUTBOX: [] });
  const host = await account(env, "Host");
  const renter = await account(env, "Renter");
  await env.DB.prepare("UPDATE users SET email_verified_at = 1").run();
  const { listing } = (await host.call("POST", "/api/listings", LISTING)).body;
  const { rental } = (await renter.call("POST", "/api/rentals", { ...RENT, listing_id: listing.id })).body;
  env.EMAIL_OUTBOX.length = 0;
  await renter.call("POST", `/api/rentals/${rental.id}/messages`, { body: "one" });
  await renter.call("POST", `/api/rentals/${rental.id}/messages`, { body: "two" });
  assert.equal(env.EMAIL_OUTBOX.length, 1);
  assert.equal(env.EMAIL_OUTBOX[0].to, host.email);
  assert.match(env.EMAIL_OUTBOX[0].text, /one/);
});

test("reviews after a finished rental show on the listing", async () => {
  const env = newEnv();
  const { host, renter, listing, rental } = await rented(env);
  assert.equal((await renter.call("POST", `/api/rentals/${rental.id}/review`, { rating: 5 })).status, 409, "not before it is finished");
  await host.call("POST", `/api/rentals/${rental.id}/accept`, {});
  await renter.call("POST", `/api/rentals/${rental.id}/complete`, {});
  assert.equal((await renter.call("POST", `/api/rentals/${rental.id}/review`, { rating: 6 })).status, 400);
  assert.equal((await renter.call("POST", `/api/rentals/${rental.id}/review`, { rating: 4, comment: "Fast and stable" })).status, 201);
  assert.equal((await renter.call("POST", `/api/rentals/${rental.id}/review`, { rating: 1 })).status, 409, "once per side");
  assert.equal((await host.call("POST", `/api/rentals/${rental.id}/review`, { rating: 5, comment: "Polite renter" })).status, 201);
  const pub = (await renter.call("GET", `/api/listings/${listing.id}`)).body.listing;
  assert.equal(pub.host_rating, 4);
  assert.equal(pub.host_reviews, 1);
  const { reviews } = (await renter.call("GET", `/api/listings/${listing.id}/reviews`)).body;
  assert.equal(reviews[0].comment, "Fast and stable");
  const req = (await host.call("GET", "/api/my/requests")).body.requests[0];
  assert.equal(req.renter_rating, 5);
  assert.equal(req.reviewed, true);
});

test("disputes reach the admins and can be settled", async () => {
  const env = newEnv({ ADMIN_EMAILS: "boss1@example.com" });
  const { host, renter, rental } = await rented(env);
  assert.equal((await renter.call("POST", `/api/rentals/${rental.id}/dispute`, { reason: "The host never gave me access." })).status, 409, "not for a request");
  await host.call("POST", `/api/rentals/${rental.id}/accept`, {});
  assert.equal((await renter.call("POST", `/api/rentals/${rental.id}/dispute`, { reason: "short" })).status, 400);
  assert.equal((await renter.call("POST", `/api/rentals/${rental.id}/dispute`, { reason: "The host never gave me access." })).status, 201);
  assert.equal((await renter.call("POST", `/api/rentals/${rental.id}/dispute`, { reason: "The host never gave me access." })).status, 409);
  assert.equal((await renter.call("GET", "/api/my/rentals")).body.rentals[0].dispute_open, true);
  const admin = await account(env, "Boss");
  await env.DB.prepare("UPDATE users SET email = 'boss1@example.com', email_verified_at = 1 WHERE id = ?").bind(admin.id).run();
  const overview = (await admin.call("GET", "/api/admin")).body;
  assert.equal(overview.disputes.length, 1);
  const id = overview.disputes[0].id;
  assert.equal((await admin.call("POST", `/api/admin/disputes/${id}`, { action: "refund", amount_cents: 10 })).status, 409, "no card payment to refund");
  assert.equal((await admin.call("POST", `/api/admin/disputes/${id}`, { action: "dismiss", note: "Sorted out by email" })).status, 200);
  assert.equal((await admin.call("GET", "/api/admin")).body.disputes.length, 0);
});

test("scheduled starts: capacity counts only overlapping rentals", async () => {
  const env = newEnv();
  const host = await account(env, "Host");
  const a = await account(env, "Ann");
  const b = await account(env, "Ben");
  const { listing } = (await host.call("POST", "/api/listings", { ...LISTING, gpu_count: 1 })).body;
  const t = Math.floor(Date.now() / 1000);
  assert.equal((await a.call("POST", "/api/rentals", { ...RENT, listing_id: listing.id, start_at: t + 90 * 86400 })).status, 400, "too far ahead");
  const later = (await a.call("POST", "/api/rentals", { ...RENT, listing_id: listing.id, start_at: t + 86400 })).body.rental;
  assert.equal(later.start_at, t + 86400);
  let r = await host.call("POST", `/api/rentals/${later.id}/accept`, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.rental.access_starts_at, t + 86400);
  assert.equal(r.body.rental.access_expires_at, t + 86400 + 7200);
  // The GPU is free now, so a rental right away fits...
  let pub = (await b.call("GET", `/api/listings/${listing.id}`)).body.listing;
  assert.equal(pub.available, 1);
  const now1 = (await b.call("POST", "/api/rentals", { ...RENT, listing_id: listing.id })).body.rental;
  assert.equal((await host.call("POST", `/api/rentals/${now1.id}/accept`, {})).status, 200);
  // ...but not one that overlaps tomorrow's booking.
  r = await b.call("POST", "/api/rentals", { ...RENT, listing_id: listing.id, start_at: t + 86400 + 3600 });
  assert.equal(r.status, 409);
});

test("finished rentals complete and unanswered requests expire by themselves", async () => {
  const env = newEnv();
  const { host, renter, listing, rental } = await rented(env);
  await host.call("POST", `/api/rentals/${rental.id}/accept`, {});
  const other = (await renter.call("POST", "/api/rentals", { ...RENT, listing_id: listing.id })).body.rental;
  await age(env, "rentals", "access_expires_at", 3 * 3600, `id = '${rental.id}'`);
  await age(env, "rentals", "created_at", 7 * 86400, `id = '${other.id}'`);
  await housekeeping(env);
  const rows = (await renter.call("GET", "/api/my/rentals")).body.rentals;
  assert.equal(rows.find((x) => x.id === rental.id).status, "completed");
  assert.equal(rows.find((x) => x.id === other.id).status, "expired");
});

test("uptime and hardware checks come from the linked machine", async () => {
  const env = newEnv();
  const host = await account(env, "Host");
  const { listing } = (await host.call("POST", "/api/listings", LISTING)).body;
  const { token } = (await host.call("POST", `/api/listings/${listing.id}/node-token`, {})).body;
  await beat(env, token, { gpus: [{ name: "NVIDIA GeForce RTX 4090", vram_gb: 24 }] });
  let pub = (await host.call("GET", `/api/listings/${listing.id}`)).body.listing;
  assert.equal(pub.hardware_verified, false, "two GPUs listed, one reported");
  assert.equal(pub.uptime_7d, null, "no history yet");
  await beat(env, token, { gpus: [{ name: "NVIDIA GeForce RTX 4090", vram_gb: 24 }, { name: "NVIDIA GeForce RTX 4090", vram_gb: 24 }] });
  pub = (await host.call("GET", `/api/listings/${listing.id}`)).body.listing;
  assert.equal(pub.hardware_verified, true);
  // Two days of history with check-ins during half of it.
  await env.DB.prepare("UPDATE listings SET node_first_seen_at = node_first_seen_at - 2 * 86400").run();
  await env.DB.prepare("DELETE FROM node_uptime").run();
  const hour = Math.floor(Date.now() / 3600_000);
  for (let h = 0; h < 24; h++) await env.DB.prepare("INSERT INTO node_uptime (listing_id, hour, beats) VALUES (?, ?, 60)").bind(listing.id, hour - h).run();
  pub = (await host.call("GET", `/api/listings/${listing.id}`)).body.listing;
  assert.ok(pub.uptime_7d >= 49 && pub.uptime_7d <= 51, String(pub.uptime_7d));
  // Claiming a different GPU than the machine has is not verified.
  await host.call("PATCH", `/api/listings/${listing.id}`, { gpu_model: "H100" });
  assert.equal((await host.call("GET", `/api/listings/${listing.id}`)).body.listing.hardware_verified, false);
});

test("search filters and pages run on the server", async () => {
  const env = newEnv();
  const host = await account(env, "Host");
  for (let i = 0; i < 7; i++) {
    await host.call("POST", "/api/listings", { ...LISTING, gpu_model: i % 2 ? "RTX 3090" : "A100 80GB", vram_gb: i % 2 ? 24 : 80, price: 1 + i, region: i < 3 ? "us-east" : "eu-west" });
  }
  let r = (await host.call("GET", "/api/listings?limit=3")).body;
  assert.equal(r.total, 7);
  assert.equal(r.listings.length, 3);
  assert.equal(r.next_offset, 3);
  assert.deepEqual(r.active_regions, ["eu-west", "us-east"]);
  r = (await host.call("GET", "/api/listings?limit=3&offset=6")).body;
  assert.equal(r.listings.length, 1);
  assert.equal(r.next_offset, null);
  r = (await host.call("GET", "/api/listings?min_vram=48")).body;
  assert.equal(r.total, 4);
  r = (await host.call("GET", "/api/listings?q=3090&region=eu-west")).body;
  assert.equal(r.total, 2);
  r = (await host.call("GET", "/api/listings?q=%25")).body;
  assert.equal(r.total, 0, "LIKE wildcards are matched literally");
  r = (await host.call("GET", "/api/listings?sort=vram&limit=1")).body;
  assert.equal(r.listings[0].vram_gb, 80);
  r = (await host.call("GET", "/api/listings?online=1")).body;
  assert.equal(r.total, 0);
});
