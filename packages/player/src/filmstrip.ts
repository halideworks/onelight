import type { FrameRate } from "@onelight/core";

/* Filmstrip lane math. The worker writes one sprite sheet per version (a
   10x10 grid of tiles) plus a WEBVTT sidecar whose cue payloads carry the
   tile geometry as media fragments:

     1
     00:00:00.000 --> 00:00:02.000
     sprite.png#xywh=0,0,160,90

   These helpers parse that sidecar and map timeline pixels to tiles. They
   are pure so the mapping is testable without a DOM. */

export type SpriteCue = {
  /* Cue window in seconds of media time. */
  start: number;
  end: number;
  /* Tile rectangle in sprite-sheet pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
};

export type FilmstripTile = {
  /* Left edge and width of the tile slot in lane pixels. */
  left: number;
  width: number;
  cue: SpriteCue;
};

/* "HH:MM:SS.mmm" (hours optional) to seconds, or null when malformed. */
export const parseVttTime = (text: string): number | null => {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(text.trim());
  if (!match) return null;
  const hours = match[1] ? Number(match[1]) : 0;
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (minutes >= 60 || seconds >= 60) return null;
  return hours * 3600 + minutes * 60 + seconds;
};

/* Parse the sprite VTT written by the worker (writeSpriteVtt). Cues whose
   timing line or #xywh payload is malformed are dropped; the result is
   sorted by start time. */
export const parseSpriteVtt = (text: string): SpriteCue[] => {
  const cues: SpriteCue[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.includes("-->")) continue;
    const [rawStart, rawEnd] = line.split("-->");
    const start = parseVttTime(rawStart ?? "");
    const end = parseVttTime(rawEnd ?? "");
    if (start === null || end === null) continue;
    /* The payload is the next non-empty line. */
    let payload = "";
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = (lines[next] ?? "").trim();
      if (candidate) {
        payload = candidate;
        break;
      }
      if (next > index + 1) break;
    }
    const geometry = /#xywh=(\d+),(\d+),(\d+),(\d+)\s*$/.exec(payload);
    if (!geometry) continue;
    const w = Number(geometry[3]);
    const h = Number(geometry[4]);
    if (w <= 0 || h <= 0) continue;
    cues.push({
      start,
      end,
      x: Number(geometry[1]),
      y: Number(geometry[2]),
      w,
      h,
    });
  }
  return cues.sort((a, b) => a.start - b.start);
};

/* Total sheet size implied by the cue rectangles.

   This is a LOWER BOUND, not the sheet's size, and it is exact only when the
   grid is full. The worker tiles with tile=10x10, which always emits a full
   10x10 canvas and pads the cells it did not fill, so a clip with fewer than
   100 cues has a sheet taller than its cues reach: 48 cues occupy 5 rows
   (max y+h = 450) of a sheet that is really 900 tall.

   Scaling CSS background-size by this value therefore squashes the sheet and
   stacks several rows of the grid inside every tile. Measure the image instead
   -- Timeline.svelte and web's ScrubThumb.svelte both load it and read
   naturalWidth/naturalHeight -- and use this only as a pre-load fallback. */
export const spriteSheetSize = (
  cues: SpriteCue[],
): { width: number; height: number } => {
  let width = 0;
  let height = 0;
  for (const cue of cues) {
    if (cue.x + cue.w > width) width = cue.x + cue.w;
    if (cue.y + cue.h > height) height = cue.y + cue.h;
  }
  return { width, height };
};

/* The cue covering a media time: the last cue whose start is at or before
   the time (cue windows are contiguous), clamped to the first cue. */
export const cueAtTime = (
  cues: SpriteCue[],
  seconds: number,
): SpriteCue | null => {
  let found: SpriteCue | null = null;
  for (const cue of cues) {
    if (cue.start <= seconds) found = cue;
    else break;
  }
  return found ?? cues[0] ?? null;
};

/* Tile slots across a lane of `width` pixels. Each slot owns an equal span
   of the timeline; the tile shown is the cue at the media time of the frame
   in the slot's center, so the strip reads left to right in story order. */
export const filmstripTiles = (options: {
  cues: SpriteCue[];
  durationFrames: number;
  rate: FrameRate;
  width: number;
  tileWidth: number;
}): FilmstripTile[] => {
  const { cues, durationFrames, rate, width, tileWidth } = options;
  if (
    cues.length === 0 ||
    durationFrames <= 0 ||
    width <= 0 ||
    tileWidth <= 0 ||
    rate.num <= 0 ||
    rate.den <= 0
  )
    return [];
  const count = Math.max(1, Math.floor(width / tileWidth));
  const slotWidth = width / count;
  const tiles: FilmstripTile[] = [];
  for (let index = 0; index < count; index += 1) {
    const fraction = (index + 0.5) / count;
    const frame = Math.min(
      durationFrames - 1,
      Math.floor(fraction * durationFrames),
    );
    const seconds = ((frame + 0.5) * rate.den) / rate.num;
    const cue = cueAtTime(cues, seconds);
    if (cue) tiles.push({ left: index * slotWidth, width: slotWidth, cue });
  }
  return tiles;
};
