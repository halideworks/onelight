-- The stills ladder: a photograph is rendered by sharp into a 640 poster and
-- a 2048 review still, plus a full-size rung made on demand for the formats a
-- browser cannot decode (TIFF, PSD, EXR, DPX). still_tiles is retired but kept
-- in the CHECK so versions transcoded before this still read.
--
-- SQLite cannot extend the kind CHECK in place, so rebuild the table while
-- preserving all rows and both partial unique indexes.
CREATE TABLE renditions_new (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('proxy_2160','proxy_1080','proxy_540','hdr_hevc','hdr_av1','proxy_audio','reference_audio_1x','shuttle_audio_2x','shuttle_audio_4x','audio_peaks','waveform_data','spectrogram','sprite','poster','pdf_pages','still_tiles','still_review','still_full','watermarked')),
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
