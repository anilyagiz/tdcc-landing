-- Reviews, messages, disputes, uptime, scheduled starts, and account security
-- (two-factor sign-in, session list, email change, activity log).

-- Rentals: the renter may ask for a later start. Accepting fixes the access
-- window [access_starts_at, access_expires_at).
ALTER TABLE rentals ADD COLUMN start_at INTEGER;
ALTER TABLE rentals ADD COLUMN access_starts_at INTEGER;
-- Rentals accepted before this migration started when they were accepted.
UPDATE rentals SET access_starts_at = access_expires_at - hours * 3600 WHERE access_expires_at IS NOT NULL;

-- Two-factor sign-in (TOTP). The secret is only stored once confirmed with a code.
ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN pending_email TEXT;

CREATE TABLE IF NOT EXISTS recovery_codes (
  code_hash     TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS recovery_codes_user ON recovery_codes(user_id);

-- Shown on the account page so people can sign out devices they do not know.
ALTER TABLE sessions ADD COLUMN user_agent TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER;

CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event         TEXT NOT NULL,
  detail        TEXT NOT NULL DEFAULT '',
  ip            TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_log_user ON audit_log(user_id, created_at);

-- One review per side per rental. role = who wrote it ('renter' reviews the
-- host, 'host' reviews the renter).
CREATE TABLE IF NOT EXISTS reviews (
  id            TEXT PRIMARY KEY,
  rental_id     TEXT NOT NULL REFERENCES rentals(id) ON DELETE CASCADE,
  listing_id    TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  author_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL,
  rating        INTEGER NOT NULL,
  comment       TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS reviews_once ON reviews(rental_id, role);
CREATE INDEX IF NOT EXISTS reviews_subject ON reviews(subject_id, role);

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,
  rental_id     TEXT NOT NULL REFERENCES rentals(id) ON DELETE CASCADE,
  author_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body          TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_rental ON messages(rental_id, created_at);

CREATE TABLE IF NOT EXISTS disputes (
  id            TEXT PRIMARY KEY,
  rental_id     TEXT NOT NULL REFERENCES rentals(id) ON DELETE CASCADE,
  opened_by     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason        TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  resolved_at   INTEGER,
  resolution    TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS disputes_once ON disputes(rental_id, opened_by);
CREATE INDEX IF NOT EXISTS disputes_open ON disputes(resolved_at);

-- Node check-ins per hour, for the uptime shown on listings.
CREATE TABLE IF NOT EXISTS node_uptime (
  listing_id    TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  hour          INTEGER NOT NULL,
  beats         INTEGER NOT NULL,
  PRIMARY KEY (listing_id, hour)
);
ALTER TABLE listings ADD COLUMN node_first_seen_at INTEGER;
CREATE INDEX IF NOT EXISTS listings_price ON listings(status, price_cents);
