-- What a clip does over its own length, for the colour pass that arrives with
-- no audio at all, which is common.
--
-- One number per frame: how much the picture changed since the last one. Cuts
-- are spikes, camera moves are plateaus, a locked-off shot is a floor. A grade
-- is a per pixel transform and cannot move a cut, so the shape survives it;
-- a re-edit moves every spike. It is the audio tier's answer for silent
-- deliveries, and the two agree where both exist.
ALTER TABLE asset_versions ADD COLUMN motion_hash TEXT;
--> statement-breakpoint
ALTER TABLE upload_sessions ADD COLUMN motion_hash TEXT;
