-- Short public identities for the entities that appear in page URLs.
-- ULIDs stay the canonical keys everywhere inside the system; the public
-- id exists so an address reads as a name and a short random tail instead
-- of a 26-character machine id. Random (not derived, not sequential), so
-- links neither collide nor enumerate; uniqueness is enforced by index.
ALTER TABLE projects ADD COLUMN public_id TEXT;
ALTER TABLE assets ADD COLUMN public_id TEXT;
ALTER TABLE shares ADD COLUMN public_id TEXT;
UPDATE projects SET public_id = lower(hex(randomblob(5))) WHERE public_id IS NULL;
UPDATE assets SET public_id = lower(hex(randomblob(5))) WHERE public_id IS NULL;
UPDATE shares SET public_id = lower(hex(randomblob(5))) WHERE public_id IS NULL;
CREATE UNIQUE INDEX projects_public_id_uq ON projects(public_id);
CREATE UNIQUE INDEX assets_public_id_uq ON assets(public_id);
CREATE UNIQUE INDEX shares_public_id_uq ON shares(public_id);
