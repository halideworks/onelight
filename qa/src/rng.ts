/* Deterministic PRNG for reproducible random seeks. Mulberry32: tiny, well
   distributed for this purpose, and trivially reseedable from the printed
   seed. */

export const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const resolveSeed = (): number => {
  const fromEnv = process.env.QA_SEED;
  if (fromEnv !== undefined && /^\d+$/.test(fromEnv))
    return Number(fromEnv) >>> 0;
  return (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
};

/* Draws `count` distinct frame indices in [0, frameCount). Distinctness also
   guarantees consecutive seeks always change currentTime, so every seek
   produces a fresh rVFC presentation. */
export const uniqueRandomFrames = (
  random: () => number,
  frameCount: number,
  count: number,
): number[] => {
  const picked = new Set<number>();
  const limit = Math.min(count, frameCount);
  while (picked.size < limit)
    picked.add(Math.floor(random() * frameCount) % frameCount);
  return [...picked];
};
