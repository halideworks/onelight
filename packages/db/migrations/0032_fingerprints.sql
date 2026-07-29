-- Matching a second pass by something other than its name.
--
-- capture_key is exact: the instant a frame was taken plus the body that took
-- it, or a clip's creation time plus its source timecode. A re-export keeps
-- them, and two frames a second apart differ in the field itself, so this
-- cannot slide onto the neighbouring frame.
--
-- content_hash is a suggestion: a 64 bit difference hash of the picture, or
-- four of them along a clip. Measured, a frame sits one bit from its own
-- retouch and three from the next frame of the same burst, so it narrows and
-- never decides. See packages/core/src/fingerprint.ts.
--
-- Both live on the version, because v1 and v2 are different pictures, and on
-- the upload session, because a file being matched is not a version yet.
ALTER TABLE asset_versions ADD COLUMN capture_key TEXT;
--> statement-breakpoint
ALTER TABLE asset_versions ADD COLUMN content_hash TEXT;
--> statement-breakpoint
CREATE INDEX asset_versions_capture_idx ON asset_versions(capture_key);
--> statement-breakpoint
ALTER TABLE upload_sessions ADD COLUMN capture_key TEXT;
--> statement-breakpoint
ALTER TABLE upload_sessions ADD COLUMN content_hash TEXT;
--> statement-breakpoint
-- 'pending' until a fingerprint job has looked at it, so the matcher can say
-- "still working" rather than "no match".
ALTER TABLE upload_sessions ADD COLUMN fingerprint_state TEXT NOT NULL DEFAULT 'pending';
