-- GPU marketplace: accounts, sessions, listings, rental requests.
-- Apply with: npx wrangler d1 migrations apply tdcc-market --remote

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  pw_hash       TEXT NOT NULL,
  pw_salt       TEXT NOT NULL,
  pw_iter       INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash    TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS listings (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gpu_model       TEXT NOT NULL,
  vram_gb         INTEGER NOT NULL,
  gpu_count       INTEGER NOT NULL,
  region          TEXT NOT NULL,
  host_kind       TEXT NOT NULL,
  price_cents     INTEGER NOT NULL,
  min_hours       INTEGER NOT NULL DEFAULT 1,
  description     TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'active',
  node_token_hash TEXT,
  node_seen_at    INTEGER,
  node_version    TEXT,
  node_gpus       TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS listings_owner ON listings(owner_id);
CREATE INDEX IF NOT EXISTS listings_status ON listings(status);
CREATE UNIQUE INDEX IF NOT EXISTS listings_node_token ON listings(node_token_hash);

CREATE TABLE IF NOT EXISTS rentals (
  id            TEXT PRIMARY KEY,
  listing_id    TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  renter_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gpu_count     INTEGER NOT NULL,
  hours         INTEGER NOT NULL,
  environment   TEXT NOT NULL,
  image         TEXT NOT NULL DEFAULT '',
  access        TEXT NOT NULL,
  ssh_key       TEXT NOT NULL DEFAULT '',
  message       TEXT NOT NULL DEFAULT '',
  price_cents   INTEGER NOT NULL,
  total_cents   INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  host_note     TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rentals_listing ON rentals(listing_id, status);
CREATE INDEX IF NOT EXISTS rentals_renter ON rentals(renter_id);

CREATE TABLE IF NOT EXISTS rate_limits (
  key           TEXT PRIMARY KEY,
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL
);
