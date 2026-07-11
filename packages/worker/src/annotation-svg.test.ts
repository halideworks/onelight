import { describe, expect, it } from "vitest";
import {
  annotationSvg,
  compositeAnnotation,
  parseAnnotationStrokes,
} from "./annotation-svg.js";
import type { AnnotationStroke } from "./annotation-svg.js";

// The compositing tests execute sharp for real. When sharp cannot load its
// native prebuild on this machine, they skip cleanly with a logged reason
// instead of failing the suite; the pure SVG tests always run.
let sharpAvailable = true;
try {
  await import("sharp");
} catch (error) {
  sharpAvailable = false;
  console.warn(
    `[onelight] skipping annotation composite tests, sharp unavailable: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

describe("annotation stroke parsing", () => {
  it("accepts a bare stroke array or a strokes object and drops junk", () => {
    const bare = parseAnnotationStrokes([
      {
        tool: "pen",
        points: [
          [0.1, 0.2],
          [0.3, 0.4],
        ],
      },
    ]);
    expect(bare).toHaveLength(1);
    expect(bare[0]?.tool).toBe("pen");
    const wrapped = parseAnnotationStrokes({
      strokes: [{ points: [[0.5, 0.5]] }],
    });
    expect(wrapped).toHaveLength(1);
    expect(parseAnnotationStrokes(null)).toEqual([]);
    expect(parseAnnotationStrokes("nope")).toEqual([]);
    expect(parseAnnotationStrokes([{ points: "nope" }, 42])).toEqual([]);
    expect(parseAnnotationStrokes([{ points: [["a", 1]] }])).toEqual([]);
  });

  it("clamps coordinates into the unit square", () => {
    const strokes = parseAnnotationStrokes([
      {
        points: [
          [-0.5, 1.5],
          [0.5, 0.5],
        ],
      },
    ]);
    expect(strokes[0]?.points[0]).toEqual([0, 1]);
  });
});

describe("annotation svg generation", () => {
  it("renders each tool with player-matching geometry", () => {
    const strokes: AnnotationStroke[] = [
      {
        tool: "pen",
        points: [
          [0, 0],
          [0.5, 0.5],
          [1, 0],
        ],
      },
      {
        tool: "line",
        points: [
          [0, 0],
          [0.25, 0.25],
          [1, 1],
        ],
      },
      {
        tool: "arrow",
        points: [
          [0, 1],
          [1, 0],
        ],
      },
      {
        tool: "rect",
        points: [
          [0.75, 0.75],
          [0.25, 0.25],
        ],
      },
      {
        tool: "ellipse",
        points: [
          [0.25, 0.25],
          [0.75, 0.75],
        ],
      },
    ];
    const svg = annotationSvg(strokes, 200, 100);
    expect(svg).toContain('viewBox="0 0 200 100"');
    // Pen keeps every point; line keeps only the endpoints.
    expect(svg).toContain('<polyline points="0,0 100,50 200,0"');
    expect(svg).toContain('<polyline points="0,0 200,100"');
    // Arrow adds two head lines at the end point.
    expect((svg.match(/<line /g) ?? []).length).toBe(2);
    // Rect normalizes a backwards drag into a positive box.
    expect(svg).toContain('<rect x="50" y="25" width="100" height="50"');
    expect(svg).toContain('<ellipse cx="100" cy="50" rx="50" ry="25"');
  });

  it("sanitizes hostile colors instead of injecting markup", () => {
    const svg = annotationSvg(
      [
        {
          tool: "pen",
          color: '"/><script>alert(1)</script>',
          points: [
            [0, 0],
            [1, 1],
          ],
        },
      ],
      100,
      100,
    );
    expect(svg).not.toContain("script");
    expect(svg).toContain('stroke="#a5605a"');
    const hex = annotationSvg(
      [
        {
          tool: "pen",
          color: "#00ff00",
          points: [
            [0, 0],
            [1, 1],
          ],
        },
      ],
      100,
      100,
    );
    expect(hex).toContain('stroke="#00ff00"');
  });
});

describe.skipIf(!sharpAvailable)("annotation compositing with sharp", () => {
  const solidPng = async (
    width: number,
    height: number,
    value: number,
  ): Promise<Uint8Array> => {
    const sharp = (await import("sharp")).default;
    return new Uint8Array(
      await sharp({
        create: {
          width,
          height,
          channels: 3,
          background: { r: value, g: value, b: value },
        },
      })
        .png()
        .toBuffer(),
    );
  };

  const rawPixels = async (png: Uint8Array) => {
    const sharp = (await import("sharp")).default;
    return sharp(Buffer.from(png)).raw().toBuffer({ resolveWithObject: true });
  };

  it("draws strokes onto the still and keeps its dimensions", async () => {
    const still = await solidPng(160, 90, 20);
    const composed = await compositeAnnotation(still, [
      {
        tool: "rect",
        color: "#ffffff",
        // Stored widths are display-referred (about 1280 px wide); 24 maps to
        // a 3 px stroke on this 160 px still, wide enough to fully cover the
        // border pixel sampled below.
        width: 24,
        points: [
          [0.25, 0.25],
          [0.75, 0.75],
        ],
      },
    ]);
    const { data, info } = await rawPixels(composed);
    expect(info.width).toBe(160);
    expect(info.height).toBe(90);
    const pixel = (x: number, y: number): number =>
      data[(y * info.width + x) * info.channels] ?? -1;
    // On the rect border (x = 40 at y = 45) the white stroke lightened the
    // frame; in the untouched corner and dead center it is still solid grey.
    expect(pixel(40, 45)).toBeGreaterThan(128);
    expect(pixel(2, 2)).toBe(20);
    expect(pixel(80, 45)).toBe(20);
  });

  it("returns the still untouched when there are no strokes", async () => {
    const still = await solidPng(32, 32, 77);
    const composed = await compositeAnnotation(still, []);
    expect(composed).toBe(still);
  });

  it("rejects undecodable stills so callers can fall back to text", async () => {
    await expect(
      compositeAnnotation(new Uint8Array([1, 2, 3]), []),
    ).rejects.toThrow();
  });
});
