import { describe, expect, it, vi } from "vitest";
import {
  hdrRenditionContract,
  qualifyNativeHdr,
  type HdrCapabilityEnvironment,
} from "./hdr-selection.js";

const rendition = {
  kind: "hdr_hevc",
  url: "/hdr.mp4",
  meta: {
    codec: "hvc1.2.4.L153.B0",
    coded_width: 3840,
    coded_height: 2160,
    bit_rate: 18_000_000,
    frame_rate_num: 24000,
    frame_rate_den: 1001,
    hdr_metadata_type: "smpteSt2086",
    source_color: {
      primaries: "bt2020",
      transfer: "smpte2084",
      matrix: "bt2020nc",
      range: "tv",
      assumed: false,
    },
    output_color: {
      primaries: "bt2020",
      transfer: "smpte2084",
      matrix: "bt2020nc",
      range: "tv",
    },
  },
};

const environment = (
  result: Partial<MediaCapabilitiesDecodingInfo> = {
    supported: true,
    smooth: true,
  },
): HdrCapabilityEnvironment => ({
  decodingInfo: vi.fn().mockResolvedValue({
    supported: false,
    smooth: false,
    powerEfficient: false,
    keySystemAccess: null,
    configuration: {},
    ...result,
  }),
  matches: vi.fn().mockReturnValue(true),
});

describe("native HDR qualification", () => {
  it("builds an exact fail-closed capability contract", () => {
    expect(hdrRenditionContract(rendition)).toMatchObject({
      contentType: 'video/mp4; codecs="hvc1.2.4.L153.B0"',
      width: 3840,
      height: 2160,
      bitrate: 18_000_000,
      transferFunction: "pq",
      colorGamut: "rec2020",
      hdrMetadataType: "smpteSt2086",
    });
  });

  it("requires metadata agreement and PQ mastering metadata", () => {
    expect(
      hdrRenditionContract({
        ...rendition,
        meta: {
          ...rendition.meta,
          output_color: {
            ...rendition.meta.output_color,
            transfer: "arib-std-b67",
          },
        },
      }),
    ).toBeNull();
    expect(
      hdrRenditionContract({
        ...rendition,
        meta: { ...rendition.meta, hdr_metadata_type: null },
      }),
    ).toBeNull();
  });

  it("requires both display queries and supported smooth decode", async () => {
    const noDisplay = environment();
    vi.mocked(noDisplay.matches).mockReturnValue(false);
    expect((await qualifyNativeHdr(rendition, noDisplay)).qualified).toBe(
      false,
    );

    const rough = environment({ supported: true, smooth: false });
    expect((await qualifyNativeHdr(rendition, rough)).qualified).toBe(false);

    const qualified = environment();
    const result = await qualifyNativeHdr(rendition, qualified);
    expect(result.qualified).toBe(true);
    expect(qualified.decodingInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "file",
        video: expect.objectContaining({
          contentType: 'video/mp4; codecs="hvc1.2.4.L153.B0"',
          transferFunction: "pq",
          colorGamut: "rec2020",
          hdrMetadataType: "smpteSt2086",
        }),
      }),
    );
  });
});
