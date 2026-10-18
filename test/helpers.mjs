// Shared helpers for the marketplace API tests.
import assert from "node:assert/strict";
import { handleApi } from "../src/api.js";
import { createD1 } from "./d1.mjs";

export const ORIGIN = "https://decentralizedcompute.company";
export const LISTING = { gpu_model: "RTX 4090", vram_gb: 24, gpu_count: 2, region: "eu-central", host_kind: "independent", price: 0.5, description: "Home rig" };
export const RENT = { gpu_count: 1, hours: 2, environment: "pytorch", access: "api" };

export function client(env) {
  let cookie = "";
  const call = async (method, path, body, headers = {}) => {
    const h = { origin: ORIGIN, "user-agent": "test-agent", ...headers };
    if (cookie) h.cookie = cookie;
    if (body !== undefined) h["content-type"] = "application/json";
    const res = await handleApi(new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0].endsWith("=") ? "" : set.split(";")[0];
    return { status: res.status, body: await res.json(), headers: res.headers };
  };
  return { call, get cookie() { return cookie; }, set cookie(v) { cookie = v; } };
}

let n = 0;
export async function account(env, name = "User", extra = {}) {
  const c = client(env);
  const email = `${name.toLowerCase()}${++n}@example.com`;
  const r = await c.call("POST", "/api/auth/signup", { email, name, password: "a long enough password", accept_terms: true, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.email = email;
  c.id = r.body.user.id;
  return c;
}

export const newEnv = (extra = {}) => ({ DB: createD1(), ...extra });

export async function beat(env, token, body = {}) {
  const res = await handleApi(new Request(ORIGIN + "/api/node/heartbeat", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ version: "0.74.0", gpus: [], ...body }),
  }), env);
  return { status: res.status, body: await res.json() };
}

// Moves the database clock: shifts every stored timestamp back by `secs`.
export async function age(env, table, column, secs, where = "1 = 1") {
  await env.DB.prepare(`UPDATE ${table} SET ${column} = ${column} - ? WHERE ${where}`).bind(secs).run();
}
