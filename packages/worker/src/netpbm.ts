/* A reader for binary PPM and PGM, which is what libraw hands back.

   dcraw_emu writes either netpbm or TIFF, and its TIFF is not something the
   libvips in this image will open (it reads a sharp-written 16-bit TIFF
   perfectly and refuses dcraw's, which is a fight with someone else's tag
   layout that nobody needs to have). netpbm has no tags at all: a five token
   header and then the samples, big-endian when there are two of them. Reading
   it here means the RAW path depends on no loader beyond the demosaic. */

export interface NetpbmImage {
  width: number;
  height: number;
  /** Interleaved 8-bit RGB, ready for sharp's raw input. */
  data: Uint8Array;
  /** The source's maximum sample value: 255 for 8-bit, 65535 for 16. */
  maxValue: number;
}

const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c]);

/** The next header token, skipping whitespace and # comments. */
const nextToken = (
  bytes: Uint8Array,
  from: number,
): { token: string; next: number } => {
  let cursor = from;
  for (;;) {
    while (cursor < bytes.length && WHITESPACE.has(bytes[cursor] as number))
      cursor += 1;
    if (bytes[cursor] !== 0x23) break;
    while (cursor < bytes.length && bytes[cursor] !== 0x0a) cursor += 1;
  }
  const start = cursor;
  while (cursor < bytes.length && !WHITESPACE.has(bytes[cursor] as number))
    cursor += 1;
  if (start === cursor) throw new Error("netpbm header ended early.");
  return {
    token: String.fromCharCode(...bytes.subarray(start, cursor)),
    next: cursor,
  };
};

export const readNetpbm = (bytes: Uint8Array): NetpbmImage => {
  const magic = nextToken(bytes, 0);
  const channels = magic.token === "P6" ? 3 : magic.token === "P5" ? 1 : 0;
  if (!channels)
    throw new Error(
      `Unsupported netpbm magic "${magic.token}"; only binary P5 and P6 are read.`,
    );
  const widthToken = nextToken(bytes, magic.next);
  const heightToken = nextToken(bytes, widthToken.next);
  const maxToken = nextToken(bytes, heightToken.next);
  const width = Number(widthToken.token);
  const height = Number(heightToken.token);
  const maxValue = Number(maxToken.token);
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1
  )
    throw new Error("netpbm header has no usable dimensions.");
  if (!Number.isInteger(maxValue) || maxValue < 1 || maxValue > 65535)
    throw new Error(`netpbm maximum value ${maxToken.token} is out of range.`);
  /* Exactly one whitespace byte separates the header from the samples. */
  const from = maxToken.next + 1;
  const sampleBytes = maxValue > 255 ? 2 : 1;
  const expected = width * height * channels * sampleBytes;
  if (from + expected > bytes.length)
    throw new Error("netpbm data is shorter than its header promises.");

  const data = new Uint8Array(width * height * 3);
  const scale = maxValue === 255 || maxValue === 65535 ? null : 255 / maxValue;
  const sampleAt = (index: number): number => {
    const at = from + index * sampleBytes;
    const value =
      sampleBytes === 2
        ? ((bytes[at] as number) << 8) | (bytes[at + 1] as number)
        : (bytes[at] as number);
    const eight = sampleBytes === 2 ? value >> 8 : value;
    return scale === null
      ? eight
      : Math.max(0, Math.min(255, Math.round(value * scale)));
  };
  const pixels = width * height;
  for (let index = 0; index < pixels; index += 1) {
    if (channels === 1) {
      const grey = sampleAt(index);
      data[index * 3] = grey;
      data[index * 3 + 1] = grey;
      data[index * 3 + 2] = grey;
    } else {
      data[index * 3] = sampleAt(index * 3);
      data[index * 3 + 1] = sampleAt(index * 3 + 1);
      data[index * 3 + 2] = sampleAt(index * 3 + 2);
    }
  }
  return { width, height, data, maxValue };
};
