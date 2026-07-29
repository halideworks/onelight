import { describe, expect, it } from "vitest";
import { columnsFor, nearEnd, windowSlice } from "./virtual.js";

describe("windowSlice", () => {
  const base = {
    scrollTop: 0,
    viewport: 600,
    total: 3000,
    rowHeight: 200,
    columns: 4,
    overscan: 1,
  };

  it("renders only what is near the viewport", () => {
    const slice = windowSlice(base);
    expect(slice.start).toBe(0);
    /* Three rows visible plus one row of overscan plus the partial row, all
       four wide: far short of 3000. */
    expect(slice.end).toBeLessThanOrEqual(24);
    expect(slice.rows).toBe(750);
  });

  it("keeps the scroll height honest with padding", () => {
    const slice = windowSlice({ ...base, scrollTop: 20_000 });
    const renderedRows = (slice.end - slice.start) / base.columns;
    expect(slice.padTop + renderedRows * base.rowHeight + slice.padBottom).toBe(
      slice.rows * base.rowHeight,
    );
  });

  it("aligns the window to row boundaries so a grid never shifts", () => {
    const slice = windowSlice({ ...base, scrollTop: 350 });
    expect(slice.start % base.columns).toBe(0);
    expect(slice.padTop % base.rowHeight).toBe(0);
  });

  it("clamps at the end of the list", () => {
    const slice = windowSlice({ ...base, scrollTop: 1_000_000 });
    expect(slice.end).toBe(3000);
    expect(slice.padBottom).toBe(0);
    expect(slice.start).toBeLessThanOrEqual(3000);
  });

  it("renders everything rather than nothing when it cannot measure", () => {
    expect(windowSlice({ ...base, rowHeight: 0 })).toMatchObject({
      start: 0,
      end: 3000,
      padTop: 0,
      padBottom: 0,
    });
    expect(windowSlice({ ...base, viewport: 0 }).end).toBe(3000);
  });

  it("handles an empty list and a single column", () => {
    expect(windowSlice({ ...base, total: 0 })).toMatchObject({
      start: 0,
      end: 0,
      rows: 0,
    });
    const list = windowSlice({ ...base, columns: 1, rowHeight: 56 });
    expect(list.start).toBe(0);
    expect(list.end).toBeLessThan(30);
  });

  it("never returns a start past its end", () => {
    for (const scrollTop of [0, 1, 199, 200, 5_000, 149_800, 150_000])
      for (const total of [0, 1, 3, 7, 100, 2999]) {
        const slice = windowSlice({ ...base, scrollTop, total });
        expect(slice.start).toBeLessThanOrEqual(slice.end);
        expect(slice.end).toBeLessThanOrEqual(total);
        expect(slice.padTop).toBeGreaterThanOrEqual(0);
        expect(slice.padBottom).toBeGreaterThanOrEqual(0);
      }
  });
});

describe("columnsFor", () => {
  it("counts the tracks that fit", () => {
    expect(columnsFor(1200, 300)).toBe(4);
    expect(columnsFor(1000, 300)).toBe(3);
    expect(columnsFor(0, 300)).toBe(1);
    expect(columnsFor(1200, 0)).toBe(1);
  });
});

describe("nearEnd", () => {
  it("asks for the next page a viewport early", () => {
    expect(nearEnd(0, 800, 5000)).toBe(false);
    expect(nearEnd(3500, 800, 5000)).toBe(true);
  });
});
