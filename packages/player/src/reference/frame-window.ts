import {
  FRAME_WINDOW_AHEAD,
  FRAME_WINDOW_BEHIND,
  MAX_OPEN_FRAMES,
} from "./protocol.js";

export interface ClosableFrame {
  close(): void;
}

export type WindowFrame<T extends ClosableFrame> = {
  frame: number;
  value: T;
};

export class FrameWindow<T extends ClosableFrame> {
  readonly #frames = new Map<number, T>();
  #target = 0;

  get size(): number {
    return this.#frames.size;
  }

  get target(): number {
    return this.#target;
  }

  get bounds(): { first: number; last: number } {
    return {
      first: Math.max(0, this.#target - FRAME_WINDOW_BEHIND),
      last: this.#target + FRAME_WINDOW_AHEAD,
    };
  }

  setTarget(target: number): void {
    if (!Number.isSafeInteger(target) || target < 0)
      throw new RangeError(
        "Frame-window target must be a non-negative integer.",
      );
    this.#target = target;
    this.#evictOutsideBounds();
  }

  insert(frame: number, value: T): boolean {
    if (!Number.isSafeInteger(frame) || frame < 0) {
      value.close();
      throw new RangeError(
        "Frame-window position must be a non-negative integer.",
      );
    }
    const { first, last } = this.bounds;
    if (frame < first || frame > last) {
      value.close();
      return false;
    }
    const previous = this.#frames.get(frame);
    if (previous && previous !== value) previous.close();
    this.#frames.set(frame, value);
    if (this.#frames.size > MAX_OPEN_FRAMES) {
      this.#frames.delete(frame);
      value.close();
      throw new Error("Frame-window resource cap exceeded.");
    }
    return true;
  }

  has(frame: number): boolean {
    return this.#frames.has(frame);
  }

  ordered(): WindowFrame<T>[] {
    return [...this.#frames]
      .sort(([left], [right]) => left - right)
      .map(([frame, value]) => ({ frame, value }));
  }

  drain(): WindowFrame<T>[] {
    const frames = this.ordered();
    this.#frames.clear();
    return frames;
  }

  clear(): void {
    for (const frame of this.#frames.values()) frame.close();
    this.#frames.clear();
  }

  #evictOutsideBounds(): void {
    const { first, last } = this.bounds;
    for (const [frame, value] of this.#frames)
      if (frame < first || frame > last) {
        this.#frames.delete(frame);
        value.close();
      }
  }
}
