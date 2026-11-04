// Stand-in for the RunPod v2 endpoints src/cloud.js uses, for local browser
// runs:  node test/fake-runpod.mjs   then start wrangler dev with
//   --var RUNPOD_API_KEY:test --var RUNPOD_API_BASE:http://127.0.0.1:8799/v2
// Pods go from PROVISIONING to RUNNING 15 seconds after they are created.
import { createServer } from "node:http";

const GPUS = [
  { id: "NVIDIA GeForce RTX 4090", name: "RTX 4090", memory: 24, secure: true, community: true, price: { secure: 0.69, community: 0.34 }, maxCount: { secure: 8, community: 8 }, availability: "HIGH" },
  { id: "NVIDIA H100 80GB HBM3", name: "H100 SXM", memory: 80, secure: true, community: false, price: { secure: 2.99, community: 0 }, maxCount: { secure: 8, community: 0 }, availability: "LOW" },
];
const pods = new Map();
let n = 0;

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
};

createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const url = new URL(req.url, "http://x");
  const path = url.pathname.replace(/^\/v2/, "");
  console.log(req.method, url.pathname);
  if (path === "/catalog/gpus") return send(res, 200, { gpus: GPUS });
  if (path === "/pods" && req.method === "POST") {
    const body = JSON.parse(raw || "{}");
    const id = `pod_${++n}`;
    pods.set(id, { id, name: body.name, status: "PROVISIONING", ssh: { proxy: null, direct: null }, createdAt: Date.now() });
    return send(res, 201, pods.get(id));
  }
  if (path === "/pods") return send(res, 200, { pods: [...pods.values()] });
  const m = path.match(/^\/pods\/([^/]+)$/);
  const pod = m && pods.get(decodeURIComponent(m[1]));
  if (m && req.method === "DELETE") { if (!pod) return send(res, 404, { detail: "not found" }); pods.delete(pod.id); res.writeHead(204); return res.end(); }
  if (pod) {
    if (pod.status === "PROVISIONING" && Date.now() - pod.createdAt > 15_000) {
      pod.status = "RUNNING";
      pod.ssh.direct = { host: "203.0.113.7", port: 10000 + n, username: "root", command: "" };
    }
    return send(res, 200, pod);
  }
  return send(res, 404, { detail: "not found" });
}).listen(8799, "127.0.0.1", () => console.log("fake RunPod on http://127.0.0.1:8799/v2"));
