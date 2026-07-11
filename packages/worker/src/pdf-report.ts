/* PDF comment report with annotated stills (phase-3 P3-T07).

   Assembled with pdf-lib (pure JS). Text uses a bundled Noto Sans Regular
   (SIL OFL 1.1, license alongside the font in assets/fonts/OFL.txt) embedded
   through fontkit and subset on save, so non-ASCII comment text renders
   instead of failing WinAnsi encoding the way the standard 14 fonts do.
   Glyphs outside the font's coverage degrade to "?" rather than throwing.

   All flow is measured: text is wrapped against the real font metrics and
   every block reserves its height before drawing, so nothing lands off the
   page. Stills are scaled to the content column and never split. */

import { readFile } from "node:fs/promises";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb } from "pdf-lib";
import type { PDFFont, PDFImage, PDFPage } from "pdf-lib";
import {
  formatTimecode,
  isDropFrameRate,
  timecodeFromFrames,
} from "@onelight/core";

export interface ReportRate {
  num: number;
  den: number;
}

export interface ReportReply {
  author: string;
  body: string;
}

export interface ReportReaction {
  code: string;
  count: number;
}

export interface ReportComment {
  author: string;
  body: string;
  frame: number | null;
  frameOut?: number | null;
  rate: ReportRate;
  dropFrame: boolean;
  startFrame: number;
  assetName: string;
  versionNo?: number;
  completed: boolean;
  internal?: boolean;
  replies: ReportReply[];
  reactions: ReportReaction[];
  stillPng?: Uint8Array;
}

export interface ReportInput {
  project: string;
  title: string;
  filterSummary: string;
  generatedAt: string;
  comments: ReportComment[];
}

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const FOOTER_SPACE = 30;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const MAX_IMAGE_HEIGHT = 300;

const INK = rgb(0.1, 0.1, 0.1);
const MUTED = rgb(0.45, 0.45, 0.45);

const FONT_URL = new URL(
  "../assets/fonts/NotoSans-Regular.ttf",
  import.meta.url,
);

let fontBytes: Promise<Uint8Array> | undefined;
const loadFontBytes = (): Promise<Uint8Array> => {
  fontBytes ??= readFile(FONT_URL);
  return fontBytes;
};

export const commentTimecode = (comment: ReportComment): string => {
  if (comment.frame === null) return "no timecode";
  const dropFrame = comment.dropFrame && isDropFrameRate(comment.rate);
  const label = (frame: number): string =>
    formatTimecode(
      timecodeFromFrames(comment.startFrame + frame, comment.rate, dropFrame),
    );
  try {
    const inLabel = label(comment.frame);
    return comment.frameOut != null && comment.frameOut > comment.frame
      ? `${inLabel} to ${label(comment.frameOut)}`
      : inLabel;
  } catch {
    return `frame ${comment.frame}`;
  }
};

// Characters the embedded font cannot map degrade to "?" so encoding never
// throws mid-report; tabs widen to two spaces and other control characters
// (except the newline the wrapper handles) are dropped.
const sanitizer = (font: PDFFont): ((text: string) => string) => {
  const charset = new Set(font.getCharacterSet());
  return (text: string): string =>
    [...text.replace(/\r\n?/g, "\n").replaceAll("\t", "  ")]
      .map((char) => {
        const code = char.codePointAt(0) ?? 0;
        if (char === "\n") return char;
        if (code < 0x20) return "";
        return charset.has(code) ? char : "?";
      })
      .join("");
};

const wrapText = (
  font: PDFFont,
  text: string,
  size: number,
  width: number,
): string[] => {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph.length) {
      lines.push("");
      continue;
    }
    let line = "";
    const push = (): void => {
      if (line.length) lines.push(line);
      line = "";
    };
    for (const word of paragraph.split(" ")) {
      // Hard-break words wider than the column so no line can overflow.
      let piece = word;
      while (font.widthOfTextAtSize(piece, size) > width) {
        push();
        let cut = piece.length - 1;
        while (
          cut > 1 &&
          font.widthOfTextAtSize(piece.slice(0, cut), size) > width
        )
          cut -= 1;
        lines.push(piece.slice(0, cut));
        piece = piece.slice(cut);
      }
      const candidate = line.length ? `${line} ${piece}` : piece;
      if (font.widthOfTextAtSize(candidate, size) > width) {
        push();
        line = piece;
      } else {
        line = candidate;
      }
    }
    push();
  }
  return lines.length ? lines : [""];
};

interface Flow {
  page: PDFPage;
  y: number;
}

export const buildPdfReport = async (
  input: ReportInput,
): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(await loadFontBytes(), { subset: true });
  const clean = sanitizer(font);

  const flow: Flow = { page: doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]), y: 0 };
  const newPage = (): void => {
    flow.page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    flow.y = PAGE_HEIGHT - MARGIN;
  };
  const ensure = (height: number): void => {
    if (flow.y - height < MARGIN + FOOTER_SPACE) newPage();
  };
  const drawLines = (
    lines: string[],
    size: number,
    options: { color?: ReturnType<typeof rgb>; indent?: number } = {},
  ): void => {
    const lineHeight = Math.round(size * 1.45 * 100) / 100;
    for (const line of lines) {
      ensure(lineHeight);
      flow.y -= lineHeight;
      if (line.length)
        flow.page.drawText(line, {
          x: MARGIN + (options.indent ?? 0),
          y: flow.y,
          size,
          font,
          color: options.color ?? INK,
        });
    }
  };
  const drawParagraph = (
    text: string,
    size: number,
    options: { color?: ReturnType<typeof rgb>; indent?: number } = {},
  ): void =>
    drawLines(
      wrapText(font, clean(text), size, CONTENT_WIDTH - (options.indent ?? 0)),
      size,
      options,
    );
  const space = (height: number): void => {
    flow.y -= height;
  };

  // Cover page.
  flow.y = PAGE_HEIGHT - 180;
  drawParagraph(input.title, 24);
  space(10);
  drawParagraph(input.project, 13);
  space(24);
  drawParagraph(input.filterSummary, 10.5, { color: MUTED });
  space(6);
  drawParagraph(
    `${input.comments.length} comment${input.comments.length === 1 ? "" : "s"}`,
    10.5,
    { color: MUTED },
  );
  space(6);
  drawParagraph(`Generated ${input.generatedAt}`, 10.5, { color: MUTED });

  if (input.comments.length) newPage();

  for (const comment of input.comments) {
    // Keep the section header and the start of its content on one page.
    ensure(96);
    space(20);

    const version =
      comment.versionNo !== undefined ? ` v${comment.versionNo}` : "";
    drawParagraph(
      `${commentTimecode(comment)}  ${comment.assetName}${version}`,
      11,
    );
    space(6);

    if (comment.stillPng) {
      let image: PDFImage | undefined;
      try {
        image = await doc.embedPng(comment.stillPng);
      } catch {
        image = undefined;
      }
      if (image) {
        const scale = Math.min(
          CONTENT_WIDTH / image.width,
          MAX_IMAGE_HEIGHT / image.height,
          1,
        );
        const width = image.width * scale;
        const height = image.height * scale;
        ensure(height);
        flow.y -= height;
        flow.page.drawImage(image, {
          x: MARGIN,
          y: flow.y,
          width,
          height,
        });
        space(8);
      } else {
        drawParagraph("(still unavailable)", 9.5, { color: MUTED });
      }
    }

    const state = comment.completed ? "completed" : "open";
    const internal = comment.internal ? ", internal" : "";
    drawParagraph(`${comment.author}, ${state}${internal}`, 9.5, {
      color: MUTED,
    });
    space(2);
    drawParagraph(comment.body, 10.5);

    for (const reply of comment.replies) {
      space(6);
      drawParagraph(`${reply.author} replied`, 9.5, {
        color: MUTED,
        indent: 16,
      });
      drawParagraph(reply.body, 10, { indent: 16 });
    }

    if (comment.reactions.length) {
      space(6);
      drawParagraph(
        `Reactions: ${comment.reactions
          .map((reaction) => `${reaction.code} x${reaction.count}`)
          .join(", ")}`,
        9.5,
        { color: MUTED },
      );
    }
  }

  // Page numbers, centered in the footer band on every page.
  const pages = doc.getPages();
  pages.forEach((page, index) => {
    const label = `${index + 1} / ${pages.length}`;
    page.drawText(label, {
      x: (PAGE_WIDTH - font.widthOfTextAtSize(label, 9)) / 2,
      y: MARGIN / 2,
      size: 9,
      font,
      color: MUTED,
    });
  });

  return doc.save();
};
