export const PALETTES = [
  "kuwanomi",
  "sakinezu",
  "shinai",
  "yorukou",
  "tetsukon",
  "ebicha",
  "sumimai",
  "yoai",
  "kachitetsu",
  "mokutan",
  "kuro",
  "azuki",
  "sabiasagi",
  "ikkonzome",
  "shikkoku",
  "kesuzumi",
  "nibisumi",
] as const;

export type Palette = (typeof PALETTES)[number];

export const isPalette = (value: string): value is Palette =>
  (PALETTES as readonly string[]).includes(value);
