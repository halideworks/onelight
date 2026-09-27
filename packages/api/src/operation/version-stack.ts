import { SignJWT, jwtVerify } from "jose";
import { eq, asc, sql } from "drizzle-orm";
import { assets, assetVersions } from "@onelight/db/schema";
import { errors, sha256Hex } from "@onelight/core";
import { z } from "zod";
import type { AppEnv, ActorUser } from "../types.js";
import type { stackState } from "../schemas.js";

export type StackState = z.infer<typeof stackState>;
export const stackDigest = (state: StackState): Promise<string> =>
  sha256Hex(
    JSON.stringify({
      asset_id: state.asset_id,
      current_version_id: state.current_version_id,
      versions: [...state.versions].sort((a, b) => a.version_no - b.version_no),
    }),
  );

export const readVersionStack = async (
  env: AppEnv,
  assetId: string,
): Promise<{
  state: StackState;
  versions: Array<typeof assetVersions.$inferSelect>;
}> => {
  const rows = await env.db
    .select({ current: assets.currentVersionId, version: assetVersions })
    .from(assets)
    .leftJoin(assetVersions, eq(assetVersions.assetId, assets.id))
    .where(eq(assets.id, assetId))
    .orderBy(asc(assetVersions.versionNo))
    .all();
  const first = rows[0];
  if (!first) throw errors.notFound("Asset was not found.");
  const versions = rows.flatMap((row) => (row.version ? [row.version] : []));
  return {
    versions,
    state: {
      asset_id: assetId,
      current_version_id: first.current,
      versions: versions.map((version) => ({
        id: version.id,
        version_no: version.versionNo,
      })),
    },
  };
};

/* Membership and the current pointer are compared in the write itself. JSON
   keeps the bind count constant even for a long-running version stack. */
export const stackPredicate = (state: StackState) => sql`
  ${assets.id} = ${state.asset_id} AND ${assets.deletedAt} IS NULL
  AND ${assets.currentVersionId} IS ${state.current_version_id}
  AND (SELECT json_group_array(json_object('id', id, 'version_no', version_no))
       FROM (SELECT id, version_no FROM asset_versions WHERE asset_id = ${state.asset_id} ORDER BY version_no))
      = ${JSON.stringify([...state.versions].sort((a, b) => a.version_no - b.version_no))}`;

const claim = z.object({
  action: z.enum(["unstack", "restack"]),
  project_id: z.string(),
  version_id: z.string(),
  asset_id: z.string(),
  current_version_id: z.string().nullable(),
  expected_digest: z.string(),
  version_no: z.number().int().positive().optional(),
  detached_id: z.string().optional(),
  detached_updated_at: z.number().int().optional(),
});
export type StackClaim = z.infer<typeof claim>;
const PURPOSE = "onelight.version-stack.undo.v1";

export const signStackUndo = (
  env: AppEnv,
  actor: ActorUser,
  data: StackClaim,
): Promise<string> =>
  new SignJWT(data)
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(PURPOSE)
    .setSubject(actor.id)
    .setIssuedAt(Math.floor(env.clock.now() / 1000))
    .setExpirationTime(Math.floor(env.clock.now() / 1000) + 7 * 86400)
    .sign(new TextEncoder().encode(env.config.SECRET_KEY));

export const verifyStackUndo = async (
  env: AppEnv,
  actor: ActorUser,
  token: string,
  action: StackClaim["action"],
  projectId: string,
  versionId: string,
  expected: StackState,
): Promise<StackClaim> => {
  try {
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(env.config.SECRET_KEY),
      {
        algorithms: ["HS256"],
        audience: PURPOSE,
        subject: actor.id,
        currentDate: new Date(env.clock.now()),
      },
    );
    const data = claim.parse(payload);
    if (
      data.action !== action ||
      data.project_id !== projectId ||
      data.version_id !== versionId ||
      data.expected_digest !== (await stackDigest(expected))
    )
      throw new Error("Wrong undo scope.");
    return data;
  } catch {
    throw errors.conflict("This version undo is invalid or has expired.");
  }
};
