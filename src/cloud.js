// Instant cloud GPUs: pods bought from RunPod (API v2) on demand and resold by
// the hour, paid up front from the prepaid balance (src/billing.js).
// Off until RUNPOD_API_KEY is set. See migrations/0011_cloud_gpus.sql.
//
// Money rules:
// - The full price is taken from the balance before the provider is called,
//   in one D1 batch that also checks the balance (minus running API holds),
//   so two rentals cannot spend the same money.
// - No capacity, a provider error, or a pod that is not reachable within
//   PROVISION_TIMEOUT: refunded in full. The renter's clock starts only once
//   the pod runs, and `expires_at` = start + rented hours.
// - The renter ends early: refund of the hours not yet begun. The provider
//   loses a running pod: refund of the hours not yet begun as well.
// - Every pod is named "tdcc-<rental id>". The sweep (cron, every minute)
//   terminates pods without a live rental and adopts pods whose create reply
//   was lost, so nothing keeps running on our account unpaid.

import { HttpError, json, readJson, requireUser, requireVerified, limit, newId, now, int, sshKey } from "./api.js";
import { microToUsd } from "./billing.js";
import { emailEnabled, sendEmail } from "./email.js";

const API = "https://api.runpod.io/v2";
const MICRO = 1_000_000;
const POD_PREFIX = "tdcc-";
const MAX_HOURS = 168;
const MAX_GPUS = 8;
const MAX_ACTIVE = 3;
const PROVISION_TIMEOUT = 20 * 60;   // creating/provisioning -> failed + refund
const LOST_CREATE_GRACE = 5 * 60;     // create reply lost: wait this long for the pod to show up
const CATALOG_TTL = 60 * 1000;
const DEFAULT_IMAGE = "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404";
const ACTIVE = ["creating", "provisioning", "running"];

export const cloudEnabled = (env) => !!env.RUNPOD_API_KEY;

function cfg(env) {
  const markup = Number(env.GPU_MARKUP);
  return {
    markup: Number.isFinite(markup) && markup >= 1 ? markup : 1.25,
    image: (env.RUNPOD_IMAGE || DEFAULT_IMAGE).trim(),
    disk: Number.isInteger(Number(env.RUNPOD_DISK_GB)) && Number(env.RUNPOD_DISK_GB) > 0 ? Number(env.RUNPOD_DISK_GB) : 50,
  };
}

class ProviderError extends Error {
  constructor(status, detail) { super(`runpod ${status}: ${detail}`); this.status = status; this.detail = detail; }
}

// status 0 = no answer (network error or timeout): the outcome is unknown.
async function runpod(env, method, path, body) {
  const doFetch = env.RUNPOD_FETCH || fetch;
  let res;
  try {
    // RUNPOD_API_BASE points at a stand-in for local end-to-end runs.
    res = await doFetch((env.RUNPOD_API_BASE || API).replace(/\/+$/, "") + path, {
      method,
      headers: { authorization: `Bearer ${env.RUNPOD_API_KEY}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new ProviderError(0, (err && err.message) || "unreachable");
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ProviderError(res.status, String(data.detail || data.title || data.message || "").slice(0, 300));
  return data;
}

// ---------- catalog ----------

let catalog = { at: 0, gpus: null };

// GPUs in stock on Secure Cloud, at our price. Cached per isolate for a minute.
async function gpus(env, fresh = false) {
  if (!fresh && catalog.gpus && Date.now() - catalog.at < CATALOG_TTL) return catalog.gpus;
  const c = cfg(env);
  const data = await runpod(env, "GET", "/catalog/gpus?include=AVAILABILITY&product=POD&cloud=SECURE&count=1");
  const list = (data && Array.isArray(data.gpus) ? data.gpus : [])
    .filter((g) => g && g.secure && g.price && Number(g.price.secure) > 0 && g.availability && g.availability !== "NONE")
    .map((g) => {
      const cost = Math.ceil(Number(g.price.secure) * MICRO);
      return {
        id: String(g.id),
        name: String(g.name || g.id),
        vram_gb: Number(g.memory) || 0,
        availability: g.availability,
        max_count: Math.max(1, Math.min(MAX_GPUS, Number(g.maxCount && g.maxCount.secure) || 1)),
        cost_micro: cost,
        // Rounded up to whole cents per GPU-hour.
        price_micro: Math.ceil(Math.round(cost * c.markup) / 10_000) * 10_000,
      };
    })
    .sort((a, b) => a.price_micro - b.price_micro);
  catalog = { at: Date.now(), gpus: list };
  return list;
}

const gpuOut = (g) => ({
  id: g.id, name: g.name, vram_gb: g.vram_gb, availability: g.availability, max_count: g.max_count,
  price_micro: g.price_micro, price_per_gpu_hour_usd: (g.price_micro / MICRO).toFixed(2),
});

async function listGpus(env) {
  if (!cloudEnabled(env)) return json(200, { enabled: false, gpus: [] });
  try {
    return json(200, { enabled: true, max_hours: MAX_HOURS, gpus: (await gpus(env)).map(gpuOut) }, { "cache-control": "public, max-age=30" });
  } catch (err) {
    console.error("cloud catalog failed", err.message);
    return json(200, { enabled: true, max_hours: MAX_HOURS, gpus: [], unavailable: true });
  }
}

// ---------- money ----------

// Takes the full price from the balance and records the rental, atomically.
// Returns false when the balance (minus running API holds) does not cover it.
async function chargeAndInsert(env, r) {
  const ref = `cloud:${r.id}`;
  const t = r.created_at;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO cloud_rentals (id, user_id, gpu_id, gpu_name, vram_gb, gpu_count, hours, price_micro, cost_micro, total_micro, image, ssh_key, status, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'creating', ?13
       WHERE COALESCE((SELECT micro FROM balances WHERE user_id = ?2), 0)
           - COALESCE((SELECT SUM(micro) FROM holds WHERE user_id = ?2 AND expires_at > ?13), 0) >= ?10`
    ).bind(r.id, r.user_id, r.gpu_id, r.gpu_name, r.vram_gb, r.gpu_count, r.hours, r.price_micro, r.cost_micro, r.total_micro, r.image, r.ssh_key, t),
    env.DB.prepare(
      `INSERT INTO ledger (user_id, micro, kind, ref, detail, created_at)
       SELECT ?1, ?2, 'cloud', ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM cloud_rentals WHERE id = ?6)`
    ).bind(r.user_id, -r.total_micro, ref, `${r.gpu_count} x ${r.gpu_name} ${r.hours} h`, t, r.id),
    env.DB.prepare(
      "UPDATE balances SET micro = micro - ?1, updated_at = ?2 WHERE user_id = ?3 AND EXISTS (SELECT 1 FROM ledger WHERE ref = ?4)"
    ).bind(r.total_micro, t, r.user_id, ref),
  ]);
  return !!(await env.DB.prepare("SELECT 1 FROM cloud_rentals WHERE id = ?").bind(r.id).first());
}

// Moves a rental from one of `from` to its final status `to` and gives back
// `micro`, all in one D1 batch: a crash can never leave a closed rental
// without its refund. The refund rows only apply when this very batch closed
// the rental (status + ended_at marker) and nothing was refunded before, so a
// second, concurrent close changes nothing. Returns whether it closed it.
async function close(env, r, from, to, { error = null, micro = 0, reason = "" } = {}) {
  micro = Math.max(0, Math.min(micro, r.total_micro - (r.refunded_micro || 0)));
  const t = now();
  const ref = `cloudrefund:${r.id}`;
  const mine = "EXISTS (SELECT 1 FROM cloud_rentals WHERE id = ?1 AND status = ?2 AND ended_at = ?3 AND refunded_micro = 0)";
  const stmts = [
    env.DB.prepare(
      `UPDATE cloud_rentals SET status = ?, ended_at = ?, error = COALESCE(?, error), expires_at = COALESCE(expires_at, ?)
       WHERE id = ? AND status IN (${from.map(() => "?").join(", ")})`
    ).bind(to, t, error, t, r.id, ...from),
  ];
  if (micro > 0) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO ledger (user_id, micro, kind, ref, detail, created_at)
         SELECT ?4, ?5, 'cloud_refund', ?6, ?7, ?3 WHERE ${mine} AND NOT EXISTS (SELECT 1 FROM ledger WHERE ref = ?6)`
      ).bind(r.id, to, t, r.user_id, micro, ref, reason.slice(0, 200)),
      env.DB.prepare(
        `INSERT INTO balances (user_id, micro, updated_at)
         SELECT ?4, ?5, ?3 WHERE ${mine} AND EXISTS (SELECT 1 FROM ledger WHERE ref = ?6 AND created_at = ?3)
         ON CONFLICT(user_id) DO UPDATE SET micro = micro + ?5, updated_at = ?3`
      ).bind(r.id, to, t, r.user_id, micro, ref),
      env.DB.prepare(
        `UPDATE cloud_rentals SET refunded_micro = ?4
         WHERE ${mine} AND EXISTS (SELECT 1 FROM ledger WHERE ref = ?5 AND created_at = ?3)`
      ).bind(r.id, to, t, micro, ref),
    );
  }
  const [res] = await env.DB.batch(stmts);
  return res.meta.changes > 0;
}

// Hours not yet begun, at the price paid.
function unusedMicro(r, t) {
  if (!r.started_at) return r.total_micro;
  // The hour under way counts as begun, including its first second.
  const used = Math.min(r.hours, Math.floor(Math.max(0, t - r.started_at) / 3600) + 1);
  return Math.max(0, r.hours - used) * r.gpu_count * r.price_micro;
}

const fail = (env, r, reason) =>
  close(env, r, ["creating", "provisioning"], "failed", { error: reason.slice(0, 300), micro: r.total_micro, reason: `Refund: ${reason}` });

async function terminate(env, podId) {
  try {
    await runpod(env, "DELETE", `/pods/${encodeURIComponent(podId)}`);
  } catch (err) {
    if (err.status !== 404) throw err;
  }
}

// `kind` limits repeats to one email an hour (cron problems recur every minute).
async function alertAdmins(env, subject, text, kind = null) {
  console.error(subject, text);
  if (!emailEnabled(env) || !env.ADMIN_EMAILS) return;
  if (kind) {
    try { await limit(env, "cloudalert:" + kind, 1, 3600); } catch { return; }
  }
  await Promise.all(env.ADMIN_EMAILS.split(",").map((x) => x.trim()).filter(Boolean)
    .map((to) => sendEmail(env, { to, subject, text }).catch(() => {})));
}

// ---------- renting ----------

const rentalOut = (r, t = now()) => ({
  id: r.id,
  gpu_name: r.gpu_name,
  vram_gb: r.vram_gb,
  gpu_count: r.gpu_count,
  hours: r.hours,
  price_per_gpu_hour_usd: (r.price_micro / MICRO).toFixed(2),
  total_usd: microToUsd(r.total_micro),
  refunded_usd: microToUsd(r.refunded_micro || 0),
  status: r.status,
  ssh: r.status === "running" && r.ssh_host && r.ssh_port ? `ssh root@${r.ssh_host} -p ${r.ssh_port}` : null,
  image: r.image,
  error: r.error || null,
  created_at: r.created_at,
  started_at: r.started_at || null,
  expires_at: r.expires_at || null,
  ended_at: r.ended_at || null,
  seconds_left: r.status === "running" && r.expires_at ? Math.max(0, r.expires_at - t) : null,
});

async function createRental(request, env, ctx) {
  const user = await requireUser(request, env);
  requireVerified(env, user);
  if (!cloudEnabled(env)) throw new HttpError(503, "Instant cloud GPUs are not available on this deployment yet.");
  const body = await readJson(request);
  const list = await gpus(env, true).catch(() => { throw new HttpError(503, "The GPU provider cannot be reached right now. Nothing was charged; please try again in a minute."); });
  const g = list.find((x) => x.id === body.gpu_id);
  if (!g) throw new HttpError(409, "That GPU is not available right now. Pick another one.", { field: "gpu_id" });
  const count = int(body.gpu_count, "Number of GPUs", 1, g.max_count);
  const hours = int(body.hours, "Hours", 1, MAX_HOURS);
  const key = sshKey(body.ssh_key);
  if (!key) throw new HttpError(400, "Paste your SSH public key; it is how you log in to the machine.", { field: "ssh_key" });
  // The page shows a price; never charge more than the renter saw.
  if (body.quoted_price_micro !== undefined && Number(body.quoted_price_micro) < g.price_micro) {
    throw new HttpError(409, `The price of this GPU changed to $${(g.price_micro / MICRO).toFixed(2)} per GPU-hour. Check it and send the request again.`, { field: "gpu_id" });
  }
  const open = await env.DB.prepare(`SELECT COUNT(*) AS n FROM cloud_rentals WHERE user_id = ? AND status IN ('creating', 'provisioning', 'running')`).bind(user.id).first();
  if (open.n >= MAX_ACTIVE) throw new HttpError(409, `You can run up to ${MAX_ACTIVE} cloud GPUs at a time. End one first.`);
  // Counted only once the request is valid, so a price change does not use it up.
  await limit(env, "cloud:" + user.id, 10, 3600);

  const c = cfg(env);
  const r = {
    id: newId("cgr"), user_id: user.id, gpu_id: g.id, gpu_name: g.name, vram_gb: g.vram_gb, gpu_count: count, hours,
    price_micro: g.price_micro, cost_micro: g.cost_micro, total_micro: g.price_micro * count * hours,
    refunded_micro: 0, image: c.image, ssh_key: key, created_at: now(),
  };
  if (!(await chargeAndInsert(env, r))) {
    throw new HttpError(402, `Your balance is too low: this costs $${microToUsd(r.total_micro)}. Top up at /account.html#billing.`);
  }

  let pod;
  try {
    pod = await runpod(env, "POST", "/pods", {
      name: POD_PREFIX + r.id,
      image: c.image,
      cloud: "SECURE",
      gpu: { id: g.id, count },
      disk: c.disk,
      ports: ["22/tcp"],
      // Official images start sshd with this key (per-pod, never account-wide).
      env: { PUBLIC_KEY: key },
    });
  } catch (err) {
    if (err.status === 0 || err.status >= 500 || err.status === 429) {
      // Unknown outcome: the pod may exist. The sweep adopts it or refunds.
      console.warn("cloud create unknown outcome", r.id, err.message);
      const row = await env.DB.prepare("SELECT * FROM cloud_rentals WHERE id = ?").bind(r.id).first();
      return json(202, { rental: rentalOut(row), note: "The provider is slow to answer. Your machine is being set up; if it cannot be, you are refunded automatically." });
    }
    await fail(env, r, err.status === 402 || err.status === 403 ? "provider account problem" : "no capacity for this GPU right now");
    if (err.status === 402 || err.status === 403) {
      const p = alertAdmins(env, "RunPod refused a pod: account problem", `Rental ${r.id} (${count} x ${g.name}) was refused with ${err.status}: ${err.detail}. The renter was refunded. Check the RunPod balance and API key.`);
      if (ctx && ctx.waitUntil) ctx.waitUntil(p); else await p;
    }
    throw new HttpError(409, "No machine with that GPU could be started right now. You were refunded in full; try another GPU or a smaller count.");
  }
  // Without an id the pod cannot be tracked here; the sweep finds it by name.
  if (pod && pod.id) {
    await env.DB.prepare("UPDATE cloud_rentals SET pod_id = ?, status = 'provisioning', checked_at = ? WHERE id = ? AND status = 'creating'")
      .bind(String(pod.id), now(), r.id).run();
  }
  const row = await env.DB.prepare("SELECT * FROM cloud_rentals WHERE id = ?").bind(r.id).first();
  return json(201, { rental: rentalOut(row) });
}

// Brings one rental in line with its pod. Safe to run concurrently: every
// state change is conditional on the status it starts from.
async function sync(env, r) {
  const t = now();
  if (r.status === "creating") {
    if (t - r.created_at < LOST_CREATE_GRACE) return;
    // The create reply was lost: look for the pod by name. Refund only when
    // the whole list was read; otherwise the pod may be on a page not seen.
    const { pods, complete } = await listOurPods(env);
    const found = pods.find((p) => p.name === POD_PREFIX + r.id);
    if (found) {
      await env.DB.prepare("UPDATE cloud_rentals SET pod_id = ?, status = 'provisioning' WHERE id = ? AND status = 'creating'").bind(found.id, r.id).run();
    } else if (complete) {
      await fail(env, r, "the machine could not be started");
    } else {
      throw new Error("pod list incomplete; will retry");
    }
    return;
  }
  if (!r.pod_id) return;
  if (r.status === "running" && r.expires_at <= t) {
    // Hours up: stop the meter without waiting on a status read.
    await terminate(env, r.pod_id);
    await close(env, r, ["running"], "ended");
    return;
  }
  let pod;
  try {
    pod = await runpod(env, "GET", `/pods/${encodeURIComponent(r.pod_id)}`);
  } catch (err) {
    if (err.status !== 404) throw err;
    pod = { status: "TERMINATED" };
  }
  const direct = pod && pod.ssh && pod.ssh.direct;
  if (r.status === "provisioning") {
    if (pod.status === "RUNNING" && direct && direct.host && direct.port) {
      // The renter's hours start now.
      await env.DB.prepare(
        "UPDATE cloud_rentals SET status = 'running', ssh_host = ?, ssh_port = ?, started_at = ?, expires_at = ?, checked_at = ? WHERE id = ? AND status = 'provisioning'"
      ).bind(String(direct.host).slice(0, 255), Number(direct.port), t, t + r.hours * 3600, t, r.id).run();
    } else if (["ERROR", "EXITED", "TERMINATED"].includes(pod.status) || t - r.created_at > PROVISION_TIMEOUT) {
      await terminate(env, r.pod_id);
      await fail(env, r, pod.status === "RUNNING" || ["PROVISIONING", "STARTING"].includes(pod.status) ? "the machine did not become reachable in time" : "the machine failed to start");
    } else {
      await env.DB.prepare("UPDATE cloud_rentals SET checked_at = ? WHERE id = ?").bind(t, r.id).run();
    }
    return;
  }
  if (r.status === "running") {
    if (["ERROR", "EXITED", "TERMINATED"].includes(pod.status)) {
      // Lost on the provider's side: end it and give back the hours not begun.
      await terminate(env, r.pod_id);
      await close(env, r, ["running"], "ended", { error: "The machine stopped on the provider side.", micro: unusedMicro(r, t), reason: "Refund: machine stopped by the provider" });
    } else {
      // Ports can change after a provider-side restart.
      if (direct && direct.port && (direct.port !== r.ssh_port || direct.host !== r.ssh_host)) {
        await env.DB.prepare("UPDATE cloud_rentals SET ssh_host = ?, ssh_port = ? WHERE id = ?").bind(String(direct.host).slice(0, 255), Number(direct.port), r.id).run();
      }
      await env.DB.prepare("UPDATE cloud_rentals SET checked_at = ? WHERE id = ?").bind(t, r.id).run();
    }
  }
}

// Our pods on the provider account. GET /v2/pods pages with `limit` (max
// 1000) and `cursor` = the previous page's `pagination.nextCursor`.
// `complete` is false when the page cap stopped the walk.
async function listOurPods(env) {
  const pods = [];
  let cursor = "";
  for (let page = 0; page < 20; page++) {
    const data = await runpod(env, "GET", `/pods?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    for (const p of (data && data.pods) || []) if (p && typeof p.name === "string" && p.name.startsWith(POD_PREFIX)) pods.push(p);
    cursor = data && data.pagination && data.pagination.nextCursor;
    if (!cursor) return { pods, complete: true };
  }
  return { pods, complete: false };
}

// Cron (every minute): sync open rentals, then (every 10 minutes by default)
// terminate pods on our account that no live rental owns.
export async function cloudSweep(env, orphans = Math.floor(now() / 60) % 10 === 0) {
  if (!cloudEnabled(env)) return;
  const t = now();
  let first = null;
  const failed = async (what, err) => {
    console.error(what, err && err.message);
    first = first || err;
    if (err instanceof ProviderError && [401, 402, 403].includes(err.status)) {
      await alertAdmins(env, "RunPod is refusing the marketplace's requests", `${what}: ${err.message}. Check the RunPod API key and balance; expired machines cannot be stopped until this is fixed.`, "auth");
    }
  };
  // Expired machines first (they cost money every minute), then the rest.
  const { results } = await env.DB.prepare(
    `SELECT r.*, u.suspended_at FROM cloud_rentals r JOIN users u ON u.id = r.user_id
     WHERE r.status IN ('creating', 'provisioning', 'running')
       AND (r.status != 'running' OR r.expires_at <= ?1 OR r.checked_at IS NULL OR r.checked_at < ?1 - 240 OR u.suspended_at IS NOT NULL)
     ORDER BY (r.status = 'running' AND r.expires_at <= ?1) DESC, u.suspended_at IS NOT NULL DESC, COALESCE(r.checked_at, 0), r.created_at
     LIMIT 200`
  ).bind(t).all();
  for (const r of results) {
    try {
      if (r.suspended_at && r.status !== "creating") await endForSuspension(env, r);
      else await sync(env, r);
    } catch (err) { await failed(`cloud sync ${r.id}`, err); }
  }
  if (orphans) {
    let list = null;
    try { list = await listOurPods(env); } catch (err) { await failed("cloud orphan scan", err); }
    if (list && !list.complete) await alertAdmins(env, "RunPod pod list too long", "The orphan scan stopped after 20 pages; some pods were not checked.", "pages");
    for (const p of (list && list.pods) || []) {
    const id = p.name.slice(POD_PREFIX.length);
    const r = await env.DB.prepare("SELECT status FROM cloud_rentals WHERE id = ?").bind(id).first();
      // Open rentals own their pod ('creating' ones are adopted by sync above);
      // a pod of an ended or failed rental, or of no rental, is unpaid.
      if (r && ACTIVE.includes(r.status)) continue;
      try {
        await terminate(env, p.id);
        await alertAdmins(env, "Terminated an orphaned RunPod pod", `Pod ${p.id} (${p.name}) had no live rental (${r ? r.status : "no row"}) and was terminated.`);
      } catch (err) { await failed(`orphan terminate ${p.id}`, err); }
    }
  }
  // Reported by the worker (logs and Sentry) once everything else has run.
  if (first) throw first;
}

// Suspended accounts lose their machines at once, without a refund (terms,
// "Instant cloud GPUs").
async function endForSuspension(env, r) {
  if (r.pod_id) await terminate(env, r.pod_id);
  await close(env, r, ["provisioning", "running"], "ended", { error: "Ended by TDCC: the account was suspended." });
}

// Called when an admin suspends an account; the sweep retries what fails here.
export async function endAllForUser(env, userId) {
  if (!cloudEnabled(env)) return;
  const { results } = await env.DB.prepare("SELECT * FROM cloud_rentals WHERE user_id = ? AND status IN ('provisioning', 'running')").bind(userId).all();
  for (const r of results) await endForSuspension(env, r).catch((err) => console.error("cloud end on suspend failed", r.id, err.message));
}

async function myRentals(request, env) {
  const user = await requireUser(request, env);
  await limit(env, "cloudpoll:" + user.id, 30, 60);
  const { results } = await env.DB.prepare("SELECT * FROM cloud_rentals WHERE user_id = ? ORDER BY created_at DESC LIMIT 50").bind(user.id).all();
  // Fresh state for machines still starting, so the SSH line appears quickly.
  // Claiming the check first means parallel page loads ask the provider once.
  const t = now();
  for (const r of results.filter((x) => x.status === "provisioning").slice(0, 3)) {
    const claim = await env.DB.prepare("UPDATE cloud_rentals SET checked_at = ?1 WHERE id = ?2 AND status = 'provisioning' AND (checked_at IS NULL OR checked_at <= ?1 - 10)").bind(t, r.id).run();
    if (!claim.meta.changes) continue;
    try { await sync(env, r); } catch (err) { console.warn("cloud sync on load failed", r.id, err.message); }
  }
  const fresh = (await env.DB.prepare("SELECT * FROM cloud_rentals WHERE user_id = ? ORDER BY created_at DESC LIMIT 50").bind(user.id).all()).results;
  return json(200, { enabled: cloudEnabled(env), rentals: fresh.map((r) => rentalOut(r, t)) });
}

async function endRental(request, env, id) {
  const user = await requireUser(request, env);
  await limit(env, "write:" + user.id, 30, 60);
  await readJson(request);
  const r = await env.DB.prepare("SELECT * FROM cloud_rentals WHERE id = ? AND user_id = ?").bind(id, user.id).first();
  if (!r) throw new HttpError(404, "This machine does not exist.");
  if (!ACTIVE.includes(r.status)) throw new HttpError(409, `This machine is already ${r.status}.`);
  if (r.status === "creating") throw new HttpError(409, "This machine is still being created. Try again in a minute.");
  // Stop the provider's meter first; if that fails nothing changes and the
  // renter can try again.
  try {
    await terminate(env, r.pod_id);
  } catch (err) {
    console.error("cloud terminate failed", id, err.message);
    throw new HttpError(502, "The machine could not be stopped right now. Please try again in a minute.");
  }
  await close(env, r, ["provisioning", "running"], "ended", { micro: unusedMicro(r, now()), reason: "Refund: ended early by the renter" });
  const row = await env.DB.prepare("SELECT * FROM cloud_rentals WHERE id = ?").bind(id).first();
  return json(200, { rental: rentalOut(row) });
}

// Account deletion is refused while a machine is open (its pod would be left
// running with nobody to bill).
export async function openCloudRentals(env, userId) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_rentals WHERE user_id = ? AND status IN ('creating', 'provisioning', 'running')").bind(userId).first();
  return Number(row.n);
}

export async function handleCloud(route, request, env, ctx, id) {
  switch (route) {
    case "GET /cloud/gpus": return listGpus(env);
    case "GET /cloud/rentals": return myRentals(request, env);
    case "POST /cloud/rentals": return createRental(request, env, ctx);
    case "POST /cloud/rentals/:id/end": return endRental(request, env, id);
  }
  return null;
}
