-- Selects: the pick a photographer makes before anyone approves anything.
--
-- Distinct from approval status on purpose. Approval is the client's decision
-- about a frame; a select is the photographer's own shortlist, and the list of
-- filenames it produces is what the retoucher actually works from. Today that
-- list gets rebuilt by hand in a spreadsheet.
ALTER TABLE assets ADD COLUMN selected_at INTEGER;
--> statement-breakpoint
CREATE INDEX assets_selected_idx ON assets(project_id, selected_at);
