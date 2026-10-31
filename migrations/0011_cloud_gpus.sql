-- Instant cloud GPUs: pods bought on demand from the provider (RunPod) and
-- resold by the hour, paid up front from the prepaid balance (src/cloud.js).
--
-- status: creating -> provisioning -> running -> ended
--         creating | provisioning -> failed (refunded in full)
-- The pod is named "tdcc-<id>", so a pod whose create reply was lost can be
-- found again and nothing runs on our account without a rental behind it.
CREATE TABLE IF NOT EXISTS cloud_rentals (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gpu_id             TEXT NOT NULL,
  gpu_name           TEXT NOT NULL,
  vram_gb            INTEGER NOT NULL DEFAULT 0,
  gpu_count          INTEGER NOT NULL,
  hours              INTEGER NOT NULL,
  price_micro        INTEGER NOT NULL,          -- what the renter pays per GPU-hour
  cost_micro         INTEGER NOT NULL,          -- provider list price per GPU-hour
  total_micro        INTEGER NOT NULL,
  refunded_micro     INTEGER NOT NULL DEFAULT 0,
  image              TEXT NOT NULL,
  ssh_key            TEXT NOT NULL,
  status             TEXT NOT NULL,
  pod_id             TEXT,
  ssh_host           TEXT,
  ssh_port           INTEGER,
  error              TEXT,
  created_at         INTEGER NOT NULL,
  started_at         INTEGER,
  expires_at         INTEGER,
  ended_at           INTEGER,
  checked_at         INTEGER
);
CREATE INDEX IF NOT EXISTS cloud_rentals_user ON cloud_rentals(user_id, created_at);
CREATE INDEX IF NOT EXISTS cloud_rentals_open ON cloud_rentals(status, expires_at);
