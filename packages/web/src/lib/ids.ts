/* Pretty URLs carry a readable tail after the id: /projects/{ulid}-{name}.
 * Ids are 26-character ULIDs and never contain a hyphen, so the id is
 * whatever precedes the first one; a bare id parses unchanged. The tail is
 * decoration for the address bar and the copied link, nothing more -- lookups
 * use the id alone, so a rename never breaks an old link. */

export const idFrom = (param: string | undefined): string =>
  (param ?? "").split("-")[0] ?? "";

export const pretty = (id: string, name: string | null | undefined): string => {
  const tail = (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return tail ? `${id}-${tail}` : id;
};
