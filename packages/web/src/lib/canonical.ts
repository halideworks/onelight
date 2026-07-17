import { replaceState } from "$app/navigation";
import { page } from "$app/state";

/* Every entity page rewrites its address to the pretty form once its data
   arrives: a link that came in as a bare ULID, an old-format id, or a stale
   name leaves the address bar reading name-first with the short public id.
   History is replaced, not pushed, so Back still leaves the page. */
export const canonicalizePath = (path: string): void => {
  if (typeof window === "undefined") return;
  if (page.url.pathname === path) return;
  try {
    replaceState(`${path}${page.url.search}${page.url.hash}`, page.state);
  } catch {
    /* The router is not ready during the very first tick; the address is
       cosmetic, so losing one rewrite costs nothing. */
  }
};
