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

  it("does not treat HDR or a non-proxy source as a reference contract", () => {
    expect(
      referenceSourceContract(
        { ...rendition, kind: "hdr_hevc" },
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
