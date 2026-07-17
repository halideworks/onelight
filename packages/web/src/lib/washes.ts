import { grainLayer } from "./grain.js";

/* Project identity washes, one grammar: vertical, dark anchor at top, light
   terminal at bottom. Stops follow mockups/projects.html where the mockup
   defines the wash. Shared by the project subpages so a project keeps one
   identity everywhere outside the review room. Page-scale washes carry the
   grain tile as their top layer (see pageWashFromStops): the ramps are long
   and subtle, and without a little noise they band. Swatch-scale washes
   (covers, avatars) stay clean; at their size banding cannot form. */

export const WASHES: Record<string, string> = {
  kuwanomi:
    "linear-gradient(180deg, #3d1c2a 0%, var(--kuwanomi-a) 34%, #5a7ba0 76%, var(--kuwanomi-b) 112%)",
  sakinezu:
    "linear-gradient(180deg, var(--sakinezu-b) 0%, var(--sakinezu-a) 70%, #55696a 110%)",
  shinai:
    "linear-gradient(180deg, var(--shinai-a) 0%, var(--shinai-m) 55%, var(--shinai-b) 105%)",
  yorukou:
    "linear-gradient(180deg, var(--yorukou-a) 0%, var(--yorukou-m) 62%, var(--yorukou-b) 108%)",
  tetsukon:
    "linear-gradient(180deg, #16283a 0%, var(--tetsukon-a) 40%, var(--tetsukon-m) 78%, var(--tetsukon-b) 116%)",
  ebicha:
    "linear-gradient(180deg, var(--ebicha-a) 0%, var(--ebicha-m) 55%, var(--ebicha-b) 108%)",
  sumimai:
    "linear-gradient(180deg, var(--sumimai-a) 0%, var(--sumimai-m) 58%, var(--sumimai-b) 108%)",
  yoai: "linear-gradient(180deg, var(--yoai-a) 0%, var(--yoai-m) 55%, var(--yoai-b) 105%)",
  kachitetsu:
    "linear-gradient(180deg, var(--kachitetsu-a) 0%, var(--kachitetsu-m) 55%, var(--kachitetsu-b) 105%)",
  mokutan:
    "linear-gradient(180deg, var(--mokutan-a) 0%, var(--mokutan-m) 55%, var(--mokutan-b) 105%)",
  kuro: "linear-gradient(180deg, var(--kuro-a) 0%, var(--kuro-m) 58%, var(--kuro-b) 108%)",
  azuki:
    "linear-gradient(180deg, var(--azuki-a) 0%, var(--azuki-m) 60%, var(--azuki-b) 110%)",
  sabiasagi:
    "linear-gradient(180deg, var(--sabiasagi-a) 0%, var(--sabiasagi-m) 55%, var(--sabiasagi-b) 105%)",
  ikkonzome:
    "linear-gradient(180deg, var(--ikkonzome-a) 0%, var(--ikkonzome-m) 55%, var(--ikkonzome-b) 108%)",
  shikkoku:
    "linear-gradient(180deg, var(--shikkoku-a) 0%, var(--shikkoku-m) 62%, var(--shikkoku-b) 115%)",
  kesuzumi:
    "linear-gradient(180deg, var(--kesuzumi-a) 0%, var(--kesuzumi-m) 55%, var(--kesuzumi-b) 105%)",
  nibisumi:
    "linear-gradient(180deg, var(--nibisumi-a) 0%, var(--nibisumi-m) 58%, var(--nibisumi-b) 108%)",
};

export const washFor = (palette: string | null | undefined): string =>
  WASHES[palette ?? ""] ?? WASHES.sumimai;

/* The same identity, as a page rather than a swatch.
 *
 * Every wash above ends on a light stop -- tan, cream, pale blue -- because it
 * was drawn to fill a card 104px tall, where that terminal is a highlight. Run
 * down a 1000px page it stops being a highlight and becomes most of the screen:
 * the mid tone smears through the middle and the page ends in dirty cream with
 * light text sitting on it. That is the dinginess. It is not the colours, which
 * are the point; it is the distance they were being stretched over.
 *
 * So the page keeps the top of its wash -- the part that says which project you
 * are in -- and resolves into the app's ink within the first screenful. Panels
 * then sit on ink, at one value step, everywhere: the wash stops competing with
 * the content and goes back to being a wash. The stop percentages are shared,
 * so every page in the app resolves at the same height and they finally match.
 */
const PAGE_TOPS: Record<string, [string, string]> = {
  kuwanomi: ["#3d1c2a", "var(--kuwanomi-a)"],
  sakinezu: ["var(--sakinezu-b)", "var(--sakinezu-a)"],
  shinai: ["var(--shinai-a)", "var(--shinai-m)"],
  yorukou: ["var(--yorukou-a)", "var(--yorukou-m)"],
  tetsukon: ["#16283a", "var(--tetsukon-a)"],
  ebicha: ["var(--ebicha-a)", "var(--ebicha-m)"],
  sumimai: ["var(--sumimai-a)", "var(--sumimai-m)"],
  yoai: ["var(--yoai-a)", "var(--yoai-m)"],
  kachitetsu: ["var(--kachitetsu-a)", "var(--kachitetsu-m)"],
  mokutan: ["var(--mokutan-a)", "var(--mokutan-m)"],
  kuro: ["var(--kuro-a)", "var(--kuro-m)"],
  azuki: ["var(--azuki-a)", "var(--azuki-m)"],
  sabiasagi: ["var(--sabiasagi-a)", "var(--sabiasagi-m)"],
  ikkonzome: ["var(--ikkonzome-a)", "var(--ikkonzome-m)"],
  shikkoku: ["var(--shikkoku-a)", "var(--shikkoku-m)"],
  kesuzumi: ["var(--kesuzumi-a)", "var(--kesuzumi-m)"],
  nibisumi: ["var(--nibisumi-a)", "var(--nibisumi-m)"],
};

export const pageWashFor = (palette: string | null | undefined): string => {
  const [anchor, mid] = PAGE_TOPS[palette ?? ""] ?? PAGE_TOPS.sumimai;
  return pageWashFromStops(anchor, mid);
};

/* The same grammar from any two colours: a dark anchor and a mid tone,
   resolving into ink at the same heights as every library wash. This is what
   a share's custom brand colours run through, so a client-designed room still
   reads as this app rather than as two raw hexes stretched down a page. */
export const pageWashFromStops = (anchor: string, mid: string): string =>
  [
    `${grainLayer},`,
    "linear-gradient(180deg,",
    `color-mix(in oklab, ${anchor} 88%, var(--ink-000)) 0px,`,
    /* The colour peaks around the header, where the page's name is, and is
       gone by the time the content starts. */
    `color-mix(in oklab, ${mid} 42%, var(--ink-000)) 190px,`,
    `color-mix(in oklab, ${mid} 12%, var(--ink-000)) 380px,`,
    "var(--ink-000) 640px)",
  ].join(" ");
