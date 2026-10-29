-- Card payments through Stripe Connect (optional; see src/api.js "payments").

ALTER TABLE users ADD COLUMN payout_account_id TEXT;
ALTER TABLE users ADD COLUMN payouts_enabled INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS users_payout_account ON users(payout_account_id);

-- payment_status: none | awaiting | authorized | captured | released |
--   partially_refunded | refunded | failed
-- payout_status:  none | held | paying | paid | failed
ALTER TABLE rentals ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE rentals ADD COLUMN checkout_session_id TEXT;
ALTER TABLE rentals ADD COLUMN payment_intent_id TEXT;
ALTER TABLE rentals ADD COLUMN charge_id TEXT;
ALTER TABLE rentals ADD COLUMN fee_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rentals ADD COLUMN refunded_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rentals ADD COLUMN payout_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE rentals ADD COLUMN transfer_id TEXT;
CREATE INDEX IF NOT EXISTS rentals_checkout ON rentals(checkout_session_id);
CREATE INDEX IF NOT EXISTS rentals_payment_intent ON rentals(payment_intent_id);
CREATE INDEX IF NOT EXISTS rentals_payout ON rentals(payout_status, status);

CREATE TABLE IF NOT EXISTS stripe_events (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
