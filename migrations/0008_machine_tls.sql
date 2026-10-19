-- Jupyter machines are served over HTTPS with a per-rental self-signed
-- certificate; renters compare this SHA-256 fingerprint with their browser's.
ALTER TABLE rentals ADD COLUMN machine_tls_fingerprint TEXT;
