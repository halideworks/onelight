import { clientIp, jsonBody, getLimit, parseJsonObject } from "../helpers.js";
import { bodies } from "../schemas.js";
import { errors, zipEntryName } from "@onelight/core";
import {
  shareAssets,
  assets,
  renditions,
  assetVersions,
  captionTracks,
  projects,
} from "@onelight/db/schema";
import { eq, asc, and, isNull, desc, inArray } from "drizzle-orm";
import type { ZipEntry } from "@onelight/core";
import type { AppEnv, ApiRouter, Variables } from "../types.js";
import type { Context } from "hono";
import type { PublicShareAsset, Shares } from "../operation/shares.js";
import type { Identity } from "../operation/identity.js";
import { publicShareWire, shareIsWatermarked } from "../wire.js";
import type { Blobs } from "../operation/blobs.js";
import type { Media } from "../operation/media.js";

export const registerPublicSharesRoutes = (
  api: ApiRouter,
  root: ApiRouter,
  env: AppEnv,
  {
    sharesOps,
    identity,
    blobs,
    media,
  }: { sharesOps: Shares; identity: Identity; blobs: Blobs; media: Media },
) => {
  const {
    shareBySlug,
    issueViewer,
    logoKeyOf,
    LOGO_TYPES,
    publicShareResponse,
    publicShare,
    SHARE_ASSET_PAGE,
    publicShareAssetsWire,
    authorizeExpiredShareMedia,
  } = sharesOps;
  const { hitRateLimit } = identity;
  const {
    blobContentType,
    attachmentDisposition,
    sanitizeDisposition,
    serveBlob,
    requireBlobStore,
    serveZip,
  } = blobs;
  const {
    watermarkedRenditionFor,
    publicMediaUrl,
    DOWNLOAD_TOKEN_TTL_MS,
    verifyMediaToken,
    shareMediaPolicy,
  } = media;

  const shareAccess = async (
    c: Context<{ Variables: Variables }, "/s/:slug/access">,
  ) => {
    const share = await shareBySlug(c.req.param("slug"));
    const ip = clientIp(c, env);
    await hitRateLimit(`share_access:${share.id}:${ip}`, 20, 5 * 60 * 1000);
    const body = await jsonBody(c, bodies.shareAccess);
    if (
      share.passphraseHash &&
      (!body.passphrase ||
        !(await env.hasher.verify(body.passphrase, share.passphraseHash)))
    )
      throw errors.invalidCredentials();
    const viewer = await issueViewer(c, share, body.name, body.email);
    return c.json({
      share: publicShareWire(share),
      viewer_key: viewer.viewerKey,
    });
  };
  api.post("/s/:slug/access", shareAccess);
  root.post("/s/:slug/access", shareAccess);

  /* The share's logo, public by the slug's secrecy like the page itself:
     it draws on the access prompt, before any viewer exists. */
  api.get("/s/:slug/logo", async (c) => {
    const share = await shareBySlug(c.req.param("slug"));
    const key = logoKeyOf(share);
    if (!key || !env.blobStore) throw errors.notFound();
    const extension = key.split(".").pop() ?? "png";
    const contentType =
      Object.entries(LOGO_TYPES).find(([, ext]) => ext === extension)?.[0] ??
      "image/png";
    const stream = await env.blobStore.getStream(key);
    return new Response(stream, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400",
        /* A logo may be an SVG, and an SVG opened as a top-level document runs
           its own script -- so a manager could upload a scripted mark and lure
           a viewer to this public URL to run it in our origin. The sandbox
           directive (no allow-scripts) neutralises that on direct navigation
           while leaving <img> rendering, where SVG never executes, untouched.
           nosniff stops a mislabelled blob from being sniffed into HTML. */
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  /* The unfurl picture og.ts points crawlers at: the first asset's poster,
     public by the slug's secrecy. Passphrase-protected shares serve nothing;
     unfurls outlive chats, and the passphrase is what stands between them
     and the content. */
  api.get("/s/:slug/unfurl.png", async (c) => {
    const share = await shareBySlug(c.req.param("slug"));
    if (share.passphraseHash !== null) throw errors.notFound();
    if (!env.blobStore) throw errors.notFound();
    const first = (
      await env.db
        .select({ assetId: shareAssets.assetId })
        .from(shareAssets)
        .where(eq(shareAssets.shareId, share.id))
        .orderBy(asc(shareAssets.sortOrder))
        .limit(1)
        .all()
    )[0];
    if (!first) throw errors.notFound();
    const asset = (
      await env.db
        .select({
          currentVersionId: assets.currentVersionId,
          thumbnailBlobKey: assets.thumbnailBlobKey,
        })
        .from(assets)
        .where(eq(assets.id, first.assetId))
        .limit(1)
        .all()
    )[0];
    if (!asset?.currentVersionId) throw errors.notFound();
    const poster = (
      await env.db
        .select({ blobKey: renditions.blobKey })
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
    /* The chosen thumbnail is the picture of this share in every other
       surface; the link preview is not the place to disagree. */
    const key = asset.thumbnailBlobKey ?? poster?.blobKey;
    if (!key) throw errors.notFound();
    const stream = await env.blobStore.getStream(key);
    return new Response(stream, {
      headers: {
        "Content-Type": await blobContentType(key),
        "Cache-Control": "public, max-age=3600",
      },
    });
  });

  root.get("/s/:slug", async (c) =>
    c.json(
      await publicShareResponse(
        await publicShare(c, await shareBySlug(c.req.param("slug"))),
      ),
    ),
  );

  /* The room opens on its first page and asks for the rest as the viewer
     scrolls. A share can hold an entire delivery; sending all of it in the
     first payload, and drawing all of it, is what a room of that size cannot
     survive. next_cursor is null when there is no more, which is what every
     existing client sees on an ordinary share. */
  api.get("/s/:slug", async (c) =>
    c.json(
      await publicShareResponse(
        await publicShare(c, await shareBySlug(c.req.param("slug")), {
          limit: SHARE_ASSET_PAGE,
        }),
      ),
    ),
  );

  api.get("/s/:slug/assets", async (c) => {
    const projection = await publicShare(
      c,
      await shareBySlug(c.req.param("slug")),
      {
        limit: Math.min(
          SHARE_ASSET_PAGE,
          getLimit(c.req.query("limit")) || SHARE_ASSET_PAGE,
        ),
        ...(c.req.query("cursor") ? { cursor: c.req.query("cursor") } : {}),
      },
    );
    if (!projection.viewer) throw errors.unauthorized();
    return c.json({
      items: await publicShareAssetsWire(projection.share, projection.assets),
      next_cursor: projection.nextCursor,
    });
  });

  api.get("/s/:slug/assets/:assetId", async (c) => {
    const projection = await publicShare(
      c,
      await shareBySlug(c.req.param("slug")),
      { assetId: c.req.param("assetId") },
    );
    if (!projection.viewer) throw errors.unauthorized();
    const asset = projection.assets.find(
      (candidate: PublicShareAsset) => candidate.id === c.req.param("assetId"),
    );
    if (!asset) throw errors.notFound();
    const versions = await env.db
      .select()
      .from(assetVersions)
      .where(
        and(
          eq(assetVersions.assetId, asset.id),
          isNull(assetVersions.deletedAt),
        ),
      )
      .orderBy(desc(assetVersions.versionNo))
      .all();
    const visibleVersions = projection.share.showAllVersions
      ? versions
      : versions.filter((version) => version.id === asset.currentVersionId);
    const share = projection.share;
    const watermarked = shareIsWatermarked(share) && asset.kind === "video";
    /* proxy_audio rides the same list: for an audio asset it is the whole
       ladder, and a room that can play a video source can play this one. */
    const proxyKinds = [
      "proxy_540",
      "proxy_1080",
      "proxy_2160",
      "hdr_av1",
      "hdr_hevc",
      "proxy_audio",
    ];
    const items = [];
    for (const version of visibleVersions) {
      const versionRenditions = await env.db
        .select()
        .from(renditions)
        .where(
          and(eq(renditions.versionId, version.id), isNull(renditions.shareId)),
        )
        .all();
      // Playable ladder with signed URLs, watermark-aware: a watermarked
      // share exposes only the burned rendition for the current spec hash
      // (currently 1080-based, so the ladder is that single rung); an
      // unwatermarked share exposes every proxy rung that exists.
      const sources: Array<{
        kind: string;
        url: string;
        size: number;
        height: number | null;
        meta: Record<string, unknown>;
      }> = [];
      let watermarkState: "ready" | "processing" | null = null;
      const heightOf = (meta: Record<string, unknown>): number | null =>
        typeof meta.height === "number" ? meta.height : null;
      if (watermarked) {
        const burned = await watermarkedRenditionFor(share, version.id);
        watermarkState = burned ? "ready" : "processing";
        if (burned && env.blobStore)
          sources.push({
            kind: "watermarked",
            url: await publicMediaUrl(
              share,
              asset.id,
              version.id,
              burned.blobKey,
            ),
            size: burned.size,
            height: heightOf(parseJsonObject(burned.metaJson)),
            meta: parseJsonObject(burned.metaJson),
          });
      } else if (env.blobStore) {
        for (const rendition of versionRenditions as Array<
          typeof renditions.$inferSelect
        >) {
          if (!proxyKinds.includes(rendition.kind)) continue;
          sources.push({
            kind: rendition.kind,
            url: await publicMediaUrl(
              share,
              asset.id,
              version.id,
              rendition.blobKey,
            ),
            size: rendition.size,
            height: heightOf(parseJsonObject(rendition.metaJson)),
            meta: parseJsonObject(rendition.metaJson),
          });
        }
      }
      // Sidecars are watermark-neutral (no footage pixels beyond thumbnails).
      const spriteRendition = (
        versionRenditions as Array<typeof renditions.$inferSelect>
      ).find((rendition) => rendition.kind === "sprite");
      const peaksRendition = (
        versionRenditions as Array<typeof renditions.$inferSelect>
      ).find((rendition) => rendition.kind === "audio_peaks");
      const waveformRendition = (
        versionRenditions as Array<typeof renditions.$inferSelect>
      ).find((rendition) => rendition.kind === "waveform_data");
      const spectrogramRendition = (
        versionRenditions as Array<typeof renditions.$inferSelect>
      ).find((rendition) => rendition.kind === "spectrogram");
      const reference1xRendition = (
        versionRenditions as Array<typeof renditions.$inferSelect>
      ).find((rendition) => rendition.kind === "reference_audio_1x");
      const shuttle2xRendition = (
        versionRenditions as Array<typeof renditions.$inferSelect>
      ).find((rendition) => rendition.kind === "shuttle_audio_2x");
      const shuttle4xRendition = (
        versionRenditions as Array<typeof renditions.$inferSelect>
      ).find((rendition) => rendition.kind === "shuttle_audio_4x");
      const spriteMeta = spriteRendition
        ? parseJsonObject(spriteRendition.metaJson)
        : {};
      const vttKey =
        typeof spriteMeta.vtt_blob_key === "string"
          ? spriteMeta.vtt_blob_key
          : undefined;
      const sidecars = {
        sprite:
          spriteRendition && env.blobStore
            ? {
                url: await publicMediaUrl(
                  share,
                  asset.id,
                  version.id,
                  spriteRendition.blobKey,
                ),
                vtt_url: vttKey
                  ? await publicMediaUrl(share, asset.id, version.id, vttKey)
                  : null,
              }
            : null,
        peaks:
          peaksRendition && env.blobStore
            ? {
                url: await publicMediaUrl(
                  share,
                  asset.id,
                  version.id,
                  peaksRendition.blobKey,
                ),
              }
            : null,
        waveform:
          waveformRendition && env.blobStore
            ? {
                url: await publicMediaUrl(
                  share,
                  asset.id,
                  version.id,
                  waveformRendition.blobKey,
                ),
                meta: parseJsonObject(waveformRendition.metaJson),
              }
            : null,
        spectrogram:
          spectrogramRendition && env.blobStore
            ? {
                url: await publicMediaUrl(
                  share,
                  asset.id,
                  version.id,
                  spectrogramRendition.blobKey,
                ),
              }
            : null,
        shuttle_audio: {
          x1:
            reference1xRendition && env.blobStore
              ? await publicMediaUrl(
                  share,
                  asset.id,
                  version.id,
                  reference1xRendition.blobKey,
                )
              : null,
          x2:
            shuttle2xRendition && env.blobStore
              ? await publicMediaUrl(
                  share,
                  asset.id,
                  version.id,
                  shuttle2xRendition.blobKey,
                )
              : null,
          x4:
            shuttle4xRendition && env.blobStore
              ? await publicMediaUrl(
                  share,
                  asset.id,
                  version.id,
                  shuttle4xRendition.blobKey,
                )
              : null,
        },
        captions: env.blobStore
          ? await Promise.all(
              (
                (await env.db
                  .select()
                  .from(captionTracks)
                  .where(eq(captionTracks.versionId, version.id))
                  .orderBy(asc(captionTracks.language))
                  .all()) as Array<typeof captionTracks.$inferSelect>
              ).map(async (track) => ({
                language: track.language,
                label: track.label,
                url: await publicMediaUrl(
                  share,
                  asset.id,
                  version.id,
                  track.blobKey,
                ),
              })),
            )
          : [],
      };
      items.push({
        id: version.id,
        version_no: version.versionNo,
        media_info: parseJsonObject(version.mediaInfoJson),
        /* Source color tags, so the room resolves the same display transfer
           an editor sees on the project page. Technical file metadata only. */
        color: parseJsonObject(version.colorJson),
        transcode_status: version.transcodeStatus,
        renditions: versionRenditions.map(
          (rendition: typeof renditions.$inferSelect) => ({
            id: rendition.id,
            kind: rendition.kind,
            meta: parseJsonObject(rendition.metaJson),
            size: rendition.size,
          }),
        ),
        sources,
        sidecars,
        watermark: watermarkState,
      });
    }
    return c.json({
      asset: {
        id: asset.id,
        name: asset.name,
        kind: asset.kind,
        status: asset.status,
        /* The editor's reference-render transfer override, read-only here:
           the share room must show the same picture the project page does. */
        display_transfer: asset.displayTransfer ?? null,
      },
      versions: items,
    });
  });

  api.post("/s/:slug/assets/:assetId/playback-diagnostics", async (c) => {
    const projection = await publicShare(
      c,
      await shareBySlug(c.req.param("slug")),
      { assetId: c.req.param("assetId") },
    );
    if (!projection.viewer) throw errors.unauthorized();
    const asset = projection.assets.find(
      (candidate: typeof assets.$inferSelect & { sort_order: number }) =>
        candidate.id === c.req.param("assetId"),
    );
    if (!asset?.currentVersionId) throw errors.notFound();
    await hitRateLimit(
      `share_playback_diagnostic:${projection.share.id}:${projection.viewer.viewerKey}:${asset.currentVersionId}`,
      12,
      5 * 60 * 1000,
    );
    const diagnostic = await jsonBody(c, bodies.playbackDiagnostic);
    console.warn(
      `[onelight-playback-diagnostic] ${JSON.stringify({
        scope: "share",
        request_id: c.get("requestId"),
        share_id: projection.share.id,
        asset_id: asset.id,
        version_id: asset.currentVersionId,
        viewer_id: projection.viewer.id,
        user_agent: c.req.header("user-agent") ?? null,
        client_platform: c.req.header("sec-ch-ua-platform") ?? null,
        client_brands: c.req.header("sec-ch-ua") ?? null,
        recorded_at: env.clock.now(),
        ...diagnostic,
      })}`,
    );
    return c.body(null, 204);
  });

  api.get("/s/:slug/assets/:assetId/media", async (c) => {
    const projection = await publicShare(
      c,
      await shareBySlug(c.req.param("slug")),
      { assetId: c.req.param("assetId") },
    );
    if (!projection.viewer) throw errors.unauthorized();
    const asset = projection.assets.find(
      (candidate: typeof assets.$inferSelect & { sort_order: number }) =>
        candidate.id === c.req.param("assetId"),
    );
    if (!asset?.currentVersionId || !env.blobStore) throw errors.notFound();
    const share = projection.share;
    if (shareIsWatermarked(share)) {
      // Watermarked shares serve ONLY the burned rendition registered for
      // this share under the current spec hash. While it is missing (still
      // rendering, or the spec just changed) the response is 202
      // {status: "processing"}; the clean proxy is never a fallback.
      const watermarked = await watermarkedRenditionFor(
        share,
        asset.currentVersionId,
      );
      if (!watermarked) return c.json({ status: "processing" }, 202);
      return c.json({
        url: await publicMediaUrl(
          share,
          asset.id,
          asset.currentVersionId,
          watermarked.blobKey,
        ),
        expires_at: env.clock.now() + 15 * 60 * 1000,
      });
    }
    /* Video serves the review proxy; a still serves the review rung of its
       ladder. Without this, image assets in a share answered 404 forever.
       Audio serves its own proxy for the same reason: the original may be a
       24-bit WAV no browser will play, exactly as a TIFF or a PSD is not
       something a browser will draw. */
    const renditionRows = (await env.db
      .select()
      .from(renditions)
      .where(
        and(
          eq(renditions.versionId, asset.currentVersionId),
          inArray(renditions.kind, [
            "proxy_1080",
            "proxy_audio",
            "still_review",
            "still_tiles",
          ]),
          isNull(renditions.shareId),
        ),
      )
      .all()) as Array<typeof renditions.$inferSelect>;
    /* Preference by asset kind, not by a fixed order: an audio asset must
       never be handed a still, and a video whose peaks landed first must not
       be handed anything but its proxy. */
    const preferredKinds =
      asset.kind === "audio"
        ? ["proxy_audio"]
        : asset.kind === "image"
          ? /* The 2048 review still, or the retired 4096 tile for a version
               transcoded before the stills ladder. */
            ["still_review", "still_tiles"]
          : ["proxy_1080"];
    const rendition =
      preferredKinds
        .map((kind) => renditionRows.find((row) => row.kind === kind))
        .find(Boolean) ?? renditionRows[0];
    if (!rendition) throw errors.notFound("A review rendition is not ready.");
    return c.json({
      url: await publicMediaUrl(
        share,
        asset.id,
        asset.currentVersionId,
        rendition.blobKey,
      ),
      expires_at: env.clock.now() + 15 * 60 * 1000,
    });
  });

  // Share downloads, gated by allow_download. A watermarked share never
  // hands out the clean file in ANY mode: both proxy and original resolve to
  // the burned rendition (202 while it is still rendering).
  api.get("/s/:slug/assets/:assetId/download", async (c) => {
    const projection = await publicShare(
      c,
      await shareBySlug(c.req.param("slug")),
      { assetId: c.req.param("assetId") },
    );
    if (!projection.viewer) throw errors.unauthorized();
    const asset = projection.assets.find(
      (candidate: PublicShareAsset) => candidate.id === c.req.param("assetId"),
    );
    if (!asset) throw errors.notFound();
    const share = projection.share;
    // The policy answer precedes any storage dependency: disabled downloads
    // are 403 even when no rendition or blob store exists yet.
    if (share.allowDownload === "none")
      throw errors.forbidden("Downloads are disabled for this share.");
    if (!asset.currentVersionId || !env.blobStore) throw errors.notFound();
    const version = (
      await env.db
        .select()
        .from(assetVersions)
        .where(eq(assetVersions.id, asset.currentVersionId))
        .limit(1)
        .all()
    )[0];
    if (!version) throw errors.notFound();
    const baseName =
      version.originalFilename.replace(/\.[^.]+$/, "") || "download";
    const expiresAt = env.clock.now() + DOWNLOAD_TOKEN_TTL_MS;
    if (shareIsWatermarked(share)) {
      const watermarked = await watermarkedRenditionFor(share, version.id);
      if (!watermarked) return c.json({ status: "processing" }, 202);
      return c.json({
        url: await publicMediaUrl(
          share,
          asset.id,
          version.id,
          watermarked.blobKey,
          attachmentDisposition(`${baseName}-watermarked.mp4`),
        ),
        expires_at: expiresAt,
      });
    }
    /* A proxy-only share hands out the review file for anything that has
       one. Stills and documents have no lesser form, so they hand out the
       original -- the same rule the zip bundle keeps, which this endpoint
       used not to: an image in a proxy share answered "not ready" forever
       because it was looked up as a 1080 video proxy. */
    const proxyKindForDownload =
      asset.kind === "video"
        ? "proxy_1080"
        : asset.kind === "audio"
          ? "proxy_audio"
          : null;
    if (share.allowDownload === "proxy" && proxyKindForDownload) {
      const proxy = (
        await env.db
          .select()
          .from(renditions)
          .where(
            and(
              eq(renditions.versionId, version.id),
              eq(renditions.kind, proxyKindForDownload),
              isNull(renditions.shareId),
            ),
          )
          .limit(1)
          .all()
      )[0];
      if (!proxy) throw errors.notFound("A review rendition is not ready.");
      return c.json({
        url: await publicMediaUrl(
          share,
          asset.id,
          version.id,
          proxy.blobKey,
          attachmentDisposition(
            `${baseName}-proxy.${proxy.kind === "proxy_audio" ? "m4a" : "mp4"}`,
          ),
        ),
        expires_at: expiresAt,
      });
    }
    return c.json({
      url: await publicMediaUrl(
        share,
        asset.id,
        version.id,
        version.originalBlobKey,
        attachmentDisposition(version.originalFilename),
      ),
      expires_at: expiresAt,
    });
  });

  api.get("/s/:slug/assets/:assetId/media/file", async (c) => {
    const share = await shareBySlug(c.req.param("slug"));
    const token = c.req.query("token");
    if (!token || !env.blobStore) throw errors.unauthorized();
    let blobKey: string;
    let disposition: string | undefined;
    let payload: Record<string, unknown>;
    let expired: boolean;
    try {
      const verified = await verifyMediaToken(token);
      payload = verified.payload;
      expired = verified.expired;
      if (
        payload.share_id !== share.id ||
        payload.asset_id !== c.req.param("assetId") ||
        typeof payload.blob_key !== "string" ||
        typeof payload.version_id !== "string"
      )
        throw new Error("Token claims do not match this share asset.");
      blobKey = payload.blob_key;
      // Downloads carry an attachment disposition in the verified claim;
      // it is sanitized again before reaching the header.
      if (typeof payload.disposition === "string")
        disposition = sanitizeDisposition(payload.disposition);
    } catch {
      throw errors.unauthorized();
    }
    // Signed URLs remain capabilities, but cannot outlive the policy or
    // asset membership under which they were issued.
    if (
      (!expired || payload.access_policy !== undefined) &&
      payload.access_policy !== (await shareMediaPolicy(share))
    )
      throw errors.unauthorized();
    const visible = await env.db
      .select({ id: assets.id })
      .from(shareAssets)
      .innerJoin(assets, eq(shareAssets.assetId, assets.id))
      .innerJoin(assetVersions, eq(assetVersions.assetId, assets.id))
      .innerJoin(projects, eq(assets.projectId, projects.id))
      .where(
        and(
          eq(shareAssets.shareId, share.id),
          eq(assets.id, c.req.param("assetId")),
          eq(
            assetVersions.id,
            typeof payload.version_id === "string" ? payload.version_id : "",
          ),
          isNull(assets.deletedAt),
          isNull(assetVersions.deletedAt),
          share.showAllVersions
            ? undefined
            : eq(assets.currentVersionId, assetVersions.id),
        ),
      )
      .limit(1)
      .all();
    if (!visible.length) throw errors.notFound();
    if (expired)
      await authorizeExpiredShareMedia(
        c,
        share,
        c.req.param("assetId"),
        payload,
        blobKey,
      );
    return serveBlob(c, blobKey, disposition);
  });

  /* The whole share as one streamed zip, under the same policy as the
     per-file downloads: none refuses, original bundles the negatives, proxy
     bundles review files (originals for stills and documents, which have no
     lesser form). A watermarked share never bundles: the burned renditions
     download one at a time, and the clean files never leave in ANY mode. */
  api.get("/s/:slug/zip", async (c) => {
    const projection = await publicShare(
      c,
      await shareBySlug(c.req.param("slug")),
    );
    if (!projection.viewer) throw errors.unauthorized();
    const share = projection.share;
    if (share.allowDownload === "none")
      throw errors.forbidden("Downloads are disabled for this share.");
    if (shareIsWatermarked(share))
      throw errors.forbidden("Watermarked shares download one file at a time.");
    const store = requireBlobStore();
    const versionIds = projection.assets
      .map((asset: PublicShareAsset) => asset.currentVersionId)
      .filter((id: string | null): id is string => id !== null);
    if (!versionIds.length) throw errors.notFound("Nothing to download.");
    const versionRows = (await env.db
      .select()
      .from(assetVersions)
      .where(inArray(assetVersions.id, versionIds))
      .all()) as Array<typeof assetVersions.$inferSelect>;
    const versionsById = new Map(versionRows.map((row) => [row.id, row]));
    const proxyRows =
      share.allowDownload === "proxy"
        ? ((await env.db
            .select()
            .from(renditions)
            .where(
              and(
                inArray(renditions.versionId, versionIds),
                inArray(renditions.kind, ["proxy_1080", "proxy_audio"]),
                isNull(renditions.shareId),
              ),
            )
            .all()) as Array<typeof renditions.$inferSelect>)
        : [];
    const proxiesByVersion = new Map(
      proxyRows.map((row) => [row.versionId, row]),
    );
    const used = new Set<string>();
    const entries: ZipEntry[] = [];
    for (const asset of projection.assets) {
      const version = asset.currentVersionId
        ? versionsById.get(asset.currentVersionId)
        : undefined;
      if (!version) continue;
      let source: { size: number; blobKey: string; filename: string };
      /* Audio bundles its proxy for the same reason video does: a proxy
         bundle that quietly shipped 24-bit WAV originals would hand out the
         masters a "proxy only" share exists to withhold. */
      if (
        share.allowDownload === "proxy" &&
        (asset.kind === "video" || asset.kind === "audio")
      ) {
        const proxy = proxiesByVersion.get(version.id);
        /* A partial archive would read as complete; refuse instead. */
        if (!proxy)
          throw errors.conflict(
            "A review rendition is still processing. Try again shortly.",
          );
        const baseName =
          version.originalFilename.replace(/\.[^.]+$/, "") || "download";
        source = {
          size: proxy.size,
          blobKey: proxy.blobKey,
          filename: `${baseName}-proxy.${proxy.kind === "proxy_audio" ? "m4a" : "mp4"}`,
        };
      } else {
        source = {
          size: version.size,
          blobKey: version.originalBlobKey,
          filename: version.originalFilename,
        };
      }
      let name = zipEntryName(source.filename);
      if (used.has(name)) {
        const dot = name.lastIndexOf(".");
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const extension = dot > 0 ? name.slice(dot) : "";
        let suffix = 2;
        while (used.has(`${stem} (${suffix})${extension}`)) suffix += 1;
        name = `${stem} (${suffix})${extension}`;
      }
      used.add(name);
      entries.push({
        name,
        size: source.size,
        modifiedAt: version.createdAt,
        cacheKey: source.blobKey,
        open: () => store.getStream(source.blobKey),
        openRange: (from) => store.getStream(source.blobKey, { start: from }),
      });
    }
    if (!entries.length) throw errors.notFound("Nothing to download.");
    const zipName = `${
      share.title
        .replace(/[^\w.-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 80) || "share"
    }.zip`;
    return serveZip(c, entries, zipName);
  });
};
