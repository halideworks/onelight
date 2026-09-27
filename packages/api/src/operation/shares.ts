import {
  shares,
  shareViewers,
  assetVersions,
  renditions,
  captionTracks,
  assets,
  shareAssets,
  comments,
} from "@onelight/db/schema";
import { eq, and, lt, isNull, or, gt, asc, inArray } from "drizzle-orm";
import {
  errors,
  base64UrlEncode,
  randomBytes,
  sha256Hex,
} from "@onelight/core";
import type { Context } from "hono";
import type { Variables, AppEnv } from "../types.js";
import { SignJWT, jwtVerify } from "jose";
import { setCookie, getCookie } from "hono/cookie";
import { PRESENCE_WRITE_INTERVAL_MS } from "../limits.js";
import {
  parseJsonObject,
  decodeShareCursor,
  encodeShareCursor,
} from "../helpers.js";
import {
  shareIsWatermarked,
  publicShareWire,
  publicViewerWire,
} from "../wire.js";
import type { Media } from "./media.js";

export type PublicShareAsset = typeof assets.$inferSelect & {
  sort_order: number;
};

export const createShares = (env: AppEnv, media: Media) => {
  const {
    watermarkedRenditionFor,
    POSTER_FALLBACK_KINDS,
    posterRank,
    publicMediaUrl,
  } = media;

  const shareBySlug = async (slug: string) => {
    const share = (
      await env.db
        .select()
        .from(shares)
        .where(eq(shares.slug, slug))
        .limit(1)
        .all()
    )[0];
    if (
      !share ||
      share.revokedAt ||
      (share.expiresAt !== null && share.expiresAt <= env.clock.now())
    )
      throw errors.notFound("Share is unavailable.");
    return share;
  };

  const shareCookie = (shareId: string): string => `ol_share_${shareId}`;

  const issueViewer = async (
    c: Context<{ Variables: Variables }>,
    share: typeof shares.$inferSelect,
    name: string | undefined,
    email: string | undefined,
  ) => {
    const viewerKey = base64UrlEncode(randomBytes(18));
    const now = env.clock.now();
    const viewerId = env.ids.ulid();
    await env.db
      .insert(shareViewers)
      .values({
        id: viewerId,
        shareId: share.id,
        viewerKey,
        name: name?.trim() || null,
        email: email?.trim().toLowerCase() || null,
        firstSeenAt: now,
        lastSeenAt: now,
        userAgent: c.req.header("user-agent") ?? null,
        viewStateJson: "{}",
      })
      .run();
    const signed = await new SignJWT({
      share_id: share.id,
      viewer_key: viewerKey,
      passphrase_tag: await sha256Hex(share.passphraseHash ?? ""),
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("24h")
      .sign(new TextEncoder().encode(env.config.SECRET_KEY));
    setCookie(c, shareCookie(share.id), signed, {
      httpOnly: true,
      sameSite: "Lax",
      secure: env.config.cookieSecure,
      maxAge: 86_400,
      path: "/",
    });
    return { viewerId, viewerKey };
  };

  const viewerFor = async (
    c: Context<{ Variables: Variables }>,
    share: typeof shares.$inferSelect,
  ) => {
    const signed = getCookie(c, shareCookie(share.id));
    if (!signed) return undefined;
    try {
      const verified = await jwtVerify(
        signed,
        new TextEncoder().encode(env.config.SECRET_KEY),
      );
      if (
        verified.payload.share_id !== share.id ||
        typeof verified.payload.viewer_key !== "string" ||
        verified.payload.passphrase_tag !==
          (await sha256Hex(share.passphraseHash ?? ""))
      )
        return undefined;
      const viewer = (
        await env.db
          .select()
          .from(shareViewers)
          .where(
            and(
              eq(shareViewers.shareId, share.id),
              eq(shareViewers.viewerKey, verified.payload.viewer_key),
            ),
          )
          .limit(1)
          .all()
      )[0];
      const now = env.clock.now();
      if (viewer && viewer.lastSeenAt <= now - PRESENCE_WRITE_INTERVAL_MS)
        await env.db
          .update(shareViewers)
          .set({ lastSeenAt: now })
          .where(
            and(
              eq(shareViewers.id, viewer.id),
              lt(shareViewers.lastSeenAt, now - PRESENCE_WRITE_INTERVAL_MS + 1),
            ),
          )
          .run();
      return viewer;
    } catch {
      return undefined;
    }
  };

  const authorizeExpiredShareMedia = async (
    c: Context<{ Variables: Variables }>,
    share: typeof shares.$inferSelect,
    assetId: string,
    payload: Record<string, unknown>,
    blobKey: string,
  ): Promise<void> => {
    if (payload.disposition !== undefined) throw errors.unauthorized();
    const projection = await publicShare(c, share, { assetId });
    if (!projection.viewer) throw errors.unauthorized();
    const asset = projection.assets.find(
      (candidate: PublicShareAsset) =>
        candidate.id === assetId && candidate.deletedAt === null,
    );
    const versionId =
      typeof payload.version_id === "string" ? payload.version_id : undefined;
    if (
      !asset ||
      !versionId ||
      (!share.showAllVersions && asset.currentVersionId !== versionId)
    )
      throw errors.unauthorized();
    const version = (
      await env.db
        .select({ id: assetVersions.id })
        .from(assetVersions)
        .where(
          and(
            eq(assetVersions.id, versionId),
            eq(assetVersions.assetId, asset.id),
            isNull(assetVersions.deletedAt),
          ),
        )
        .limit(1)
        .all()
    )[0];
    if (!version) throw errors.unauthorized();
    if (!shareIsWatermarked(share) || asset.kind !== "video") return;

    const burned = await watermarkedRenditionFor(share, versionId);
    if (burned?.blobKey === blobKey) return;
    const versionRenditions = await env.db
      .select({
        kind: renditions.kind,
        blobKey: renditions.blobKey,
        metaJson: renditions.metaJson,
      })
      .from(renditions)
      .where(
        and(eq(renditions.versionId, versionId), isNull(renditions.shareId)),
      )
      .all();
    const playableKinds = new Set([
      "proxy_540",
      "proxy_1080",
      "proxy_2160",
      "hdr_av1",
      "hdr_hevc",
      "proxy_audio",
    ]);
    if (
      versionRenditions.some(
        (rendition) =>
          !playableKinds.has(rendition.kind) &&
          (rendition.blobKey === blobKey ||
            parseJsonObject(rendition.metaJson).vtt_blob_key === blobKey),
      )
    )
      return;
    const caption = (
      await env.db
        .select({ id: captionTracks.id })
        .from(captionTracks)
        .where(
          and(
            eq(captionTracks.versionId, versionId),
            eq(captionTracks.blobKey, blobKey),
          ),
        )
        .limit(1)
        .all()
    )[0];
    if (!caption) throw errors.unauthorized();
  };

  /* ---- the share's logo (brand, design doc section 11) ---- */

  const LOGO_TYPES: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/svg+xml": "svg",
  };

  const LOGO_MAX_BYTES = 512 * 1024;

  const logoKeyOf = (share: typeof shares.$inferSelect): string | null => {
    const brand = share.brandJson ? parseJsonObject(share.brandJson) : {};
    return typeof brand.logo_key === "string" ? brand.logo_key : null;
  };

  /* A share's assets, gated by the same passphrase check every share endpoint
     makes.

     Three shapes, because a share can hold a whole delivery and reading all of
     it to answer one question does not scale:

       assetId  one row, for the endpoints that already knew which asset they
                wanted and used to scan the whole share to find it
       versionId  the shared asset a comment belongs to, for the same reason
       limit    a page, for the room's own listing
       neither  everything, for the archive builder, which genuinely needs it

     The room's first payload and its paging both go through `limit`, so a
     share of any size opens at the speed of its first screen. */
  const SHARE_ASSET_PAGE = 200;

  /* An id no asset can have, for the endpoints that want the passphrase check
     and nothing else. */
  const NO_ASSET = "-";

  const publicShare = async (
    c: Context<{ Variables: Variables }>,
    share: typeof shares.$inferSelect,
    options: {
      assetId?: string | undefined;
      /** The shared asset whose current version this is, for the endpoints
          that hold a comment and must prove the share exposes it. */
      versionId?: string | undefined;
      limit?: number | undefined;
      cursor?: string | undefined;
    } = {},
  ) => {
    const viewer = await viewerFor(c, share);
    if (share.passphraseHash && !viewer) throw errors.unauthorized();
    const cursor = options.cursor ? decodeShareCursor(options.cursor) : null;
    const rows = await env.db
      .select({ asset: assets, link: shareAssets })
      .from(shareAssets)
      .innerJoin(assets, eq(shareAssets.assetId, assets.id))
      .where(
        and(
          eq(shareAssets.shareId, share.id),
          isNull(assets.deletedAt),
          options.assetId ? eq(assets.id, options.assetId) : undefined,
          options.versionId
            ? eq(assets.currentVersionId, options.versionId)
            : undefined,
          cursor
            ? or(
                gt(shareAssets.sortOrder, cursor.sortOrder),
                and(
                  eq(shareAssets.sortOrder, cursor.sortOrder),
                  gt(shareAssets.assetId, cursor.assetId),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(asc(shareAssets.sortOrder), asc(shareAssets.assetId))
      .limit(options.limit ? options.limit + 1 : -1)
      .all();
    const page = options.limit ? rows.slice(0, options.limit) : rows;
    const last = page[page.length - 1];
    return {
      share,
      viewer,
      assets: page.map(
        (link: {
          asset: typeof assets.$inferSelect;
          link: typeof shareAssets.$inferSelect;
        }) => ({ ...link.asset, sort_order: link.link.sortOrder }),
      ),
      nextCursor:
        options.limit && rows.length > options.limit && last
          ? encodeShareCursor(last.link.sortOrder, last.asset.id)
          : null,
    };
  };

  const posterUrlsFor = async (
    share: typeof shares.$inferSelect,
    shareAssets: PublicShareAsset[],
  ): Promise<
    Map<
      string,
      {
        poster: string | null;
        sprite: string | null;
        sprite_vtt: string | null;
      }
    >
  > => {
    const urls = new Map<
      string,
      {
        poster: string | null;
        sprite: string | null;
        sprite_vtt: string | null;
      }
    >();
    const versionIds = shareAssets
      .map((asset) => asset.currentVersionId)
      .filter((id): id is string => Boolean(id));
    if (!env.blobStore || !versionIds.length) return urls;
    // Posters and sprites in one query: the landing draws the poster and
    // hover-scrubs the sprite, both watermark-neutral sidecars.
    const sidecarRows = (await env.db
      .select()
      .from(renditions)
      .where(
        and(
          inArray(renditions.versionId, versionIds),
          inArray(renditions.kind, [...POSTER_FALLBACK_KINDS, "sprite"]),
          isNull(renditions.shareId),
        ),
      )
      .all()) as Array<typeof renditions.$inferSelect>;
    const postersBy = new Map<string, typeof renditions.$inferSelect>();
    const spritesBy = new Map<string, typeof renditions.$inferSelect>();
    for (const row of sidecarRows) {
      if (row.kind === "sprite") {
        spritesBy.set(row.versionId, row);
        continue;
      }
      /* Poster first, then the stills ladder's other rungs in order. A
         library part way through the ladder migration has image versions
         whose poster is missing (every JPEG made before it, whose poster
         ffmpeg silently never wrote) and whose only picture is a still. */
      const current = postersBy.get(row.versionId);
      if (!current || posterRank(row.kind) < posterRank(current.kind))
        postersBy.set(row.versionId, row);
    }
    for (const asset of shareAssets) {
      const versionId = asset.currentVersionId;
      if (!versionId) continue;
      const poster = postersBy.get(versionId);
      const sprite = spritesBy.get(versionId);
      const spriteMeta = sprite ? parseJsonObject(sprite.metaJson) : {};
      const vttKey =
        typeof spriteMeta.vtt_blob_key === "string"
          ? spriteMeta.vtt_blob_key
          : undefined;
      /* A thumbnail chosen for the asset beats the generated poster here as
         well as inside the app: the room is the place it was chosen for. */
      const posterKey = asset.thumbnailBlobKey ?? poster?.blobKey ?? null;
      urls.set(asset.id, {
        poster: posterKey
          ? await publicMediaUrl(share, asset.id, versionId, posterKey)
          : null,
        sprite:
          sprite && vttKey
            ? await publicMediaUrl(share, asset.id, versionId, sprite.blobKey)
            : null,
        sprite_vtt:
          sprite && vttKey
            ? await publicMediaUrl(share, asset.id, versionId, vttKey)
            : null,
      });
    }
    return urls;
  };

  // Running time per asset, from the current version's probe. The stored
  // media_info keeps the probe's camelCase keys; older rows may carry snake.
  const durationsFor = async (
    shareAssets: PublicShareAsset[],
  ): Promise<Map<string, number>> => {
    const seconds = new Map<string, number>();
    const versionIds = shareAssets
      .map((asset) => asset.currentVersionId)
      .filter((id): id is string => Boolean(id));
    if (!versionIds.length) return seconds;
    const versions = (await env.db
      .select()
      .from(assetVersions)
      .where(inArray(assetVersions.id, versionIds))
      .all()) as Array<typeof assetVersions.$inferSelect>;
    const byVersion = new Map(versions.map((row) => [row.id, row]));
    for (const asset of shareAssets) {
      const version = asset.currentVersionId
        ? byVersion.get(asset.currentVersionId)
        : undefined;
      if (!version) continue;
      const info = parseJsonObject(version.mediaInfoJson);
      const frames = info.durationFrames ?? info.duration_frames;
      const num = info.frameRateNum ?? info.frame_rate_num;
      const den = info.frameRateDen ?? info.frame_rate_den;
      if (
        typeof frames === "number" &&
        frames > 0 &&
        typeof num === "number" &&
        num > 0 &&
        typeof den === "number" &&
        den > 0
      )
        seconds.set(asset.id, (frames * den) / num);
    }
    return seconds;
  };

  // The one client-safe asset projection for a share, used by both the
  // bootstrap and the assets list so the two cannot drift apart.
  const publicShareAssetsWire = async (
    share: typeof shares.$inferSelect,
    shareAssets: PublicShareAsset[],
  ) => {
    const [posters, seconds] = await Promise.all([
      posterUrlsFor(share, shareAssets),
      durationsFor(shareAssets),
    ]);
    return shareAssets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      kind: asset.kind,
      status: asset.status,
      current_version_id: asset.currentVersionId,
      poster_url: posters.get(asset.id)?.poster ?? null,
      sprite_url: posters.get(asset.id)?.sprite ?? null,
      sprite_vtt_url: posters.get(asset.id)?.sprite_vtt ?? null,
      duration_seconds: seconds.get(asset.id) ?? null,
      sort_order: asset.sort_order,
    }));
  };

  // Client-safe projection of a publicShare result: raw share and viewer rows
  // are replaced by the public wire shapes and assets are reduced to the
  // fields a share client needs, so no internal columns reach the wire.
  const publicShareResponse = async (projection: {
    share: typeof shares.$inferSelect;
    viewer: typeof shareViewers.$inferSelect | undefined;
    assets: PublicShareAsset[];
    nextCursor?: string | null;
  }) => ({
    share: publicShareWire(projection.share),
    viewer: projection.viewer ? publicViewerWire(projection.viewer) : null,
    assets: await publicShareAssetsWire(projection.share, projection.assets),
    next_cursor: projection.nextCursor ?? null,
  });

  const shareCommentForViewer = async (
    c: Context<{ Variables: Variables }>,
    slug: string,
    commentId: string,
  ) => {
    const share = await shareBySlug(slug);
    /* The gate only: this endpoint never looks at the listing, and reading a
       whole delivery to check a passphrase is what made a big share slow. */
    const projection = await publicShare(c, share, { assetId: NO_ASSET });
    if (!projection.viewer) throw errors.unauthorized();
    const comment = (
      await env.db
        .select()
        .from(comments)
        .where(and(eq(comments.id, commentId), isNull(comments.deletedAt)))
        .limit(1)
        .all()
    )[0];
    if (!comment || comment.viewerKey !== projection.viewer.viewerKey)
      throw errors.forbidden(
        "Only the comment author can change this share comment.",
      );
    if (
      comment.internal ||
      !(await publicShare(c, share, { versionId: comment.versionId })).assets
        .length
    )
      throw errors.notFound("This comment is no longer visible in this share.");
    return { share, projection, comment };
  };

  return {
    shareBySlug,
    issueViewer,
    authorizeExpiredShareMedia,
    LOGO_TYPES,
    LOGO_MAX_BYTES,
    logoKeyOf,
    SHARE_ASSET_PAGE,
    NO_ASSET,
    publicShare,
    publicShareAssetsWire,
    publicShareResponse,
    shareCommentForViewer,
  };
};

export type Shares = ReturnType<typeof createShares>;
