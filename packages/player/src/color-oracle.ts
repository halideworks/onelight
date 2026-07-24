export type ColorTriplet = readonly [number, number, number];

export interface ColorOraclePatch {
  name: string;
  rect: { x: number; y: number; w: number; h: number };
  srgb: ColorTriplet;
  nominal: ColorTriplet;
  tolerance: ColorTriplet;
}

export interface ColorPatchReading {
  name: string;
  rgb: ColorTriplet;
}

export interface ColorPatchDelta {
  name: string;
  rgb: ColorTriplet;
  reference: ColorTriplet;
  delta: ColorTriplet;
}

export type ColorDeviationKind =
  "none" | "incomplete" | "range" | "matrix" | "transfer" | "unclassified";

export interface ColorOracleFailure {
  kind: "missing" | "channel" | "pinned";
  patch: string;
  channel?: number;
  message: string;
}

export interface ColorOracleResult {
  status: "pass" | "warning";
  deviation: ColorDeviationKind;
  failures: ColorOracleFailure[];
  deltas: ColorPatchDelta[];
}

export interface ColorOracleOptions {
  pinned?: Readonly<Record<string, ColorTriplet | undefined>>;
}

/*
 * Canonical sample points for the BT.709 limited-range RP 219 fixture.
 *
 * The reference values are derived from the encoded YUV planes with the exact
 * float BT.709 conversion in qa/src/fixtures.ts. They are intentionally not
 * idealized RGB bars: small one-byte differences are part of the encoded
 * fixture and must remain visible to parity tests.
 */
export const COLOR_ORACLE_PATCHES: readonly ColorOraclePatch[] = [
  {
    name: "grey40_left",
    rect: { x: 70, y: 200, w: 20, h: 20 },
    srgb: [102, 102, 102],
    nominal: [102, 102, 102],
    tolerance: [2, 2, 2],
  },
  {
    name: "white75",
    rect: { x: 218, y: 200, w: 20, h: 20 },
    srgb: [191, 191, 191],
    nominal: [191, 191, 191],
    tolerance: [2, 2, 2],
  },
  {
    name: "yellow75",
    rect: { x: 357, y: 200, w: 20, h: 20 },
    srgb: [191, 191, 0],
    nominal: [191, 191, 0],
    tolerance: [2, 2, 12],
  },
  {
    name: "cyan75",
    rect: { x: 493, y: 200, w: 20, h: 20 },
    srgb: [0, 191, 190],
    nominal: [0, 191, 191],
    tolerance: [2, 2, 12],
  },
  {
    name: "green75",
    rect: { x: 632, y: 200, w: 20, h: 20 },
    srgb: [0, 191, 0],
    nominal: [0, 191, 0],
    tolerance: [2, 2, 12],
  },
  {
    name: "magenta75",
    rect: { x: 771, y: 200, w: 20, h: 20 },
    srgb: [191, 0, 192],
    nominal: [191, 0, 191],
    tolerance: [2, 2, 12],
  },
  {
    name: "red75",
    rect: { x: 908, y: 200, w: 20, h: 20 },
    srgb: [191, 0, 1],
    nominal: [191, 0, 0],
    tolerance: [2, 2, 12],
  },
  {
    name: "blue75",
    rect: { x: 1048, y: 200, w: 20, h: 20 },
    srgb: [0, 0, 191],
    nominal: [0, 0, 191],
    tolerance: [2, 2, 12],
  },
  {
    name: "grey40_right",
    rect: { x: 1193, y: 200, w: 20, h: 20 },
    srgb: [102, 102, 102],
    nominal: [102, 102, 102],
    tolerance: [2, 2, 2],
  },
  {
    name: "black0",
    rect: { x: 784, y: 620, w: 20, h: 20 },
    srgb: [0, 0, 0],
    nominal: [0, 0, 0],
    tolerance: [2, 2, 2],
  },
  {
    name: "white100",
    rect: { x: 496, y: 620, w: 20, h: 20 },
    srgb: [255, 255, 255],
    nominal: [255, 255, 255],
    tolerance: [2, 2, 2],
  },
];

const NEUTRAL_PATCHES = new Set([
  "grey40_left",
  "grey40_right",
  "white75",
  "black0",
  "white100",
]);
const ENDPOINT_PATCHES = new Set(["black0", "white100"]);
const MID_NEUTRAL_PATCHES = new Set(["grey40_left", "grey40_right", "white75"]);
const CHROMATIC_PATCHES = new Set([
  "yellow75",
  "cyan75",
  "green75",
  "magenta75",
  "red75",
  "blue75",
]);

const channelUniform = (delta: ColorTriplet): boolean =>
  Math.max(...delta) - Math.min(...delta) <= 2;

const classifyDeviation = (
  failures: readonly ColorOracleFailure[],
  deltas: readonly ColorPatchDelta[],
): ColorDeviationKind => {
  if (failures.length === 0) return "none";
  if (failures.some((failure) => failure.kind === "missing"))
    return "incomplete";

  const failedNames = new Set(failures.map((failure) => failure.patch));
  const deltaByName = new Map(deltas.map((delta) => [delta.name, delta]));
  const uniformEndpointFailure = [...ENDPOINT_PATCHES].some((name) => {
    const delta = deltaByName.get(name)?.delta;
    return (
      failedNames.has(name) && delta !== undefined && channelUniform(delta)
    );
  });
  if (uniformEndpointFailure) return "range";

  const endpointsPass = [...ENDPOINT_PATCHES].every(
    (name) => !failedNames.has(name),
  );
  const uniformMidtoneFailures = [...MID_NEUTRAL_PATCHES].filter((name) => {
    const delta = deltaByName.get(name)?.delta;
    return (
      failedNames.has(name) && delta !== undefined && channelUniform(delta)
    );
  });
  if (endpointsPass && uniformMidtoneFailures.length >= 2) return "transfer";

  const neutralFailures = [...failedNames].filter((name) =>
    NEUTRAL_PATCHES.has(name),
  );
  const chromaticFailures = [...failedNames].filter((name) =>
    CHROMATIC_PATCHES.has(name),
  );
  if (neutralFailures.length === 0 && chromaticFailures.length >= 2)
    return "matrix";

  return "unclassified";
};

export const compareColorOracle = (
  readings: readonly ColorPatchReading[],
  options: ColorOracleOptions = {},
): ColorOracleResult => {
  const failures: ColorOracleFailure[] = [];
  const deltas: ColorPatchDelta[] = [];
  const readingsByName = new Map(
    readings.map((reading) => [reading.name, reading]),
  );

  for (const patch of COLOR_ORACLE_PATCHES) {
    const reading = readingsByName.get(patch.name);
    if (!reading) {
      failures.push({
        kind: "missing",
        patch: patch.name,
        message: `${patch.name}: reading missing`,
      });
      continue;
    }

    const delta: ColorTriplet = [
      reading.rgb[0] - patch.srgb[0],
      reading.rgb[1] - patch.srgb[1],
      reading.rgb[2] - patch.srgb[2],
    ];
    deltas.push({
      name: patch.name,
      rgb: reading.rgb,
      reference: patch.srgb,
      delta,
    });

    const pinned = options.pinned?.[patch.name];
    if (pinned) {
      if (
        reading.rgb[0] !== pinned[0] ||
        reading.rgb[1] !== pinned[1] ||
        reading.rgb[2] !== pinned[2]
      )
        failures.push({
          kind: "pinned",
          patch: patch.name,
          message: `${patch.name}: got ${reading.rgb.join(",")}, pinned deviation ${pinned.join(",")} (reference ${patch.srgb.join(",")}); the decoder changed, re-derive or delete the pin`,
        });
      continue;
    }

    for (const channel of [0, 1, 2] as const) {
      const got = reading.rgb[channel];
      const want = patch.srgb[channel];
      const tolerance = patch.tolerance[channel];
      if (Math.abs(got - want) > tolerance)
        failures.push({
          kind: "channel",
          patch: patch.name,
          channel,
          message: `${patch.name} channel ${String(channel)}: got ${reading.rgb.join(",")}, reference ${patch.srgb.join(",")} (nominal ${patch.nominal.join(",")}, tolerance ${String(tolerance)})`,
        });
    }
  }

  return {
    status: failures.length === 0 ? "pass" : "warning",
    deviation: classifyDeviation(failures, deltas),
    failures,
    deltas,
  };
};
