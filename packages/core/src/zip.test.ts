import { describe, expect, it } from "vitest";
import { zipEntryName, zipLength, zipStream, zipStreamFrom } from "./zip.js";
import type { ZipEntry } from "./zip.js";

const streamOf = (bytes: Uint8Array, chunkSize = 7): ReadableStream => {
  let cursor = 0;
  return new ReadableStream({
    pull(controller) {
      if (cursor >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(cursor, cursor + chunkSize));
      cursor += chunkSize;
    },
  });
};

const collect = async (stream: ReadableStream<Uint8Array>): Promise<Buffer> => {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
  }
  return Buffer.concat(chunks);
};

/* Minimal central-directory reader: enough of the format to prove the
   archive round-trips. Walks the central directory, then checks each
   stored entry's bytes at its local offset. */
const parseZip = (buffer: Buffer) => {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd, "end of central directory record exists").toBeGreaterThanOrEqual(
    0,
  );
  let count = buffer.readUInt16LE(eocd + 10);
  let centralOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || centralOffset === 0xffffffff) {
    const locator = buffer.lastIndexOf(
      Buffer.from([0x50, 0x4b, 0x06, 0x07]),
      eocd,
    );
    expect(locator, "zip64 locator exists").toBeGreaterThanOrEqual(0);
    const zip64Eocd = Number(buffer.readBigUInt64LE(locator + 8));
    count = Number(buffer.readBigUInt64LE(zip64Eocd + 32));
    centralOffset = Number(buffer.readBigUInt64LE(zip64Eocd + 48));
  }
  const entries: Array<{ name: string; crc: number; bytes: Buffer }> = [];
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    expect(buffer.readUInt32LE(cursor)).toBe(0x02014b50);
    const crc = buffer.readUInt32LE(cursor + 16);
    let size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    let localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString("utf8");
    /* Zip64 extra: fields appear in order for each 0xFFFFFFFF marker. */
    let extraCursor = cursor + 46 + nameLength;
    const extraEnd = extraCursor + extraLength;
    while (extraCursor < extraEnd) {
      const id = buffer.readUInt16LE(extraCursor);
      const dataSize = buffer.readUInt16LE(extraCursor + 2);
      if (id === 0x0001) {
        let dataCursor = extraCursor + 4;
        if (size === 0xffffffff) {
          size = Number(buffer.readBigUInt64LE(dataCursor));
          dataCursor += 16;
        }
        if (localOffset === 0xffffffff)
          localOffset = Number(buffer.readBigUInt64LE(dataCursor));
      }
      extraCursor += 4 + dataSize;
    }
    expect(buffer.readUInt32LE(localOffset)).toBe(0x04034b50);
    const localName = buffer.readUInt16LE(localOffset + 26);
    const localExtra = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localName + localExtra;
    entries.push({
      name,
      crc,
      bytes: buffer.subarray(dataStart, dataStart + size),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
};

const crc32Of = (bytes: Uint8Array): number => {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
};

describe("zip", () => {
  it("round-trips stored entries with exact length", async () => {
    const first = new Uint8Array(1000).map((_, index) => index % 251);
    const second = new TextEncoder().encode("Onelight package manifest.");
    const entries: ZipEntry[] = [
      {
        name: "day01/A001_C002.mov",
        size: first.length,
        modifiedAt: Date.UTC(2026, 6, 17, 12, 30, 42),
        open: () => Promise.resolve(streamOf(first)),
      },
      {
        name: "notes.txt",
        size: second.length,
        open: () => Promise.resolve(streamOf(second, 5)),
      },
    ];
    const buffer = await collect(zipStream(entries));
    expect(buffer.length).toBe(zipLength(entries));
    const parsed = parseZip(buffer);
    expect(parsed.length).toBe(2);
    expect(parsed[0]?.name).toBe("day01/A001_C002.mov");
    expect(new Uint8Array(parsed[0]?.bytes ?? Buffer.alloc(0))).toEqual(first);
    expect(parsed[0]?.crc).toBe(crc32Of(first));
    expect(parsed[1]?.name).toBe("notes.txt");
    expect(new Uint8Array(parsed[1]?.bytes ?? Buffer.alloc(0))).toEqual(second);
    expect(parsed[1]?.crc).toBe(crc32Of(second));
  });

  it("fails loudly when an entry lies about its size", async () => {
    const bytes = new Uint8Array(64);
    const entries: ZipEntry[] = [
      {
        name: "short.bin",
        size: 128,
        open: () => Promise.resolve(streamOf(bytes)),
      },
    ];
    await expect(collect(zipStream(entries))).rejects.toThrow(
      /shorter than declared/,
    );
  });

  it("resumes from any byte, matching the full stream exactly", async () => {
    const first = new Uint8Array(700).map((_, index) => (index * 13) % 256);
    const second = new Uint8Array(450).map((_, index) => (index * 7) % 256);
    const third = new TextEncoder().encode("short tail entry");
    const build = (): ZipEntry[] => [
      {
        name: "a/first.bin",
        size: first.length,
        cacheKey: "blob:first",
        open: () => Promise.resolve(streamOf(first, 64)),
        openRange: (from) => Promise.resolve(streamOf(first.slice(from), 64)),
      },
      {
        name: "second.bin",
        size: second.length,
        cacheKey: "blob:second",
        open: () => Promise.resolve(streamOf(second, 33)),
        openRange: (from) => Promise.resolve(streamOf(second.slice(from), 33)),
      },
      {
        name: "third.txt",
        size: third.length,
        cacheKey: "blob:third",
        open: () => Promise.resolve(streamOf(third, 5)),
      },
    ];
    const full = await collect(zipStream(build()));
    const total = zipLength(build());
    expect(full.length).toBe(total);
    /* Every region boundary plus interior bytes: header starts, data
       middles, descriptors, the central directory, and the last byte. */
    const starts = [
      0,
      1,
      29,
      30,
      31,
      200,
      700 + 30 + 11,
      full.length - 500,
      full.length - 22,
      full.length - 1,
    ];
    for (const start of starts) {
      const resumed = await collect(zipStreamFrom(build(), start));
      expect(
        Buffer.compare(resumed, full.subarray(start)),
        `resume at ${start}`,
      ).toBe(0);
    }
    /* With a warm CRC cache, entries before the resume point are never
       opened, and the interrupted entry opens through its range reader. */
    const crcs = new Map<string, number>();
    await collect(
      zipStreamFrom(build(), 0, {
        onCrc: (key, crc) => crcs.set(key, crc),
      }),
    );
    expect(crcs.size).toBe(3);
    let opened = 0;
    let ranged = 0;
    const cachedEntries: ZipEntry[] = build().map((entry) => ({
      ...entry,
      open: () => {
        opened += 1;
        return entry.open();
      },
      ...(entry.openRange
        ? {
            openRange: (from: number) => {
              ranged += 1;
              const range = entry.openRange;
              if (!range) throw new Error("unreachable");
              return range(from);
            },
          }
        : {}),
    }));
    /* Resume in the middle of the second entry's data. */
    const secondDataMiddle = 30 + 11 + first.length + 16 + 30 + 10 + 200;
    const resumed = await collect(
      zipStreamFrom(cachedEntries, secondDataMiddle, { crcs }),
    );
    expect(Buffer.compare(resumed, full.subarray(secondDataMiddle))).toBe(0);
    /* The first entry was skipped outright; the second jumped by range;
       only the third (after the resume point) streamed from the top. */
    expect(ranged).toBe(1);
    expect(opened).toBe(1);
  });

  it("zipEntryName strips traversal and normalizes separators", () => {
    expect(zipEntryName("..\\..\\etc/passwd")).toBe("etc/passwd");
    expect(zipEntryName("/leading/slash.mov")).toBe("leading/slash.mov");
    expect(zipEntryName("")).toBe("file");
  });
});
