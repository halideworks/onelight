-- What a clip sounds like, which is the tier that answers a colour pass.
--
-- A grade changes every pixel and not one sample of the audio, so two exports
-- of the same cut sound identical while their pictures drift; a re-edit is the
-- other way round. Together they say which kind of second pass this is, which
-- neither the name nor the export time can.
ALTER TABLE asset_versions ADD COLUMN audio_hash TEXT;
--> statement-breakpoint
ALTER TABLE upload_sessions ADD COLUMN audio_hash TEXT;
