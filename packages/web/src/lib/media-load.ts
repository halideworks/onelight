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
   the case the load event alone misses.

   A failed load (a 404 poster, an unfinished proxy) fires `error`, never
   `load`/`loadeddata`. Without handling it the element stays pinned at
   opacity:0 -- a permanent invisible blank. On error the element is revealed
   anyway (so it is never stuck) and marked data-failed, which the container
   can style to hide the broken glyph in favour of its own background. */
export function arrives(node: HTMLImageElement | HTMLVideoElement): {
  destroy: () => void;
} {
  const ready = (): void => {
    node.setAttribute("data-arrived", "");
  };
  const failed = (): void => {
    node.setAttribute("data-arrived", "");
    node.setAttribute("data-failed", "");
  };
  if (node instanceof HTMLImageElement) {
    if (node.complete && node.naturalWidth > 0) {
      ready();
      return { destroy: (): void => {} };
    }
    node.addEventListener("load", ready, { once: true });
    node.addEventListener("error", failed, { once: true });
    return {
      destroy: (): void => {
        node.removeEventListener("load", ready);
        node.removeEventListener("error", failed);
      },
    };
  }
  if (node.readyState >= 2) {
    ready();
    return { destroy: (): void => {} };
  }
  node.addEventListener("loadeddata", ready, { once: true });
  node.addEventListener("error", failed, { once: true });
  return {
    destroy: (): void => {
      node.removeEventListener("loadeddata", ready);
      node.removeEventListener("error", failed);
    },
  };
}
