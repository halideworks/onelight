/* The Node server's frameMatcher: sprite sheets and their VTTs come off the
 * blob volume, tiles hash with sharp, and the mapping walks source frames to
 * target frames through matched tile pairs. Every failure path returns null,
 * which the carry-forward reads as "keep the frames"; re-anchoring is a
 * refinement, never a gate.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import {
  buildTimeRemap,
  consensusMatches,
  matchTiles,
  parseSpriteVttTiles,
  spriteTileHashes,
} from "@onelight/worker";
import { assetVersions, renditions } from "@onelight/db/schema";
import type { AppDb } from "@onelight/db";

interface SpriteIndex {
  tiles: ReturnType<typeof parseSpriteVttTiles>;
  hashes: bigint[];
  rate: { num: number; den: number };
  durationFrames: number | null;
}

const spriteIndexFor = async (
  db: AppDb,
  blobRoot: string,
  versionId: string,
): Promise<SpriteIndex | null> => {
  const version = (
    await db
      .select()
      .from(assetVersions)
      .where(eq(assetVersions.id, versionId))
      .limit(1)
      .all()
  )[0];
  if (!version || !version.frameRateNum || !version.frameRateDen) return null;
  const sprite = (
    await db
      .select()
      .from(renditions)
      .where(
        and(
          eq(renditions.versionId, versionId),
          eq(renditions.kind, "sprite"),
          isNull(renditions.shareId),
        ),
      )
      .limit(1)
      .all()
  )[0];
  if (!sprite) return null;
  let vttKey: string | undefined;
  try {
    const meta = JSON.parse(sprite.metaJson) as Record<string, unknown>;
    vttKey =
      typeof meta.vtt_blob_key === "string" ? meta.vtt_blob_key : undefined;
  } catch {
    return null;
  }
  if (!vttKey) return null;
  try {
    const [sheet, vtt] = await Promise.all([
      readFile(path.join(blobRoot, sprite.blobKey)),
      readFile(path.join(blobRoot, vttKey), "utf8"),
    ]);
    const tiles = parseSpriteVttTiles(vtt);
    if (!tiles.length) return null;
    return {
      tiles,
      hashes: await spriteTileHashes(sheet, tiles),
      rate: { num: version.frameRateNum, den: version.frameRateDen },
      durationFrames: version.durationFrames,
    };
  } catch {
    return null;
  }
};

export const spriteFrameMatcher =
  (db: AppDb, blobRoot: string) =>
  async (
    sourceVersionId: string,
    targetVersionId: string,
  ): Promise<((frame: number) => number | null) | null> => {
    const [source, target] = await Promise.all([
      spriteIndexFor(db, blobRoot, sourceVersionId),
      spriteIndexFor(db, blobRoot, targetVersionId),
    ]);
    if (!source || !target) return null;
    const matches = consensusMatches(matchTiles(source.hashes, target.hashes));
    if (!matches.some((match) => match !== null)) return null;
    const remapTime = buildTimeRemap(source.tiles, target.tiles, matches);
    const sourceFps = source.rate.num / source.rate.den;
    const targetFps = target.rate.num / target.rate.den;
    return (frame) => {
      const seconds = remapTime(frame / sourceFps);
      if (seconds === null) return null;
      const mapped = Math.round(seconds * targetFps);
      const last =
        target.durationFrames !== null && target.durationFrames !== undefined
          ? target.durationFrames - 1
          : null;
      return Math.max(0, last === null ? mapped : Math.min(last, mapped));
    };
  };
