-- Machine rentals: hosts whose node runs `tdcc market machines on` get an
-- isolated container per accepted SSH/Jupyter rental, started by the node.

ALTER TABLE listings ADD COLUMN machines_seen_at INTEGER;
-- What the node offers: {"gpus": n, "custom_images": bool, "ssh_host": "..."}
ALTER TABLE listings ADD COLUMN machines_offer TEXT;

-- What the node reports about the rental's container.
ALTER TABLE rentals ADD COLUMN machine_state TEXT;
ALTER TABLE rentals ADD COLUMN machine_host TEXT;
ALTER TABLE rentals ADD COLUMN machine_port INTEGER;
ALTER TABLE rentals ADD COLUMN machine_token TEXT;
ALTER TABLE rentals ADD COLUMN machine_error TEXT;
