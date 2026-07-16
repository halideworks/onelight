import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { AppDb } from "@onelight/db";
import { assets, renditions, shareAssets, shares } from "@onelight/db/schema";

// Escapes a value for interpolation into a double-quoted HTML attribute.
// Share titles are user controlled, so ampersands, angle brackets, and
// both quote characters must never reach the markup unescaped.
const escapeAttr = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const meta = (property: string, content: string): string =>
  `<meta property="${escapeAttr(property)}" content="${escapeAttr(content)}">`;

/**
 * Open Graph meta tags for a share landing page (/s/:slug), rendered
 * server side so link unfurlers (which never execute the SPA's
 * JavaScript) see a real title and description.
 *
 * Returns null when the share does not exist, is revoked, or is expired;
 * callers then serve the shell untouched, which is indistinguishable from
 * a share that never existed. Passphrase-protected shares get generic
 * tags only: unfurls persist in chat logs and inboxes, and the passphrase
 * is the only thing standing between those and the content.
 *
 * og:image points at the public unfurl route (GET /s/:slug/unfurl.png in
 * app.ts, the first asset's poster), emitted only when that poster exists
 * and the share has no passphrase: unfurls persist, so protected shares
 * stay pictureless.
 */
export const buildShareOgTags = async (
  db: AppDb,
  slug: string,
  publicUrl: string,
): Promise<string | null> => {
  const share = (
    await db
      .select({
        id: shares.id,
        slug: shares.slug,
        kind: shares.kind,
        title: shares.title,
        passphraseHash: shares.passphraseHash,
        expiresAt: shares.expiresAt,
        revokedAt: shares.revokedAt,
      })
      .from(shares)
      .where(eq(shares.slug, slug))
      .limit(1)
      .all()
  )[0];
  if (
    !share ||
    share.revokedAt !== null ||
    (share.expiresAt !== null && share.expiresAt <= Date.now())
  )
    return null;
  const url = `${publicUrl.replace(/\/$/, "")}/s/${share.slug}`;
  if (share.passphraseHash !== null)
    return [
      meta("og:title", "Protected share"),
      meta("og:description", "This share requires a passphrase."),
      meta("og:type", "website"),
      meta("og:url", url),
    ].join("\n");
  const counted = (
    await db
      .select({ count: sql<number>`count(*)` })
      .from(shareAssets)
      .where(eq(shareAssets.shareId, share.id))
      .all()
  )[0];
  const count = counted?.count ?? 0;
  const noun = count === 1 ? "item" : "items";
  const description =
    share.kind === "presentation"
      ? `${count} ${noun} in a presentation on Onelight`
      : `${count} ${noun} for review on Onelight`;
  const first = (
    await db
      .select({ assetId: shareAssets.assetId })
      .from(shareAssets)
      .where(eq(shareAssets.shareId, share.id))
      .orderBy(asc(shareAssets.sortOrder))
      .limit(1)
      .all()
  )[0];
  let hasPoster = false;
  if (first) {
    const asset = (
      await db
        .select({ currentVersionId: assets.currentVersionId })
        .from(assets)
        .where(eq(assets.id, first.assetId))
        .limit(1)
        .all()
    )[0];
    if (asset?.currentVersionId) {
      const poster = (
        await db
          .select({ id: renditions.id })
          .from(renditions)
          .where(
            and(
              eq(renditions.versionId, asset.currentVersionId),
              eq(renditions.kind, "poster"),
              isNull(renditions.shareId),
            ),
          )
          .limit(1)
          .all()
      )[0];
      hasPoster = Boolean(poster);
    }
  }
  return [
    meta("og:title", share.title),
    meta("og:description", description),
    meta("og:type", "website"),
    meta("og:url", url),
    ...(hasPoster ? [meta("og:image", `${url}/unfurl.png`)] : []),
  ].join("\n");
};
