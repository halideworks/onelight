CREATE TRIGGER comment_attachments_limit_before_insert
BEFORE INSERT ON comment_attachments
BEGIN
  SELECT CASE
    WHEN NEW.size < 0 THEN RAISE(ABORT, 'comment attachment size is invalid')
    WHEN (
      SELECT COUNT(*)
      FROM comment_attachments
      WHERE comment_id = NEW.comment_id
    ) >= 10 THEN RAISE(ABORT, 'comment attachment count limit reached')
    WHEN COALESCE((
      SELECT SUM(size)
      FROM comment_attachments
      WHERE comment_id = NEW.comment_id
    ), 0) + NEW.size > 104857600
      THEN RAISE(ABORT, 'comment attachment byte limit reached')
  END;
END;
--> statement-breakpoint
CREATE TRIGGER comment_attachments_account_after_insert
AFTER INSERT ON comment_attachments
BEGIN
  UPDATE projects
  SET storage_bytes = storage_bytes + NEW.size
  WHERE id = (
    SELECT assets.project_id
    FROM comments
    JOIN asset_versions ON asset_versions.id = comments.version_id
    JOIN assets ON assets.id = asset_versions.asset_id
    WHERE comments.id = NEW.comment_id
  );
END;
--> statement-breakpoint
CREATE TRIGGER comment_attachments_account_after_delete
AFTER DELETE ON comment_attachments
BEGIN
  UPDATE projects
  SET storage_bytes = MAX(0, storage_bytes - OLD.size)
  WHERE id = (
    SELECT assets.project_id
    FROM comments
    JOIN asset_versions ON asset_versions.id = comments.version_id
    JOIN assets ON assets.id = asset_versions.asset_id
    WHERE comments.id = OLD.comment_id
  );
END;
--> statement-breakpoint
CREATE TRIGGER transfer_receipts_limit_before_insert
BEFORE INSERT ON transfer_receipts
WHEN (
  SELECT byte_cap
  FROM transfers
  WHERE id = NEW.transfer_id
) IS NOT NULL
BEGIN
  SELECT CASE
    WHEN COALESCE((
      SELECT SUM(upload_sessions.size)
      FROM transfer_receipts
      JOIN upload_sessions
        ON upload_sessions.id = transfer_receipts.upload_session_id
      WHERE transfer_receipts.transfer_id = NEW.transfer_id
        AND upload_sessions.status NOT IN ('aborted', 'quarantined')
    ), 0) + COALESCE((
      SELECT size
      FROM upload_sessions
      WHERE id = NEW.upload_session_id
    ), 0) > (
      SELECT byte_cap
      FROM transfers
      WHERE id = NEW.transfer_id
    ) THEN RAISE(ABORT, 'transfer byte limit reached')
  END;
END;
--> statement-breakpoint
UPDATE projects
SET storage_bytes = storage_bytes + COALESCE((
  SELECT SUM(comment_attachments.size)
  FROM comment_attachments
  JOIN comments ON comments.id = comment_attachments.comment_id
  JOIN asset_versions ON asset_versions.id = comments.version_id
  JOIN assets ON assets.id = asset_versions.asset_id
  WHERE assets.project_id = projects.id
), 0);
--> statement-breakpoint
UPDATE transfers
SET byte_cap = 1099511627776
WHERE kind = 'request' AND byte_cap IS NULL;
