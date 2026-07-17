/* Pretty URLs read name-first with a short random identity at the end:
 * /projects/autumn-spot-a3f9c02b17. The tail id is the entity's public_id
 * (10 lowercase hex characters, random, unique-indexed); the name part is
 * decoration for the address bar and the copied link, nothing more.
 * Lookups use the id alone, so a rename never breaks an old link.
 *
 * Parsing has to accept every form ever minted:
 *   autumn-spot-a3f9c02b17   name plus public id: the id is the LAST segment
 *   a3f9c02b17               bare public id
 *   01J8...  (26 chars)      bare canonical ULID (legacy links, API-built)
 *   01J8...-autumn-spot      the old ULID-first pretty form
 * ULIDs are 26 uppercase Crockford characters and slugified names are
 * lowercase, so the first-segment test cannot false-positive on a name. */

const ULID_SHAPE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const idFrom = (param: string | undefined): string => {
  const raw = param ?? "";
  const parts = raw.split("-");
  const first = parts[0] ?? "";
  if (ULID_SHAPE.test(first)) return first;
  return parts[parts.length - 1] ?? raw;
};

export const pretty = (id: string, name: string | null | undefined): string => {
  const tail = (name ?? "")
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return tail ? `${tail}-${id}` : id;
};
