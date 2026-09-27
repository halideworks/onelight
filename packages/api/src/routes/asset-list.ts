import { asc, desc, and, eq, gt, lt, or, sql } from "drizzle-orm";
import { assets } from "@onelight/db/schema";
import { base64UrlDecode, base64UrlEncode, errors } from "@onelight/core";
import { z } from "zod";
import { cursorParam, encodeCursor } from "../helpers.js";
import { assetListQuery } from "../schemas.js";

const cursorShape = z.object({
  context: z.string().max(4096),
  id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/i),
  value: z.union([z.string().max(500), z.number().int().nonnegative().safe()]),
});

/* Keep the old cursor unchanged for old clients. Extended queries carry their
   context so a saved view cannot accidentally reuse another view's keyset. */
export const assetListOrder = (
  projectId: string,
  query: Record<string, string>,
) => {
  const parsed = assetListQuery.safeParse(query);
  if (!parsed.success)
    throw errors.validation("Asset list filters are invalid.", {
      issues: parsed.error.issues,
    });
  const { sort, direction, status, kind } = parsed.data;
  if (direction && !sort)
    throw errors.validation("Direction requires an asset sort.");
  const extended =
    sort !== undefined || status !== undefined || kind !== undefined;
  const ascending = direction === "asc";
  const context = JSON.stringify([
    projectId,
    query.folder_id || null,
    query.share_id || null,
    query.selected === "1",
    status ?? null,
    kind ?? null,
    sort ?? "id",
    ascending ? "asc" : "desc",
  ]);
  const column =
    sort === "name"
      ? sql<string>`${assets.name} COLLATE NOCASE`
      : sort === "status"
        ? assets.status
        : sort === "created_at"
          ? assets.createdAt
          : sort === "updated_at"
            ? assets.updatedAt
            : assets.id;
  const key = sql<string | number>`${column}`;
  const valueOf = (asset: typeof assets.$inferSelect): string | number =>
    sort === "name"
      ? asset.name
      : sort === "status"
        ? asset.status
        : sort === "created_at"
          ? asset.createdAt
          : sort === "updated_at"
            ? asset.updatedAt
            : asset.id;
  let after;
  if (query.cursor) {
    if (!extended) {
      after = lt(assets.id, cursorParam(query.cursor)!);
    } else {
      try {
        if (query.cursor.length > 8192) throw new Error("Oversized cursor");
        const cursor = cursorShape.parse(
          JSON.parse(new TextDecoder().decode(base64UrlDecode(query.cursor))),
        );
        const numeric = sort === "created_at" || sort === "updated_at";
        if (
          cursor.context !== context ||
          typeof cursor.value !== (numeric ? "number" : "string")
        )
          throw new Error("Cursor does not match query");
        const compare = ascending ? gt : lt;
        after = or(
          compare(key, cursor.value),
          and(eq(key, cursor.value), compare(assets.id, cursor.id)),
        );
      } catch {
        throw errors.validation(
          "Cursor is invalid or does not match these filters.",
        );
      }
    }
  }
  const order = ascending ? asc : desc;
  return {
    where: and(
      after,
      status === undefined ? undefined : eq(assets.status, status),
      kind === undefined ? undefined : eq(assets.kind, kind),
    ),
    order: [order(key), order(assets.id)],
    cursor: (asset: typeof assets.$inferSelect): string =>
      extended
        ? base64UrlEncode(
            new TextEncoder().encode(
              JSON.stringify({
                context,
                id: asset.id,
                value: valueOf(asset),
              }),
            ),
          )
        : encodeCursor(asset.id),
  };
};
