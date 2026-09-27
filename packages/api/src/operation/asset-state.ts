import { and, eq, isNull, isNotNull, sql } from "drizzle-orm";
import { assets } from "@onelight/db/schema";
import type { z } from "zod";
import type { bodies } from "../schemas.js";

type Expected = z.infer<typeof bodies.assetPatch>["expected"];

/* Compare only the fields a reversal owns. A rename must not reject because
   another reviewer changed approval, or overwrite that reviewer's decision. */
export const assetPredicate = (id: string, expected?: Expected) =>
  and(
    eq(assets.id, id),
    expected?.name === undefined ? undefined : eq(assets.name, expected.name),
    expected?.folder_id === undefined
      ? undefined
      : expected.folder_id === null
        ? isNull(assets.folderId)
        : eq(assets.folderId, expected.folder_id),
    expected?.status === undefined
      ? undefined
      : eq(assets.status, expected.status),
    expected?.tags === undefined
      ? undefined
      : eq(sql`json(${assets.tagsJson})`, JSON.stringify(expected.tags)),
    expected?.selected === undefined
      ? undefined
      : expected.selected
        ? isNotNull(assets.selectedAt)
        : isNull(assets.selectedAt),
    expected?.deleted_at === undefined
      ? undefined
      : expected.deleted_at === null
        ? isNull(assets.deletedAt)
        : eq(assets.deletedAt, expected.deleted_at),
    expected?.updated_at === undefined
      ? undefined
      : eq(assets.updatedAt, expected.updated_at),
  );

/* SQLite evaluates both assignments against the old row. A trash and its
   later re-trash get distinct tokens even on a fixed or backward clock. */
export const nextAssetStamp = (now: number) =>
  sql<number>`max(${assets.updatedAt} + 1, ${now})`;
