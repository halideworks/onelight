-- Guest workspace accounts: outward-facing users (freelancers, vendors,
-- client-side producers) who see only what they are explicitly granted.
--
-- Stored as a flag beside role rather than a third role value: the users
-- and invites role columns carry CHECK (role IN ('admin','member')) from
-- 0000, and relaxing a CHECK in SQLite means rebuilding the table, which
-- for users would cascade through every table holding a user_id ON DELETE
-- CASCADE (sessions, tokens, notifications). An additive column is safe
-- on live instances; the API derives the effective "guest" role at the
-- auth boundary so the rest of the system sees a real third tier.
ALTER TABLE users ADD COLUMN guest INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invites ADD COLUMN guest INTEGER NOT NULL DEFAULT 0;
