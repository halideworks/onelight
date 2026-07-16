/* Which /s/ requests the SPA shell answers.
 *
 * The share landing page is the only route packages/web has under /s/, and it
 * is one segment deep. Every deeper /s/ path is an API endpoint.
 *
 * The distinction cannot be drawn on the Accept header, which is what this
 * used to do. A viewer downloading an asset navigates the top level to
 * /s/:slug/assets/:id/media/file (window.location.assign), and a top-level
 * navigation sends Accept: text/html exactly like a page load: the shell would
 * answer, its router has no route for that path, and the download lands on a
 * 404. The same file plays fine in the player, because a video element and
 * fetch both send a wildcard Accept, reach the API, and never touch this
 * middleware. That asymmetry is the whole bug, so match the shape of the path
 * instead of the header.
 */
export const isShareLandingPath = (pathname: string): boolean =>
  /^\/s\/[^/]+\/?$/.test(pathname);
