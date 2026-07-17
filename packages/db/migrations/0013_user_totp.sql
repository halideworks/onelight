-- TOTP two-factor: the secret sits unverified until the user proves a code,
-- and backup codes are stored only as SHA-256 hashes.
ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN totp_verified_at INTEGER;
ALTER TABLE users ADD COLUMN totp_backup_codes_json TEXT NOT NULL DEFAULT '[]';
