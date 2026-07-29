/* Windowing for lists that can hold a whole shoot.

   Three surfaces in this app can reach thousands of rows at once: the upload
   queue when a folder of 3000 stills is dropped on it, the asset browser, and
   a share room built from the same delivery. Rendering all of them is not slow,
   it is fatal: every card carries a picture element, and the queue also carries
   an object URL per row, so the tab runs out of memory long before anyone
   scrolls.

   The maths is separated from the DOM on purpose. Everything below is pure and
   tested; the components own the measuring and the scroll listener. */

export interface WindowInput {
  /** How far the scroller has travelled past the top of the list. */
  scrollTop: number;
  /** Visible height to fill. */
  viewport: number;
  /** Items in the list. */
  total: number;
  /** Height of one row, including any gap below it. */
  rowHeight: number;
  /** Items per row; 1 for a list, measured for a grid. */
  columns: number;
  /** Extra rows rendered above and below, so a fast scroll does not show
      blank space before the next frame lands. */
  overscan?: number;
}

export interface WindowSlice {
  /** First item index to render. */
  start: number;
  /** One past the last item index to render. */
  end: number;
  /** Pixels of empty space standing in for the rows above `start`. */
  padTop: number;
  /** Pixels of empty space standing in for the rows below `end`. */
  padBottom: number;
  /** Total rows the list would occupy, for anyone who wants the full height. */
  rows: number;
}

const DEFAULT_OVERSCAN = 3;

/** The slice of a uniform grid or list that is worth having in the DOM.

    Degenerate inputs (a container not laid out yet, an unmeasurable row) fall
    back to rendering everything, because a wrong window shows an empty page
    and no window merely shows a slow one. */
export const windowSlice = (input: WindowInput): WindowSlice => {
  const total = Math.max(0, Math.floor(input.total));
  const columns = Math.max(1, Math.floor(input.columns));
  const rows = Math.ceil(total / columns);
  if (!(input.rowHeight > 0) || !(input.viewport > 0))
    return { start: 0, end: total, padTop: 0, padBottom: 0, rows };
  const overscan = Math.max(0, input.overscan ?? DEFAULT_OVERSCAN);
  const scrollTop = Math.max(0, input.scrollTop);
  const firstRow = Math.max(
    0,
    Math.floor(scrollTop / input.rowHeight) - overscan,
  );
  const visibleRows = Math.ceil(input.viewport / input.rowHeight);
  const lastRow = Math.min(
    rows,
    Math.floor(scrollTop / input.rowHeight) + visibleRows + overscan + 1,
  );
  const start = Math.min(total, firstRow * columns);
  const end = Math.min(total, lastRow * columns);
  return {
    start,
    end,
    padTop: firstRow * input.rowHeight,
    padBottom: Math.max(0, (rows - lastRow) * input.rowHeight),
    rows,
  };
};

/** Columns that fit, given the space and one item's width including its gap.
    Measured rather than derived from the CSS: the grid is auto-fill with a
    minmax track, so only the browser knows what it settled on. */
export const columnsFor = (
  containerWidth: number,
  itemWidth: number,
): number => {
  if (!(containerWidth > 0) || !(itemWidth > 0)) return 1;
  return Math.max(1, Math.round(containerWidth / itemWidth));
};

/** Whether a scroller is close enough to the end to ask for the next page.
    One viewport of runway, so the fetch is in flight before the user arrives. */
export const nearEnd = (
  scrollTop: number,
  viewport: number,
  contentHeight: number,
): boolean => scrollTop + viewport * 2 >= contentHeight;
