/* Project identity washes, one grammar: vertical, dark anchor at top, light
   terminal at bottom. Stops follow mockups/projects.html where the mockup
   defines the wash. Shared by the project subpages so a project keeps one
   identity everywhere outside the review room. */

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
};

export const washFor = (palette: string | null | undefined): string =>
  WASHES[palette ?? ""] ?? WASHES.sumimai;
