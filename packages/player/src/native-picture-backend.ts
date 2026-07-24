import { mediaTimeInsideFrame } from "./frame-clock.js";
import type {
  PictureBackend,
  PicturePlaybackRate,
  SourceContract,
} from "./picture-backend.js";
import { configurePlaybackRate } from "./transport-state.js";

type NativeMediaElement = Pick<
  HTMLVideoElement,
  | "addEventListener"
  | "removeEventListener"
  | "currentSrc"
  | "currentTime"
  | "load"
  | "pause"
  | "play"
  | "playbackRate"
  | "preservesPitch"
  | "readyState"
  | "src"
>;

export type NativePictureBackendOptions = {
  element: () => NativeMediaElement | null;
  loadTimeoutMs?: number;
  onPlayRejected?: (reason: unknown) => void;
};

export class NativePictureBackend implements PictureBackend {
  readonly #element: () => NativeMediaElement | null;
  readonly #loadTimeoutMs: number;
  readonly #onPlayRejected: ((reason: unknown) => void) | undefined;
  #source: SourceContract | null = null;
  #generation = 0;

  constructor(options: NativePictureBackendOptions) {
    this.#element = options.element;
    this.#loadTimeoutMs = options.loadTimeoutMs ?? 10_000;
    this.#onPlayRejected = options.onPlayRejected;
  }

  async load(source: SourceContract, frame: number): Promise<void> {
    const element = this.#element();
    if (!element) throw new Error("Native video element is unavailable.");
    const generation = ++this.#generation;
    this.#source = source;
    if (element.currentSrc !== source.url && element.src !== source.url) {
      element.src = source.url;
      element.load();
    }
    if (element.readyState === 0)
      await this.#waitForMetadata(element, generation);
    if (generation !== this.#generation) return;
    this.seek(frame);
  }

  seek(frame: number): void {
    const element = this.#element();
    const source = this.#source;
    if (!element || !source || element.readyState === 0) return;
    const bounded = Math.max(0, Math.round(frame));
    element.currentTime = mediaTimeInsideFrame(
      bounded,
      source.expected.frameRate,
    );
  }

  play(frame: number, rate: PicturePlaybackRate): void {
    const element = this.#element();
    if (!element) return;
    this.seek(frame);
    configurePlaybackRate(element, rate, rate === 1);
    void element.play().catch((reason: unknown) => {
      this.#onPlayRejected?.(reason);
    });
  }

  pause(): void {
    const element = this.#element();
    if (!element) return;
    element.pause();
    configurePlaybackRate(element, 1, true);
  }

  close(): void {
    this.#generation += 1;
    this.pause();
    this.#source = null;
  }

  #waitForMetadata(
    element: NativeMediaElement,
    generation: number,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        element.removeEventListener("loadedmetadata", loaded);
        element.removeEventListener("error", failed);
      };
      const loaded = (): void => {
        cleanup();
        resolve();
      };
      const failed = (): void => {
        cleanup();
        reject(new Error("Native video metadata failed to load."));
      };
      const timer = setTimeout(() => {
        cleanup();
        if (generation === this.#generation)
          reject(new Error("Native video metadata timed out."));
        else resolve();
      }, this.#loadTimeoutMs);
      element.addEventListener("loadedmetadata", loaded, { once: true });
      element.addEventListener("error", failed, { once: true });
    });
  }
}
