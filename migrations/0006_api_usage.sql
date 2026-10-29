-- Usage of tdcc API rentals as the host's node reports it (tdcc 0.74+):
-- tunneled connections, connections refused for going over the per-renter
-- fair-use limits, and seconds with a connection open.
ALTER TABLE rentals ADD COLUMN usage_streams INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rentals ADD COLUMN usage_refused INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rentals ADD COLUMN usage_active_secs INTEGER NOT NULL DEFAULT 0;
