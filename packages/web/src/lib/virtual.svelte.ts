/* The reactive half of the windowing in virtual.ts: measuring, listening, and
   handing a component the slice it should render.

   Two actions do the work. `container` attaches to the element that holds the
   items and watches whatever actually scrolls (the window, or the element
   itself). `probe` attaches to one rendered item and measures the cell, which
   is the only honest way to know a grid's column count: the tracks are
   auto-fill, so their number is the browser's decision, not the CSS's. */

import { columnsFor, nearEnd, windowSlice } from "./virtual.js";
import type { WindowSlice } from "./virtual.js";

export type VirtualScroller = "window" | "self";

export class Virtual {
  /** Items in the list. The component keeps this up to date. */
  total = $state(0);
  scrollTop = $state(0);
  viewport = $state(0);
  containerWidth = $state(0);
  /** One cell including the gap that follows it. */
  itemWidth = $state(0);
  rowHeight = $state(0);
  /** Raised when the scroller comes within a viewport of the end, for pages
      that keep loading. */
  onEnd: (() => void) | undefined;

  private overscan: number;
  private scroller: VirtualScroller;

  constructor(
    options: {
      scroller?: VirtualScroller;
      overscan?: number;
      onEnd?: () => void;
    } = {},
  ) {
    this.scroller = options.scroller ?? "window";
    this.overscan = options.overscan ?? 3;
    this.onEnd = options.onEnd;
  }

  get columns(): number {
    return columnsFor(this.containerWidth, this.itemWidth);
  }

  get slice(): WindowSlice {
    return windowSlice({
      scrollTop: this.scrollTop,
      viewport: this.viewport,
      total: this.total,
      rowHeight: this.rowHeight,
      columns: this.columns,
      overscan: this.overscan,
    });
  }

  /** Svelte action for the element holding the items. */
  container = (node: HTMLElement) => {
    let frame = 0;
    const measure = (): void => {
      const style = getComputedStyle(node);
      const rowGap = Number.parseFloat(style.rowGap) || 0;
      const columnGap = Number.parseFloat(style.columnGap) || 0;
      this.containerWidth = node.clientWidth;
      const first = node.querySelector<HTMLElement>("[data-virtual-item]");
      if (first && first.offsetHeight > 0) {
        this.itemWidth = first.offsetWidth + columnGap;
        this.rowHeight = first.offsetHeight + rowGap;
      }
    };
    const read = (): void => {
      frame = 0;
      if (this.scroller === "self") {
        this.scrollTop = node.scrollTop;
        this.viewport = node.clientHeight;
      } else {
        const rect = node.getBoundingClientRect();
        /* rect.top is how far the container's top sits below the viewport's;
           once it goes negative that is exactly how far we have scrolled into
           the list. */
        this.scrollTop = Math.max(0, -rect.top);
        this.viewport = window.innerHeight;
      }
      measure();
      if (
        this.onEnd &&
        this.rowHeight > 0 &&
        nearEnd(
          this.scrollTop,
          this.viewport,
          Math.ceil(this.total / this.columns) * this.rowHeight,
        )
      )
        this.onEnd();
    };
    const schedule = (): void => {
      if (frame) return;
      frame = requestAnimationFrame(read);
    };
    const target: EventTarget = this.scroller === "self" ? node : window;
    target.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(node);
    read();
    return {
      destroy: () => {
        if (frame) cancelAnimationFrame(frame);
        target.removeEventListener("scroll", schedule);
        window.removeEventListener("resize", schedule);
        observer.disconnect();
      },
    };
  };

  /** Svelte action for a rendered item, so the first one to appear sizes the
      window. Cheap: it reads two numbers when the node mounts. */
  probe = (node: HTMLElement) => {
    const parent = node.parentElement;
    if (parent && node.offsetHeight > 0) {
      const style = getComputedStyle(parent);
      this.itemWidth =
        node.offsetWidth + (Number.parseFloat(style.columnGap) || 0);
      this.rowHeight =
        node.offsetHeight + (Number.parseFloat(style.rowGap) || 0);
      this.containerWidth = parent.clientWidth;
    }
    return {};
  };
}
