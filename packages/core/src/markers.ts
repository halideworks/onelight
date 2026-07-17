import {
  formatTimecode,
  framesFromTimecode,
  isDropFrameRate,
  parseTimecode,
  timecodeFromFrames,
  type FrameRate,
} from "./timecode.js";

export interface MarkerComment {
  id: string;
  bodyText: string;
  authorName?: string | null;
  frameIn: number;
  frameOut?: number | null;
}

export interface MarkerOptions {
  title?: string;
  rate: FrameRate;
  startFrame?: number;
  dropFrame?: boolean;
  timecodeBase?: "source" | "record_run";
}

// Text encoding for structure-constrained formats.
//
// The Resolve marker EDL and the Avid marker text format are line- and
// field-oriented, so raw newlines (and, in the EDL, raw pipes) cannot
// survive. One encoding is used everywhere structure forbids the raw
// character, for multi-line single comments and grouped same-frame bodies
// alike:
//   - every newline (CR, LF, CRLF) becomes the two-character sequence "\n"
//   - a pipe in the EDL becomes "/" (a pipe opens the next EDL field)
//   - a tab in the Avid text format becomes a space (tabs separate fields)
// CSV, JSON, and plain text exporters keep comment text verbatim.
const ENCODED_NEWLINE = "\\n";

const encodeNewlines = (value: string): string =>
  value.replace(/\r\n|\r|\n/g, ENCODED_NEWLINE);

// XML 1.0 forbids the C0 control characters other than tab, LF, and CR, even
// as numeric character references, so a raw control byte in a comment would
// make the FCPXML or xmeml document unparseable. Strip them before escaping.
// Tab, LF, and CR are preserved (the callers handle newlines themselves).
const stripXmlControls = (value: string): string =>
  // eslint-disable-next-line no-control-regex
  value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");

// Resolve exporter sanitization per design doc section 12: ASCII only
// (transliterate diacritics via NFKD, strip what remains) and a "_" prefix
// when the marker text would start with a digit (Resolve drops such notes).
const toAscii = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, "");

const edlText = (value: string): string =>
  toAscii(encodeNewlines(value).replace(/\|/g, "/").replace(/\t/g, " ")).trim();

const avidText = (value: string): string =>
  encodeNewlines(value).replace(/\t/g, " ").trim();

const byFrameThenId = (left: MarkerComment, right: MarkerComment): number =>
  left.frameIn - right.frameIn || left.id.localeCompare(right.id);

const sourceFrame = (frame: number, options: MarkerOptions): number =>
  options.timecodeBase === "record_run"
    ? frame
    : (options.startFrame ?? 0) + frame;

// Drop-frame timecode is only defined at 29.97 and 59.94 fps. A source that
// is mistagged dropFrame at any other rate is coerced to non-drop here rather
// than throwing, so the export still succeeds (the label is plain NDF).
const effectiveDropFrame = (options: MarkerOptions): boolean =>
  Boolean(options.dropFrame) && isDropFrameRate(options.rate);

const timecodeLabel = (frame: number, options: MarkerOptions): string =>
  formatTimecode(
    timecodeFromFrames(frame, options.rate, effectiveDropFrame(options)),
  );

// Inclusive frameOut, so a point marker (frameOut null) has duration 1.
const durationFrames = (comment: MarkerComment): number =>
  Math.max(1, (comment.frameOut ?? comment.frameIn) - comment.frameIn + 1);

// Resolve marker EDL, imported via Timelines > Import > Timeline Markers
// from EDL. Format verified against working converters (see
// docs/research/playback-transcode.md section 5.3): CMX3600-style header,
// blank line, then per marker an event line with four timecodes (src in,
// src out, rec in, rec out; out is exclusive, in + duration) and a
// continuation line ` |C:<color> |M:<text> |D:<duration frames>`.
// Same-frame comments are grouped into one marker (Resolve collapses
// same-frame markers) ordered by ULID and joined with the encoded newline.
export const exportResolveEdl = (
  comments: readonly MarkerComment[],
  options: MarkerOptions,
): string => {
  const sorted = [...comments].sort(byFrameThenId);
  const lines = [
    `TITLE: ${edlText(options.title ?? "Onelight Comments")}`,
    `FCM: ${effectiveDropFrame(options) ? "DROP FRAME" : "NON-DROP FRAME"}`,
    "",
  ];
  let event = 1;
  for (let index = 0; index < sorted.length;) {
    const frame = sorted[index]?.frameIn ?? 0;
    const group: MarkerComment[] = [];
    while (index < sorted.length && sorted[index]?.frameIn === frame) {
      const comment = sorted[index];
      if (comment) group.push(comment);
      index += 1;
    }
    if (group.length === 0) continue;
    const inFrame = sourceFrame(frame, options);
    const duration = Math.max(...group.map(durationFrames));
    const inLabel = timecodeLabel(inFrame, options);
    const outLabel = timecodeLabel(inFrame + duration, options);
    const rawBody = group
      .map(
        (comment) =>
          `${edlText(comment.bodyText)}${
            comment.authorName ? ` (${edlText(comment.authorName)})` : ""
          }`,
      )
      .join(ENCODED_NEWLINE);
    const body = /^\d/.test(rawBody) ? `_${rawBody}` : rawBody;
    lines.push(
      `${String(event).padStart(3, "0")}  001      V     C        ${inLabel} ${outLabel} ${inLabel} ${outLabel}`,
      ` |C:ResolveColorBlue |M:${body} |D:${duration}`,
    );
    event += 1;
  }
  return `${lines.join("\n")}\n`;
};

export const exportCsv = (
  comments: readonly MarkerComment[],
  options: MarkerOptions,
): string => {
  const quote = (value: string): string => `"${value.replace(/"/g, '""')}"`;
  const rows = ["id,frame_in,frame_out,timecode,body,author"];
  for (const comment of [...comments].sort(byFrameThenId)) {
    rows.push(
      [
        comment.id,
        String(comment.frameIn),
        String(comment.frameOut ?? comment.frameIn),
        timecodeLabel(sourceFrame(comment.frameIn, options), options),
        comment.bodyText,
        comment.authorName ?? "",
      ]
        .map(quote)
        .join(","),
    );
  }
  return `${rows.join("\n")}\n`;
};

// FCPXML with the minimal structure FCPX accepts: resources > format with
// the rational frameDuration, then library > event > project > sequence >
// spine > gap, with the markers inside the gap. All times are exact
// integer rationals "N/Ds" (frames * den / num seconds).
export const exportFcpXml = (
  comments: readonly MarkerComment[],
  options: MarkerOptions,
): string => {
  const escapeAttr = (value: string): string =>
    stripXmlControls(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/"/g, "&quot;")
      .replace(/]]>/g, "]]&gt;")
      .replace(/\r\n|\r|\n/g, "&#10;");
  const { num, den } = options.rate;
  const time = (frames: number): string => `${frames * den}/${num}s`;
  const sorted = [...comments].sort(byFrameThenId);
  let end = 1;
  const markers = sorted.map((comment) => {
    const start = sourceFrame(comment.frameIn, options);
    const duration = durationFrames(comment);
    end = Math.max(end, start + duration);
    return `              <marker start="${time(start)}" duration="${time(duration)}" value="${escapeAttr(comment.bodyText)}"/>`;
  });
  const title = escapeAttr(options.title ?? "Onelight Comments");
  return `${[
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE fcpxml>`,
    `<fcpxml version="1.11">`,
    `  <resources>`,
    `    <format id="r1" frameDuration="${den}/${num}s" width="1920" height="1080"/>`,
    `  </resources>`,
    `  <library>`,
    `    <event name="${title}">`,
    `      <project name="${title}">`,
    `        <sequence format="r1" duration="${time(end)}" tcStart="0s" tcFormat="${effectiveDropFrame(options) ? "DF" : "NDF"}">`,
    `          <spine>`,
    `            <gap name="Gap" offset="0s" start="0s" duration="${time(end)}">`,
    ...markers,
    `            </gap>`,
    `          </spine>`,
    `        </sequence>`,
    `      </project>`,
    `    </event>`,
    `  </library>`,
    `</fcpxml>`,
  ].join("\n")}\n`;
};

// Media Composer marker import (Tools > Markers > Import) accepts a
// tab-separated .txt with five fields per line:
// name <TAB> timecode <TAB> track <TAB> color <TAB> comment
// (docs/research/playback-transcode.md section 5.3). Text stays verbatim
// except tabs (field separators) and newlines (record separators), which
// use the shared encoding above.
export const exportAvidText = (
  comments: readonly MarkerComment[],
  options: MarkerOptions,
): string =>
  [...comments]
    .sort(byFrameThenId)
    .map((comment) =>
      [
        avidText(comment.authorName ?? "Onelight"),
        timecodeLabel(sourceFrame(comment.frameIn, options), options),
        "V1",
        "blue",
        avidText(comment.bodyText),
      ].join("\t"),
    )
    .join("\n") + "\n";

// Media Composer's marker XML schema is not publicly documented and no
// captured sample exists in docs/research; the design doc requires
// round-tripping a real MC export before shipping a bespoke XML shape.
// Until then this emits the MC-compatible tab-separated text format, which
// the same Markers window imports.
export const exportAvidXml = (
  comments: readonly MarkerComment[],
  options: MarkerOptions,
): string => exportAvidText(comments, options);

// FCP7 XML (xmeml) sequence markers for Premiere import. The sequence must
// declare <rate> with <timebase> (rounded rate) and <ntsc> (TRUE for
// 1001-denominator rates) or Premiere cannot place the markers. Marker
// body goes in <comment>, the author in <name>. Point markers use out -1,
// ranges use the exclusive out frame.
export const exportXmeml = (
  comments: readonly MarkerComment[],
  options: MarkerOptions,
): string => {
  const escapeText = (value: string): string =>
    stripXmlControls(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      // "]]>" is forbidden in XML character data even outside a CDATA section.
      .replace(/]]>/g, "]]&gt;");
  const timebase = Math.round(options.rate.num / options.rate.den);
  const ntsc = options.rate.den === 1001 ? "TRUE" : "FALSE";
  const sorted = [...comments].sort(byFrameThenId);
  let sequenceDuration = 0;
  const markers = sorted.map((comment) => {
    const inFrame = sourceFrame(comment.frameIn, options);
    const isRange =
      comment.frameOut != null && comment.frameOut > comment.frameIn;
    const outFrame = isRange ? inFrame + durationFrames(comment) : -1;
    sequenceDuration = Math.max(sequenceDuration, inFrame + 1, outFrame);
    return [
      `    <marker>`,
      `      <name>${escapeText(comment.authorName ?? "")}</name>`,
      `      <comment>${escapeText(comment.bodyText)}</comment>`,
      `      <in>${inFrame}</in>`,
      `      <out>${outFrame}</out>`,
      `    </marker>`,
    ].join("\n");
  });
  return `${[
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE xmeml>`,
    `<xmeml version="5">`,
    `  <sequence>`,
    `    <name>${escapeText(options.title ?? "Onelight Comments")}</name>`,
    `    <duration>${sequenceDuration}</duration>`,
    `    <rate>`,
    `      <timebase>${timebase}</timebase>`,
    `      <ntsc>${ntsc}</ntsc>`,
    `    </rate>`,
    ...markers,
    `  </sequence>`,
    `</xmeml>`,
  ].join("\n")}\n`;
};

export const exportJson = (
  comments: readonly MarkerComment[],
  options: MarkerOptions,
): string =>
  JSON.stringify(
    [...comments].sort(byFrameThenId).map((comment) => ({
      ...comment,
      timecode: timecodeLabel(sourceFrame(comment.frameIn, options), options),
    })),
    null,
    2,
  ) + "\n";

export const exportText = (
  comments: readonly MarkerComment[],
  options: MarkerOptions,
): string =>
  [...comments]
    .sort(byFrameThenId)
    .map(
      (comment) =>
        `${timecodeLabel(sourceFrame(comment.frameIn, options), options)} ${comment.bodyText}`,
    )
    .join("\n") + "\n";

/* ---- the way back: marker files into comments ---- */

export interface ImportedMarker {
  frameIn: number;
  frameOut: number | null;
  bodyText: string;
}

/* Parses the Resolve marker EDL this module writes (and what Resolve's own
   Export > Timeline Markers to EDL produces): an event line carrying four
   timecodes, then a continuation line with |M:<text> and |D:<duration>.
   The record-in timecode anchors the marker; the duration reopens the span.
   Unparseable lines are skipped rather than fatal, because these files come
   from NLEs and converters with their own ideas about whitespace. */
export const parseResolveEdl = (
  content: string,
  options: MarkerOptions,
): ImportedMarker[] => {
  const markers: ImportedMarker[] = [];
  const lines = content.split(/\r?\n/);
  const start =
    options.timecodeBase === "record_run" ? 0 : (options.startFrame ?? 0);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const event =
      /^\d+\s+\S+\s+\S+\s+\S+\s+(\d{2,}:\d{2}:\d{2}[:;]\d{2})\s+\d{2,}:\d{2}:\d{2}[:;]\d{2}\s+(\d{2,}:\d{2}:\d{2}[:;]\d{2})\s+\d{2,}:\d{2}:\d{2}[:;]\d{2}\s*$/.exec(
        line,
      );
    if (!event) continue;
    const continuation = lines[index + 1] ?? "";
    const text = /\|M:(.*?)(?:\s*\|D:(\d+))?\s*$/.exec(continuation);
    if (!text) continue;
    const anchor = event[2] ?? event[1] ?? "";
    let frame: number;
    try {
      frame = framesFromTimecode(
        parseTimecode(anchor, options.rate),
        options.rate,
      );
    } catch {
      continue;
    }
    const frameIn = Math.max(0, frame - start);
    const duration = text[2] ? Number(text[2]) : 1;
    const body = (text[1] ?? "")
      .replace(/^_(?=\d)/, "")
      .split(ENCODED_NEWLINE)
      .join("\n")
      .trim();
    if (!body) continue;
    markers.push({
      frameIn,
      frameOut: duration > 1 ? frameIn + duration - 1 : null,
      bodyText: body,
    });
    index += 1;
  }
  return markers;
};

/* Parses the CSV this module writes: quoted fields, columns
   id,frame_in,frame_out,timecode,body,author. Frames are authoritative;
   the timecode column is a label. */
export const parseMarkersCsv = (content: string): ImportedMarker[] => {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  for (let at = 0; at < content.length; at += 1) {
    const char = content[at] ?? "";
    if (quoted) {
      if (char === '"' && content[at + 1] === '"') {
        field += '"';
        at += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && content[at + 1] === "\n") at += 1;
      row.push(field);
      field = "";
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
    } else field += char;
  }
  row.push(field);
  if (row.some((value) => value.length > 0)) rows.push(row);
  const header = rows[0] ?? [];
  const frameInAt = header.indexOf("frame_in");
  const frameOutAt = header.indexOf("frame_out");
  const bodyAt = header.indexOf("body");
  if (frameInAt < 0 || bodyAt < 0) return [];
  const markers: ImportedMarker[] = [];
  for (const cells of rows.slice(1)) {
    const frameIn = Number(cells[frameInAt]);
    const body = (cells[bodyAt] ?? "").trim();
    if (!Number.isInteger(frameIn) || frameIn < 0 || !body) continue;
    const frameOut = frameOutAt >= 0 ? Number(cells[frameOutAt]) : NaN;
    markers.push({
      frameIn,
      frameOut:
        Number.isInteger(frameOut) && frameOut > frameIn ? frameOut : null,
      bodyText: body,
    });
  }
  return markers;
};
