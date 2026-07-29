/* A reader for the composite picture inside a PSD or a PSB.

   ffmpeg decodes PSD and refuses PSB: its decoder rejects any container whose
   version is not 1, and PSB (Photoshop's "large document format", for anything
   past 30000 pixels on a side) is version 2. The two formats are otherwise the
   same file with three fields widened, so reading them here costs less than
   arguing with a decoder that will not take one of them.

   What is read is the composite: the flattened picture Photoshop writes at the
   end of the file so that software which is not Photoshop can open it. A save
   with "maximise compatibility" off has no composite, and nothing can show
   that file a picture; this reader says so rather than guessing.

   Layers, masks, adjustment layers and smart objects are all deliberately out
   of scope. A review tool needs the picture the designer sees, which is
   exactly the composite. */

const SIGNATURE = "8BPS";

export type PsdColorMode =
  | "bitmap"
  | "grayscale"
  | "indexed"
  | "rgb"
  | "cmyk"
  | "multichannel"
  | "duotone"
  | "lab";

const COLOR_MODES: Record<number, PsdColorMode> = {
  0: "bitmap",
  1: "grayscale",
  2: "indexed",
  3: "rgb",
  4: "cmyk",
  7: "multichannel",
  8: "duotone",
  9: "lab",
};

export interface PsdHeader {
  /** 1 for PSD, 2 for PSB. */
  version: number;
  large: boolean;
  channels: number;
  width: number;
  height: number;
  depth: number;
  colorMode: PsdColorMode;
}

export interface PsdImage {
  header: PsdHeader;
  /** Interleaved 8-bit RGB, ready for sharp's raw input. */
  data: Uint8Array;
  width: number;
  height: number;
  channels: 3;
}

/* A ceiling on what will be decoded into memory. A PSB may legally be 300000
   pixels on a side, which is a terabyte of channel data; a worker that tries
   is a worker that dies. The limit is on the source, not the output: a file
   past it is refused with a message an operator can act on. */
export const PSD_MAX_PIXELS = 120_000_000;

export const readPsdHeader = (bytes: Uint8Array): PsdHeader => {
  if (bytes.length < 26) throw new Error("File is too short to be a PSD.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = String.fromCharCode(...bytes.subarray(0, 4));
  if (signature !== SIGNATURE)
    throw new Error("File does not start with a Photoshop signature.");
  const version = view.getUint16(4);
  if (version !== 1 && version !== 2)
    throw new Error(`Unsupported Photoshop container version ${version}.`);
  const channels = view.getUint16(12);
  const height = view.getUint32(14);
  const width = view.getUint32(18);
  const depth = view.getUint16(22);
  const mode = view.getUint16(24);
  const colorMode = COLOR_MODES[mode];
  if (!colorMode) throw new Error(`Unknown Photoshop colour mode ${mode}.`);
  return {
    version,
    large: version === 2,
    channels,
    width,
    height,
    depth,
    colorMode,
  };
};

/** PackBits, as the composite's scanlines are stored. */
const unpackBits = (
  source: Uint8Array,
  from: number,
  length: number,
  out: Uint8Array,
  outFrom: number,
  outLength: number,
): void => {
  let read = from;
  let write = outFrom;
  const end = from + length;
  const writeEnd = outFrom + outLength;
  while (read < end && write < writeEnd) {
    const control = source[read] as number;
    read += 1;
    if (control === 128) continue;
    if (control < 128) {
      const run = control + 1;
      for (let index = 0; index < run && write < writeEnd; index += 1) {
        out[write] = source[read] ?? 0;
        write += 1;
        read += 1;
      }
    } else {
      const run = 257 - control;
      const value = source[read] ?? 0;
      read += 1;
      for (let index = 0; index < run && write < writeEnd; index += 1) {
        out[write] = value;
        write += 1;
      }
    }
  }
  if (write < writeEnd)
    throw new Error("A Photoshop scanline ended before its width.");
};

/** The composite picture, as interleaved 8-bit RGB. */
export const readPsdComposite = (bytes: Uint8Array): PsdImage => {
  const header = readPsdHeader(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { width, height, depth, large } = header;
  if (!width || !height)
    throw new Error("This Photoshop file has no picture in it.");
  if (width * height > PSD_MAX_PIXELS)
    throw new Error(
      `This Photoshop file is ${width}x${height}, past the ${String(
        PSD_MAX_PIXELS / 1_000_000,
      )} megapixel decode limit.`,
    );
  if (depth !== 8 && depth !== 16)
    throw new Error(`Unsupported Photoshop bit depth ${depth}.`);
  if (
    header.colorMode !== "rgb" &&
    header.colorMode !== "grayscale" &&
    header.colorMode !== "cmyk" &&
    header.colorMode !== "duotone"
  )
    throw new Error(
      `Unsupported Photoshop colour mode "${header.colorMode}"; only RGB, greyscale, duotone and CMYK composites are read.`,
    );

  /* Three variable sections stand between the header and the picture. Their
     lengths are 4 bytes each in a PSD; in a PSB the layer and mask section's
     length is 8. */
  let cursor = 26;
  const skipSection = (lengthBytes: 4 | 8): void => {
    if (cursor + lengthBytes > bytes.length)
      throw new Error("This Photoshop file ends before its picture.");
    const length =
      lengthBytes === 8
        ? Number(view.getBigUint64(cursor))
        : view.getUint32(cursor);
    cursor += lengthBytes + length;
  };
  skipSection(4); // colour mode data
  skipSection(4); // image resources
  skipSection(large ? 8 : 4); // layer and mask information
  if (cursor + 2 > bytes.length)
    throw new Error(
      "This Photoshop file has no composite; it was saved without maximise compatibility.",
    );

  const compression = view.getUint16(cursor);
  cursor += 2;
  const sampleBytes = depth === 16 ? 2 : 1;
  /* Only the colour channels are read; an alpha channel present in the file
     is ignored, because the composite is already flattened onto its matte. */
  const colorChannels =
    header.colorMode === "cmyk"
      ? 4
      : header.colorMode === "rgb"
        ? 3
        : /* grayscale and duotone are one ink */ 1;
  if (header.channels < colorChannels)
    throw new Error("This Photoshop file has fewer channels than its mode.");
  const planeLength = width * height * sampleBytes;
  const planes: Uint8Array[] = [];

  if (compression === 0) {
    for (let channel = 0; channel < colorChannels; channel += 1) {
      const from = cursor + channel * planeLength;
      if (from + planeLength > bytes.length)
        throw new Error("This Photoshop file's picture is truncated.");
      planes.push(bytes.subarray(from, from + planeLength));
    }
  } else if (compression === 1) {
    /* RLE: every scanline of every channel is length-prefixed up front, two
       bytes per count in a PSD and four in a PSB. */
    const countBytes = large ? 4 : 2;
    const scanlines = height * header.channels;
    const countsAt = cursor;
    const dataAt = countsAt + scanlines * countBytes;
    if (dataAt > bytes.length)
      throw new Error("This Photoshop file's scanline table is truncated.");
    let dataCursor = dataAt;
    /* Walk every channel in the file, not only the ones wanted: the counts
       are in file order and skipping one means skipping its bytes too. */
    for (let channel = 0; channel < header.channels; channel += 1) {
      const wanted = channel < colorChannels;
      const plane = wanted ? new Uint8Array(planeLength) : null;
      for (let row = 0; row < height; row += 1) {
        const index = channel * height + row;
        const count =
          countBytes === 4
            ? view.getUint32(countsAt + index * 4)
            : view.getUint16(countsAt + index * 2);
        if (dataCursor + count > bytes.length)
          throw new Error("This Photoshop file's picture is truncated.");
        if (plane)
          unpackBits(
            bytes,
            dataCursor,
            count,
            plane,
            row * width * sampleBytes,
            width * sampleBytes,
          );
        dataCursor += count;
      }
      if (plane) planes.push(plane);
    }
  } else {
    throw new Error(
      `This Photoshop file's picture uses compression ${compression}, which is not read here.`,
    );
  }

  /* Planar to interleaved, 16 bit reduced to 8, and CMYK to RGB. Photoshop
     stores CMYK inverted, which is why the channels are complemented first. */
  const out = new Uint8Array(width * height * 3);
  const sampleAt = (plane: Uint8Array, index: number): number =>
    sampleBytes === 2 ? (plane[index * 2] as number) : (plane[index] as number);
  const pixels = width * height;
  if (header.colorMode === "cmyk") {
    const [c, m, y, k] = planes as [
      Uint8Array,
      Uint8Array,
      Uint8Array,
      Uint8Array,
    ];
    for (let index = 0; index < pixels; index += 1) {
      const cyan = 255 - sampleAt(c, index);
      const magenta = 255 - sampleAt(m, index);
      const yellow = 255 - sampleAt(y, index);
      const black = 255 - sampleAt(k, index);
      out[index * 3] = ((255 - cyan) * (255 - black)) / 255;
      out[index * 3 + 1] = ((255 - magenta) * (255 - black)) / 255;
      out[index * 3 + 2] = ((255 - yellow) * (255 - black)) / 255;
    }
  } else if (colorChannels === 1) {
    const gray = planes[0] as Uint8Array;
    for (let index = 0; index < pixels; index += 1) {
      const value = sampleAt(gray, index);
      out[index * 3] = value;
      out[index * 3 + 1] = value;
      out[index * 3 + 2] = value;
    }
  } else {
    const [r, g, b] = planes as [Uint8Array, Uint8Array, Uint8Array];
    for (let index = 0; index < pixels; index += 1) {
      out[index * 3] = sampleAt(r, index);
      out[index * 3 + 1] = sampleAt(g, index);
      out[index * 3 + 2] = sampleAt(b, index);
    }
  }
  return { header, data: out, width, height, channels: 3 };
};
