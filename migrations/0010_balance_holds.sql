-- Balance reserved by metered requests that are still running. A request
-- reserves its worst-case cost before the provider is called, so concurrent
-- requests cannot spend the same balance twice; the hold is dropped in the
-- same batch that charges the real usage. Holds of requests that never
-- finished (the Worker was evicted) stop counting at `expires_at` and are
-- deleted by the cron.
CREATE TABLE IF NOT EXISTS holds (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  micro       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS holds_user ON holds(user_id, expires_at);
