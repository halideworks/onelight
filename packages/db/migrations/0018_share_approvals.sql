-- Approve / Request changes becomes a per-share choice. Review shares keep
-- the buttons; existing presentations lose them (they were review furniture
-- in the washed room), and any share can turn them on or off from settings.
ALTER TABLE shares ADD COLUMN allow_approvals INTEGER NOT NULL DEFAULT 1;
UPDATE shares SET allow_approvals = 0 WHERE kind = 'presentation';
