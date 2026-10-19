-- Email verification, password reset, notifications, and moderation.

ALTER TABLE users ADD COLUMN email_verified_at INTEGER;
ALTER TABLE users ADD COLUMN suspended_at INTEGER;

-- One-time links sent by email. Only the SHA-256 of the token is stored.
CREATE TABLE IF NOT EXISTS email_tokens (
  token_hash    TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose       TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS email_tokens_user ON email_tokens(user_id, purpose);

ALTER TABLE listings ADD COLUMN moderation_note TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS reports (
  id            TEXT PRIMARY KEY,
  listing_id    TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  reporter_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason        TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  resolved_at   INTEGER,
  resolution    TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS reports_once ON reports(listing_id, reporter_id);
CREATE INDEX IF NOT EXISTS reports_open ON reports(resolved_at);
