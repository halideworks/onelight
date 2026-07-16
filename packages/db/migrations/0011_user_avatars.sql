-- A face for each user: a small picture in the blob store, keyed here.
-- Null means the generated avatar (initials on the user's own wash).
ALTER TABLE users ADD COLUMN avatar_key TEXT;
