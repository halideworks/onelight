/* Fuzz suite for the annotation SVG builder: 500 seeded-random annotation
 * JSON blobs (valid strokes, coordinate garbage, NaN/Infinity, huge point
 * arrays, wrong types at every level, hostile color strings including SVG
 * injection attempts) through parseAnnotationStrokes and annotationSvg.
 *
 * Guarantees under test:
 *
 *   - neither function ever throws,
 *   - the output contains no script element, no event-handler attribute,
 *     no javascript: URL, and only allowlisted attribute names,
 *   - every numeric attribute value is finite (no NaN/Infinity leaks),
 *   - projected coordinates stay clamped to the viewport (arrowhead
 *     decorations may overshoot by their fixed head size, 2 percent of
 *     the frame diagonal, which is the documented rendering margin),
 *   - parsed stroke points are clamped to the normalized [0, 1] square.
 *
 * The seed prints at collection and is embedded in every failure message;
 * reproduce with FUZZ_SEED=<seed> pnpm test.
 */

import { describe, expect, it } from "vitest";
import { annotationSvg, parseAnnotationStrokes } from "./annotation-svg.js";

const ITERATIONS = 500;

const seed =
  process.env.FUZZ_SEED !== undefined
    ? Number(process.env.FUZZ_SEED) >>> 0
    : (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
console.log(
  `[fuzz] annotation-svg: seed ${seed} (run with FUZZ_SEED=${seed} to reproduce)`,
);

const mulberry32 = (state: number) => (): number => {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const rng = mulberry32(seed);
const int = (maxExclusive: number): number => Math.floor(rng() * maxExclusive);
const pick = <T>(values: readonly T[]): T => {
  if (values.length === 0) throw new Error("pick from empty array");
  return values[int(values.length)] as T;
};

const HOSTILE_COLORS: readonly unknown[] = [
  "#a5605a",
  "#fff",
  "#00ff0080",
  "tomato",
  'red"/><script>alert(1)</script>',
  'red" onload="alert(1)',
  "javascript:alert(1)",
  "url(javascript:alert(1))",
  "#gggggg",
  "rgb(0, 0, 0)",
  "expression(alert(1))",
  "red;background:url(//evil)",
  "&#106;avascript:alert(1)",
  "a".repeat(5000),
  "<style>*{}</style>",
  "",
  42,
  null,
  { toString: "nope" },
];

const GARBAGE_NUMBERS: readonly unknown[] = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  1e300,
  -1e300,
  -5,
  7.5,
  "0.5",
  null,
  undefined,
];

const TOOLS: readonly unknown[] = [
  "pen",
  "line",
  "arrow",
  "rect",
  "ellipse",
  "polygon",
  "<script>",
  "",
  17,
  null,
];

const randomCoordinate = (): unknown => {
  const shape = rng();
  if (shape < 0.6) return rng(); // valid normalized
  if (shape < 0.75) return rng() * 6 - 3; // out of range, clamps
  return pick(GARBAGE_NUMBERS);
};

const randomPoint = (): unknown => {
  const shape = rng();
  if (shape < 0.7) {
    const point: unknown[] = [randomCoordinate(), randomCoordinate()];
    if (rng() < 0.3) point.push(randomCoordinate()); // pressure slot
    return point;
  }
  if (shape < 0.78) return [randomCoordinate()]; // too short
  if (shape < 0.86) return "0.5,0.5";
  if (shape < 0.94) return { x: rng(), y: rng() };
  return null;
};

const randomPoints = (): unknown => {
  const shape = rng();
  if (shape < 0.05) return []; // empty
  if (shape < 0.1) return "not an array";
  const count = shape < 0.15 ? 5000 + int(15_000) : 1 + int(40);
  const points: unknown[] = [];
  for (let index = 0; index < count; index += 1) points.push(randomPoint());
  return points;
};

const randomStroke = (): unknown => {
  const shape = rng();
  if (shape < 0.08) return null;
  if (shape < 0.14) return "stroke";
  if (shape < 0.2) return 99;
  const stroke: Record<string, unknown> = { points: randomPoints() };
  if (rng() < 0.85) stroke.tool = pick(TOOLS);
  if (rng() < 0.85) stroke.color = pick(HOSTILE_COLORS);
  if (rng() < 0.85) stroke.width = pick([3, 1, 12, ...GARBAGE_NUMBERS]);
  if (rng() < 0.1) stroke.extra = { nested: { deep: [1, 2, 3] } };
  return stroke;
};

const randomAnnotation = (): unknown => {
  const shape = rng();
  if (shape < 0.05) return null;
  if (shape < 0.1) return "just a string";
  if (shape < 0.15) return 12345;
  if (shape < 0.2) return { strokes: "nope" };
  if (shape < 0.25) return { other: [] };
  const strokes: unknown[] = [];
  const count = int(6);
  for (let index = 0; index < count; index += 1) strokes.push(randomStroke());
  return rng() < 0.5 ? strokes : { strokes };
};

/* ------------------------------------------------------------------ */
/* SVG output inspection                                               */
/* ------------------------------------------------------------------ */

const ALLOWED_ATTRIBUTES = new Set([
  "xmlns",
  "width",
  "height",
  "viewBox",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "points",
  "x",
  "y",
  "cx",
  "cy",
  "rx",
  "ry",
  "x1",
  "y1",
  "x2",
  "y2",
]);

const NUMERIC_ATTRIBUTES = new Set([
  "width",
  "height",
  "x",
  "y",
  "cx",
  "cy",
  "rx",
  "ry",
  "x1",
  "y1",
  "x2",
  "y2",
  "stroke-width",
]);

const X_ATTRIBUTES = new Set(["x", "cx", "x1", "x2"]);
const Y_ATTRIBUTES = new Set(["y", "cy", "y1", "y2"]);

interface ParsedElement {
  name: string;
  attributes: Map<string, string>;
}

/* Attribute-quoted tag scanner for the SVG the builder emits. */
const parseElements = (svg: string, context: string): ParsedElement[] => {
  const elements: ParsedElement[] = [];
  const tagPattern =
    /<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>/g;
  let covered = 0;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(svg)) !== null) {
    covered += match[0].length;
    if (match[1] === "/") continue;
    const attributes = new Map<string, string>();
    const attrPattern = /([\w:-]+)="([^"]*)"/g;
    let attr: RegExpExecArray | null;
    while ((attr = attrPattern.exec(match[3] ?? "")) !== null)
      attributes.set(attr[1] ?? "", attr[2] ?? "");
    elements.push({ name: match[2] ?? "", attributes });
  }
  /* Everything in the output must be tags: the builder emits no text
     nodes, so any uncovered byte would mean a malformed or injected
     region the scanner skipped. */
  expect(
    covered,
    `${context}: SVG consists entirely of well-formed quoted tags (covered ${covered} of ${svg.length})`,
  ).toBe(svg.length);
  return elements;
};

describe("annotation svg fuzz: hostile blobs through the builder", () => {
  it(`survives ${ITERATIONS} seeded-random annotation blobs (seed ${seed})`, () => {
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const context = `seed ${seed} iteration ${iteration}`;
      const annotation = randomAnnotation();
      const width = 16 + int(4080);
      const height = 16 + int(2160);

      let strokes;
      let svg = "";
      try {
        strokes = parseAnnotationStrokes(annotation);
        svg = annotationSvg(strokes, width, height);
      } catch (error) {
        throw new Error(
          `${context}: builder threw: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      /* Parsed strokes are the contract the renderer trusts: normalized
         and finite. Plain checks (not expect per point) keep 20k-point
         strokes cheap; violations throw with full context. */
      for (const stroke of strokes)
        for (const point of stroke.points) {
          const ok =
            Number.isFinite(point[0]) &&
            Number.isFinite(point[1]) &&
            point[0] >= 0 &&
            point[0] <= 1 &&
            point[1] >= 0 &&
            point[1] <= 1;
          if (!ok)
            throw new Error(
              `${context}: parsed point ${String(point[0])},${String(point[1])} escapes the normalized [0,1] square`,
            );
        }

      const lower = svg.toLowerCase();
      expect(lower.includes("<script"), `${context}: no script element`).toBe(
        false,
      );
      expect(
        lower.includes("javascript:"),
        `${context}: no javascript: URL`,
      ).toBe(false);
      expect(lower.includes("<style"), `${context}: no style element`).toBe(
        false,
      );
      expect(svg.includes("NaN"), `${context}: no NaN in output`).toBe(false);
      expect(
        svg.includes("Infinity"),
        `${context}: no Infinity in output`,
      ).toBe(false);

      const elements = parseElements(svg, context);
      expect(elements[0]?.name, `${context}: svg root element`).toBe("svg");

      /* Arrowhead decoration lines may extend past the projected endpoint
         by the head size (2 percent of the diagonal); everything else is
         hard-clamped to the viewport. */
      const margin = 0.02 * Math.hypot(width, height) + 0.01;
      for (const element of elements) {
        expect(
          ["svg", "g", "polyline", "rect", "ellipse", "line"].includes(
            element.name,
          ),
          `${context}: element <${element.name}> is expected`,
        ).toBe(true);
        for (const [name, value] of element.attributes) {
          expect(
            ALLOWED_ATTRIBUTES.has(name),
            `${context}: attribute "${name}" is allowlisted (value "${value.slice(0, 60)}")`,
          ).toBe(true);
          expect(
            name.toLowerCase().startsWith("on"),
            `${context}: no event handler attributes`,
          ).toBe(false);
          if (element.name !== "svg" && NUMERIC_ATTRIBUTES.has(name)) {
            const numeric = Number(value);
            expect(
              Number.isFinite(numeric),
              `${context}: <${element.name} ${name}="${value}"> is finite`,
            ).toBe(true);
            if (X_ATTRIBUTES.has(name))
              expect(
                numeric >= -margin && numeric <= width + margin,
                `${context}: <${element.name}> ${name}=${numeric} inside viewport width ${width} (margin ${margin.toFixed(2)})`,
              ).toBe(true);
            if (Y_ATTRIBUTES.has(name))
              expect(
                numeric >= -margin && numeric <= height + margin,
                `${context}: <${element.name}> ${name}=${numeric} inside viewport height ${height} (margin ${margin.toFixed(2)})`,
              ).toBe(true);
            if (name === "rx" || name === "ry" || name === "stroke-width")
              expect(numeric >= 0, `${context}: ${name} is non-negative`).toBe(
                true,
              );
            if (
              element.name === "rect" &&
              (name === "width" || name === "height")
            )
              expect(
                numeric >= 0 &&
                  numeric <= (name === "width" ? width : height) + 0.01,
                `${context}: rect ${name}=${numeric} fits the viewport`,
              ).toBe(true);
          }
          if (name === "points") {
            const pairs = value.split(" ").filter((pair) => pair.length);
            for (const pair of pairs) {
              const [xRaw, yRaw] = pair.split(",");
              const x = Number(xRaw);
              const y = Number(yRaw);
              const ok =
                Number.isFinite(x) &&
                Number.isFinite(y) &&
                x >= 0 &&
                x <= width + 0.01 &&
                y >= 0 &&
                y <= height + 0.01;
              if (!ok)
                throw new Error(
                  `${context}: polyline pair "${pair}" escapes the ${width}x${height} viewport`,
                );
            }
          }
        }
      }
    }
  });
});
