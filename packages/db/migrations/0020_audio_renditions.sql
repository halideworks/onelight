-- Audio gets a player, so audio gets renditions worth playing.
--
-- Three kinds join the table:
--
--   proxy_audio    an AAC/m4a proxy. Audio arrives as WAV, AIFF, FLAC and
--                  worse; none of those play everywhere, and the original of
--                  a mix stem is not what a browser should be asked to
--                  stream. This is the audio equivalent of proxy_1080.
--   waveform_data  peak data (the BBC audiowaveform .dat container, version
--                  2), not a picture of a waveform. The showwavespic PNG the
--                  pipeline made before is fixed in size, fixed in colour,
--                  and cannot answer "what is the level at this frame", so it
--                  could never be the hero of an audio review page.
--   spectrogram    a log-frequency spectrogram, rendered as luminance so the
--                  player can map it through the palette it needs.
--
-- The kind column carries a CHECK constraint, and SQLite cannot alter one:
-- the table has to be rebuilt. That is what the rest of this file is, in the
-- order the SQLite documentation prescribes for a table rebuild. Nothing
-- references renditions with a foreign key, so the rename at the end cannot
-- re-point anyone else's clause.
--
-- audio_peaks stays in the CHECK. Versions transcoded before this migration
-- have those rows, the timeline still draws that lane from them when no peak
-- data exists, and dropping the value would fail the copy below.
CREATE TABLE renditions_new (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('proxy_2160','proxy_1080','proxy_540','hdr_hevc','hdr_av1','proxy_audio','audio_peaks','waveform_data','spectrogram','sprite','poster','pdf_pages','still_tiles','watermarked')),
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
