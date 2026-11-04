// `npm run db:backup`: SQL dump of the remote D1 database into backups/.
// Plain Node so it works the same from PowerShell, cmd and POSIX shells.
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

mkdirSync("backups", { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const out = `backups/tdcc-market-${stamp}.sql`;
const res = spawnSync("npx", ["wrangler", "d1", "export", "tdcc-market", "--remote", "--output", out], { stdio: "inherit", shell: true });
if (res.status === 0) console.log(`Backup written to ${out}`);
process.exit(res.status ?? 1);
