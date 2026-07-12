import { describe, expect, it } from "vitest";
import {
  cueAtTime,
  filmstripTiles,
  parseSpriteVtt,
  parseVttTime,
  spriteSheetSize,
} from "./filmstrip.js";

/* Mirrors writeSpriteVtt in packages/worker/src/media.ts: a 10-column grid
   of 160x90 tiles, one cue per interval, payload "sprite.png#xywh=...". */
const spriteVtt = (count: number, interval: number): string => {
  const pad = (value: number, size: number): string =>
    String(value).padStart(size, "0");
  const time = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds - hours * 3600 - minutes * 60;
    return `${pad(hours, 2)}:${pad(minutes, 2)}:${remainder.toFixed(3).padStart(6, "0")}`;
  };
  const rows = ["WEBVTT", ""];
  for (let index = 0; index < count; index += 1) {
    const start = index * interval;
    rows.push(
      `${index + 1}`,
      `${time(start)} --> ${time(start + interval)}`,
      `sprite.png#xywh=${(index % 10) * 160},${Math.floor(index / 10) * 90},160,90`,
      "",
    );
  }
  return rows.join("\n");
};

describe("parseVttTime", () => {
  it("parses hours, minutes, seconds, and milliseconds", () => {
    expect(parseVttTime("00:00:00.000")).toBe(0);
    expect(parseVttTime("00:01:02.500")).toBe(62.5);
    expect(parseVttTime("02:00:00.000")).toBe(7200);
    expect(parseVttTime("01:30.000")).toBe(90);
  });

  it("rejects malformed or out-of-range fields", () => {
    expect(parseVttTime("nonsense")).toBeNull();
    expect(parseVttTime("00:61:00.000")).toBeNull();
    expect(parseVttTime("00:00:75.000")).toBeNull();
    expect(parseVttTime("")).toBeNull();
  });
});

describe("parseSpriteVtt", () => {
  it("parses every cue of a worker-format sidecar with grid geometry", () => {
    const cues = parseSpriteVtt(spriteVtt(100, 2));
    expect(cues).toHaveLength(100);
    expect(cues[0]).toEqual({ start: 0, end: 2, x: 0, y: 0, w: 160, h: 90 });
    /* Cue 11 (index 10) wraps to the second sheet row. */
    expect(cues[10]).toEqual({
      start: 20,
      end: 22,
      x: 0,
      y: 90,
      w: 160,
      h: 90,
    });
    expect(cues[99]).toEqual({
      start: 198,
      end: 200,
      x: 9 * 160,
      y: 9 * 90,
      w: 160,
      h: 90,
    });
  });

  it("sorts cues by start time", () => {
    const shuffled = [
      "WEBVTT",
      "",
      "00:00:04.000 --> 00:00:06.000",
      "sprite.png#xywh=320,0,160,90",
      "",
      "00:00:00.000 --> 00:00:02.000",
      "sprite.png#xywh=0,0,160,90",
      "",
    ].join("\n");
    const cues = parseSpriteVtt(shuffled);
    expect(cues.map((cue) => cue.start)).toEqual([0, 4]);
  });

  it("drops cues with malformed timing or missing xywh payloads", () => {
    const broken = [
      "WEBVTT",
      "",
      "garbage --> 00:00:02.000",
      "sprite.png#xywh=0,0,160,90",
      "",
      "00:00:02.000 --> 00:00:04.000",
      "sprite.png",
      "",
      "00:00:04.000 --> 00:00:06.000",
      "sprite.png#xywh=160,0,160,90",
      "",
    ].join("\n");
    const cues = parseSpriteVtt(broken);
    expect(cues).toHaveLength(1);
    expect(cues[0]?.x).toBe(160);
  });

  it("returns nothing for non-VTT input", () => {
    expect(parseSpriteVtt("")).toEqual([]);
    expect(parseSpriteVtt("not a vtt file")).toEqual([]);
  });
});

describe("spriteSheetSize", () => {
  it("computes the sheet extent from cue rectangles", () => {
    const cues = parseSpriteVtt(spriteVtt(100, 2));
    expect(spriteSheetSize(cues)).toEqual({ width: 1600, height: 900 });
  });

  it("handles a partial final row", () => {
    const cues = parseSpriteVtt(spriteVtt(13, 2));
    expect(spriteSheetSize(cues)).toEqual({ width: 1600, height: 180 });
  });

  it("is zero for no cues", () => {
    expect(spriteSheetSize([])).toEqual({ width: 0, height: 0 });
  });
});

describe("cueAtTime", () => {
  const cues = parseSpriteVtt(spriteVtt(10, 2));

  it("selects the covering cue and clamps outside the range", () => {
    expect(cueAtTime(cues, 0)?.x).toBe(0);
    expect(cueAtTime(cues, 3.5)?.x).toBe(160);
    expect(cueAtTime(cues, -5)?.x).toBe(0);
    expect(cueAtTime(cues, 999)?.x).toBe(9 * 160);
  });

  it("returns null with no cues", () => {
    expect(cueAtTime([], 1)).toBeNull();
  });
});

describe("filmstripTiles", () => {
  const RATE = { num: 24000, den: 1001 };

  it("fills the lane with equal slots and story-ordered tiles", () => {
    /* 200 seconds of 23.976 material, 100 cues at 2 second intervals. */
    const durationFrames = Math.floor((200 * RATE.num) / RATE.den);
    const cues = parseSpriteVtt(spriteVtt(100, 2));
    const tiles = filmstripTiles({
      cues,
      durationFrames,
      rate: RATE,
      width: 640,
      tileWidth: 64,
    });
    expect(tiles).toHaveLength(10);
    expect(tiles[0]?.left).toBe(0);
    expect((tiles[9]?.left ?? 0) + (tiles[9]?.width ?? 0)).toBeCloseTo(640);
    /* Cue start times never move backward across the strip. */
    const starts = tiles.map((tile) => tile.cue.start);
    for (let index = 1; index < starts.length; index += 1)
      expect(starts[index]).toBeGreaterThanOrEqual(starts[index - 1] ?? 0);
    /* The first slot samples near the head, the last near the tail. */
    expect(tiles[0]?.cue.start).toBeLessThan(20);
    expect(tiles[9]?.cue.start).toBeGreaterThan(180);
  });

  it("keeps at least one tile when the lane is narrower than a tile", () => {
    const cues = parseSpriteVtt(spriteVtt(5, 2));
    const tiles = filmstripTiles({
      cues,
      durationFrames: 240,
      rate: { num: 24, den: 1 },
      width: 40,
      tileWidth: 64,
    });
    expect(tiles).toHaveLength(1);
    expect(tiles[0]?.width).toBe(40);
  });

  it("maps a one-cue clip to the same tile everywhere", () => {
    const cues = parseSpriteVtt(spriteVtt(1, 2));
    const tiles = filmstripTiles({
      cues,
      durationFrames: 48,
      rate: { num: 24, den: 1 },
      width: 320,
      tileWidth: 64,
    });
    expect(tiles).toHaveLength(5);
    for (const tile of tiles) expect(tile.cue.x).toBe(0);
  });

  it("degrades to nothing on empty or invalid input", () => {
    const cues = parseSpriteVtt(spriteVtt(5, 2));
    expect(
      filmstripTiles({
        cues: [],
        durationFrames: 100,
        rate: { num: 24, den: 1 },
        width: 640,
        tileWidth: 64,
      }),
    ).toEqual([]);
    expect(
      filmstripTiles({
        cues,
        durationFrames: 0,
        rate: { num: 24, den: 1 },
        width: 640,
        tileWidth: 64,
      }),
    ).toEqual([]);
    expect(
      filmstripTiles({
        cues,
        durationFrames: 100,
        rate: { num: 24, den: 1 },
        width: 0,
        tileWidth: 64,
      }),
    ).toEqual([]);
  });
});
