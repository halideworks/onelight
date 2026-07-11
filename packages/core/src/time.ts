export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export const days = (count: number): number => count * 24 * 60 * 60 * 1000;
