-- Prepaid balance, USDC top-ups on Solana, API keys and metered usage.
-- Money is integer micro-dollars (1 USD = 1,000,000), the base unit of USDC.

CREATE TABLE IF NOT EXISTS balances (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  micro       INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);

-- Append-only record of every change to a balance. `ref` is unique so the
-- same payment or request can never be applied twice.
CREATE TABLE IF NOT EXISTS ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  micro       INTEGER NOT NULL,
  kind        TEXT NOT NULL,          -- deposit | usage | adjust
  ref         TEXT NOT NULL UNIQUE,
  detail      TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_user ON ledger(user_id, created_at);

-- A Solana Pay transfer request. `reference` is the random key the wallet adds
-- to the transfer, which is how the payment is found on chain.
CREATE TABLE IF NOT EXISTS deposits (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_micro  INTEGER NOT NULL,
  reference     TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'pending',   -- pending | confirmed | expired
  signature     TEXT UNIQUE,
  credited_micro INTEGER,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  checked_at    INTEGER
);
CREATE INDEX IF NOT EXISTS deposits_user ON deposits(user_id, created_at);
CREATE INDEX IF NOT EXISTS deposits_pending ON deposits(status, expires_at);

CREATE TABLE IF NOT EXISTS api_keys (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  prefix        TEXT NOT NULL,
  key_hash      TEXT NOT NULL UNIQUE,
  rpm           INTEGER NOT NULL DEFAULT 60,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  revoked_at    INTEGER
);
CREATE INDEX IF NOT EXISTS api_keys_user ON api_keys(user_id);

CREATE TABLE IF NOT EXISTS usage (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_id             TEXT,
  source             TEXT NOT NULL,     -- api | chat
  model              TEXT NOT NULL,
  prompt_tokens      INTEGER NOT NULL,
  completion_tokens  INTEGER NOT NULL,
  cost_micro         INTEGER NOT NULL,
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_user ON usage(user_id, created_at);
