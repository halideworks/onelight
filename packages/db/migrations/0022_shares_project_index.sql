-- Index shares by project.
--
-- The shares table carried only its column-level uniques (public_id, slug), so
-- every "shares in this project" lookup -- the shares index page, and the
-- asset-list share filter -- scanned the whole table. Transfers already had
-- transfers_project_idx; this brings shares level with it. The id tail matches
-- the keyset order the shares list pages by.
CREATE INDEX shares_project_idx ON shares(project_id, id);
