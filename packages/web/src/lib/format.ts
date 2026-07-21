/* Presentation helpers shared by the dashboard surfaces. Times render in the
   viewer's local timezone: relative text for recent instants, with the
   absolute form supplied through a title attribute (design doc 24.5). */

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const ABSOLUTE = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const STEPS: Array<{ unit: Intl.RelativeTimeFormatUnit; ms: number }> = [
  { unit: "year", ms: 31_536_000_000 },
  { unit: "month", ms: 2_592_000_000 },
  { unit: "week", ms: 604_800_000 },
  { unit: "day", ms: 86_400_000 },
  { unit: "hour", ms: 3_600_000 },
  { unit: "minute", ms: 60_000 },
];

/* A missing or nonsense stamp renders as nothing rather than throwing:
   Intl.DateTimeFormat raises on a non-finite value, and one absent field on
   one row used to take the whole page down with it. */
const usable = (epochMs: number): boolean =>
  typeof epochMs === "number" && Number.isFinite(epochMs);

export const whenRelative = (epochMs: number): string => {
  if (!usable(epochMs)) return "";
  const delta = epochMs - Date.now();
  for (const step of STEPS) {
    if (Math.abs(delta) >= step.ms)
      return RELATIVE.format(Math.trunc(delta / step.ms), step.unit);
  }
  return "just now";
};

export const whenAbsolute = (epochMs: number): string =>
  usable(epochMs) ? ABSOLUTE.format(new Date(epochMs)) : "";

export const excerpt = (text: string, max = 140): string =>
  text.length <= max ? text : `${text.slice(0, max - 3).trimEnd()}...`;
