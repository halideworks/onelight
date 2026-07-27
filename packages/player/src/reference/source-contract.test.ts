import { describe, expect, it } from "vitest";
import {
  referenceSourceAvailability,
  referenceSourceContract,
} from "./source-contract.js";

const rendition = {
  kind: "proxy_1080",
  url: "/proxy.mp4",
  meta: {
    frame_rate_num: 24000,
    frame_rate_den: 1001,
    width: 1920,
    height: 1080,
    output_color: {
      primaries: "bt709",
      transfer: "bt709",
      matrix: "bt709",
      range: "tv",
      chroma_location: "left",
    },
  },
};

describe("reference source contract", () => {
  it("accepts complete SDR proxy metadata", () => {
    expect(
      referenceSourceContract(rendition, { num: 24000, den: 1001 }, 107892),
    ).toEqual({
      url: "/proxy.mp4",
      expected: {
        frameRate: { num: 24000, den: 1001 },
        durationFrames: 107892,
        codedWidth: 1920,
        codedHeight: 1080,
        codec: null,
        outputColor: {
          primaries: "bt709",
          transfer: "bt709",
          matrix: "bt709",
          range: "tv",
        },
        outputChromaLocation: "left",
      },
    });
  });

  it("fails closed on missing chroma metadata or a rate mismatch", () => {
    expect(
      referenceSourceContract(
        {
          ...rendition,
          meta: {
            ...rendition.meta,
            output_color: {
              primaries: "bt709",
              transfer: "bt709",
              matrix: "bt709",
              range: "tv",
            },
          },
        },
        { num: 24000, den: 1001 },
        100,
      ),
    ).toBeNull();
    expect(
      referenceSourceContract(rendition, { num: 24, den: 1 }, 100),
    ).toBeNull();
  });

  /* The HDR renditions carry the grade at its own transfer and gamut, which
     the renderer decodes, so they became eligible with that support. A kind
     that is not a playable picture never was. */
  it("accepts an HDR rendition and still refuses a non-picture kind", () => {
    expect(
      referenceSourceContract(
        { ...rendition, kind: "hdr_hevc" },
        { num: 24000, den: 1001 },
        100,
      ),
    ).not.toBeNull();
    expect(
      referenceSourceContract(
        { ...rendition, kind: "audio_peaks" },
        { num: 24000, den: 1001 },
        100,
      ),
    ).toBeNull();
  });

  it("accepts a burned watermark rendition with the same complete contract", () => {
    expect(
      referenceSourceContract(
        { ...rendition, kind: "watermarked" },
        { num: 24000, den: 1001 },
        100,
      ),
    ).not.toBeNull();
  });

  it("reports why a rendition is unavailable", () => {
    expect(
      referenceSourceAvailability(
        {
          ...rendition,
          kind: "watermarked",
          meta: {
            frame_rate_num: 24000,
            frame_rate_den: 1001,
            width: 1920,
            height: 1080,
          },
        },
        { num: 24000, den: 1001 },
        100,
      ),
    ).toEqual({
      contract: null,
      reason: "The rendition is missing its complete output color contract.",
    });
  });

  it("accepts 4K through 30 fps and fails closed above that scope", () => {
    expect(
      referenceSourceContract(
        {
          ...rendition,
          kind: "proxy_2160",
          meta: {
            ...rendition.meta,
            frame_rate_num: 30,
            frame_rate_den: 1,
            width: 4096,
            height: 2160,
          },
        },
        { num: 30, den: 1 },
        100,
      ),
    ).not.toBeNull();
    expect(
      referenceSourceContract(
        {
          ...rendition,
          kind: "proxy_4320",
          meta: { ...rendition.meta, width: 7680, height: 4320 },
        },
        { num: 24000, den: 1001 },
        100,
      ),
    ).toBeNull();
    expect(
      referenceSourceContract(
        {
          ...rendition,
          meta: {
            ...rendition.meta,
            frame_rate_num: 60000,
            frame_rate_den: 1001,
          },
        },
        { num: 60000, den: 1001 },
        100,
      ),
    ).toBeNull();
  });
});

/*
 * The gate used to name one space -- limited-range BT.709 -- because that was
 * the only thing the pipeline ever produced and the only thing the renderer
 * could draw. Both of those are changing, so it asks the renderer's own two
 * questions instead: can a gamut matrix be derived, and is the YUV matrix one
 * we implement.
 */
describe("reference availability across colour spaces", () => {
  const withColor = (color: Record<string, string>): typeof rendition => ({
    ...rendition,
    meta: {
      ...rendition.meta,
      output_color: { ...rendition.meta.output_color, ...color },
    },
  });
  const contractFor = (color: Record<string, string>) =>
    referenceSourceContract(
      withColor(color),
      { num: 24000, den: 1001 },
      107892,
    );

  it("offers reference for the gamuts the renderer can convert", () => {
    for (const primaries of [
      "bt709",
      "smpte432",
      "bt2020",
      "smpte170m",
      "bt470bg",
    ]) {
      const contract = contractFor({ primaries });
      expect(contract, `${primaries} should be offered`).not.toBeNull();
      expect(contract?.expected.outputColor.primaries).toBe(primaries);
    }
  });

  it("refuses a gamut it cannot derive rather than approximating it", () => {
    expect(contractFor({ primaries: "film" })).toBeNull();
  });

  /* PQ and HLG are genuinely different code values, not a label difference,
     and stay refused until the output path can carry them. */
  /* The shader decodes PQ and HLG now, so they are offered rather than
     refused; a transfer it does not implement still is. */
  it("offers the HDR transfers the shader implements", () => {
    for (const transfer of ["pq", "smpte2084", "hlg", "arib-std-b67"])
      expect(
        contractFor({ transfer }),
        `${transfer} should be offered`,
      ).not.toBeNull();
    expect(contractFor({ transfer: "linear" })).toBeNull();
    expect(contractFor({ transfer: "log3g10" })).toBeNull();
  });

  it("offers the matrices the YUV stage implements and no others", () => {
    for (const matrix of ["bt709", "smpte170m", "bt470bg", "bt2020-ncl"])
      expect(contractFor({ matrix }), matrix).not.toBeNull();
    expect(contractFor({ matrix: "rgb" })).toBeNull();
  });
});

/*
 * The exact strings production carries, copied from a real rendition on the
 * live site rather than invented here. The matrix is where this bit: the
 * pipeline stores ffprobe's "bt2020nc" and the decoder emits WebCodecs'
 * "bt2020-ncl", and only the second was recognised -- so reference playback
 * was refused for every BT.2020 rendition, HDR included, while the tests
 * passed against the spelling that was never in the metadata.
 */
describe("the spellings production actually stores", () => {
  const withColor = (color: Record<string, string>): typeof rendition => ({
    ...rendition,
    meta: {
      ...rendition.meta,
      output_color: { ...rendition.meta.output_color, ...color },
    },
  });

  it("accepts an HDR rendition exactly as the pipeline writes it", () => {
    const contract = referenceSourceContract(
      {
        ...withColor({
          primaries: "bt2020",
          transfer: "smpte2084",
          matrix: "bt2020nc",
          range: "tv",
        }),
        kind: "hdr_hevc",
      },
      { num: 24000, den: 1001 },
      100,
    );
    expect(contract).not.toBeNull();
    expect(contract?.expected.outputColor.matrix).toBe("bt2020-ncl");
  });

  it("accepts an SDR BT.2020 rendition written the same way", () => {
    const contract = referenceSourceContract(
      withColor({ primaries: "bt2020", transfer: "bt709", matrix: "bt2020nc" }),
      { num: 24000, den: 1001 },
      100,
    );
    expect(contract).not.toBeNull();
    expect(contract?.expected.outputColor.matrix).toBe("bt2020-ncl");
  });
});
