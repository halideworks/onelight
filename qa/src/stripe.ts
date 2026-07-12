/* The pixel-level frame-identity scheme shared by fixture synthesis (ffmpeg
   drawbox filters, Node side) and the browser harness (canvas readback).

   Encoding: 8 blocks of STRIPE_BLOCK_SIZE x STRIPE_BLOCK_SIZE pixels along
   the bottom-left edge of the frame. Block i (left to right) carries bit i
   (LSB first) of (frame_number mod 256): white when set, black when clear.
   Pure black/white luma blocks of this size survive yuv420p chroma
   subsampling and CRF 18 H.264 untouched for our purposes; decoding
   thresholds the average luma of a 16x16 patch at each block center, so
   ringing at block edges cannot flip a bit. */

export const STRIPE_BLOCK_SIZE = 64;
export const STRIPE_BLOCK_COUNT = 8;
export const STRIPE_SAMPLE_HALF = 8;

/* ffmpeg filtergraph fragments that burn the stripe. `n` inside a timeline
   `enable` expression is the 0-based frame number of the filter input; the
   fixtures apply no rate conversion, so it equals the encoded frame index. */
export const stripeFilters = (): string[] => {
  const filters = [
    `drawbox=x=0:y=ih-${STRIPE_BLOCK_SIZE}:w=${STRIPE_BLOCK_SIZE * STRIPE_BLOCK_COUNT}:h=${STRIPE_BLOCK_SIZE}:color=black:t=fill`,
  ];
  for (let bit = 0; bit < STRIPE_BLOCK_COUNT; bit += 1)
    filters.push(
      `drawbox=x=${bit * STRIPE_BLOCK_SIZE}:y=ih-${STRIPE_BLOCK_SIZE}:w=${STRIPE_BLOCK_SIZE}:h=${STRIPE_BLOCK_SIZE}:color=white:t=fill:enable='gt(mod(floor(n/${2 ** bit}),2),0)'`,
    );
  return filters;
};

/* Decodes (frame mod 256) from RGBA pixel data of a full frame. Pure
   function over the byte array so the same code runs in the harness bundle
   and in Node against raw dumps. */
export const decodeStripe = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
): number => {
  let value = 0;
  for (let bit = 0; bit < STRIPE_BLOCK_COUNT; bit += 1) {
    const centerX = bit * STRIPE_BLOCK_SIZE + STRIPE_BLOCK_SIZE / 2;
    const centerY = height - STRIPE_BLOCK_SIZE / 2;
    let sum = 0;
    let samples = 0;
    for (
      let y = centerY - STRIPE_SAMPLE_HALF;
      y < centerY + STRIPE_SAMPLE_HALF;
      y += 1
    )
      for (
        let x = centerX - STRIPE_SAMPLE_HALF;
        x < centerX + STRIPE_SAMPLE_HALF;
        x += 1
      ) {
        const offset = (y * width + x) * 4;
        sum +=
          ((data[offset] ?? 0) +
            (data[offset + 1] ?? 0) +
            (data[offset + 2] ?? 0)) /
          3;
        samples += 1;
      }
    if (sum / samples >= 128) value |= 1 << bit;
  }
  return value;
};
