-- Pitch-corrected shuttle audio is generated at the two accelerated JKL
-- rates. The files are shorter than the source by their rate, then played at
-- 1x beside the accelerated picture. This avoids the browser media element's
-- unreliable rate-changed audio path while preserving speech pitch.
--
-- SQLite cannot extend the kind CHECK in place, so rebuild the table while
-- preserving all rows and both partial unique indexes.
CREATE TABLE renditions_new (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('proxy_2160','proxy_1080','proxy_540','hdr_hevc','hdr_av1','proxy_audio','shuttle_audio_2x','shuttle_audio_4x','audio_peaks','waveform_data','spectrogram','sprite','poster','pdf_pages','still_tiles','watermarked')),
  blob_key TEXT NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '{}',
  size INTEGER NOT NULL DEFAULT 0,
  checksum_sha256 TEXT NOT NULL DEFAULT '',
  share_id TEXT,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
INSERT INTO renditions_new (id, version_id, kind, blob_key, meta_json, size, checksum_sha256, share_id, created_at)
SELECT id, version_id, kind, blob_key, meta_json, size, checksum_sha256, share_id, created_at FROM renditions;
--> statement-breakpoint
DROP TABLE renditions;
--> statement-breakpoint
ALTER TABLE renditions_new RENAME TO renditions;
--> statement-breakpoint
CREATE UNIQUE INDEX renditions_base_uq ON renditions(version_id, kind) WHERE share_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX renditions_share_uq ON renditions(version_id, kind, share_id) WHERE share_id IS NOT NULL;
