-- Shares live in the project's folder tree, not in a second tree beside it.
--
-- The rail had two lists: Folders, and Shares. Two systems for one question --
-- "where is this?" -- so shares move into the tree under their own root, and
-- can be filed in folders like everything else.
--
-- A share is still not a folder: an asset lives in exactly one folder and in
-- any number of shares, so the two cannot be the same row. What they share is
-- the tree. `kind` splits the folders table into two trees that never mix:
-- 'assets' folders hold assets, 'shares' folders hold shares.
ALTER TABLE folders ADD COLUMN kind TEXT NOT NULL DEFAULT 'assets';

-- Which folder a share is filed in. NULL means directly under Shares.
ALTER TABLE shares ADD COLUMN folder_id TEXT;

-- Sibling names are unique per parent; the two trees have separate namespaces,
-- so "Client" can be both an asset folder and a share folder.
DROP INDEX IF EXISTS folders_sibling_uq;
CREATE UNIQUE INDEX folders_sibling_uq
  ON folders(project_id, kind, ifnull(parent_id, ''), name);
