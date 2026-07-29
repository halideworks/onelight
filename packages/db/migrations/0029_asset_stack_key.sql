-- Batch versioning: the identity an asset shares with a later pass of the same
-- picture, so a delivery of 1200 files can be matched to its originals with one
-- indexed query rather than 1200 scans.
--
-- The column starts empty on purpose. Normalizing a filename is not something
-- SQL should be asked to do (see packages/core/stack-key.ts: it strips version
-- tokens but must never strip a bare trailing number, or a numbered shoot
-- stacks on top of itself). New and renamed assets get their key in
-- application code, and a bounded sweep in the worker pump fills the rows that
-- predate this.
ALTER TABLE assets ADD COLUMN stack_key TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
CREATE INDEX assets_stack_idx ON assets(project_id, stack_key);
