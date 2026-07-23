/* Fuzz suite for the marker exporters: 500 seeded-random batches of hostile
 * comments (control characters, pipes, newlines, tabs, RTL and other
 * non-emoji unicode, 10KB bodies, leading digits) across the full supported
 * rate set, through every exporter. Structural guarantees under test:
 *
 *   - no exporter throws on any valid comment row,
 *   - Resolve EDL stays pipe-field-parseable and pure printable ASCII,
 *   - CSV round-trips verbatim through a real RFC 4180 parse,
 *   - FCPXML and xmeml stay well-formed (regex-free SAX-ish scan:
 *     balanced tags, quoted attributes, no raw "<", entities valid),
 *   - Avid text stays five tab-separated fields per marker,
 *   - JSON round-trips verbatim.
 *
 * The seed prints at collection and is embedded in every failure message;
 * reproduce with FUZZ_SEED=<seed> pnpm test.
 *
 * The hostile corpus includes XML-illegal controls, raw "]]>", and
 * mistagged drop-frame flags. These are regression cases found by the
 * original fuzz pass and now fixed in the exporters.
 */

import { describe, expect, it } from "vitest";
import {
  exportAvidText,
  exportAvidXml,
  exportCsv,
  exportFcpXml,
  exportJson,
  exportResolveEdl,
  exportText,
  exportXmeml,
} from "./markers.js";
import type { MarkerComment, MarkerOptions } from "./markers.js";
import { isDropFrameRate, SUPPORTED_RATES } from "./timecode.js";

const ITERATIONS = 500;

const seed =
  process.env.FUZZ_SEED !== undefined
    ? Number(process.env.FUZZ_SEED) >>> 0
    : (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
console.log(
  `[fuzz] markers: seed ${seed} (run with FUZZ_SEED=${seed} to reproduce)`,
);

/* mulberry32: tiny, deterministic, good enough distribution for fuzzing. */
const mulberry32 = (state: number) => (): number => {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const rng = mulberry32(seed);
const int = (maxExclusive: number): number => Math.floor(rng() * maxExclusive);
const pick = <T>(values: readonly T[]): T => {
  const value = values[int(values.length)];
  if (value === undefined) throw new Error("pick from empty array");
  return value;
};

const FRAGMENTS: readonly string[] = [
  "plain note",
  "42 leading digit",
  "007 starts numeric",
  "pipe | in | text |M:fake |D:9",
  "line one\nline two",
  "crlf\r\nline",
  "lone\rcarriage",
  "tab\tseparated\tfields",
  "control \u0000\u0001\u0007\u001b\u001f chars",
  "rtl ‮txet desrever‬ mixed",
  "hebrew שלום arabic مرحبا",
  "cjk 日本語テスト",
  "diacritics café naïve ṩ",
  "combining é à ñ",
  `quotes "double" 'single' \`back\``,
  `xmlish <tag attr="v"> </tag> raw > close`,
  "ampersands && &amp; &lt; &#10; &bogus; &",
  "backslash \\n literal \\ trailing",
  "comma,separated,values",
  "  leading and trailing spaces  ",
];

const BIG_CHUNK = "0123456789 hostile café 日本 | line\n";

const randomBody = (): string => {
  let body: string;
  if (rng() < 0.08) {
    body = BIG_CHUNK.repeat(320); // roughly 10KB
  } else {
    const parts: string[] = [];
    const count = 1 + int(3);
    for (let index = 0; index < count; index += 1) parts.push(pick(FRAGMENTS));
    body = parts.join(" ");
  }
  return body;
};

const randomComments = (): MarkerComment[] => {
  const count = 1 + int(4);
  const comments: MarkerComment[] = [];
  for (let index = 0; index < count; index += 1) {
    const frameIn = int(250_000);
    const shape = rng();
    comments.push({
      id: `${String(int(1_000_000)).padStart(7, "0")}-${index}`,
      bodyText: randomBody(),
      authorName: rng() < 0.25 ? null : randomBody().slice(0, 80),
      frameIn,
      frameOut:
        shape < 0.4 ? null : shape < 0.6 ? frameIn : frameIn + 1 + int(5_000),
      completed: rng() < 0.35,
      internal: rng() < 0.2,
      replies:
        rng() < 0.35
          ? [
              {
                id: `${String(int(1_000_000)).padStart(7, "0")}-${index}-r`,
                bodyText: randomBody(),
                authorName: rng() < 0.25 ? null : randomBody().slice(0, 80),
              },
            ]
          : [],
    });
  }
  return comments;
};

const randomOptions = (): MarkerOptions => {
  const rate = pick(SUPPORTED_RATES);
  return {
    ...(rng() < 0.3 ? {} : { title: pick(FRAGMENTS) }),
    rate,
    dropFrame: rng() < 0.5,
    startFrame: rng() < 0.5 ? 0 : int(2_000_000),
    timecodeBase: rng() < 0.5 ? "source" : "record_run",
  };
};

const sortLikeExporters = (comments: readonly MarkerComment[]) =>
  [...comments].sort(
    (left, right) =>
      left.frameIn - right.frameIn || left.id.localeCompare(right.id),
  );

/* ------------------------------------------------------------------ */
/* Format checkers                                                     */
/* ------------------------------------------------------------------ */

const TIMECODE_PATTERN = /^\d{2,}:\d{2}:\d{2}[:;]\d{2}$/;

const checkEdl = (
  output: string,
  comments: readonly MarkerComment[],
  options: MarkerOptions,
  context: string,
): void => {
  const lines = output.split("\n");
  expect(lines[lines.length - 1], `${context}: EDL ends with newline`).toBe("");
  lines.pop();
  /* Plain scan (not expect per character) keeps 10KB bodies cheap. */
  for (const [lineNo, line] of lines.entries())
    for (let index = 0; index < line.length; index += 1) {
      const code = line.charCodeAt(index);
      if (code < 0x20 || code > 0x7e)
        throw new Error(
          `${context}: EDL line ${lineNo} carries non printable-ASCII code ${code}`,
        );
    }
  expect(lines[0]?.startsWith("TITLE: "), `${context}: TITLE line`).toBe(true);
  expect(lines[1], `${context}: FCM line`).toBe(
    options.dropFrame && isDropFrameRate(options.rate)
      ? "FCM: DROP FRAME"
      : "FCM: NON-DROP FRAME",
  );
  expect(lines[2], `${context}: blank line after header`).toBe("");
  const body = lines.slice(3);
  expect(
    body.length % 2,
    `${context}: EDL body alternates event/continuation lines`,
  ).toBe(0);
  const distinctFrames = new Set(comments.map((comment) => comment.frameIn));
  expect(body.length / 2, `${context}: one event per distinct frame`).toBe(
    distinctFrames.size,
  );
  for (let index = 0; index < body.length; index += 2) {
    const event = body[index] ?? "";
    const continuation = body[index + 1] ?? "";
    const tokens = event.split(/\s+/).filter((token) => token.length);
    expect(
      tokens.length,
      `${context}: event line "${event}" has 8 fields`,
    ).toBe(8);
    expect(/^\d{3,}$/.test(tokens[0] ?? ""), `${context}: event number`).toBe(
      true,
    );
    for (const timecode of tokens.slice(4))
      expect(
        TIMECODE_PATTERN.test(timecode),
        `${context}: event timecode "${timecode}"`,
      ).toBe(true);
    /* Pipe-field parseability: exactly the three fields the importer
       splits on, which requires the encoded text to be pipe-free. */
    const fields = continuation.split("|");
    expect(
      fields.length,
      `${context}: continuation "${continuation.slice(0, 120)}" splits into exactly 4 pipe fields`,
    ).toBe(4);
    expect(fields[1]?.startsWith("C:"), `${context}: color field`).toBe(true);
    expect(fields[2]?.startsWith("M:"), `${context}: marker field`).toBe(true);
    expect(
      /^D:\d+\s*$/.test(fields[3] ?? ""),
      `${context}: duration field "${fields[3]}"`,
    ).toBe(true);
  }
};

/* Real RFC 4180 parse: quoted fields, doubled-quote escapes, newlines and
   carriage returns preserved inside quotes. */
const parseCsv = (text: string, context: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let index = 0;
  while (index < text.length) {
    const char = text[index] as string;
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"') {
      expect(field, `${context}: quote opens at field start`).toBe("");
      inQuotes = true;
      index += 1;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      index += 1;
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }
  expect(inQuotes, `${context}: CSV ends outside quotes`).toBe(false);
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
};

const checkCsv = (
  output: string,
  comments: readonly MarkerComment[],
  context: string,
): void => {
  const rows = parseCsv(output, context);
  const sorted = sortLikeExporters(comments);
  expect(rows.length, `${context}: header plus one row per comment`).toBe(
    sorted.length + 1,
  );
  expect(rows[0]?.join(","), `${context}: CSV header`).toBe(
    "id,frame_in,frame_out,timecode,body,author",
  );
  for (const [index, comment] of sorted.entries()) {
    const row = rows[index + 1];
    expect(row?.length, `${context}: row ${index} has 6 fields`).toBe(6);
    if (!row) continue;
    expect(row[0], `${context}: row ${index} id`).toBe(comment.id);
    expect(row[1], `${context}: row ${index} frame_in`).toBe(
      String(comment.frameIn),
    );
    expect(
      TIMECODE_PATTERN.test(row[3] ?? ""),
      `${context}: row ${index} timecode "${row[3]}"`,
    ).toBe(true);
    /* The verbatim round trip: hostile bytes in, identical bytes out. */
    expect(row[4], `${context}: row ${index} body round-trips`).toBe(
      comment.bodyText,
    );
    expect(row[5], `${context}: row ${index} author`).toBe(
      comment.authorName ?? "",
    );
  }
};

/* Regex-free XML well-formedness scan: balanced tags, quoted attribute
   values with no raw "<", entities restricted to the five predefined names
   plus numeric references, and no "]]>" in text content. Raw ">" in text
   is legal XML and the exporters rely on that; character-level validity
   (control characters) is deliberately not checked, see known issue 1. */
const scanXml = (xml: string, context: string): void => {
  const fail = (message: string, at: number): never => {
    throw new Error(
      `${context}: XML ill-formed at index ${at}: ${message} (near "${xml.slice(Math.max(0, at - 30), at + 30)}")`,
    );
  };
  const isNameCode = (code: number): boolean =>
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 45 ||
    code === 46 ||
    code === 58 ||
    code === 95;
  const isSpace = (char: string | undefined): boolean =>
    char === " " || char === "\n" || char === "\t" || char === "\r";
  const length = xml.length;
  const stack: string[] = [];
  const entityEnd = (from: number): number => {
    let index = from + 1;
    if (xml[index] === "#") {
      index += 1;
      const hex = xml[index] === "x";
      if (hex) index += 1;
      const digitsStart = index;
      while (index < length && xml[index] !== ";") {
        const code = xml.charCodeAt(index);
        const isDigit = code >= 48 && code <= 57;
        const isHexAlpha =
          (code >= 97 && code <= 102) || (code >= 65 && code <= 70);
        if (!(isDigit || (hex && isHexAlpha)))
          fail("bad numeric character reference", from);
        index += 1;
      }
      if (index >= length || index === digitsStart)
        fail("unterminated numeric character reference", from);
      return index + 1;
    }
    const nameStart = index;
    while (index < length && isNameCode(xml.charCodeAt(index))) index += 1;
    if (xml[index] !== ";") fail("unterminated entity", from);
    const name = xml.slice(nameStart, index);
    if (!["amp", "lt", "gt", "quot", "apos"].includes(name))
      fail(`undefined entity &${name};`, from);
    return index + 1;
  };
  let i = 0;
  while (i < length) {
    const char = xml[i];
    if (char === "<") {
      if (xml[i + 1] === "?") {
        const end = xml.indexOf("?>", i);
        if (end < 0) fail("unterminated processing instruction", i);
        i = end + 2;
        continue;
      }
      if (xml[i + 1] === "!") {
        const end = xml.indexOf(">", i);
        if (end < 0) fail("unterminated declaration", i);
        i = end + 1;
        continue;
      }
      if (xml[i + 1] === "/") {
        let j = i + 2;
        const nameStart = j;
        while (j < length && isNameCode(xml.charCodeAt(j))) j += 1;
        const name = xml.slice(nameStart, j);
        while (isSpace(xml[j])) j += 1;
        if (xml[j] !== ">") fail("malformed closing tag", i);
        const open = stack.pop();
        if (open !== name)
          fail(`closing </${name}> does not match <${open ?? "nothing"}>`, i);
        i = j + 1;
        continue;
      }
      let j = i + 1;
      const nameStart = j;
      while (j < length && isNameCode(xml.charCodeAt(j))) j += 1;
      if (j === nameStart) fail("tag without a name", i);
      const name = xml.slice(nameStart, j);
      let selfClosing = false;
      for (;;) {
        while (isSpace(xml[j])) j += 1;
        if (j >= length) fail("unterminated tag", i);
        if (xml[j] === "/") {
          if (xml[j + 1] !== ">") fail("stray slash inside tag", j);
          selfClosing = true;
          j += 2;
          break;
        }
        if (xml[j] === ">") {
          j += 1;
          break;
        }
        const attrStart = j;
        while (j < length && isNameCode(xml.charCodeAt(j))) j += 1;
        if (j === attrStart) fail("malformed attribute name", j);
        if (xml[j] !== "=") fail("attribute without a value", j);
        j += 1;
        const quote = xml[j];
        if (quote !== '"' && quote !== "'") fail("unquoted attribute value", j);
        j += 1;
        while (j < length && xml[j] !== quote) {
          if (xml[j] === "<") fail("raw < inside attribute value", j);
          if (xml[j] === "&") {
            j = entityEnd(j);
            continue;
          }
          j += 1;
        }
        if (j >= length) fail("unterminated attribute value", attrStart);
        j += 1;
      }
      if (!selfClosing) stack.push(name);
      i = j;
      continue;
    }
    if (char === "&") {
      i = entityEnd(i);
      continue;
    }
    if (char === ">" && xml[i - 1] === "]" && xml[i - 2] === "]")
      fail("]]> sequence in text content", i);
    i += 1;
  }
  if (stack.length) fail(`unclosed elements ${stack.join(", ")}`, length);
};

const countOccurrences = (haystack: string, needle: string): number => {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
};

const checkAvidText = (
  output: string,
  comments: readonly MarkerComment[],
  context: string,
): void => {
  expect(output.endsWith("\n"), `${context}: Avid text ends with newline`).toBe(
    true,
  );
  const trimmed = output.slice(0, -1);
  const lines = trimmed === "" ? [] : trimmed.split("\n");
  expect(lines.length, `${context}: one line per comment`).toBe(
    comments.length,
  );
  for (const [index, line] of lines.entries()) {
    const fields = line.split("\t");
    expect(
      fields.length,
      `${context}: line ${index} has exactly 5 tab fields (got ${fields.length})`,
    ).toBe(5);
    expect(
      TIMECODE_PATTERN.test(fields[1] ?? ""),
      `${context}: line ${index} timecode "${fields[1]}"`,
    ).toBe(true);
    expect(fields[2], `${context}: line ${index} track`).toBe("V1");
  }
};

const checkJson = (
  output: string,
  comments: readonly MarkerComment[],
  context: string,
): void => {
  const parsed = JSON.parse(output) as Array<Record<string, unknown>>;
  const sorted = sortLikeExporters(comments);
  expect(parsed.length, `${context}: JSON row count`).toBe(sorted.length);
  for (const [index, comment] of sorted.entries()) {
    expect(parsed[index]?.id, `${context}: JSON row ${index} id`).toBe(
      comment.id,
    );
    expect(
      parsed[index]?.bodyText,
      `${context}: JSON row ${index} body round-trips`,
    ).toBe(comment.bodyText);
    const timecode = parsed[index]?.timecode;
    expect(
      typeof timecode === "string" && TIMECODE_PATTERN.test(timecode),
      `${context}: JSON row ${index} timecode`,
    ).toBe(true);
  }
};

/* ------------------------------------------------------------------ */
/* The fuzz loop                                                       */
/* ------------------------------------------------------------------ */

describe("markers fuzz: hostile comments through every exporter", () => {
  it(`survives ${ITERATIONS} seeded-random batches (seed ${seed})`, () => {
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const comments = iteration === 0 ? [] : randomComments();
      const options = randomOptions();
      const context = `seed ${seed} iteration ${iteration} rate ${options.rate.num}/${options.rate.den}${options.dropFrame ? " DF" : ""}`;
      const exporters: Array<[string, () => string]> = [
        ["resolve_edl", () => exportResolveEdl(comments, options)],
        ["csv", () => exportCsv(comments, options)],
        ["fcpxml", () => exportFcpXml(comments, options)],
        ["avid_txt", () => exportAvidText(comments, options)],
        ["avid_xml", () => exportAvidXml(comments, options)],
        ["xmeml", () => exportXmeml(comments, options)],
        ["json", () => exportJson(comments, options)],
        ["text", () => exportText(comments, options)],
      ];
      const outputs = new Map<string, string>();
      for (const [name, produce] of exporters) {
        try {
          outputs.set(name, produce());
        } catch (error) {
          throw new Error(
            `${context}: exporter ${name} threw: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      checkEdl(
        outputs.get("resolve_edl") ?? "",
        comments,
        options,
        `${context} resolve_edl`,
      );
      checkCsv(outputs.get("csv") ?? "", comments, `${context} csv`);
      const fcpxml = outputs.get("fcpxml") ?? "";
      scanXml(fcpxml, `${context} fcpxml`);
      expect(
        countOccurrences(fcpxml, "<marker "),
        `${context}: fcpxml marker count`,
      ).toBe(comments.length);
      const xmeml = outputs.get("xmeml") ?? "";
      scanXml(xmeml, `${context} xmeml`);
      expect(
        countOccurrences(xmeml, "<marker>"),
        `${context}: xmeml marker count`,
      ).toBe(comments.length);
      checkAvidText(
        outputs.get("avid_txt") ?? "",
        comments,
        `${context} avid_txt`,
      );
      /* exportAvidXml is documented to emit the same tab-separated text
         until a real Media Composer XML sample is round-tripped. */
      expect(outputs.get("avid_xml"), `${context}: avid_xml alias`).toBe(
        outputs.get("avid_txt"),
      );
      checkJson(outputs.get("json") ?? "", comments, `${context} json`);
      const text = outputs.get("text") ?? "";
      expect(text.endsWith("\n"), `${context}: text ends with newline`).toBe(
        true,
      );
      if (comments.length)
        expect(
          /^\d{2,}:\d{2}:\d{2}[:;]\d{2} /.test(text),
          `${context}: text starts with a timecode label`,
        ).toBe(true);
    }
  });
});
