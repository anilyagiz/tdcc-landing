-- API rentals over the tdcc mesh: the host's node offers its invite token,
-- renters give their tdcc owner id, and access ends when the rental does.

ALTER TABLE listings ADD COLUMN api_join_token TEXT;
ALTER TABLE listings ADD COLUMN api_seen_at INTEGER;

-- The renter's tdcc owner id (`tdcc auth status`). Not called owner_id:
-- rental queries already use that name for the listing owner's user id.
ALTER TABLE rentals ADD COLUMN renter_owner_id TEXT NOT NULL DEFAULT '';
ALTER TABLE rentals ADD COLUMN access_expires_at INTEGER;
CREATE INDEX IF NOT EXISTS rentals_api_grants ON rentals(listing_id, access, status, access_expires_at);
