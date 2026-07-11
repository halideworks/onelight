import { errors } from "./errors.js";

export interface FrameRate {
  num: number;
  den: number;
}

export interface Timecode {
  hours: number;
  minutes: number;
  seconds: number;
  frames: number;
  dropFrame: boolean;
}

export const SUPPORTED_RATES: readonly FrameRate[] = [
  { num: 24000, den: 1001 },
  { num: 24, den: 1 },
  { num: 25, den: 1 },
  { num: 30000, den: 1001 },
  { num: 48, den: 1 },
  { num: 50, den: 1 },
  { num: 60000, den: 1001 },
  { num: 60, den: 1 },
];

const nominalFps = (rate: FrameRate): number => Math.round(rate.num / rate.den);
const isRate = (rate: FrameRate, num: number, den: number): boolean =>
  rate.num === num && rate.den === den;

export const isDropFrameRate = (rate: FrameRate): boolean =>
  isRate(rate, 30000, 1001) || isRate(rate, 60000, 1001);

const dropCount = (rate: FrameRate): number => {
  if (!isDropFrameRate(rate))
    throw errors.validation(
      "Drop-frame timecode is only valid at 29.97 or 59.94 fps.",
    );
  return isRate(rate, 30000, 1001) ? 2 : 4;
};

const validateRate = (rate: FrameRate): void => {
  if (
    !SUPPORTED_RATES.some(
      (candidate) => candidate.num === rate.num && candidate.den === rate.den,
    )
  )
    throw errors.validation("Unsupported frame rate.");
};

export const framesFromTimecode = (tc: Timecode, rate: FrameRate): number => {
  validateRate(rate);
  const nominal = nominalFps(rate);
  if (
    !Number.isInteger(tc.hours) ||
    !Number.isInteger(tc.minutes) ||
    !Number.isInteger(tc.seconds) ||
    !Number.isInteger(tc.frames)
  )
    throw errors.validation("Timecode components must be integers.");
  if (
    tc.minutes < 0 ||
    tc.minutes > 59 ||
    tc.seconds < 0 ||
    tc.seconds > 59 ||
    tc.frames < 0 ||
    tc.frames >= nominal ||
    tc.hours < 0
  )
    throw errors.validation("Timecode component is out of range.");
  const totalMinutes = tc.hours * 60 + tc.minutes;
  if (!tc.dropFrame)
    return (
      (tc.hours * 3600 + tc.minutes * 60 + tc.seconds) * nominal + tc.frames
    );
  const dropped = dropCount(rate);
  if (tc.seconds === 0 && tc.frames < dropped && tc.minutes % 10 !== 0)
    throw errors.validation(
      "Dropped frame labels cannot be used at the start of a drop-frame minute.",
    );
  return (
    (tc.hours * 3600 + tc.minutes * 60 + tc.seconds) * nominal +
    tc.frames -
    dropped * (totalMinutes - Math.floor(totalMinutes / 10))
  );
};

export const timecodeFromFrames = (
  frameIndex: number,
  rate: FrameRate,
  dropFrame = false,
): Timecode => {
  validateRate(rate);
  if (!Number.isInteger(frameIndex) || frameIndex < 0)
    throw errors.validation("Frame index must be a non-negative integer.");
  const nominal = nominalFps(rate);
  if (!dropFrame) {
    const totalSeconds = Math.floor(frameIndex / nominal);
    return {
      hours: Math.floor(totalSeconds / 3600),
      minutes: Math.floor(totalSeconds / 60) % 60,
      seconds: totalSeconds % 60,
      frames: frameIndex % nominal,
      dropFrame: false,
    };
  }
  const dropped = dropCount(rate);
  const framesPerTenMinutes = nominal * 600 - dropped * 9;
  const block = Math.floor(frameIndex / framesPerTenMinutes);
  let remainder = frameIndex % framesPerTenMinutes;
  let minuteInBlock = 0;
  while (minuteInBlock < 10) {
    const minuteFrames =
      minuteInBlock === 0 ? nominal * 60 : nominal * 60 - dropped;
    if (remainder < minuteFrames) break;
    remainder -= minuteFrames;
    minuteInBlock += 1;
  }
  const frameWithinMinute =
    minuteInBlock === 0 ? remainder : remainder + dropped;
  const totalMinutes = block * 10 + minuteInBlock;
  const totalSeconds = Math.floor(frameWithinMinute / nominal);
  return {
    hours: Math.floor(totalMinutes / 60),
    minutes: totalMinutes % 60,
    seconds: totalSeconds,
    frames: frameWithinMinute % nominal,
    dropFrame: true,
  };
};

export const formatTimecode = (tc: Timecode): string => {
  const separator = tc.dropFrame ? ";" : ":";
  return `${String(tc.hours).padStart(2, "0")}:${String(tc.minutes).padStart(2, "0")}:${String(tc.seconds).padStart(2, "0")}${separator}${String(tc.frames).padStart(2, "0")}`;
};

export const parseTimecode = (value: string, rate: FrameRate): Timecode => {
  const match = /^(\d{2,}):(\d{2}):(\d{2})(:|;)(\d{2})$/.exec(value);
  if (!match)
    throw errors.validation("Timecode must use HH:MM:SS:FF or HH:MM:SS;FF.");
  const dropFrame = match[4] === ";";
  if (dropFrame !== isDropFrameRate(rate) && dropFrame)
    throw errors.validation("Drop-frame timecode is invalid at this rate.");
  const tc = {
    hours: Number(match[1]),
    minutes: Number(match[2]),
    seconds: Number(match[3]),
    frames: Number(match[5]),
    dropFrame,
  };
  framesFromTimecode(tc, rate);
  return tc;
};
