import { jwtVerify, compactVerify, SignJWT } from "jose";
import type { shares } from "@onelight/db/schema";
import {
  renditions,
  assets,
  assetVersions,
  exportJobs,
} from "@onelight/db/schema";
import { sha256Hex, errors } from "@onelight/core";
import { and, eq, isNull } from "drizzle-orm";
import { parseJsonObject } from "../helpers.js";
import type { AppEnv, ActorUser } from "../types.js";
import type { Access } from "./access.js";

export const createMedia = (env: AppEnv, access: Access) => {
  const { requireProject } = access;

  /* Download URLs live twelve hours so an interrupted multi-hundred-GB pull
     can resume long after it started; playback URLs stay short. A token
     carrying an attachment disposition IS a download, so the TTL follows
     the disposition and no call site can get it wrong. */
  const DOWNLOAD_TOKEN_TTL = "12h";

  const DOWNLOAD_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

  const mediaSigningKey = new TextEncoder().encode(env.config.SECRET_KEY);

  const verifyMediaToken = async (
    token: string,
  ): Promise<{
    payload: Record<string, unknown>;
    expired: boolean;
  }> => {
    try {
      const verified = await jwtVerify(token, mediaSigningKey);
      return {
        payload: verified.payload,
        expired: false,
      };
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ERR_JWT_EXPIRED"
      )
        throw error;
      const verified = await compactVerify(token, mediaSigningKey);
      if (verified.protectedHeader.alg !== "HS256")
        throw new Error("Media token algorithm is invalid.");
      const parsed = JSON.parse(
        new TextDecoder().decode(verified.payload),
      ) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("Media token payload is invalid.");
      return {
        payload: parsed as Record<string, unknown>,
        expired: true,
      };
    }
  };

  const shareMediaPolicy = (
    share: typeof shares.$inferSelect,
  ): Promise<string> =>
    sha256Hex(
      JSON.stringify([
        share.passphraseHash,
        share.watermarkSpecHash,
        share.allowDownload,
        share.showAllVersions,
      ]),
    );

  const issueMediaToken = async (
    share: typeof shares.$inferSelect,
    assetId: string,
    versionId: string,
    blobKey: string,
    disposition?: string,
  ) =>
    new SignJWT({
      share_id: share.id,
      asset_id: assetId,
      version_id: versionId,
      blob_key: blobKey,
      access_policy: await shareMediaPolicy(share),
      ...(disposition ? { disposition } : {}),
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(disposition ? DOWNLOAD_TOKEN_TTL : "15m")
      .sign(mediaSigningKey);

  const publicMediaUrl = async (
    share: typeof shares.$inferSelect,
    assetId: string,
    versionId: string,
    blobKey: string,
    disposition?: string,
  ) =>
    /* Origin-relative on purpose: the page fetches these from whatever origin
       it was loaded on, so the same deployment works via LAN IP and the public
       domain without PUBLIC_URL having to match the request. Links that leave
       the browser (emails, OG tags, the copyable share URL) still use
       PUBLIC_URL. */
    `/s/${share.slug}/assets/${assetId}/media/file?token=${encodeURIComponent(await issueMediaToken(share, assetId, versionId, blobKey, disposition))}`;

  /**
   * The watermarked rendition this share may serve for a version: kind
   * "watermarked", registered for this share, and carrying the share's
   * CURRENT watermark_spec_hash in its meta. A spec change invalidates the
   * old rendition immediately (its hash no longer matches) even before the
   * superseded row is cleaned up.
   */
  const watermarkedRenditionFor = async (
    share: typeof shares.$inferSelect,
    versionId: string,
  ): Promise<typeof renditions.$inferSelect | undefined> => {
    if (!share.watermarkSpecHash) return undefined;
    const rows = await env.db
      .select()
      .from(renditions)
      .where(
        and(
          eq(renditions.versionId, versionId),
          eq(renditions.kind, "watermarked"),
          eq(renditions.shareId, share.id),
        ),
      )
      .all();
    return rows.find(
      (rendition: typeof renditions.$inferSelect) =>
        parseJsonObject(rendition.metaJson).spec_hash ===
        share.watermarkSpecHash,
    );
  };

  /* Private media is authorized against its current project on every request.
     The signed scope identifies that project without trusting the blob path. */
  type MediaScope =
    { versionId: string } | { projectId: string } | { exportId: string };

  const mediaScopeClaim = (scope: MediaScope): Record<string, string> =>
    "versionId" in scope
      ? { version_id: scope.versionId }
      : "projectId" in scope
        ? { project_id: scope.projectId }
        : { export_id: scope.exportId };

  const issuePrivateMediaToken = async (
    scope: MediaScope,
    blobKey: string,
    disposition?: string,
  ) =>
    new SignJWT({
      ...mediaScopeClaim(scope),
      blob_key: blobKey,
      ...(disposition ? { disposition } : {}),
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(disposition ? DOWNLOAD_TOKEN_TTL : "15m")
      .sign(mediaSigningKey);

  const authorizePrivateMedia = async (
    payload: Record<string, unknown>,
    actor: ActorUser,
  ): Promise<void> => {
    if (typeof payload.version_id === "string") {
      const row = (
        await env.db
          .select({ projectId: assets.projectId })
          .from(assetVersions)
          .innerJoin(assets, eq(assetVersions.assetId, assets.id))
          .where(
            and(
              eq(assetVersions.id, payload.version_id),
              isNull(assetVersions.deletedAt),
              isNull(assets.deletedAt),
            ),
          )
          .limit(1)
          .all()
      )[0];
      if (!row) throw errors.notFound();
      await requireProject(row.projectId, actor, "viewer");
      return;
    }
    if (typeof payload.project_id === "string") {
      await requireProject(payload.project_id, actor, "viewer");
      return;
    }
    if (typeof payload.export_id === "string") {
      const row = (
        await env.db
          .select({ projectId: exportJobs.projectId })
          .from(exportJobs)
          .where(eq(exportJobs.id, payload.export_id))
          .limit(1)
          .all()
      )[0];
      if (!row) throw errors.notFound();
      await requireProject(row.projectId, actor, "viewer");
      return;
    }
    throw errors.unauthorized();
  };

  const privateMediaUrl = async (
    scope: MediaScope,
    blobKey: string,
    disposition?: string,
  ) =>
    /* Origin-relative for the same reason as publicMediaUrl above. */
    `/api/v1/media/${blobKey.split("/").map(encodeURIComponent).join("/")}?token=${encodeURIComponent(await issuePrivateMediaToken(scope, blobKey, disposition))}`;

  // Posters and sprites for a whole share listing, in one rendition query.
  //
  // The app's own grid resolves posters per asset through the internal
  // versions and renditions endpoints, which a share viewer cannot reach; a
  // share also has no reason to spend a request per tile. Poster pixels follow
  // the sidecar policy in the asset detail below: thumbnail-scale frames are
  // exposed even on a watermarked share, whose sprite already carries them.
  /* What stands in for a poster, best first. Wherever a tile is drawn this is
     the order it is looked for, so an asset with any rendered picture at all
     shows one. */
  const POSTER_FALLBACK_KINDS = [
    "poster",
    "still_review",
    "still_tiles",
  ] as const;

  const posterRank = (kind: string): number => {
    const index = (POSTER_FALLBACK_KINDS as readonly string[]).indexOf(kind);
    return index === -1 ? POSTER_FALLBACK_KINDS.length : index;
  };

  return {
    DOWNLOAD_TOKEN_TTL,
    DOWNLOAD_TOKEN_TTL_MS,
    verifyMediaToken,
    shareMediaPolicy,
    publicMediaUrl,
    watermarkedRenditionFor,
    authorizePrivateMedia,
    privateMediaUrl,
    POSTER_FALLBACK_KINDS,
    posterRank,
  };
};

export type Media = ReturnType<typeof createMedia>;
