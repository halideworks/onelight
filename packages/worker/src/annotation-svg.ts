/* Pure-TS SVG generation for comment annotations, plus sharp compositing
   onto extracted stills. The stroke shapes mirror the player's overlay
   renderer (packages/player/src/annotations.ts and AnnotationOverlay.svelte):
   points are normalized to the frame, x and y in [0, 1]; rect and ellipse
   use the first and last point as opposite corners; arrows grow a head whose
   size follows the frame diagonal. */

export type AnnotationPoint = [number, number, number?];

export interface AnnotationStroke {
  tool?: "pen" | "line" | "arrow" | "rect" | "ellipse";
  color?: string;
  width?: number;
  points: AnnotationPoint[];
}

const FALLBACK_COLOR = "#a5605a";

const isPoint = (value: unknown): value is AnnotationPoint =>
  Array.isArray(value) &&
  value.length >= 2 &&
  typeof value[0] === "number" &&
  typeof value[1] === "number" &&
  Number.isFinite(value[0]) &&
  Number.isFinite(value[1]);

const TOOLS = new Set(["pen", "line", "arrow", "rect", "ellipse"]);

// annotation_json is stored either as a bare stroke array or as an object
// carrying a strokes array (both shapes exist in the wild; the web app
// accepts both, see strokesFrom in the asset review page).
export const parseAnnotationStrokes = (
  annotation: unknown,
): AnnotationStroke[] => {
  const candidates = Array.isArray(annotation)
    ? annotation
    : annotation &&
        typeof annotation === "object" &&
        Array.isArray((annotation as { strokes?: unknown }).strokes)
      ? (annotation as { strokes: unknown[] }).strokes
      : [];
  const strokes: AnnotationStroke[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const raw = candidate as Record<string, unknown>;
    const points = Array.isArray(raw.points)
      ? raw.points
          .filter(isPoint)
          .map((point): AnnotationPoint => [
            Math.min(1, Math.max(0, point[0])),
            Math.min(1, Math.max(0, point[1])),
          ])
      : [];
    if (!points.length) continue;
    const stroke: AnnotationStroke = { points };
    if (typeof raw.tool === "string" && TOOLS.has(raw.tool))
      stroke.tool = raw.tool as NonNullable<AnnotationStroke["tool"]>;
    if (typeof raw.color === "string") stroke.color = raw.color;
    if (typeof raw.width === "number" && Number.isFinite(raw.width))
      stroke.width = raw.width;
    strokes.push(stroke);
  }
  return strokes;
};

// Colors come from user-controlled JSON and end up inside an SVG attribute;
// only hex colors and plain ASCII keywords pass, everything else falls back.
const safeColor = (color: string | undefined): string =>
  color !== undefined &&
  (/^#[0-9a-fA-F]{3,8}$/.test(color) || /^[a-zA-Z]{1,30}$/.test(color))
    ? color
    : FALLBACK_COLOR;

const round = (value: number): string => String(Math.round(value * 100) / 100);

// Stored stroke widths are CSS pixels of the player overlay, which renders at
// display size (roughly 1280 wide in practice). Stills are proxy-resolution,
// so the width is scaled by the ratio to that reference display width.
const strokeWidth = (stroke: AnnotationStroke, width: number): string =>
  round(Math.max(1, (stroke.width ?? 3) * (width / 1280)));

const strokeSvg = (
  stroke: AnnotationStroke,
  width: number,
  height: number,
): string => {
  const points = stroke.points;
  const first = points[0];
  if (!first) return "";
  const attrs = `stroke="${safeColor(stroke.color)}" stroke-width="${strokeWidth(stroke, width)}"`;
  const x = first[0] * width;
  const y = first[1] * height;
  const last = points[points.length - 1] ?? first;
  const endX = last[0] * width;
  const endY = last[1] * height;
  if (stroke.tool === "rect") {
    return `<rect x="${round(Math.min(x, endX))}" y="${round(Math.min(y, endY))}" width="${round(Math.abs(endX - x))}" height="${round(Math.abs(endY - y))}" ${attrs}/>`;
  }
  if (stroke.tool === "ellipse") {
    return `<ellipse cx="${round((x + endX) / 2)}" cy="${round((y + endY) / 2)}" rx="${round(Math.abs(endX - x) / 2)}" ry="${round(Math.abs(endY - y) / 2)}" ${attrs}/>`;
  }
  const path =
    stroke.tool === "line" || stroke.tool === "arrow" ? [first, last] : points;
  const polyline = `<polyline points="${path
    .map((point) => `${round(point[0] * width)},${round(point[1] * height)}`)
    .join(" ")}" ${attrs}/>`;
  if (stroke.tool !== "arrow") return polyline;
  // Arrowheads are computed in pixel space after projecting the endpoints,
  // matching the player, so the head cannot skew when width and height scale
  // independently.
  const angle = Math.atan2(endY - y, endX - x);
  const size = 0.02 * Math.hypot(width, height);
  const head = (offset: number): string =>
    `<line x1="${round(endX)}" y1="${round(endY)}" x2="${round(endX - Math.cos(angle + offset) * size)}" y2="${round(endY - Math.sin(angle + offset) * size)}" ${attrs}/>`;
  return `${polyline}${head(-0.5)}${head(0.5)}`;
};

export const annotationSvg = (
  strokes: AnnotationStroke[],
  width: number,
  height: number,
): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
  `<g fill="none" stroke-linecap="round" stroke-linejoin="round">` +
  strokes.map((stroke) => strokeSvg(stroke, width, height)).join("") +
  `</g></svg>`;

// sharp is loaded lazily so importing @onelight/worker (the server does, for
// the recipe builders) never fails on a machine without sharp prebuilds;
// only the compositing call itself requires it.
const loadSharp = async () => (await import("sharp")).default;

// Composites the annotation SVG over a still PNG at native still size and
// returns PNG bytes. Throws when the input is not decodable; callers fall
// back to a text-only report block.
export const compositeAnnotation = async (
  stillPng: Uint8Array,
  strokes: AnnotationStroke[],
): Promise<Uint8Array> => {
  const sharp = await loadSharp();
  const image = sharp(Buffer.from(stillPng));
  const meta = await image.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new Error("Still image has no dimensions.");
  if (!strokes.length) return stillPng;
  const overlay = Buffer.from(annotationSvg(strokes, width, height), "utf8");
  const composed = await image
    .composite([{ input: overlay, left: 0, top: 0 }])
    .png()
    .toBuffer();
  return new Uint8Array(composed);
};
