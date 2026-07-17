/* Streaming zip writer for package downloads.

   Store-only: media does not compress, so entries are passed through at
   full disk speed with no CPU spent. Entry sizes are known upfront, which
   makes the archive's total length computable before a byte is written
   (zipLength), so the response can carry a Content-Length and browsers can
   show real progress. Only each entry's CRC is unknown until its bytes
   stream through, so entries use the data-descriptor layout (general
   purpose bit 3): zeros in the local header, the real CRC after the data.

   Entries of 4 GiB and over switch to the zip64 layout per entry; the end
   records switch to zip64 when counts or offsets demand it. Everything is
   web streams, so the same writer runs on Node and on Workers. */

const LOCAL_SIG = 0x04034b50;
const DESCRIPTOR_SIG = 0x08074b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EXTRA_ID = 0x0001;
const LIMIT_32 = 0xffffffff;
const LIMIT_16 = 0xffff;

const crcTable = (() => {
  const values = new Uint32Array(256);
  for (let index = 0; index < values.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1)
      value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    values[index] = value >>> 0;
  }
  return values;
})();

const crc32Update = (state: number, bytes: Uint8Array): number => {
  let value = state;
  for (const byte of bytes)
    value = (crcTable[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
  return value >>> 0;
};

export interface ZipEntry {
  /** Path inside the archive; forward slashes, no leading slash. */
  name: string;
  /** Exact byte size; the archive is corrupt if the stream disagrees. */
  size: number;
  /** Modification time in ms since epoch; omitted means the DOS epoch. */
  modifiedAt?: number;
  /** Opened lazily when the entry's turn comes. */
  open: () => Promise<ReadableStream>;
}

/** Zip-safe entry name: forward slashes, no traversal, no leading slash. */
export const zipEntryName = (name: string): string =>
  name
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part !== "" && part !== "." && part !== "..")
    .join("/") || "file";

const encoder = new TextEncoder();

interface EntryLayout {
  nameBytes: Uint8Array;
  size: number;
  zip64: boolean;
  offset: number;
  dosTime: number;
  dosDate: number;
}

const dosStamp = (modifiedAt: number | undefined) => {
  if (!modifiedAt) return { dosTime: 0, dosDate: 0x21 };
  const date = new Date(modifiedAt);
  if (date.getUTCFullYear() < 1980) return { dosTime: 0, dosDate: 0x21 };
  return {
    dosTime:
      (date.getUTCHours() << 11) |
      (date.getUTCMinutes() << 5) |
      (date.getUTCSeconds() >> 1),
    dosDate:
      ((date.getUTCFullYear() - 1980) << 9) |
      ((date.getUTCMonth() + 1) << 5) |
      date.getUTCDate(),
  };
};

const layoutOf = (entries: ZipEntry[]): EntryLayout[] => {
  const layouts: EntryLayout[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = encoder.encode(zipEntryName(entry.name));
    const zip64 = entry.size >= LIMIT_32;
    layouts.push({
      nameBytes,
      size: entry.size,
      zip64,
      offset,
      ...dosStamp(entry.modifiedAt),
    });
    offset +=
      30 + nameBytes.length + (zip64 ? 20 : 0) + entry.size + (zip64 ? 24 : 16);
  }
  return layouts;
};

const centralExtraLength = (layout: EntryLayout): number => {
  let fields = 0;
  if (layout.zip64) fields += 2;
  if (layout.offset >= LIMIT_32) fields += 1;
  return fields ? 4 + fields * 8 : 0;
};

/** Exact byte length of the archive zipStream will produce. */
export const zipLength = (
  entries: Array<Pick<ZipEntry, "name" | "size">>,
): number => {
  const layouts = layoutOf(
    entries.map((entry) => ({
      ...entry,
      open: () => Promise.reject(new Error("layout only")),
    })),
  );
  const last = layouts[layouts.length - 1];
  const dataEnd = last
    ? last.offset +
      30 +
      last.nameBytes.length +
      (last.zip64 ? 20 : 0) +
      last.size +
      (last.zip64 ? 24 : 16)
    : 0;
  let centralSize = 0;
  for (const layout of layouts)
    centralSize += 46 + layout.nameBytes.length + centralExtraLength(layout);
  const needsZip64End =
    layouts.length > LIMIT_16 ||
    centralSize >= LIMIT_32 ||
    dataEnd >= LIMIT_32 ||
    layouts.some((layout) => layout.zip64 || layout.offset >= LIMIT_32);
  return dataEnd + centralSize + (needsZip64End ? 56 + 20 : 0) + 22;
};

class ByteWriter {
  private buffer: Uint8Array;
  private view: DataView;
  private cursor = 0;
  constructor(length: number) {
    this.buffer = new Uint8Array(length);
    this.view = new DataView(this.buffer.buffer);
  }
  u16(value: number): this {
    this.view.setUint16(this.cursor, value, true);
    this.cursor += 2;
    return this;
  }
  u32(value: number): this {
    this.view.setUint32(this.cursor, value >>> 0, true);
    this.cursor += 4;
    return this;
  }
  u64(value: number): this {
    this.view.setBigUint64(this.cursor, BigInt(value), true);
    this.cursor += 8;
    return this;
  }
  bytes(value: Uint8Array): this {
    this.buffer.set(value, this.cursor);
    this.cursor += value.length;
    return this;
  }
  take(): Uint8Array {
    return this.buffer;
  }
}

/* Flags: bit 3 (sizes follow the data) plus bit 11 (UTF-8 names). */
const FLAGS = 0x0808;

const localHeader = (layout: EntryLayout): Uint8Array => {
  const writer = new ByteWriter(
    30 + layout.nameBytes.length + (layout.zip64 ? 20 : 0),
  );
  writer
    .u32(LOCAL_SIG)
    .u16(layout.zip64 ? 45 : 20)
    .u16(FLAGS)
    .u16(0)
    .u16(layout.dosTime)
    .u16(layout.dosDate)
    .u32(0)
    .u32(layout.zip64 ? LIMIT_32 : 0)
    .u32(layout.zip64 ? LIMIT_32 : 0)
    .u16(layout.nameBytes.length)
    .u16(layout.zip64 ? 20 : 0)
    .bytes(layout.nameBytes);
  if (layout.zip64)
    writer.u16(ZIP64_EXTRA_ID).u16(16).u64(layout.size).u64(layout.size);
  return writer.take();
};

const descriptor = (layout: EntryLayout, crc: number): Uint8Array => {
  const writer = new ByteWriter(layout.zip64 ? 24 : 16);
  writer.u32(DESCRIPTOR_SIG).u32(crc);
  if (layout.zip64) writer.u64(layout.size).u64(layout.size);
  else writer.u32(layout.size).u32(layout.size);
  return writer.take();
};

const centralHeader = (layout: EntryLayout, crc: number): Uint8Array => {
  const extraLength = centralExtraLength(layout);
  const writer = new ByteWriter(46 + layout.nameBytes.length + extraLength);
  writer
    .u32(CENTRAL_SIG)
    .u16(45)
    .u16(layout.zip64 ? 45 : 20)
    .u16(FLAGS)
    .u16(0)
    .u16(layout.dosTime)
    .u16(layout.dosDate)
    .u32(crc)
    .u32(layout.zip64 ? LIMIT_32 : layout.size)
    .u32(layout.zip64 ? LIMIT_32 : layout.size)
    .u16(layout.nameBytes.length)
    .u16(extraLength)
    .u16(0)
    .u16(0)
    .u16(0)
    .u32(0)
    .u32(layout.offset >= LIMIT_32 ? LIMIT_32 : layout.offset)
    .bytes(layout.nameBytes);
  if (extraLength) {
    writer.u16(ZIP64_EXTRA_ID).u16(extraLength - 4);
    if (layout.zip64) writer.u64(layout.size).u64(layout.size);
    if (layout.offset >= LIMIT_32) writer.u64(layout.offset);
  }
  return writer.take();
};

async function* generate(entries: ZipEntry[]): AsyncGenerator<Uint8Array> {
  const layouts = layoutOf(entries);
  const crcs: number[] = [];
  for (const [index, entry] of entries.entries()) {
    const layout = layouts[index];
    if (!layout) throw new Error("Zip layout is out of step.");
    yield localHeader(layout);
    let crc = 0xffffffff;
    let seen = 0;
    const reader = (await entry.open()).getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const bytes =
          next.value instanceof Uint8Array
            ? next.value
            : new Uint8Array(next.value as ArrayBufferLike);
        seen += bytes.length;
        if (seen > layout.size)
          throw new Error(`Entry ${entry.name} is longer than declared.`);
        crc = crc32Update(crc, bytes);
        yield bytes;
      }
    } finally {
      reader.releaseLock();
    }
    if (seen !== layout.size)
      throw new Error(`Entry ${entry.name} is shorter than declared.`);
    const finalCrc = (crc ^ 0xffffffff) >>> 0;
    crcs.push(finalCrc);
    yield descriptor(layout, finalCrc);
  }
  const last = layouts[layouts.length - 1];
  const centralOffset = last
    ? last.offset +
      30 +
      last.nameBytes.length +
      (last.zip64 ? 20 : 0) +
      last.size +
      (last.zip64 ? 24 : 16)
    : 0;
  let centralSize = 0;
  for (const [index, layout] of layouts.entries()) {
    const header = centralHeader(layout, crcs[index] ?? 0);
    centralSize += header.length;
    yield header;
  }
  const needsZip64End =
    layouts.length > LIMIT_16 ||
    centralSize >= LIMIT_32 ||
    centralOffset >= LIMIT_32 ||
    layouts.some((layout) => layout.zip64 || layout.offset >= LIMIT_32);
  if (needsZip64End) {
    const zip64End = new ByteWriter(56)
      .u32(ZIP64_EOCD_SIG)
      .u64(44)
      .u16(45)
      .u16(45)
      .u32(0)
      .u32(0)
      .u64(layouts.length)
      .u64(layouts.length)
      .u64(centralSize)
      .u64(centralOffset)
      .take();
    yield zip64End;
    yield new ByteWriter(20)
      .u32(ZIP64_LOCATOR_SIG)
      .u32(0)
      .u64(centralOffset + centralSize)
      .u32(1)
      .take();
  }
  yield new ByteWriter(22)
    .u32(EOCD_SIG)
    .u16(0)
    .u16(0)
    .u16(Math.min(layouts.length, LIMIT_16))
    .u16(Math.min(layouts.length, LIMIT_16))
    .u32(Math.min(centralSize, LIMIT_32))
    .u32(Math.min(centralOffset, LIMIT_32))
    .take();
}

/** The archive as a web stream; entries stream through one at a time. */
export const zipStream = (entries: ZipEntry[]): ReadableStream<Uint8Array> => {
  const iterator = generate(entries);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (caught) {
        controller.error(caught);
      }
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
};
