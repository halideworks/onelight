import { describe, expect, it } from "vitest";
import { FrameWindow } from "./frame-window.js";

class TestFrame {
  closes = 0;

  close(): void {
    this.closes += 1;
  }
}

describe("reference frame window", () => {
  it("retains two behind, the target, and three ahead", () => {
    const window = new FrameWindow<TestFrame>();
    window.setTarget(10);
    const frames = Array.from({ length: 10 }, () => new TestFrame());
    for (let frame = 6; frame <= 15; frame += 1)
      window.insert(frame, frames[frame - 6] as TestFrame);

    expect(window.ordered().map((entry) => entry.frame)).toEqual([
      8, 9, 10, 11, 12, 13,
    ]);
    expect(window.size).toBe(6);
    expect(frames[0]?.closes).toBe(1);
    expect(frames[1]?.closes).toBe(1);
    expect(frames[8]?.closes).toBe(1);
    expect(frames[9]?.closes).toBe(1);
  });

  it("closes evicted frames immediately when the target moves", () => {
    const window = new FrameWindow<TestFrame>();
    window.setTarget(4);
    const frames = Array.from({ length: 6 }, () => new TestFrame());
    for (let frame = 2; frame <= 7; frame += 1)
      window.insert(frame, frames[frame - 2] as TestFrame);

    window.setTarget(7);
    expect(window.ordered().map((entry) => entry.frame)).toEqual([5, 6, 7]);
    expect(frames[0]?.closes).toBe(1);
    expect(frames[1]?.closes).toBe(1);
    expect(frames[2]?.closes).toBe(1);
  });

  it("closes replaced, rejected, and cleared resources exactly once", () => {
    const window = new FrameWindow<TestFrame>();
    window.setTarget(20);
    const original = new TestFrame();
    const replacement = new TestFrame();
    const outside = new TestFrame();
    window.insert(20, original);
    window.insert(20, replacement);
    expect(original.closes).toBe(1);
    expect(window.insert(3, outside)).toBe(false);
    expect(outside.closes).toBe(1);
    window.clear();
    expect(replacement.closes).toBe(1);
    expect(window.size).toBe(0);
  });

  it("drains in presentation order without closing transferred frames", () => {
    const window = new FrameWindow<TestFrame>();
    window.setTarget(3);
    const third = new TestFrame();
    const first = new TestFrame();
    window.insert(3, third);
    window.insert(1, first);
    expect(window.drain()).toEqual([
      { frame: 1, value: first },
      { frame: 3, value: third },
    ]);
    expect(first.closes).toBe(0);
    expect(third.closes).toBe(0);
    expect(window.size).toBe(0);
  });

  it("closes a value before rejecting an invalid position", () => {
    const window = new FrameWindow<TestFrame>();
    const frame = new TestFrame();
    expect(() => window.insert(-1, frame)).toThrow(/non-negative/);
    expect(frame.closes).toBe(1);
  });
});
