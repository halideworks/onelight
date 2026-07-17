/* Grain for the page washes. Long subtle ramps band on 8-bit panels; a
   whisper of noise breaks the contours.

   This is SVG turbulence rather than a bitmap tile on purpose: the browser
   rasterizes SVG backgrounds at the device's pixel ratio, so the grain
   stays at true pixel scale on every display instead of upscaling into
   visible chunks, and stitchTiles makes the 256px tile seamless. The rect
   opacity is the entire strength control; keep it low enough that the
   grain is felt, never seen. */
const GRAIN_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">',
  '<filter id="g" x="0" y="0" width="100%" height="100%">',
  '<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" seed="5"/>',
  '<feColorMatrix type="saturate" values="0"/>',
  "</filter>",
  '<rect width="256" height="256" filter="url(#g)" opacity="0.055"/>',
  "</svg>",
].join("");

export const grainLayer = `url("data:image/svg+xml,${encodeURIComponent(GRAIN_SVG)}")`;
