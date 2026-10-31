import { test } from "node:test";
import assert from "node:assert/strict";
import { cloudSweep } from "../src/cloud.js";
import { account, newEnv, age } from "./helpers.mjs";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq3m1v4cGkqzM8Yy0n1N2xQ5f3aT7f0bUQ8i3gWcB1K renter@laptop";

// A small fake of the RunPod v2 endpoints the reseller uses.
function fakeRunpod() {
  const state = {
    gpus: [
      { id: "NVIDIA GeForce RTX 4090", name: "RTX 4090", memory: 24, secure: true, community: true, price: { secure: 0.69, community: 0.34 }, maxCount: { secure: 8, community: 8 }, availability: "HIGH" },
      { id: "NVIDIA H100 80GB HBM3", name: "H100 SXM", memory: 80, secure: true, community: false, price: { secure: 2.99, community: 0 }, maxCount: { secure: 8, community: 0 }, availability: "LOW" },
      { id: "NVIDIA A40", name: "A40", memory: 48, secure: true, community: true, price: { secure: 0.4, community: 0.3 }, maxCount: { secure: 2, community: 2 }, availability: "NONE" },
    ],
    pods: new Map(),
    createStatus: 201,        // 400 = no capacity, 402 = our account is empty, 500 = reply lost
    createdButLost: false,    // with 500: the pod was created anyway
    deleteFails: false,
    n: 0,
  };
  const calls = [];
  const res = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const path = u.pathname.replace("/v2", "");
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path, body, auth: init.headers.authorization });
    if (path === "/catalog/gpus") return res(200, { gpus: state.gpus });
    if (path === "/pods" && init.method === "POST") {
      if (state.createStatus === 500 && state.createdButLost) {
        const id = `pod_${++state.n}`;
        state.pods.set(id, { id, name: body.name, status: "PROVISIONING", ssh: { proxy: null, direct: null } });
      }
      if (state.createStatus !== 201) return res(state.createStatus, { title: "Bad Request", status: state.createStatus, detail: "could not be placed" });
      const id = `pod_${++state.n}`;
      const pod = { id, name: body.name, status: "PROVISIONING", ssh: { proxy: null, direct: null }, env: body.env };
      state.pods.set(id, pod);
      return res(201, state.replyWithoutId ? { name: pod.name } : pod);
    }
    if (path === "/pods" && init.method === "GET") {
      // Pages of state.pageSize, continued with pagination.nextCursor.
      const all = [...state.pods.values()];
      const start = Number(u.searchParams.get("cursor") || 0);
      const size = state.pageSize || Number(u.searchParams.get("limit")) || 1000;
      const next = state.endlessPages ? String(start) : start + size < all.length ? String(start + size) : null;
      return res(200, { pods: all.slice(start, start + size), pagination: { nextCursor: next } });
    }
    const m = path.match(/^\/pods\/([^/]+)$/);
    if (m) {
      const pod = state.pods.get(decodeURIComponent(m[1]));
      if (init.method === "GET" && state.getStatus) return res(state.getStatus, { detail: "provider trouble" });
      if (init.method === "DELETE") {
        if (state.deleteFails) return res(503, { detail: "try later" });
        if (!pod) return res(404, { detail: "not found" });
        state.pods.delete(pod.id);
        return res(204);
      }
      return pod ? res(200, pod) : res(404, { detail: "not found" });
    }
    return res(400, { detail: "unexpected " + path });
  };
  const run = (id, port = 10341) => {
    const pod = state.pods.get(id);
    pod.status = "RUNNING";
    pod.ssh.direct = { host: "213.173.108.12", port, username: "root", command: `ssh root@213.173.108.12 -p ${port}` };
  };
  return { fetch, calls, state, run };
}

async function setup(extra = {}) {
  const rp = fakeRunpod();
  const env = newEnv({ RUNPOD_API_KEY: "rp_test", RUNPOD_FETCH: rp.fetch, ADMIN_EMAILS: "boss@example.com", ...extra });
  const user = await account(env, "Renter");
  return { env, rp, user };
}

const fund = (env, userId, usd) => env.DB.prepare(
  "INSERT INTO balances (user_id, micro, updated_at) VALUES (?1, ?2, 0) ON CONFLICT(user_id) DO UPDATE SET micro = ?2"
).bind(userId, Math.round(usd * 1_000_000)).run();
const balance = async (env, userId) => (await env.DB.prepare("SELECT micro FROM balances WHERE user_id = ?").bind(userId).first()).micro;
const row = (env, id) => env.DB.prepare("SELECT * FROM cloud_rentals WHERE id = ?").bind(id).first();
const rent = (user, extra = {}) => user.call("POST", "/api/cloud/rentals", { gpu_id: "NVIDIA GeForce RTX 4090", gpu_count: 1, hours: 2, ssh_key: KEY, ...extra });

test("off without a RunPod key", async () => {
  const env = newEnv();
  const u = await account(env, "Nobody");
  assert.deepEqual((await u.call("GET", "/api/cloud/gpus")).body, { enabled: false, gpus: [] });
  assert.equal((await rent(u)).status, 503);
});

test("the catalog shows in-stock Secure Cloud GPUs at cost x markup, never the cost", async () => {
  const { user } = await setup({ GPU_MARKUP: "1.25" });
  const r = await user.call("GET", "/api/cloud/gpus");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.gpus.map((g) => [g.name, g.price_per_gpu_hour_usd, g.max_count]), [["RTX 4090", "0.87", 8], ["H100 SXM", "3.74", 8]]);
  assert.ok(!JSON.stringify(r.body).includes("cost"), "provider cost stays private");
});

test("renting charges up front, starts a pod with the renter's key, and bills from the start", async () => {
  const { env, rp, user } = await setup();
  await fund(env, user.id, 10);
  const r = await rent(user, { hours: 3 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.rental.status, "provisioning");
  assert.equal(r.body.rental.total_usd, "2.610000"); // 0.87 x 1 x 3
  assert.equal(await balance(env, user.id), 10_000_000 - 2_610_000);
  const create = rp.calls.find((c) => c.method === "POST" && c.path === "/pods");
  assert.equal(create.auth, "Bearer rp_test");
  assert.equal(create.body.name, `tdcc-${r.body.rental.id}`);
  assert.equal(create.body.cloud, "SECURE");
  assert.deepEqual(create.body.gpu, { id: "NVIDIA GeForce RTX 4090", count: 1 });
  assert.deepEqual(create.body.ports, ["22/tcp"]);
  assert.equal(create.body.env.PUBLIC_KEY, KEY);
  const ledger = await env.DB.prepare("SELECT micro, kind FROM ledger WHERE ref = ?").bind(`cloud:${r.body.rental.id}`).first();
  assert.deepEqual({ ...ledger }, { micro: -2_610_000, kind: "cloud" });

  // The pod comes up: the page shows the SSH line and the clock starts.
  const pod = (await row(env, r.body.rental.id)).pod_id;
  rp.run(pod);
  await age(env, "cloud_rentals", "checked_at", 60);
  const mine = (await user.call("GET", "/api/cloud/rentals")).body.rentals[0];
  assert.equal(mine.status, "running");
  assert.equal(mine.ssh, "ssh root@213.173.108.12 -p 10341");
  const db = await row(env, mine.id);
  assert.equal(db.expires_at - db.started_at, 3 * 3600);

  // Hours up: the minute cron terminates the pod.
  await age(env, "cloud_rentals", "expires_at", 3 * 3600 + 1);
  await cloudSweep(env, false);
  assert.equal((await row(env, mine.id)).status, "ended");
  assert.equal(rp.state.pods.size, 0);
  assert.equal(await balance(env, user.id), 10_000_000 - 2_610_000, "no refund for hours used");
});

test("a balance that does not cover the rental gets 402 and no pod", async () => {
  const { env, rp, user } = await setup();
  await fund(env, user.id, 1);
  const r = await rent(user, { hours: 2 }); // 1.74
  assert.equal(r.status, 402);
  assert.ok(!rp.calls.some((c) => c.method === "POST" && c.path === "/pods"));
  assert.equal(await balance(env, user.id), 1_000_000);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_rentals").first()).n, 0);
});

test("the same money cannot pay for two rentals, nor a rental and running API requests", async () => {
  const { env, user } = await setup();
  await fund(env, user.id, 3);
  assert.equal((await rent(user, { hours: 2 })).status, 201); // 1.74 of 3.00
  assert.equal((await rent(user, { hours: 2 })).status, 402); // 1.26 left
  // An API request in flight reserves part of the rest.
  await env.DB.prepare("INSERT INTO holds (id, user_id, micro, created_at, expires_at) VALUES ('hold_x', ?, 500000, 0, 9999999999)").bind(user.id).run();
  assert.equal((await rent(user, { hours: 1 })).status, 402); // 0.87 > 1.26 - 0.50
  await env.DB.prepare("DELETE FROM holds").run();
  assert.equal((await rent(user, { hours: 1 })).status, 201);
});

test("no capacity refunds in full", async () => {
  const { env, rp, user } = await setup();
  await fund(env, user.id, 10);
  rp.state.createStatus = 400;
  const r = await rent(user);
  assert.equal(r.status, 409);
  assert.equal(await balance(env, user.id), 10_000_000);
  const db = await env.DB.prepare("SELECT status, refunded_micro, total_micro FROM cloud_rentals").first();
  assert.equal(db.status, "failed");
  assert.equal(db.refunded_micro, db.total_micro);
});

test("an empty provider account refunds the renter and alerts the admins", async () => {
  const { env, rp, user } = await setup({ RESEND_API_KEY: "x", EMAIL_OUTBOX: [] });
  await env.DB.prepare("UPDATE users SET email_verified_at = 1").run();
  await fund(env, user.id, 10);
  rp.state.createStatus = 402;
  assert.equal((await rent(user)).status, 409);
  assert.equal(await balance(env, user.id), 10_000_000);
  assert.ok(env.EMAIL_OUTBOX.some((m) => m.to === "boss@example.com" && /RunPod/.test(m.subject)));
});

test("ending early stops the pod and refunds the hours not begun", async () => {
  const { env, rp, user } = await setup();
  await fund(env, user.id, 10);
  const id = (await rent(user, { hours: 4 })).body.rental.id;
  rp.run((await row(env, id)).pod_id);
  await cloudSweep(env, false);
  assert.equal((await row(env, id)).status, "running");
  await age(env, "cloud_rentals", "started_at", 90 * 60); // 1.5 h in -> 2 h used
  rp.state.deleteFails = true;
  assert.equal((await user.call("POST", `/api/cloud/rentals/${id}/end`, {})).status, 502, "still running if the pod cannot be stopped");
  assert.equal((await row(env, id)).status, "running");
  rp.state.deleteFails = false;
  const r = await user.call("POST", `/api/cloud/rentals/${id}/end`, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.rental.status, "ended");
  assert.equal(r.body.rental.refunded_usd, "1.740000"); // 2 h x 0.87
  assert.equal(await balance(env, user.id), 10_000_000 - 3_480_000 + 1_740_000);
  assert.equal(rp.state.pods.size, 0);
  assert.equal((await user.call("POST", `/api/cloud/rentals/${id}/end`, {})).status, 409);
});

test("a machine that never becomes reachable is stopped and refunded", async () => {
  const { env, rp, user } = await setup();
  await fund(env, user.id, 10);
  const id = (await rent(user)).body.rental.id;
  await cloudSweep(env, false);
  assert.equal((await row(env, id)).status, "provisioning");
  await age(env, "cloud_rentals", "created_at", 21 * 60);
  await cloudSweep(env, false);
  const db = await row(env, id);
  assert.equal(db.status, "failed");
  assert.equal(await balance(env, user.id), 10_000_000);
  assert.equal(rp.state.pods.size, 0);
});

test("a lost create reply: the pod is adopted if it exists, refunded if not", async () => {
  const { env, rp, user } = await setup();
  await fund(env, user.id, 10);
  rp.state.createStatus = 500;
  rp.state.createdButLost = true;
  const a = await rent(user);
  assert.equal(a.status, 202);
  assert.equal(a.body.rental.status, "creating");
  rp.state.createdButLost = false;
  const b = await rent(user);
  assert.equal(b.status, 202);
  await age(env, "cloud_rentals", "created_at", 6 * 60);
  await cloudSweep(env, false);
  const adopted = await row(env, a.body.rental.id);
  assert.equal(adopted.status, "provisioning");
  assert.ok(adopted.pod_id);
  assert.equal((await row(env, b.body.rental.id)).status, "failed");
  assert.equal(await balance(env, user.id), 10_000_000 - 1_740_000, "only the adopted one is paid");
});

test("pods on the account without a live rental are terminated", async () => {
  const { env, rp, user } = await setup();
  await fund(env, user.id, 10);
  const id = (await rent(user)).body.rental.id;
  rp.state.pods.set("pod_stray", { id: "pod_stray", name: "tdcc-cgr_doesnotexist", status: "RUNNING", ssh: {} });
  rp.state.pods.set("pod_other", { id: "pod_other", name: "my-own-dev-box", status: "RUNNING", ssh: {} });
  await cloudSweep(env, true);
  assert.ok(!rp.state.pods.has("pod_stray"));
  assert.ok(rp.state.pods.has("pod_other"), "pods not made by the marketplace are left alone");
  assert.ok(rp.state.pods.has((await row(env, id)).pod_id), "live rentals keep their pod");
});

test("a pod lost by the provider ends the rental and refunds the hours not begun", async () => {
  const { env, rp, user } = await setup();
  await fund(env, user.id, 10);
  const id = (await rent(user, { hours: 3 })).body.rental.id;
  const pod = (await row(env, id)).pod_id;
  rp.run(pod);
  await cloudSweep(env, false);
  rp.state.pods.get(pod).status = "EXITED";
  await age(env, "cloud_rentals", "checked_at", 300);
  await cloudSweep(env, false);
  const db = await row(env, id);
  assert.equal(db.status, "ended");
  assert.equal(db.refunded_micro, 2 * 870_000);
});

test("price changes and limits are enforced, and the account cannot be deleted while a machine runs", async () => {
  const { env, user } = await setup();
  await fund(env, user.id, 100);
  assert.equal((await rent(user, { quoted_price_micro: 500_000 })).status, 409, "quoted below the current price");
  assert.equal((await rent(user, { gpu_count: 9 })).status, 400);
  assert.equal((await rent(user, { hours: 169 })).status, 400);
  assert.equal((await rent(user, { gpu_id: "NVIDIA A40" })).status, 409, "out of stock");
  assert.equal((await rent(user, { ssh_key: "" })).status, 400);
  for (let i = 0; i < 3; i++) assert.equal((await rent(user, { hours: 1 })).status, 201);
  assert.equal((await rent(user, { hours: 1 })).status, 409, "at most three at a time");
  assert.equal((await user.call("DELETE", "/api/me", { password: "a long enough password" })).status, 409);
});

// ---------- found in review ----------

test("a refund that fails to write leaves the machine open, so ending can be retried", async () => {
  const { env, rp, user } = await setup();
  await fund(env, user.id, 10);
  const id = (await rent(user, { hours: 4 })).body.rental.id;
  rp.run((await row(env, id)).pod_id);
  await cloudSweep(env, false);
  const realBatch = env.DB.batch;
  env.DB.batch = async (stmts) => { if (stmts.length === 4) throw new Error("D1 overloaded"); return realBatch(stmts); };
  assert.equal((await user.call("POST", `/api/cloud/rentals/${id}/end`, {})).status, 500);
  let db = await row(env, id);
  assert.deepEqual([db.status, db.refunded_micro], ["running", 0], "nothing half-done");
  env.DB.batch = realBatch;
  assert.equal((await user.call("POST", `/api/cloud/rentals/${id}/end`, {})).status, 200);
  db = await row(env, id);
  assert.deepEqual([db.status, db.refunded_micro], ["ended", 3 * 870_000]);
  // A second close (say the sweep seeing the pod gone) refunds nothing more.
  await env.DB.prepare("UPDATE cloud_rentals SET status = 'running' WHERE id = ?").bind(id).run();
  await cloudSweep(env, false);
  assert.equal((await row(env, id)).refunded_micro, 3 * 870_000);
  const n = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(micro) AS s FROM ledger WHERE ref = ?").bind(`cloudrefund:${id}`).first();
  assert.deepEqual([n.n, n.s], [1, 3 * 870_000]);
  assert.equal(await balance(env, user.id), 10_000_000 - 4 * 870_000 + 3 * 870_000);
});

test("lost creates are found on later pages, and an unfinished pod list never refunds", async () => {
  const { env, rp, user } = await setup();
  await fund(env, user.id, 10);
  for (let i = 0; i < 3; i++) rp.state.pods.set(`pod_x${i}`, { id: `pod_x${i}`, name: `someone-else-${i}`, status: "RUNNING", ssh: {} });
  rp.state.pageSize = 2;
  rp.state.createStatus = 500;
  rp.state.createdButLost = true;
  const a = (await rent(user)).body.rental.id;
  await age(env, "cloud_rentals", "created_at", 6 * 60);
  await cloudSweep(env, false);
  assert.equal((await row(env, a)).status, "provisioning", "pod on page 2 adopted");

  rp.state.createdButLost = false;
  const b = (await rent(user)).body.rental.id;
  await age(env, "cloud_rentals", "created_at", 6 * 60, `id = '${b}'`);
  rp.state.endlessPages = true;
  await assert.rejects(cloudSweep(env, false), /incomplete/);
  assert.equal((await row(env, b)).status, "creating", "not refunded while the list is unfinished");
  rp.state.endlessPages = false;
  await cloudSweep(env, false);
  assert.equal((await row(env, b)).status, "failed");
});

test("expired machines are stopped even when the provider cannot report their status", async () => {
  const { env, rp, user } = await setup();
  await fund(env, user.id, 10);
  const id = (await rent(user)).body.rental.id;
  rp.run((await row(env, id)).pod_id);
  await cloudSweep(env, false);
  await age(env, "cloud_rentals", "expires_at", 3 * 3600);
  rp.state.getStatus = 500;
  await cloudSweep(env, false);
  assert.equal((await row(env, id)).status, "ended");
  assert.equal(rp.state.pods.size, 0);
});

test("suspending an account stops its machines without a refund", async () => {
  const { env, rp, user } = await setup();
  await fund(env, user.id, 10);
  const id = (await rent(user)).body.rental.id;
  rp.run((await row(env, id)).pod_id);
  await cloudSweep(env, false);
  const admin = await account(env, "Boss");
  await env.DB.prepare("UPDATE users SET email = 'boss@example.com', email_verified_at = 1 WHERE id = ?").bind(admin.id).run();
  assert.equal((await admin.call("POST", `/api/admin/users/${user.id}/suspend`, {})).status, 200);
  const db = await row(env, id);
  assert.equal(db.status, "ended");
  assert.equal(db.refunded_micro, 0);
  assert.equal(rp.state.pods.size, 0);
});

test("provider refusals reach the logs and the admins, at most once an hour", async () => {
  const { env, rp, user } = await setup({ RESEND_API_KEY: "x", EMAIL_OUTBOX: [] });
  await env.DB.prepare("UPDATE users SET email_verified_at = 1").run();
  await fund(env, user.id, 10);
  const id = (await rent(user)).body.rental.id;
  rp.state.getStatus = 401;
  await assert.rejects(cloudSweep(env, false), /401/);
  await age(env, "cloud_rentals", "checked_at", 600);
  await assert.rejects(cloudSweep(env, false), /401/);
  assert.equal(env.EMAIL_OUTBOX.filter((m) => /refusing/.test(m.subject)).length, 1);
  assert.equal((await row(env, id)).status, "provisioning");
});

test("a create reply without a pod id is tracked down by name", async () => {
  const { env, rp, user } = await setup();
  await fund(env, user.id, 10);
  rp.state.replyWithoutId = true;
  const r = await rent(user);
  assert.equal(r.status, 201);
  assert.equal(r.body.rental.status, "creating");
  await age(env, "cloud_rentals", "created_at", 6 * 60);
  await cloudSweep(env, false);
  const db = await row(env, r.body.rental.id);
  assert.equal(db.status, "provisioning");
  assert.ok(db.pod_id);
});

test("page loads are rate limited and ask the provider once per rental", async () => {
  const { env, rp, user } = await setup();
  await fund(env, user.id, 10);
  await rent(user);
  await age(env, "cloud_rentals", "checked_at", 60);
  const before = rp.calls.filter((c) => c.method === "GET" && c.path.startsWith("/pods/")).length;
  await Promise.all(Array.from({ length: 5 }, () => user.call("GET", "/api/cloud/rentals")));
  assert.equal(rp.calls.filter((c) => c.method === "GET" && c.path.startsWith("/pods/")).length - before, 1);
  let last;
  for (let i = 0; i < 30; i++) last = await user.call("GET", "/api/cloud/rentals");
  assert.equal(last.status, 429);
});
