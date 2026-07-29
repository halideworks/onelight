/* What a frame is, apart from its name.

   Matching a second pass by filename covers the ordinary case and misses the
   one that hurts: a retoucher renames everything. DSC_1234.NEF comes back as
   Smith_Wedding_047_final.tif and no amount of normalizing joins them.

   Two other identities do. Both are computed here, and neither is trusted the
   same way.

   CAPTURE IDENTITY is exact. A photograph carries the instant it was taken,
   to the sub-second, plus the body that took it; a clip carries its creation
   time and its source timecode. A re-export from Lightroom or Resolve keeps
   them. Two frames one second apart differ in the field itself, so this
   cannot slide onto the neighbouring frame the way a picture can.

   PERCEPTUAL IDENTITY is a suggestion. Measured on this machine with a 64 bit
   difference hash: a frame against its own retouch is 1 bit, against the next
   frame of the same burst 3 bits, and against a different set-up 35. So the
   hash is superb at ruling strangers out and useless at choosing between
   neighbours, which is exactly what a shoot is made of. It narrows; it never
   decides. The margin rule below is the whole reason it is safe to offer. */

/** A 64 bit difference hash from a 9x8 greyscale sample of the picture. */
export const dHashFromLuma = (
  luma: Uint8Array,
  width: number,
  height: number,
): string => {
  if (width < 2 || height < 1 || luma.length < width * height)
    throw new Error("A difference hash needs a 9x8 greyscale sample.");
  let hash = "";
  let nibble = 0;
  let bits = 0;
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x + 1 < width; x += 1) {
      const left = luma[y * width + x] as number;
      const right = luma[y * width + x + 1] as number;
      nibble = (nibble << 1) | (left > right ? 1 : 0);
      bits += 1;
      if (bits === 4) {
        hash += nibble.toString(16);
        nibble = 0;
        bits = 0;
      }
    }
  if (bits) hash += (nibble << (4 - bits)).toString(16);
  return hash;
};

const POPCOUNT = new Uint8Array(256);
for (let value = 0; value < 256; value += 1)
  POPCOUNT[value] = (value & 1) + (POPCOUNT[value >> 1] as number);

/** Bits that differ between two hashes of the same shape. */
export const hashDistance = (left: string, right: string): number => {
  if (left.length !== right.length || !left.length)
    return Number.MAX_SAFE_INTEGER;
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number.parseInt(left[index] as string, 16);
    const b = Number.parseInt(right[index] as string, 16);
    if (Number.isNaN(a) || Number.isNaN(b)) return Number.MAX_SAFE_INTEGER;
    distance += POPCOUNT[(a ^ b) & 0xff] as number;
  }
  return distance;
};

/* A clip is fingerprinted at several points along itself rather than once,
   because two takes of the same set-up share an opening frame and diverge
   later. The parts are joined with a colon and compared position by position:
   a signature is only comparable to one of the same length. */
export const joinHashes = (hashes: string[]): string => hashes.join(":");

export const contentDistance = (left: string, right: string): number => {
  const ours = left.split(":");
  const theirs = right.split(":");
  if (ours.length !== theirs.length || !ours.length)
    return Number.MAX_SAFE_INTEGER;
  let total = 0;
  for (let index = 0; index < ours.length; index += 1) {
    const step = hashDistance(ours[index] as string, theirs[index] as string);
    if (step === Number.MAX_SAFE_INTEGER) return step;
    total += step;
  }
  return Math.round(total / ours.length);
};

/* Bits, out of 64, at which two pictures are close enough to be worth
   offering as the same frame. Generous, because the margin below is what
   actually protects the answer. */
export const CONTENT_MATCH_MAX_DISTANCE = 12;

/* How much of one clip's footage turns up in another's.

   A positional comparison answers "is this the same cut, differently graded":
   the samples line up because nothing moved. It answers nothing about a
   re-edit, where the same footage appears at different times and every
   position disagrees. Comparing the samples as a SET does: a v2 that reuses
   most of its shots keeps most of its hashes, wherever they now sit.

   Scored as the fraction of the incoming samples that find a near neighbour
   anywhere in the candidate, which is deliberately asymmetric: a thirty
   second cut-down of a two minute film should read as almost entirely made of
   that film, and the film should not read as made of the cut-down. */
export const SHOT_NEAR_BITS = 8;

export const contentOverlap = (incoming: string, candidate: string): number => {
  const ours = incoming.split(":").filter(Boolean);
  const theirs = candidate.split(":").filter(Boolean);
  if (!ours.length || !theirs.length) return 0;
  let found = 0;
  for (const hash of ours)
    if (theirs.some((other) => hashDistance(hash, other) <= SHOT_NEAR_BITS))
      found += 1;
  return found / ours.length;
};

/* The share of a clip that has to be recognisable before a re-edit is worth
   offering, and the lead the best candidate must hold over the next. Both are
   deliberately steep: an edit is the case where the pictures genuinely differ,
   so the evidence has to be a lot of footage, not a little. */
export const SHOT_OVERLAP_MIN = 0.6;
export const SHOT_OVERLAP_MIN_MARGIN = 0.2;

/* And the gap the winner must open over the runner up. The measurement that
   set this: a retouch sits 1 bit from its original and the next frame of the
   burst sits 3, so anything under a clear margin is a coin toss between two
   frames of a sequence, and a coin toss is what this must never do. */
export const CONTENT_MATCH_MIN_MARGIN = 6;

export interface CaptureIdentity {
  /** ISO-ish instant the frame was taken, to the sub-second where known. */
  takenAt?: string | undefined;
  /** Camera model, and its serial where the file carries one. */
  body?: string | undefined;
  /** Source timecode, which survives a re-export from an NLE. */
  timecode?: string | undefined;
}

/* Timecodes that identify nothing. Post starts a programme at one of these by
   convention, so every commercial in a project shares one and a key resting on
   it is not a key. Four spots in a real project all carried 01:00:00:00. */
const GENERIC_TIMECODES = new Set([
  "00:00:00:00",
  "01:00:00:00",
  "00:00:00;00",
  "01:00:00;00",
  "10:00:00:00",
]);

/* The identity is only used when it is specific enough to be one.

   A creation time alone is not: a batch export stamps a hundred files with the
   same second. Neither is a timecode everyone starts on. What is left is a
   sub-second stamp, a named camera, or a timecode that actually says where in
   a reel this came from. */
export const captureKeyOf = (identity: CaptureIdentity): string | null => {
  const takenAt = (identity.takenAt ?? "").trim();
  const body = (identity.body ?? "").trim();
  const timecode = (identity.timecode ?? "").trim();
  const distinctiveTimecode =
    Boolean(timecode) && !GENERIC_TIMECODES.has(timecode);
  if (!takenAt && !distinctiveTimecode) return null;
  const specific =
    /[.,]\d*[1-9]/.test(takenAt) || Boolean(body) || distinctiveTimecode;
  if (!specific) return null;
  return [takenAt, body, timecode]
    .map((part) => part.replace(/\s+/g, " ").toLowerCase())
    .join("|");
};

/* ---- EXIF ----

   Only four tags are wanted, so this walks the IFDs for them rather than
   pulling in a parser. The block sharp hands over is a TIFF header followed
   by IFD0; DateTimeOriginal and the serial live in the Exif sub-IFD that
   IFD0's 0x8769 points at. */

const TAG_MODEL = 0x0110;
const TAG_MAKE = 0x010f;
const TAG_EXIF_IFD = 0x8769;
const TAG_DATE_TIME_ORIGINAL = 0x9003;
const TAG_SUBSEC_TIME_ORIGINAL = 0x9291;
const TAG_BODY_SERIAL = 0xa431;

interface ExifStrings {
  make?: string;
  model?: string;
  dateTimeOriginal?: string;
  subSec?: string;
  serial?: string;
}

const asciiAt = (
  view: DataView,
  bytes: Uint8Array,
  base: number,
  offset: number,
  count: number,
): string => {
  const at = base + offset;
  if (at < 0 || at + count > bytes.length) return "";
  let text = "";
  for (let index = 0; index < count; index += 1) {
    const code = bytes[at + index] as number;
    if (!code) break;
    text += String.fromCharCode(code);
  }
  void view;
  return text.trim();
};

/** The handful of EXIF fields that identify a frame. */
export const readExifStrings = (exif: Uint8Array): ExifStrings => {
  const out: ExifStrings = {};
  try {
    /* sharp prefixes the block with "Exif\0\0" on some paths; skip it. */
    let bytes = exif;
    if (
      bytes.length > 6 &&
      String.fromCharCode(
        bytes[0] ?? 0,
        bytes[1] ?? 0,
        bytes[2] ?? 0,
        bytes[3] ?? 0,
      ) === "Exif"
    )
      bytes = bytes.subarray(6);
    if (bytes.length < 8) return out;
    const order = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0);
    if (order !== "II" && order !== "MM") return out;
    const little = order === "II";
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = (at: number): number => view.getUint16(at, little);
    const u32 = (at: number): number => view.getUint32(at, little);
    if (u16(2) !== 42) return out;

    const readIfd = (start: number, depth: number): void => {
      if (depth > 2 || start + 2 > bytes.length) return;
      const count = u16(start);
      for (let index = 0; index < count && index < 512; index += 1) {
        const entry = start + 2 + index * 12;
        if (entry + 12 > bytes.length) return;
        const tag = u16(entry);
        const type = u16(entry + 2);
        const length = u32(entry + 4);
        /* An ASCII value of four bytes or fewer sits in the entry itself. */
        const inline = type === 2 && length <= 4;
        const offset = inline ? entry + 8 : u32(entry + 8);
        if (tag === TAG_EXIF_IFD) {
          readIfd(offset, depth + 1);
          continue;
        }
        if (type !== 2) continue;
        const text = inline
          ? asciiAt(view, bytes, 0, offset, Math.min(length, 4))
          : asciiAt(view, bytes, 0, offset, Math.min(length, 128));
        if (!text) continue;
        if (tag === TAG_MODEL) out.model = text;
        else if (tag === TAG_MAKE) out.make = text;
        else if (tag === TAG_DATE_TIME_ORIGINAL) out.dateTimeOriginal = text;
        else if (tag === TAG_SUBSEC_TIME_ORIGINAL) out.subSec = text;
        else if (tag === TAG_BODY_SERIAL) out.serial = text;
      }
    };
    readIfd(u32(4), 0);
  } catch {
    /* A malformed block is simply no identity, never an error. */
  }
  return out;
};

/** The capture identity of a still, from its EXIF. */
export const captureIdentityFromExif = (
  exif: Uint8Array | undefined,
): CaptureIdentity => {
  if (!exif) return {};
  const fields = readExifStrings(exif);
  const taken = fields.dateTimeOriginal
    ? `${fields.dateTimeOriginal}${fields.subSec ? `.${fields.subSec}` : ""}`
    : undefined;
  const body = [fields.make, fields.model, fields.serial]
    .filter((part) => Boolean(part && part.length))
    .join(" ");
  return {
    ...(taken ? { takenAt: taken } : {}),
    ...(body ? { body } : {}),
  };
};

/** The capture identity of a clip, from ffprobe's format and stream tags.

    A rendered timeline is deliberately given nothing to match on: what it
    carries is the moment it was exported, which differs for every pass of the
    same cut and is identical across a batch of unrelated spots. Only a file
    that names the camera that shot it keeps its time. */
export const captureIdentityFromTags = (
  tags: Record<string, unknown>,
  sourceTimecode?: string | null,
): CaptureIdentity => {
  const pick = (...names: string[]): string | undefined => {
    for (const name of names) {
      const value = tags[name];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
  };
  const taken = pick(
    "com.apple.quicktime.creationdate",
    "creation_time",
    "date",
    "date_time_original",
  );
  const body = [
    pick("com.apple.quicktime.make", "make", "manufacturer"),
    pick("com.apple.quicktime.model", "model"),
    pick("com.apple.quicktime.camera.identifier", "serial_number"),
    pick("reel_name", "com.apple.proapps.reelname"),
  ]
    .filter((part) => Boolean(part))
    .join(" ");
  /* No camera named it, so the time on it is an export's, not a capture's. */
  const cameraKnown = Boolean(body);
  return {
    ...(taken && cameraKnown ? { takenAt: taken } : {}),
    ...(body ? { body } : {}),
    ...(sourceTimecode ? { timecode: sourceTimecode } : {}),
  };
};

/* ---- what a clip sounds like ----

   The tier that actually answers a colour pass. A grade changes every pixel
   and not one sample of the audio, so two exports of the same cut sound
   identical while their pictures drift; a re-edit is the other way round.
   Together they say which kind of second pass this is.

   The signature is a loudness contour, not the samples: it survives a
   re-encode, a format change and a level-preserving export, and it does not
   survive a different cut. Each bit is one window against the next, which is
   the same trick the picture hash uses and is why an overall level change
   moves nothing. */
export const audioHashFromEnvelope = (windows: number[]): string => {
  if (windows.length < 2) throw new Error("An audio hash needs windows.");
  let hash = "";
  let nibble = 0;
  let bits = 0;
  for (let index = 0; index + 1 < windows.length; index += 1) {
    nibble =
      (nibble << 1) |
      ((windows[index] as number) > (windows[index + 1] as number) ? 1 : 0);
    bits += 1;
    if (bits === 4) {
      hash += nibble.toString(16);
      nibble = 0;
      bits = 0;
    }
  }
  if (bits) hash += (nibble << (4 - bits)).toString(16);
  return hash;
};

/* Silence has no contour: a black-and-silent slate would otherwise sound like
   every other one. */
export const AUDIO_SILENCE_FLOOR = 1e-4;

export const isSilentEnvelope = (windows: number[]): boolean =>
  windows.every((value) => value <= AUDIO_SILENCE_FLOOR);

/* How close two soundtracks must be to count as the same one. Tight, because
   this tier is the confident one: the same audio through two encoders differs
   in a handful of window comparisons at most. */
export const AUDIO_MATCH_MAX_DISTANCE = 6;
