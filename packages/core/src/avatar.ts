import { PALETTES, type Palette } from "./palettes.js";

export type GeneratedAvatar = {
  initial: string;
  palette: Palette;
};

/* One generated identity for every surface that represents a person. Registered
   users are keyed by id and name, while public viewers have only their display
   name. This preserves the existing avatar assignment while letting smaller
   surfaces, such as timeline blips, render the same face. */
export const generatedAvatarFor = (
  name: string,
  id: string | null = null,
): GeneratedAvatar => {
  const seed = `${id ?? ""}:${name}`;
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return {
    initial: [...name.trim()][0]?.toUpperCase() ?? "?",
    palette: PALETTES[(hash >>> 0) % PALETTES.length] ?? "sumimai",
  };
};
