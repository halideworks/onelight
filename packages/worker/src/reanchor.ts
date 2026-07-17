/* Re-anchoring: when notes carry forward onto a recut, their frame numbers
 * should follow the picture, not the arithmetic. The sprite sheet the
 * pipeline already makes for every version is a per-second visual index of
 * the footage, so matching tiles between two versions' sheets by perceptual
 * hash locates where a moment moved to -- without decoding any video.
 *
 * The safety property matters more than the cleverness: a tile that matches
 * nothing well enough returns null and the caller keeps the original frame.
 * Never move a note the pictures cannot vouch for.
 */

import sharp from "sharp";

export interface SpriteTileGeometry {
  /* Cue window in seconds of media time. */
  start: number;
  end: number;
  /* Tile rectangle in sprite-sheet pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
}

const timeFrom = (label: string): number | null => {
  const match = /^(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})$/.exec(label.trim());
  if (!match) return null;
  return (
    Number(match[1] ?? 0) * 3600 +
    Number(match[2]) * 60 +
    Number(match[3]) +
    Number(match[4]) / 1000
  );
};

/* The worker writes sprite VTTs with cues like
   00:00:01.000 --> 00:00:02.000 / sheet.jpg#xywh=160,0,160,90 */
export const parseSpriteVttTiles = (text: string): SpriteTileGeometry[] => {
  const tiles: SpriteTileGeometry[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const cue = /^\s*([\d:.]+)\s+-->\s+([\d:.]+)/.exec(line);
    if (!cue) continue;
    const start = timeFrom(cue[1] ?? "");
    const end = timeFrom(cue[2] ?? "");
    const target = /#xywh=(\d+),(\d+),(\d+),(\d+)\s*$/.exec(
      lines[index + 1] ?? "",
    );
    if (start === null || end === null || !target) continue;
    tiles.push({
      start,
      end,
      x: Number(target[1]),
      y: Number(target[2]),
      w: Number(target[3]),
      h: Number(target[4]),
    });
  }
  return tiles;
};

/* dHash per tile: 9x8 grayscale, one bit per horizontal gradient. Flat
   frames hash to zero and match each other, which is honest -- black is
   black in both cuts. */
export const spriteTileHashes = async (
  sheet: Buffer,
  tiles: SpriteTileGeometry[],
): Promise<bigint[]> => {
  const hashes: bigint[] = [];
  for (const tile of tiles) {
    const raw = await sharp(sheet)
      .extract({ left: tile.x, top: tile.y, width: tile.w, height: tile.h })
      .resize(9, 8, { fit: "fill" })
      .grayscale()
      .raw()
      .toBuffer();
    let hash = 0n;
    for (let y = 0; y < 8; y += 1)
      for (let x = 0; x < 8; x += 1)
        hash =
          (hash << 1n) |
          ((raw[y * 9 + x] ?? 0) > (raw[y * 9 + x + 1] ?? 0) ? 1n : 0n);
    hashes.push(hash);
  }
  return hashes;
};

export const hammingDistance = (a: bigint, b: bigint): number => {
  let x = a ^ b;
  let count = 0;
  while (x) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
};

/* For each source tile, the index of its best target tile, or null when
   nothing is close enough or the best match is ambiguous. Two defenses,
   both learned from footage that shares a look without sharing a cut:
   maxDistance keeps grade changes and proxy recompression matching while
   unrelated tiles do not, and the margin (a ratio-test cousin) refuses a
   best match that barely beats the runner-up -- similar-looking sets
   produce many near-ties, and a near-tie is not evidence. */
export const matchTiles = (
  source: readonly bigint[],
  target: readonly bigint[],
  maxDistance = 10,
  margin = 4,
): Array<number | null> =>
  source.map((hash) => {
    let best = -1;
    let bestDistance = 65;
    let secondDistance = 65;
    for (let index = 0; index < target.length; index += 1) {
      const distance = hammingDistance(hash, target[index] ?? 0n);
      if (distance < bestDistance) {
        secondDistance = bestDistance;
        bestDistance = distance;
        best = index;
      } else if (distance < secondDistance) {
        secondDistance = distance;
      }
    }
    return bestDistance <= maxDistance &&
      best >= 0 &&
      secondDistance - bestDistance >= margin
      ? best
      : null;
  });

/* Individually-plausible matches must also agree with each other: a real
   recut aligns two timelines with a dominantly consistent shift, while
   coincidental matches between unrelated cuts scatter. Matches outside one
   tile of the median shift are dropped, and if fewer than half (or two)
   agree, the whole mapping is refused. */
export const consensusMatches = (
  matches: ReadonlyArray<number | null>,
): Array<number | null> => {
  const shifts: number[] = [];
  matches.forEach((match, index) => {
    if (match !== null) shifts.push(match - index);
  });
  if (shifts.length < 2) return matches.map(() => null);
  const sorted = [...shifts].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const agreeing = shifts.filter(
    (shift) => Math.abs(shift - median) <= 1,
  ).length;
  if (agreeing < Math.max(2, Math.ceil(shifts.length / 2)))
    return matches.map(() => null);
  return matches.map((match, index) =>
    match !== null && Math.abs(match - index - median) <= 1 ? match : null,
  );
};

/* The full mapping: media time in the source version to media time in the
   target, through the matched tile pair, keeping the offset into the tile.
   Null when the moment's tile matched nothing. */
export const buildTimeRemap = (
  sourceTiles: readonly SpriteTileGeometry[],
  targetTiles: readonly SpriteTileGeometry[],
  matches: ReadonlyArray<number | null>,
): ((seconds: number) => number | null) => {
  return (seconds) => {
    let index = sourceTiles.findIndex(
      (tile) => seconds >= tile.start && seconds < tile.end,
    );
    if (index < 0 && sourceTiles.length) {
      const last = sourceTiles[sourceTiles.length - 1];
      if (last && seconds >= last.end) index = sourceTiles.length - 1;
    }
    if (index < 0) return null;
    const matched = matches[index];
    if (matched === null || matched === undefined) return null;
    const from = sourceTiles[index];
    const to = targetTiles[matched];
    if (!from || !to) return null;
    const offset = Math.min(
      Math.max(0, seconds - from.start),
      Math.max(0, to.end - to.start),
    );
    return to.start + offset;
  };
};
