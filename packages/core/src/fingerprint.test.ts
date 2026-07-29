import { describe, expect, it } from "vitest";
import {
  CONTENT_MATCH_MIN_MARGIN,
  captureIdentityFromExif,
  captureIdentityFromTags,
  captureKeyOf,
  contentDistance,
  dHashFromLuma,
  hashDistance,
  joinHashes,
  readExifStrings,
} from "./fingerprint.js";

/* A 9x8 greyscale sample, as the worker hands one over. */
const luma = (build: (x: number, y: number) => number): Uint8Array => {
  const out = new Uint8Array(9 * 8);
  for (let y = 0; y < 8; y += 1)
    for (let x = 0; x < 9; x += 1) out[y * 9 + x] = build(x, y);
  return out;
};

describe("dHashFromLuma", () => {
  it("is 16 hex characters, which is 64 bits", () => {
    const hash = dHashFromLuma(
      luma((x) => x * 20),
      9,
      8,
    );
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("reads a ramp one way and its mirror the other", () => {
    const rising = dHashFromLuma(
      luma((x) => x * 20),
      9,
      8,
    );
    const falling = dHashFromLuma(
      luma((x) => 200 - x * 20),
      9,
      8,
    );
    expect(rising).not.toBe(falling);
    /* Every comparison flips, so every bit does. */
    expect(hashDistance(rising, falling)).toBe(64);
  });

  it("is unmoved by an overall exposure shift", () => {
    /* A difference hash compares neighbours, so lifting the whole frame
       changes nothing: this is why a re-grade still matches. */
    const base = dHashFromLuma(
      luma((x, y) => 40 + x * 10 + y),
      9,
      8,
    );
    const lifted = dHashFromLuma(
      luma((x, y) => 60 + x * 10 + y),
      9,
      8,
    );
    expect(hashDistance(base, lifted)).toBe(0);
  });

  it("refuses a sample that is not big enough to hash", () => {
    expect(() => dHashFromLuma(new Uint8Array(4), 9, 8)).toThrow(/9x8/);
  });
});

describe("hashDistance", () => {
  it("counts the bits that differ", () => {
    expect(hashDistance("0000000000000000", "0000000000000000")).toBe(0);
    expect(hashDistance("0000000000000001", "0000000000000000")).toBe(1);
    expect(hashDistance("ffffffffffffffff", "0000000000000000")).toBe(64);
  });

  it("treats a mismatched or unreadable hash as infinitely far", () => {
    expect(hashDistance("abc", "abcd")).toBe(Number.MAX_SAFE_INTEGER);
    expect(hashDistance("", "")).toBe(Number.MAX_SAFE_INTEGER);
    expect(hashDistance("zzzz", "0000")).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("contentDistance", () => {
  it("averages a clip's parts position by position", () => {
    const a = joinHashes(["0000000000000000", "0000000000000000"]);
    const b = joinHashes(["0000000000000003", "0000000000000001"]);
    /* Two bits in one part and one in the other: an average of 1.5, rounded. */
    expect(contentDistance(a, b)).toBe(2);
  });

  it("refuses to compare signatures of different shapes", () => {
    expect(
      contentDistance(
        joinHashes(["0000000000000000"]),
        joinHashes(["0000000000000000", "0000000000000000"]),
      ),
    ).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("captureKeyOf", () => {
  it("needs more than a bare second to be an identity", () => {
    /* A batch export stamps a hundred files with the same second, so a
       creation time on its own is not specific enough to pair on. */
    expect(captureKeyOf({ takenAt: "2026:07:29 14:03:11" })).toBeNull();
    expect(captureKeyOf({})).toBeNull();
    expect(captureKeyOf({ body: "NIKON Z 9" })).toBeNull();
  });

  it("accepts a sub-second, a body, or a timecode beside the time", () => {
    expect(captureKeyOf({ takenAt: "2026:07:29 14:03:11.470" })).toBeTruthy();
    expect(
      captureKeyOf({
        takenAt: "2026:07:29 14:03:11",
        body: "NIKON Z 9 3005421",
      }),
    ).toBeTruthy();
    expect(
      captureKeyOf({
        takenAt: "2026-07-29T14:03:11Z",
        timecode: "01:00:00:00",
      }),
    ).toBeTruthy();
  });

  it("is stable under case and spacing", () => {
    expect(
      captureKeyOf({ takenAt: "2026:07:29 14:03:11.470", body: "NIKON  Z 9" }),
    ).toBe(
      captureKeyOf({ takenAt: "2026:07:29 14:03:11.470", body: "nikon z 9" }),
    );
  });

  it("separates two frames a second apart", () => {
    const first = captureKeyOf({
      takenAt: "2026:07:29 14:03:11.470",
      body: "NIKON Z 9",
    });
    const second = captureKeyOf({
      takenAt: "2026:07:29 14:03:12.470",
      body: "NIKON Z 9",
    });
    expect(first).not.toBe(second);
  });
});

/* --- EXIF, written the way a camera writes it --- */

const exifBlock = (fields: {
  model?: string;
  make?: string;
  dateTimeOriginal?: string;
  subSec?: string;
  serial?: string;
}): Uint8Array => {
  const ascii = (text: string): Buffer => Buffer.from(`${text}\0`, "ascii");
  const parts: Array<{ tag: number; value: Buffer; ifd: 0 | 1 }> = [];
  if (fields.make)
    parts.push({ tag: 0x010f, value: ascii(fields.make), ifd: 0 });
  if (fields.model)
    parts.push({ tag: 0x0110, value: ascii(fields.model), ifd: 0 });
  if (fields.dateTimeOriginal)
    parts.push({ tag: 0x9003, value: ascii(fields.dateTimeOriginal), ifd: 1 });
  if (fields.subSec)
    parts.push({ tag: 0x9291, value: ascii(fields.subSec), ifd: 1 });
  if (fields.serial)
    parts.push({ tag: 0xa431, value: ascii(fields.serial), ifd: 1 });

  const ifd0 = parts.filter((part) => part.ifd === 0);
  const exifIfd = parts.filter((part) => part.ifd === 1);
  const ifd0Count = ifd0.length + (exifIfd.length ? 1 : 0);
  const header = 8;
  const ifd0At = header;
  const ifd0Size = 2 + ifd0Count * 12 + 4;
  const exifAt = ifd0At + ifd0Size;
  const exifSize = exifIfd.length ? 2 + exifIfd.length * 12 + 4 : 0;
  let valueAt = exifAt + exifSize;

  const chunks: Buffer[] = [];
  const place = (value: Buffer): number => {
    const at = valueAt;
    chunks.push(value);
    valueAt += value.length;
    return at;
  };
  const entryFor = (
    tag: number,
    value: Buffer,
  ): { tag: number; count: number; offset: number; inline: boolean } => {
    if (value.length <= 4)
      return { tag, count: value.length, offset: 0, inline: true };
    return { tag, count: value.length, offset: place(value), inline: false };
  };
  const ifd0Entries = ifd0.map((part) => ({
    ...entryFor(part.tag, part.value),
    raw: part.value,
  }));
  const exifEntries = exifIfd.map((part) => ({
    ...entryFor(part.tag, part.value),
    raw: part.value,
  }));

  const out = Buffer.alloc(valueAt);
  out.write("II", 0, "ascii");
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(ifd0At, 4);
  const writeIfd = (
    at: number,
    entries: Array<{
      tag: number;
      count: number;
      offset: number;
      inline: boolean;
      raw: Buffer;
    }>,
    extra?: { tag: number; value: number },
  ): void => {
    const total = entries.length + (extra ? 1 : 0);
    out.writeUInt16LE(total, at);
    const all = [
      ...entries.map((entry) => ({ ...entry, type: 2 })),
      ...(extra
        ? [
            {
              tag: extra.tag,
              type: 4,
              count: 1,
              offset: extra.value,
              inline: true,
              raw: Buffer.alloc(0),
            },
          ]
        : []),
    ].sort((left, right) => left.tag - right.tag);
    all.forEach((entry, index) => {
      const base = at + 2 + index * 12;
      out.writeUInt16LE(entry.tag, base);
      out.writeUInt16LE(entry.type, base + 2);
      out.writeUInt32LE(entry.count, base + 4);
      if (entry.type === 4) out.writeUInt32LE(entry.offset, base + 8);
      else if (entry.inline) entry.raw.copy(out, base + 8);
      else out.writeUInt32LE(entry.offset, base + 8);
    });
    out.writeUInt32LE(0, at + 2 + total * 12);
  };
  writeIfd(
    ifd0At,
    ifd0Entries,
    exifIfd.length ? { tag: 0x8769, value: exifAt } : undefined,
  );
  if (exifIfd.length) writeIfd(exifAt, exifEntries);
  let cursor = exifAt + exifSize;
  for (const chunk of chunks) {
    chunk.copy(out, cursor);
    cursor += chunk.length;
  }
  return new Uint8Array(out);
};

describe("readExifStrings", () => {
  it("finds the fields that identify a frame, across both IFDs", () => {
    const bytes = exifBlock({
      make: "NIKON CORPORATION",
      model: "NIKON Z 9",
      dateTimeOriginal: "2026:07:29 14:03:11",
      subSec: "470",
      serial: "3005421",
    });
    expect(readExifStrings(bytes)).toMatchObject({
      make: "NIKON CORPORATION",
      model: "NIKON Z 9",
      dateTimeOriginal: "2026:07:29 14:03:11",
      subSec: "470",
      serial: "3005421",
    });
  });

  it("reads a block that carries the Exif\\0\\0 prefix", () => {
    const inner = exifBlock({ model: "ILCE-7RM5" });
    const prefixed = new Uint8Array(inner.length + 6);
    prefixed.set(Buffer.from("Exif\0\0", "ascii"), 0);
    prefixed.set(inner, 6);
    expect(readExifStrings(prefixed).model).toBe("ILCE-7RM5");
  });

  it("returns nothing rather than throwing on rubbish", () => {
    expect(readExifStrings(new Uint8Array(0))).toEqual({});
    expect(readExifStrings(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toEqual(
      {},
    );
    expect(
      readExifStrings(Buffer.from("II*\0\xff\xff\xff\xff", "latin1")),
    ).toEqual({});
  });
});

describe("captureIdentityFromExif", () => {
  it("builds a key a retouch keeps", () => {
    const bytes = exifBlock({
      make: "NIKON CORPORATION",
      model: "NIKON Z 9",
      dateTimeOriginal: "2026:07:29 14:03:11",
      subSec: "470",
      serial: "3005421",
    });
    const identity = captureIdentityFromExif(bytes);
    expect(identity.takenAt).toBe("2026:07:29 14:03:11.470");
    expect(identity.body).toContain("NIKON Z 9");
    expect(captureKeyOf(identity)).toBeTruthy();
  });

  it("has no identity for a file that carries no EXIF", () => {
    expect(captureIdentityFromExif(undefined)).toEqual({});
    expect(captureKeyOf(captureIdentityFromExif(undefined))).toBeNull();
  });
});

describe("captureIdentityFromTags", () => {
  it("prefers QuickTime's own creation date and keeps the timecode", () => {
    const identity = captureIdentityFromTags(
      {
        "com.apple.quicktime.creationdate": "2026-07-29T14:03:11-0400",
        creation_time: "2026-07-30T09:00:00.000000Z",
        "com.apple.quicktime.model": "iPhone 17 Pro",
      },
      "01:00:00:00",
    );
    expect(identity.takenAt).toBe("2026-07-29T14:03:11-0400");
    expect(identity.body).toContain("iPhone 17 Pro");
    expect(identity.timecode).toBe("01:00:00:00");
    expect(captureKeyOf(identity)).toBeTruthy();
  });

  it("makes a key from a timecode alone, which a re-export keeps", () => {
    const identity = captureIdentityFromTags({}, "10:00:00:00");
    expect(captureKeyOf(identity)).toBeTruthy();
  });

  it("has no key for a clip with neither", () => {
    expect(captureKeyOf(captureIdentityFromTags({}, null))).toBeNull();
  });
});

describe("the margin rule", () => {
  it("is wide enough to separate a retouch from a burst neighbour", () => {
    /* Measured on this machine: a frame sits 1 bit from its own retouch and
       3 bits from the next frame of the burst. A margin under that gap would
       let a sequence pair with itself, which is the one thing this may never
       do. */
    expect(CONTENT_MATCH_MIN_MARGIN).toBeGreaterThan(3 - 1);
  });
});
