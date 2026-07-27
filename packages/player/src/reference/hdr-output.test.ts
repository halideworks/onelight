import { describe, expect, it } from "vitest";
import {
  DEFAULT_HDR_OUTPUT_ENCODING,
  hdrOutputEncodingWgsl,
  hdrOutputSupport,
} from "./hdr-output.js";

const environment = (
  over: Partial<Parameters<typeof hdrOutputSupport>[0]> = {},
) => ({
  hasWebGpu: true,
  extendedRangeAccepted: true,
  displayIsHdr: true,
  ...over,
});

describe("HDR canvas output support", () => {
  it("needs every term, and says which one is missing", () => {
    expect(hdrOutputSupport(environment()).supported).toBe(true);

    const noGpu = hdrOutputSupport(environment({ hasWebGpu: false }));
    expect(noGpu.supported).toBe(false);
    expect(noGpu.reason).toContain("WebGPU");

    const noExtended = hdrOutputSupport(
      environment({ extendedRangeAccepted: false }),
    );
    expect(noExtended.supported).toBe(false);
    expect(noExtended.reason).toContain("clip");

    const sdrDisplay = hdrOutputSupport(environment({ displayIsHdr: false }));
    expect(sdrDisplay.supported).toBe(false);
    expect(sdrDisplay.reason).toContain("dynamic range");
  });

  /* Listing the enum is not the same as accepting the configuration, and only
     the second one means the values survive. Measured: WebGL2 lists nothing
     usable at all, while WebGPU accepts display-p3 + rgba16float + extended on
     both Chrome 150 and Safari 26.5.2. */
  it("does not take an engine's word for it without a configured context", () => {
    expect(
      hdrOutputSupport(environment({ extendedRangeAccepted: false })).supported,
    ).toBe(false);
  });
});

describe("HDR output encoding", () => {
  it("emits a WGSL encoder for each candidate", () => {
    for (const encoding of ["srgb-extended", "linear-scrgb"] as const) {
      const wgsl = hdrOutputEncodingWgsl(encoding);
      expect(wgsl).toContain("fn encode_hdr_output(linear: vec3f) -> vec3f");
      /* Nothing may clamp to 1.0: that ceiling is the entire bug this path
         exists to remove. */
      expect(wgsl).not.toContain("clamp(v, vec3f(0.0), vec3f(1.0))");
      expect(wgsl).not.toContain("min(");
    }
  });

  it("defaults to the curve that matches the SDR path below white", () => {
    expect(DEFAULT_HDR_OUTPUT_ENCODING).toBe("srgb-extended");
    const wgsl = hdrOutputEncodingWgsl("srgb-extended");
    /* The same constants as the SDR renderer's srgb_encode, so a diffuse
       white patch reads identically in both. */
    expect(wgsl).toContain("12.92");
    expect(wgsl).toContain("1.055");
    expect(wgsl).toContain("0.055");
    expect(wgsl).toContain("1.0 / 2.4");
  });

  it("keeps scRGB free of any curve", () => {
    const wgsl = hdrOutputEncodingWgsl("linear-scrgb");
    expect(wgsl).not.toContain("pow(");
    expect(wgsl).not.toContain("12.92");
  });
});
