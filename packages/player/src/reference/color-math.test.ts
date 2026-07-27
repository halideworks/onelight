import { describe, expect, it } from "vitest";
import {
  applyGamut,
  convertYuvCodeToEncodedRgb,
  encodeForDisplay,
  gamutConversionMatrix,
  isIdentityGamut,
  primariesToXyz,
  referencePrimariesFromMetadata,
  hlgInverseOetf,
  bt2390Eetf,
  pqEotfNits,
  pqInverseEotf,
  toneMapIctcp,
  toneMapNits,
  wantsWideGamutOutput,
  isSdrGammaTransfer,
  quantizeEncodedRgb,
  referenceMatrixFromMetadata,
  resolveDisplayTransfer,
  type ReferenceRgb,
  type ReferenceYuv,
  type ReferenceYuvMatrix,
} from "./color-math.js";
import type { ReferenceColorContract } from "./protocol.js";

type Vector = {
  name: string;
  yuv: ReferenceYuv;
  rgb: readonly [number, number, number];
};

const VECTOR_TARGETS = [
  ["black", [0, 0, 0]],
  ["white", [255, 255, 255]],
  ["grey40", [102, 102, 102]],
  ["white75", [191, 191, 191]],
  ["red75", [191, 0, 0]],
  ["green75", [0, 191, 0]],
  ["blue75", [0, 0, 191]],
  ["cyan75", [0, 191, 191]],
  ["magenta75", [191, 0, 191]],
  ["yellow75", [191, 191, 0]],
] as const;

const expectVector = (
  vector: Vector,
  matrix: ReferenceYuvMatrix,
  range: ReferenceColorContract["range"],
): void => {
  const actual = quantizeEncodedRgb(
    convertYuvCodeToEncodedRgb(vector.yuv, matrix, range),
  );
  for (const channel of [0, 1, 2] as const)
    expect(
      Math.abs(actual[channel] - vector.rgb[channel]),
      `${matrix} ${range} ${vector.name} channel ${channel}: ${actual.join(",")}`,
    ).toBeLessThanOrEqual(1);
};

const YUV_VECTORS: Readonly<
  Record<
    ReferenceYuvMatrix,
    Readonly<Record<ReferenceColorContract["range"], readonly ReferenceYuv[]>>
  >
> = {
  bt601: {
    tv: [
      [16, 128, 128],
      [235, 128, 128],
      [104, 128, 128],
      [180, 128, 128],
      [65, 100, 212],
      [112, 72, 58],
      [35, 212, 114],
      [131, 156, 44],
      [84, 184, 198],
      [162, 44, 142],
    ],
    pc: [
      [0, 128, 128],
      [255, 128, 128],
      [102, 128, 128],
      [191, 128, 128],
      [57, 96, 224],
      [112, 65, 48],
      [22, 224, 112],
      [134, 160, 32],
      [79, 191, 208],
      [169, 32, 144],
    ],
  },
  bt709: {
    tv: [
      [16, 128, 128],
      [235, 128, 128],
      [104, 128, 128],
      [180, 128, 128],
      [51, 109, 212],
      [133, 63, 52],
      [28, 212, 120],
      [145, 147, 44],
      [63, 193, 204],
      [168, 44, 136],
    ],
    pc: [
      [0, 128, 128],
      [255, 128, 128],
      [102, 128, 128],
      [191, 128, 128],
      [41, 106, 224],
      [137, 54, 41],
      [14, 224, 119],
      [151, 150, 32],
      [54, 202, 215],
      [177, 32, 137],
    ],
  },
  "bt2020-ncl": {
    tv: [
      [16, 128, 128],
      [235, 128, 128],
      [104, 128, 128],
      [180, 128, 128],
      [59, 105, 212],
      [127, 67, 51],
      [26, 212, 121],
      [137, 151, 44],
      [69, 189, 205],
      [171, 44, 135],
    ],
    pc: [
      [0, 128, 128],
      [255, 128, 128],
      [102, 128, 128],
      [191, 128, 128],
      [50, 101, 224],
      [130, 59, 40],
      [11, 224, 120],
      [141, 155, 32],
      [62, 197, 216],
      [180, 32, 136],
    ],
  },
};

const vectorsFor = (
  matrix: ReferenceYuvMatrix,
  range: ReferenceColorContract["range"],
): Vector[] =>
  VECTOR_TARGETS.map(([name, rgb], index) => {
    const yuv = YUV_VECTORS[matrix][range][index];
    if (!yuv) throw new Error(`${matrix} ${range} ${name} vector is missing.`);
    return { name, yuv, rgb };
  });

describe("reference YUV color math", () => {
  it("maps WebCodecs matrix metadata without guessing", () => {
    expect(referenceMatrixFromMetadata("bt709")).toBe("bt709");
    expect(referenceMatrixFromMetadata("bt470bg")).toBe("bt601");
    expect(referenceMatrixFromMetadata("smpte170m")).toBe("bt601");
    expect(referenceMatrixFromMetadata("bt2020-ncl")).toBe("bt2020-ncl");
    expect(referenceMatrixFromMetadata("rgb")).toBeNull();
    expect(referenceMatrixFromMetadata("unknown")).toBeNull();
  });

  it("matches every matrix, range, neutral, and 75 percent color vector", () => {
    for (const matrix of ["bt601", "bt709", "bt2020-ncl"] as const)
      for (const range of ["tv", "pc"] as const)
        for (const vector of vectorsFor(matrix, range))
          expectVector(vector, matrix, range);
  });

  it("clamps only the final encoded output", () => {
    const rgb: ReferenceRgb = convertYuvCodeToEncodedRgb(
      [16, 16, 240],
      "bt709",
      "tv",
    );
    expect(rgb[0]).toBeGreaterThan(0);
    expect(rgb[0]).toBeLessThan(1);
    expect(rgb[1]).toBe(0);
    expect(rgb[2]).toBe(0);
  });
});

describe("display transfer", () => {
  it("passes sRGB code values through unchanged", () => {
    for (const v of [0, 0.1, 0.4, 0.749, 1] as const)
      expect(encodeForDisplay([v, v, v], "srgb")).toEqual([v, v, v]);
  });

  it("darkens shadows under BT.1886 while pinning the endpoints", () => {
    // Endpoints are invariant; a mid grey lands ~8/255 darker than sRGB.
    expect(quantizeEncodedRgb(encodeForDisplay([0, 0, 0], "bt1886"))).toEqual([
      0, 0, 0,
    ]);
    expect(quantizeEncodedRgb(encodeForDisplay([1, 1, 1], "bt1886"))).toEqual([
      255, 255, 255,
    ]);
    const grey40 = quantizeEncodedRgb(
      encodeForDisplay([0.4, 0.4, 0.4], "bt1886"),
    );
    expect(grey40[0]).toBe(94);
    // Every non-endpoint code is darker than the straight sRGB code.
    for (const v of [0.1, 0.2, 0.4, 0.6, 0.8] as const)
      expect(encodeForDisplay([v, v, v], "bt1886")[0]).toBeLessThan(v);
  });

  it("holds a pure 2.2 apart from sRGB where a grade is argued about", () => {
    // Endpoints pin, as they must for any of these curves.
    expect(quantizeEncodedRgb(encodeForDisplay([0, 0, 0], "gamma22"))).toEqual([
      0, 0, 0,
    ]);
    expect(quantizeEncodedRgb(encodeForDisplay([1, 1, 1], "gamma22"))).toEqual([
      255, 255, 255,
    ]);
    /* 2.2 is always lighter than the 2.4 reference: that is the rung. */
    for (const v of [0.1, 0.2, 0.4, 0.6, 0.8] as const)
      expect(encodeForDisplay([v, v, v], "gamma22")[0]).toBeGreaterThan(
        encodeForDisplay([v, v, v], "bt1886")[0],
      );

    /* Against sRGB the difference is a shadow difference and nothing else.
       sRGB's linear toe lifts the bottom of the scale, so a true 2.2 sits
       clearly under it there -- 0.1 encodes to 19/255 rather than 26 -- while
       the two converge to within half a code by the upper midtones. Anyone
       arguing about a grade is arguing about the first number. */
    const shadow = quantizeEncodedRgb(
      encodeForDisplay([0.1, 0.1, 0.1], "gamma22"),
    );
    expect(shadow[0]).toBe(19);
    expect(
      quantizeEncodedRgb(encodeForDisplay([0.1, 0.1, 0.1], "srgb"))[0],
    ).toBe(26);
    for (const v of [0.6, 0.8] as const)
      expect(
        Math.abs(
          encodeForDisplay([v, v, v], "gamma22")[0] -
            encodeForDisplay([v, v, v], "srgb")[0],
        ),
      ).toBeLessThan(0.006);
  });

  it("resolves the transfer from the asset, then the project, then the tag", () => {
    // An explicit choice on the asset always wins.
    expect(resolveDisplayTransfer("srgb", "bt709")).toBe("srgb");
    expect(resolveDisplayTransfer("bt1886", "iec61966-2-1")).toBe("bt1886");
    expect(resolveDisplayTransfer("gamma22", "bt709")).toBe("gamma22");
    // Then the project's house standard, for anything the asset left alone.
    expect(resolveDisplayTransfer(null, "bt709", "gamma22")).toBe("gamma22");
    expect(resolveDisplayTransfer(undefined, "iec61966-2-1", "bt1886")).toBe(
      "bt1886",
    );
    // An asset choice still beats the project.
    expect(resolveDisplayTransfer("srgb", "bt709", "gamma22")).toBe("srgb");
    // A junk setting at either level falls through rather than rendering wrong.
    expect(resolveDisplayTransfer("garbage", "bt709")).toBe("bt1886");
    expect(resolveDisplayTransfer(null, "bt709", "garbage")).toBe("bt1886");
    // Then the file's own tag. sRGB-authored material stays sRGB.
    expect(resolveDisplayTransfer(null, "iec61966-2-1")).toBe("srgb");
    expect(resolveDisplayTransfer(undefined, "sRGB")).toBe("srgb");
    // A tag that says 2.2 now gets a real 2.2 instead of sRGB's approximation.
    expect(resolveDisplayTransfer(null, "bt470m")).toBe("gamma22");
    expect(resolveDisplayTransfer(null, "gamma22")).toBe("gamma22");
    // BT.709 / SMPTE 170M / unknown / missing all resolve to the reference default.
    expect(resolveDisplayTransfer(null, "bt709")).toBe("bt1886");
    expect(resolveDisplayTransfer(null, "smpte170m")).toBe("bt1886");
    expect(resolveDisplayTransfer(null, null)).toBe("bt1886");
  });

  it("treats the SDR gamma tags as one family and nothing else", () => {
    // The tags real decoders put on a BT.709 SDR surface. Safari reports
    // "iec61966-2-1" for every H.264 BT.709 proxy it decodes.
    for (const tag of [
      "bt709",
      "BT.709",
      "rec709",
      "smpte170m",
      "iec61966-2-1",
      "iec61966_2_1",
      "srgb",
    ])
      expect(isSdrGammaTransfer(tag)).toBe(true);
    // Different code values, not a different name for the same ones.
    for (const tag of ["pq", "hlg", "linear", "smpte2084", "", null, undefined])
      expect(isSdrGammaTransfer(tag)).toBe(false);
  });
});

describe("colour primaries", () => {
  const close = (actual: number, expected: number, tolerance = 5e-4): void => {
    expect(Math.abs(actual - expected)).toBeLessThan(tolerance);
  };

  /* Derived from chromaticities, never transcribed, so this is the check that
     the derivation itself is right. Against the published BT.709 and P3
     RGB-to-XYZ matrices. */
  it("derives the published RGB-to-XYZ matrices from chromaticities", () => {
    const bt709 = primariesToXyz("bt709");
    for (const [index, expected] of [
      0.4124, 0.3576, 0.1805, 0.2126, 0.7152, 0.0722, 0.0193, 0.1192, 0.9505,
    ].entries())
      close(bt709[index] ?? 0, expected);

    const p3 = primariesToXyz("smpte432");
    for (const [index, expected] of [
      0.4866, 0.2657, 0.1982, 0.229, 0.6917, 0.0793, 0, 0.0451, 1.0439,
    ].entries())
      close(p3[index] ?? 0, expected);

    const bt2020 = primariesToXyz("bt2020");
    for (const [index, expected] of [
      0.637, 0.1446, 0.1689, 0.2627, 0.678, 0.0593, 0, 0.0281, 1.061,
    ].entries())
      close(bt2020[index] ?? 0, expected);
  });

  /* The bit-exact path. A 709 frame on an sRGB canvas must touch no colour
     matrix at all -- the measured GL-versus-CPU parity depends on it. */
  it("converts a matching gamut with an exact identity", () => {
    expect(isIdentityGamut(gamutConversionMatrix("bt709", "bt709"))).toBe(true);
    expect(isIdentityGamut(gamutConversionMatrix("smpte432", "smpte432"))).toBe(
      true,
    );
    expect(isIdentityGamut(gamutConversionMatrix("smpte432", "bt709"))).toBe(
      false,
    );
    const white = applyGamut(
      [1, 1, 1],
      gamutConversionMatrix("bt709", "bt709"),
    );
    expect(white).toEqual([1, 1, 1]);
  });

  /* White is the shared D65 in every one of these gamuts, so it must survive
     any conversion untouched. If a matrix is wrong, white tints first. */
  it("keeps the shared white point through every conversion", () => {
    for (const source of [
      "smpte432",
      "bt2020",
      "smpte170m",
      "bt470bg",
    ] as const)
      for (const channel of applyGamut(
        [1, 1, 1],
        gamutConversionMatrix(source, "bt709"),
      ))
        close(channel, 1, 1e-6);
  });

  /* What the proxy pipeline currently throws away. A saturated P3 red has no
     representation inside 709: the red channel overshoots and the others go
     negative, and clipping that to the canvas is exactly the loss that made
     preserving the source gamut worth doing. */
  it("shows saturated P3 falling outside the 709 gamut", () => {
    const red = applyGamut(
      [1, 0, 0],
      gamutConversionMatrix("smpte432", "bt709"),
    );
    expect(red[0]).toBeGreaterThan(1);
    expect(red[1]).toBeLessThan(0);
    expect(red[2]).toBeLessThan(0);
    const green = applyGamut(
      [0, 1, 0],
      gamutConversionMatrix("bt2020", "bt709"),
    );
    expect(green[1]).toBeGreaterThan(1);
  });

  /* Round trip: out to a wider gamut and back lands where it started. */
  it("round-trips through a wider gamut", () => {
    const toP3 = gamutConversionMatrix("bt709", "smpte432");
    const back = gamutConversionMatrix("smpte432", "bt709");
    for (const rgb of [
      [0.2, 0.4, 0.6],
      [1, 0, 0],
      [0.5, 0.5, 0.5],
    ] as const) {
      const round = applyGamut(applyGamut(rgb, toP3), back);
      for (const [index, channel] of round.entries())
        close(channel, rgb[index] ?? 0, 1e-9);
    }
  });

  it("refuses to guess a gamut it does not implement", () => {
    expect(referencePrimariesFromMetadata("bt709")).toBe("bt709");
    expect(referencePrimariesFromMetadata("smpte432")).toBe("smpte432");
    expect(referencePrimariesFromMetadata("bt2020")).toBe("bt2020");
    expect(referencePrimariesFromMetadata("film")).toBeNull();
    expect(referencePrimariesFromMetadata(null)).toBeNull();
    expect(referencePrimariesFromMetadata(undefined)).toBeNull();
  });
});

describe("wide-gamut output selection", () => {
  it("asks for a wide buffer only when the content is wider than 709", () => {
    expect(wantsWideGamutOutput("smpte432", true)).toBe(true);
    expect(wantsWideGamutOutput("bt2020", true)).toBe(true);
    /* 709 content gains nothing and would lose the passthrough. */
    expect(wantsWideGamutOutput("bt709", true)).toBe(false);
    expect(wantsWideGamutOutput("smpte170m", true)).toBe(false);
  });

  it("never asks for one the display cannot show", () => {
    expect(wantsWideGamutOutput("smpte432", false)).toBe(false);
    expect(wantsWideGamutOutput("bt2020", false)).toBe(false);
  });

  it("does not ask on a tag it cannot place", () => {
    expect(wantsWideGamutOutput("film", true)).toBe(false);
    expect(wantsWideGamutOutput(null, true)).toBe(false);
  });
});

describe("HDR transfer functions", () => {
  const close = (actual: number, expected: number, tol: number): void => {
    expect(Math.abs(actual - expected)).toBeLessThan(tol);
  };

  /* Against the published ST.2084 anchor points. These are the numbers a
     colourist would recognise: 0 is black, 1.0 is the format's 10000 nit
     ceiling, and 0.58 is very close to the 203 nit diffuse white BT.2408
     defines as HDR reference white. */
  it("decodes PQ to absolute luminance at the published anchors", () => {
    close(pqEotfNits(0), 0, 1e-6);
    close(pqEotfNits(1), 10000, 1);
    close(pqEotfNits(0.5081), 100, 1);
    close(pqEotfNits(0.5806), 203, 2);
    close(pqEotfNits(0.7518), 1000, 5);
  });

  it("decodes PQ monotonically", () => {
    let previous = -1;
    for (let code = 0; code <= 1; code += 0.05) {
      const nits = pqEotfNits(code);
      expect(nits).toBeGreaterThan(previous);
      previous = nits;
    }
  });

  /* HLG's inverse OETF has a defined split at signal 0.5, and both halves
     must meet there or a mid-grey gets a visible step. */
  it("decodes HLG continuously across the piecewise split", () => {
    close(hlgInverseOetf(0), 0, 1e-9);
    close(hlgInverseOetf(0.5), 1 / 12, 1e-9);
    close(hlgInverseOetf(1), 1, 1e-6);
    const below = hlgInverseOetf(0.4999);
    const above = hlgInverseOetf(0.5001);
    expect(Math.abs(above - below)).toBeLessThan(1e-3);
  });

  describe("tone mapping", () => {
    /* Diffuse white on a 1000-nit grade lands just over half of display
       linear, which is about 188/255 once the sRGB curve is applied -- a
       believable SDR white with the specular range still above it. Pinned
       because it is the number a colourist would notice moving. */
    it("places diffuse white where an SDR white belongs", () => {
      expect(toneMapNits(0)).toBe(0);
      close(toneMapNits(203, 203, 1000), 0.5206, 5e-4);
      const encoded = quantizeEncodedRgb(
        encodeForDisplay(
          [
            toneMapNits(203, 203, 1000),
            toneMapNits(203, 203, 1000),
            toneMapNits(203, 203, 1000),
          ],
          "srgb",
        ),
      );
      expect(encoded[0]).toBeGreaterThan(120);
      expect(encoded[0]).toBeLessThan(140);
    });

    /* Near black the curve is within a percent of doing nothing, so shadow
       detail arrives as graded rather than lifted or crushed. */
    it("leaves the bottom of the scale alone", () => {
      for (const nits of [0.5, 2, 10]) {
        const scene = nits / 203;
        expect(Math.abs(toneMapNits(nits, 203, 1000) - scene)).toBeLessThan(
          scene * 0.06,
        );
      }
    });

    /* The peak the grade was mastered to lands exactly on display white:
       that is the property that makes highlights roll off instead of
       clipping, and it is the reason for the extended form. */
    it("puts the mastering peak exactly on display white", () => {
      close(toneMapNits(1000, 203, 1000), 1, 1e-9);
      close(toneMapNits(4000, 203, 4000), 1, 1e-9);
      close(toneMapNits(203, 203, 203), 1, 1e-9);
    });

    it("never exceeds display white and stays monotonic", () => {
      let previous = -1;
      for (let nits = 0; nits <= 4000; nits += 50) {
        const mapped = toneMapNits(nits, 203, 1000);
        expect(mapped).toBeLessThanOrEqual(1);
        expect(mapped).toBeGreaterThanOrEqual(previous);
        previous = mapped;
      }
    });

    /* A brighter mastering peak means more headroom, so the same absolute
       luminance sits lower on the display. */
    it("respects the mastering peak it was given", () => {
      expect(toneMapNits(500, 203, 4000)).toBeLessThan(
        toneMapNits(500, 203, 1000),
      );
    });
  });
});

describe("BT.2390 tone mapping in ICtCp", () => {
  const near = (a: number, b: number, tol: number): void => {
    expect(Math.abs(a - b)).toBeLessThan(tol);
  };

  it("round-trips PQ through its own inverse", () => {
    for (const nits of [0.01, 1, 100, 203, 1000, 4000, 10000])
      near(pqEotfNits(pqInverseEotf(nits)), nits, Math.max(nits * 1e-4, 1e-4));
  });

  /* The property that makes BT.2390 the broadcast answer: content the display
     can already show is passed through untouched, so nothing below the knee
     is altered to buy headroom it does not need. */
  it("passes the range below the knee through unchanged", () => {
    const source = 1000;
    const display = 203;
    const ks = 1.5 * (pqInverseEotf(display) / pqInverseEotf(source)) - 0.5;
    const belowKnee = pqInverseEotf(source) * ks * 0.5;
    /* Not bit-exact: BT.2390's quartic black lift adds the PQ code for the
       display's own black, which is 7.3e-7 rather than zero. That lift is
       the spec doing its job, not drift. */
    near(bt2390Eetf(belowKnee, source, display), belowKnee, 1e-6);

    /* End to end, the same property in nits: everything under the knee comes
       out exactly where linear scaling would put it. */
    for (const nits of [1, 50])
      near(toneMapIctcp([nits, nits, nits], 1000, 203)[0], nits / 203, 5e-4);
  });

  it("maps the source peak to the display peak", () => {
    near(bt2390Eetf(pqInverseEotf(1000), 1000, 203), pqInverseEotf(203), 2e-3);
  });

  /* A display that can already show everything has nothing to compress. */
  it("is the identity when the display outranges the source", () => {
    const code = pqInverseEotf(200);
    expect(bt2390Eetf(code, 400, 1000)).toBe(code);
  });

  it("never exceeds the display peak and stays monotonic", () => {
    let previous = -1;
    for (let nits = 0; nits <= 4000; nits += 25) {
      const out = bt2390Eetf(pqInverseEotf(nits), 4000, 203);
      expect(out).toBeLessThanOrEqual(pqInverseEotf(203) + 1e-6);
      expect(out).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = out;
    }
  });

  /*
   * The reason for ICtCp over a curve on RGB. A saturated colour compressed
   * for an SDR display must keep its hue: the failure everyone recognises is
   * a sunset going pale as it clips. Hue in ICtCp is the angle of (Ct, Cp),
   * and scaling both by one factor cannot move it.
   */
  it("preserves hue through heavy compression", () => {
    const saturated: ReferenceRgb = [900, 180, 40];
    const mapped = toneMapIctcp(saturated, 1000, 203);
    const hueOf = (rgb: ReferenceRgb): number => {
      const lms = [
        0.412 * rgb[0] + 0.524 * rgb[1] + 0.064 * rgb[2],
        0.167 * rgb[0] + 0.72 * rgb[1] + 0.113 * rgb[2],
        0.024 * rgb[0] + 0.075 * rgb[1] + 0.9 * rgb[2],
      ] as const;
      return Math.atan2(
        (17933 / 4096) * lms[0] -
          (17390 / 4096) * lms[1] -
          (543 / 4096) * lms[2],
        (6610 / 4096) * lms[0] -
          (13613 / 4096) * lms[1] +
          (7003 / 4096) * lms[2],
      );
    };
    /* Compared in the same coarse space on both sides: what matters is that
       the angle barely moves, not its absolute value. */
    near(hueOf(mapped), hueOf(saturated), 0.06);
  });

  it("keeps saturation rather than washing colour towards white", () => {
    const saturated: ReferenceRgb = [900, 180, 40];
    const mapped = toneMapIctcp(saturated, 1000, 203);
    const spreadBefore =
      (Math.max(...saturated) - Math.min(...saturated)) /
      Math.max(...saturated);
    const spreadAfter =
      (Math.max(...mapped) - Math.min(...mapped)) / Math.max(...mapped);
    /* A per-channel curve collapses this ratio; ICtCp should hold most of it. */
    /* Scaling by the largest channel keeps the ratios, so almost all of it
       survives. Holding intensity and killing chroma instead measured 0.14
       here -- white -- which is why it is not done that way. */
    expect(spreadAfter).toBeGreaterThan(spreadBefore * 0.95);
  });

  /*
   * Where diffuse white lands is the whole trade of a peak-preserving EETF,
   * so it is pinned rather than hand-waved. A 1000-nit grade shown on an SDR
   * display puts 203-nit diffuse white at 0.78 of display white, NOT at 1.0:
   * the top fifth of the range is being held back so speculars have somewhere
   * to go and roll off instead of clipping to a flat plate. Anyone who wants
   * white at 1.0 is asking to throw the highlights away, which is the thing
   * this renderer exists not to do.
   */
  it("trades white level for specular headroom, and says where", () => {
    near(toneMapIctcp([203, 203, 203], 1000, 203)[0], 0.7835, 2e-3);
    near(toneMapIctcp([400, 400, 400], 1000, 203)[0], 0.9537, 2e-3);
    /* The source peak lands exactly on display white. */
    near(toneMapIctcp([1000, 1000, 1000], 1000, 203)[0], 1, 1e-3);
    /* Highlights above diffuse white stay distinguishable rather than
       collapsing into one white: that is what the headroom buys. */
    expect(toneMapIctcp([600, 600, 600], 1000, 203)[0]).toBeGreaterThan(
      toneMapIctcp([400, 400, 400], 1000, 203)[0],
    );
    const black = toneMapIctcp([0, 0, 0], 1000, 203);
    for (const channel of black) near(channel, 0, 1e-6);
  });
});
