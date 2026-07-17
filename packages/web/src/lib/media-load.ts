/* Svelte action: mark a media element once its pixels actually exist, so
   CSS can ease the picture in instead of letting the browser flash
   progressive scan passes and half-decoded frames at the viewer.

   Usage:
     <img use:arrives ... />
     img { opacity: 0; }
     img[data-arrived] { opacity: 1; transition: opacity 280ms ease; }

   The transition lives on the arrived state, not the base, so removal (a
   src swap resetting the attribute) snaps instantly rather than fading
   out. Cached images can be complete before the action attaches, which is
   the case the load event alone misses. */
export function arrives(node: HTMLImageElement | HTMLVideoElement): {
  destroy: () => void;
} {
  const ready = (): void => {
    node.setAttribute("data-arrived", "");
  };
  if (node instanceof HTMLImageElement) {
    if (node.complete && node.naturalWidth > 0) {
      ready();
      return { destroy: (): void => {} };
    }
    node.addEventListener("load", ready, { once: true });
    return { destroy: (): void => node.removeEventListener("load", ready) };
  }
  if (node.readyState >= 2) {
    ready();
    return { destroy: (): void => {} };
  }
  node.addEventListener("loadeddata", ready, { once: true });
  return {
    destroy: (): void => node.removeEventListener("loadeddata", ready),
  };
}
