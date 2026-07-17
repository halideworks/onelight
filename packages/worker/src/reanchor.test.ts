import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  buildTimeRemap,
  consensusMatches,
  hammingDistance,
  matchTiles,
  parseSpriteVttTiles,
  spriteTileHashes,
  type SpriteTileGeometry,
} from "./reanchor.js";

const TILE_W = 32;
const TILE_H = 18;

/* A deterministic, visually busy tile per seed: distinct dHashes without
   fixture files. */
const patternTile = (seed: number): Uint8Array => {
  const pixels = new Uint8Array(TILE_W * TILE_H);
  for (let y = 0; y < TILE_H; y += 1)
    for (let x = 0; x < TILE_W; x += 1)
      pixels[y * TILE_W + x] =
        (x * (seed * 13 + 3) + y * (seed * 7 + 5) + ((x * y * seed) % 31)) %
        256;
  return pixels;
};

const sheetFrom = async (seeds: number[]): Promise<Buffer> => {
  const sheet = new Uint8Array(TILE_W * seeds.length * TILE_H);
  seeds.forEach((seed, index) => {
    const tile = patternTile(seed);
    for (let y = 0; y < TILE_H; y += 1)
      for (let x = 0; x < TILE_W; x += 1)
        sheet[y * TILE_W * seeds.length + index * TILE_W + x] =
          tile[y * TILE_W + x] ?? 0;
  });
  return sharp(Buffer.from(sheet), {
    raw: { width: TILE_W * seeds.length, height: TILE_H, channels: 1 },
  })
    .png()
    .toBuffer();
};

const stripTiles = (count: number): SpriteTileGeometry[] =>
  Array.from({ length: count }, (_, index) => ({
    start: index,
    end: index + 1,
    x: index * TILE_W,
    y: 0,
    w: TILE_W,
    h: TILE_H,
  }));

describe("re-anchoring", () => {
  it("parses the sprite VTT the pipeline writes", () => {
    const vtt = [
      "WEBVTT",
      "",
      "1",
      "00:00:00.000 --> 00:00:01.000",
      "sprite.jpg#xywh=0,0,160,90",
      "",
      "2",
      "00:01:01.500 --> 00:01:02.500",
      "sprite.jpg#xywh=160,0,160,90",
      "",
    ].join("\n");
    const tiles = parseSpriteVttTiles(vtt);
    expect(tiles).toHaveLength(2);
    expect(tiles[0]).toEqual({ start: 0, end: 1, x: 0, y: 0, w: 160, h: 90 });
    expect(tiles[1]?.start).toBeCloseTo(61.5);
    expect(tiles[1]?.x).toBe(160);
  });

  it("follows a moment through a one-second head insert", async () => {
    // Target is the source with a new tile spliced in front: everything the
    // two cuts share sits one second later in the target.
    const sourceSheet = await sheetFrom([2, 3, 4, 5]);
    const targetSheet = await sheetFrom([9, 2, 3, 4, 5]);
    const sourceTiles = stripTiles(4);
    const targetTiles = stripTiles(5);
    const matches = consensusMatches(
      matchTiles(
        await spriteTileHashes(sourceSheet, sourceTiles),
        await spriteTileHashes(targetSheet, targetTiles),
      ),
    );
    expect(matches).toEqual([1, 2, 3, 4]);
    const remap = buildTimeRemap(sourceTiles, targetTiles, matches);
    expect(remap(1.5)).toBeCloseTo(2.5);
    expect(remap(0)).toBeCloseTo(1);
  });

  it("moves nothing when the pictures do not vouch for a match", async () => {
    const sourceSheet = await sheetFrom([2, 3]);
    const strangerSheet = await sheetFrom([40, 41]);
    const tiles = stripTiles(2);
    const matches = matchTiles(
      await spriteTileHashes(sourceSheet, tiles),
      await spriteTileHashes(strangerSheet, tiles),
    );
    expect(matches).toEqual([null, null]);
    const remap = buildTimeRemap(tiles, tiles, matches);
    expect(remap(0.5)).toBeNull();
  });

  it("hamming distance counts differing bits", () => {
    expect(hammingDistance(0n, 0n)).toBe(0);
    expect(hammingDistance(0b1011n, 0b0010n)).toBe(2);
  });

  it("refuses a lone match that disagrees with the field", () => {
    // Three matches agree on a shift of one; a fourth jumps twenty tiles.
    // The straggler dies, the consensus survives.
    expect(consensusMatches([1, 2, 3, 24, null])).toEqual([
      1,
      2,
      3,
      null,
      null,
    ]);
    // One or zero plausible matches is not an alignment at all.
    expect(consensusMatches([5, null, null])).toEqual([null, null, null]);
    // A scattered field with no majority is refused wholesale.
    expect(consensusMatches([9, 2, 30, 17])).toEqual([null, null, null, null]);
  });
});
