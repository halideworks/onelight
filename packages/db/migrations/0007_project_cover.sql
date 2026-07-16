-- A project's cover picture: one of the project's own assets, whose poster
-- rendition is reused as the card image. No REFERENCES clause, matching
-- assets.current_version_id: assets already references projects, and a hard FK
-- back the other way would make the two tables mutually dependent for no gain.
-- A cover pointing at a deleted asset simply resolves to nothing, and the
-- generated palette default takes over.
ALTER TABLE projects ADD COLUMN cover_asset_id TEXT;
