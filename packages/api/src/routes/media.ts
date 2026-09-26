import { requireAuth } from "../auth.js";
import { errors } from "@onelight/core";
import { userFromContext } from "../helpers.js";
import type { AppEnv, ApiRouter } from "../types.js";
import type { Media } from "../operation/media.js";
import type { Blobs } from "../operation/blobs.js";

export const registerMediaRoutes = (
  api: ApiRouter,
  env: AppEnv,
  { media, blobs }: { media: Media; blobs: Blobs },
) => {
  const { verifyMediaToken, authorizePrivateMedia } = media;
  const { sanitizeDisposition, serveBlob } = blobs;

  api.get("/media/*", requireAuth, async (c) => {
    if (!env.blobStore)
      throw errors.internal("Blob storage is not configured.");
    const rawKey = c.req.path.split("/media/")[1];
    if (!rawKey) throw errors.notFound();
    let key: string;
    try {
      key =
        rawKey
          .split("?")[0]
          ?.split("/")
          .map((part) => decodeURIComponent(part))
          .join("/") ?? "";
    } catch {
      throw errors.notFound();
    }
    const token = c.req.query("token");
    if (!token) throw errors.unauthorized();
    let disposition: string | undefined;
    let payload: Record<string, unknown>;
    let expired: boolean;
    try {
      const verified = await verifyMediaToken(token);
      payload = verified.payload;
      expired = verified.expired;
      const scoped =
        typeof payload.version_id === "string" ||
        typeof payload.project_id === "string" ||
        typeof payload.export_id === "string";
      if (payload.blob_key !== key || !scoped)
        throw new Error("Token claims do not match this media key.");
      // Content-disposition comes from the verified claim only, sanitized.
      if (typeof payload.disposition === "string")
        disposition = sanitizeDisposition(payload.disposition);
    } catch {
      throw errors.unauthorized();
    }
    if (expired && payload.disposition !== undefined)
      throw errors.unauthorized();
    await authorizePrivateMedia(payload, userFromContext(c));
    return serveBlob(c, key, disposition);
  });
};
