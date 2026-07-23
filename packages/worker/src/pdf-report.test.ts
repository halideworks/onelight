import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { buildPdfReport, commentTimecode } from "./pdf-report.js";
import type { ReportComment } from "./pdf-report.js";

// 64x36 solid grey PNG, generated once with sharp; keeps this test free of
// native dependencies.
const STILL_PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAkCAIAAAC2bqvFAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAUUlEQVRYhdXOQREAAAyDMOTgX+FE9LEjCoJxGIdxGIdxGIdxGIdxGIdxGIdxGIdxGIdxGIdxGIdxGIdxGIdxGIdxGIdxGIdxGIdxGIdxfAdWB2YROD3n3s4mAAAAAElFTkSuQmCC",
    "base64",
  ),
);

const commentOf = (overrides: Partial<ReportComment> = {}): ReportComment => ({
  author: "Reviewer",
  body: "Please fix this.",
  frame: 120,
  rate: { num: 24, den: 1 },
  dropFrame: false,
  startFrame: 0,
  assetName: "shot_010.mov",
  completed: false,
  replies: [],
  reactions: [],
  ...overrides,
});

const loadReport = async (bytes: Uint8Array) => PDFDocument.load(bytes);

const countEmbeddedImages = (doc: PDFDocument): number =>
  doc.context
    .enumerateIndirectObjects()
    .filter(
      ([, object]) =>
        object instanceof PDFRawStream &&
        object.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"),
    ).length;

describe("comment timecode", () => {
  it("uses the version rate, start frame, and drop-frame flag", () => {
    expect(commentTimecode(commentOf())).toBe("00:00:05:00");
    expect(
      commentTimecode(
        commentOf({
          frame: 1800,
          rate: { num: 30000, den: 1001 },
          dropFrame: true,
        }),
      ),
    ).toBe("00:01:00;02");
    expect(commentTimecode(commentOf({ startFrame: 86400, frame: 0 }))).toBe(
      "01:00:00:00",
    );
    expect(commentTimecode(commentOf({ frame: 24, frameOut: 48 }))).toBe(
      "00:00:01:00 to 00:00:02:00",
    );
    expect(commentTimecode(commentOf({ frame: null }))).toBe("no timecode");
  });

  it("never lets a bad rate throw, it falls back to the frame number", () => {
    expect(
      commentTimecode(commentOf({ frame: 7, rate: { num: 0, den: 1 } })),
    ).toBe("frame 7");
  });
});

describe("pdf report assembly", () => {
  it("builds a cover page plus flowed sections with embedded stills", async () => {
    const bytes = await buildPdfReport({
      project: "Spot 30s",
      title: "Comment report",
      filterSummary: "Open comments only",
      generatedAt: "2026-07-11 12:00 UTC",
      comments: [
        commentOf({ stillPng: STILL_PNG }),
        commentOf({
          frame: 240,
          body: "Grade feels too warm.\nCheck the skin tones.",
          stillPng: STILL_PNG,
          completed: true,
          replies: [{ author: "Colorist", body: "Pulled 200K on the mids." }],
          reactions: [{ code: "thumbs_up", count: 2 }],
        }),
        commentOf({ frame: null, body: "General note without a frame." }),
      ],
    });
    const doc = await loadReport(bytes);
    expect(doc.getPageCount()).toBe(2);
    expect(countEmbeddedImages(doc)).toBe(2);
  });

  it("paginates long threads with no off-page text", async () => {
    const longBody = Array.from(
      { length: 40 },
      (unused, index) => `Line ${index} of a very long note that wraps.`,
    ).join(" ");
    const bytes = await buildPdfReport({
      project: "Feature",
      title: "Comment report",
      filterSummary: "All comments",
      generatedAt: "2026-07-11 12:00 UTC",
      comments: Array.from({ length: 12 }, (unused, index) =>
        commentOf({ frame: index * 24, body: longBody }),
      ),
    });
    const doc = await loadReport(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(3);
    expect(countEmbeddedImages(doc)).toBe(0);
  });

  it("carries non-ASCII text through the embedded font", async () => {
    const bytes = await buildPdfReport({
      project: "Kurzfilm",
      title: "Comment report",
      filterSummary: "All comments",
      generatedAt: "2026-07-11 12:00 UTC",
      comments: [
        commentOf({
          author: "Zoe Müller",
          body: "Die Färbung wirkt kühl, célèbre? Да, ещё раз.",
        }),
      ],
    });
    const doc = await loadReport(bytes);
    expect(doc.getPageCount()).toBe(2);
  });

  it("survives an undecodable still by dropping the image", async () => {
    const bytes = await buildPdfReport({
      project: "P",
      title: "Comment report",
      filterSummary: "All comments",
      generatedAt: "2026-07-11 12:00 UTC",
      comments: [commentOf({ stillPng: new Uint8Array([9, 9, 9]) })],
    });
    const doc = await loadReport(bytes);
    expect(countEmbeddedImages(doc)).toBe(0);
    expect(doc.getPageCount()).toBe(2);
  });
});
