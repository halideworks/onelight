import {
  boundedReferenceReason,
  classifyReferenceFailure,
  type PictureBackend,
  type PicturePlaybackRate,
  type ReferenceBackendCallbacks,
  type SourceContract,
} from "../picture-backend.js";
import {
  FRAME_WINDOW_AHEAD,
  FRAME_WINDOW_BEHIND,
  MAX_OPEN_FRAMES,
  type DecodedTrack,
  type DecoderCommand,
  type DecoderEvent,
  type PlaneTransfer,
} from "./protocol.js";

type WorkerLike = Pick<
  Worker,
  "postMessage" | "terminate" | "onmessage" | "onerror" | "onmessageerror"
>;

export type ReferenceBackendOptions = {
  workerFactory?: () => WorkerLike;
  openTimeoutMs?: number;
  starvationMs?: number;
  seekTimeoutMs?: number;
};

type LoadWaiter = {
  generation: number;
  timer: ReturnType<typeof setTimeout>;
  resolve(): void;
  reject(reason: Error): void;
};

const cloneSourceContract = (source: SourceContract): SourceContract => ({
  url:
    typeof document === "undefined"
      ? source.url
      : new URL(source.url, document.baseURI).href,
  expected: {
    frameRate: {
      num: source.expected.frameRate.num,
      den: source.expected.frameRate.den,
    },
    durationFrames: source.expected.durationFrames,
    codedWidth: source.expected.codedWidth,
    codedHeight: source.expected.codedHeight,
    codec: source.expected.codec,
    outputColor: {
      primaries: source.expected.outputColor.primaries,
      transfer: source.expected.outputColor.transfer,
      matrix: source.expected.outputColor.matrix,
      range: source.expected.outputColor.range,
    },
    outputChromaLocation: source.expected.outputChromaLocation,
  },
});

const defaultWorkerFactory = (): Worker =>
  new Worker(new URL("./decoder.worker.js", import.meta.url), {
    type: "module",
    name: "onelight-reference-decoder",
  });

export class ReferencePictureBackend implements PictureBackend {
  readonly #callbacks: ReferenceBackendCallbacks;
  readonly #workerFactory: () => WorkerLike;
  readonly #openTimeoutMs: number;
  readonly #starvationMs: number;
  readonly #seekTimeoutMs: number;
  readonly #frames = new Map<number, PlaneTransfer>();
  #worker: WorkerLike | null = null;
  #track: DecodedTrack | null = null;
  #generation = 0;
  #desiredFrame = 0;
  #playing = false;
  #rate: PicturePlaybackRate = 1;
  #windowPending = false;
  #windowTarget: number | null = null;
  #scrubbing = false;
  #loadWaiter: LoadWaiter | null = null;
  #openStage = "starting decoder worker";
  #starvationTimer: ReturnType<typeof setTimeout> | null = null;
  #seekTimer: ReturnType<typeof setTimeout> | null = null;
  #failed = false;
  #presentedPlanes: PlaneTransfer | null = null;
  #presentedFrame: number | null = null;

  constructor(
    callbacks: ReferenceBackendCallbacks,
    options: ReferenceBackendOptions = {},
  ) {
    this.#callbacks = callbacks;
    this.#workerFactory = options.workerFactory ?? defaultWorkerFactory;
    this.#openTimeoutMs = options.openTimeoutMs ?? 5_000;
    this.#starvationMs = options.starvationMs ?? 900;
    this.#seekTimeoutMs = options.seekTimeoutMs ?? 5_000;
  }

  get bufferedFrames(): readonly number[] {
    return [...this.#frames.keys()].sort((left, right) => left - right);
  }

  get track(): DecodedTrack | null {
    return this.#track;
  }

  async waitUntilBuffered(
    frame: number,
    minimumFrames = FRAME_WINDOW_AHEAD + 1,
    timeoutMs = 1_000,
  ): Promise<void> {
    const duration = this.#track?.durationFrames;
    const first = Math.max(0, Math.round(frame));
    const available =
      duration === null || duration === undefined
        ? minimumFrames
        : Math.min(minimumFrames, Math.max(1, duration - first));
    const deadline = performance.now() + timeoutMs;
    while (
      this.bufferedFrames.filter((candidate) => candidate >= first).length <
      available
    ) {
      if (this.#failed)
        throw new Error("Reference decoder failed during initial buffering.");
      if (performance.now() >= deadline)
        throw new Error(
          `Reference decoder did not buffer ${String(available)} initial frames in time.`,
        );
      await new Promise<void>((resolve) => setTimeout(resolve, 8));
    }
  }

  async load(source: SourceContract, frame: number): Promise<void> {
    this.close();
    this.#failed = false;
    this.#presentedPlanes = null;
    this.#presentedFrame = null;
    this.#openStage = "starting decoder worker";
    const transferableSource = cloneSourceContract(source);
    this.#desiredFrame = frame;
    const worker = this.#workerFactory();
    this.#worker = worker;
    worker.onmessage = (event: MessageEvent<DecoderEvent>): void => {
      this.#handleEvent(event.data);
    };
    worker.onerror = (event: ErrorEvent): void => {
      this.#fail(event.message || "Reference decoder worker failed.", false);
    };
    worker.onmessageerror = (): void => {
      this.#fail(
        "Reference decoder worker returned an invalid message.",
        false,
      );
    };
    const generation = this.#nextGeneration();
    const opened = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#loadWaiter?.generation !== generation) return;
        this.#fail(
          `Reference decoder source open timed out while ${this.#openStage}.`,
          false,
        );
      }, this.#openTimeoutMs);
      this.#loadWaiter = { generation, timer, resolve, reject };
    });
    this.#post({
      type: "open",
      generation,
      url: transferableSource.url,
      expected: transferableSource.expected,
      hardwareAcceleration: "no-preference",
    });
    await opened;
    if (!this.#failed) this.seek(frame);
  }

  seek(frame: number, discontinuity = false): void {
    if (this.#failed || !this.#worker || !this.#track) return;
    const duration = this.#track.durationFrames;
    this.#desiredFrame =
      duration === null
        ? Math.max(0, Math.round(frame))
        : Math.min(duration - 1, Math.max(0, Math.round(frame)));
    if (discontinuity && !this.#scrubbing) this.#presentedFrame = null;
    const cached = this.#frames.get(this.#desiredFrame);
    if (cached) {
      this.#present(this.#desiredFrame, cached);
      this.#prefetchIfNeeded();
      return;
    }
    if (this.#scrubbing) {
      this.#presentNearestScrubFrame();
      if (!this.#windowPending)
        this.#requestWindow(this.#desiredFrame, "scrub");
      return;
    }
    if (
      !this.#windowPending ||
      this.#windowTarget === null ||
      discontinuity ||
      (!this.#playing &&
        Math.abs(this.#windowTarget - this.#desiredFrame) > FRAME_WINDOW_AHEAD)
    )
      this.#requestWindow(this.#desiredFrame, this.#playing ? "play" : "seek");
    this.#armStarvation();
  }

  beginScrub(): void {
    if (this.#failed) return;
    this.#scrubbing = true;
    this.#playing = false;
    this.#clearStarvation();
  }

  endScrub(): void {
    if (!this.#scrubbing) return;
    this.#scrubbing = false;
    if (this.#failed || !this.#worker || !this.#track) return;
    const cached = this.#frames.get(this.#desiredFrame);
    if (cached) {
      this.#present(this.#desiredFrame, cached);
      return;
    }
    if (!this.#windowPending || this.#windowTarget !== this.#desiredFrame)
      this.#requestWindow(this.#desiredFrame, "seek");
  }

  play(frame: number, rate: PicturePlaybackRate): void {
    this.#scrubbing = false;
    this.#playing = true;
    this.#rate = rate;
    this.seek(frame);
  }

  pause(): void {
    this.#playing = false;
    this.#clearStarvation();
    if (this.#scrubbing) return;
    this.#presentedPlanes = null;
    this.#presentedFrame = null;
    this.#clearSeekTimer();
    if (!this.#worker) return;
    this.#post({ type: "pause", generation: this.#nextGeneration() });
    this.#windowPending = false;
    this.#windowTarget = null;
  }

  close(): void {
    this.#clearStarvation();
    this.#clearSeekTimer();
    if (this.#loadWaiter) {
      clearTimeout(this.#loadWaiter.timer);
      this.#loadWaiter.reject(new Error("Reference source was closed."));
    }
    this.#loadWaiter = null;
    const worker = this.#worker;
    this.#worker = null;
    if (worker) {
      worker.postMessage({
        type: "close",
        generation: this.#nextGeneration(),
      } satisfies DecoderCommand);
      worker.terminate();
    }
    this.#track = null;
    this.#frames.clear();
    this.#windowPending = false;
    this.#windowTarget = null;
    this.#playing = false;
    this.#scrubbing = false;
  }

  #nextGeneration(): number {
    this.#generation += 1;
    return this.#generation;
  }

  #post(command: DecoderCommand): void {
    this.#worker?.postMessage(command);
  }

  #requestWindow(frame: number, type: "seek" | "play" | "scrub"): void {
    if (!this.#worker) return;
    const generation = this.#nextGeneration();
    this.#windowPending = true;
    this.#windowTarget = frame;
    this.#clearSeekTimer();
    this.#seekTimer = setTimeout(() => {
      this.#seekTimer = null;
      if (generation === this.#generation && !this.#frames.has(frame))
        this.#fail(
          `Reference decode stalled before frame ${String(frame)}.`,
          false,
        );
    }, this.#seekTimeoutMs);
    this.#post({
      type,
      generation,
      frame,
      ...(type === "play" ? { rate: this.#rate } : {}),
    } as DecoderCommand);
  }

  #handleEvent(event: DecoderEvent): void {
    if (this.#failed) return;
    if (event.type === "opening") {
      if (event.generation === this.#loadWaiter?.generation)
        this.#openStage = event.detail
          ? `${event.stage} (${event.detail})`
          : event.stage;
      return;
    }
    if (event.type === "ready") {
      const waiter = this.#loadWaiter;
      if (!waiter || event.generation !== waiter.generation) return;
      clearTimeout(waiter.timer);
      this.#track = event.track;
      this.#loadWaiter = null;
      this.#callbacks.onReady?.(event.track);
      waiter.resolve();
      return;
    }
    if (event.generation !== this.#generation) {
      if (event.type === "frame") this.#releasePlane(event.planes);
      return;
    }
    if (event.type === "frame") {
      const previous = this.#frames.get(event.frame);
      if (previous && previous !== event.planes) this.#releasePlane(previous);
      this.#frames.set(event.frame, event.planes);
      if (event.frame === this.#desiredFrame) {
        this.#present(event.frame, event.planes, true);
        this.#clearSeekTimer();
        this.#clearStarvation();
      } else if (
        this.#playing &&
        event.frame <= this.#desiredFrame &&
        (this.#presentedFrame === null || event.frame > this.#presentedFrame)
      ) {
        this.#present(event.frame, event.planes, true);
        this.#clearStarvation();
      } else this.#trimFrames();
      return;
    }
    if (event.type === "window") {
      this.#windowPending = false;
      this.#windowTarget = null;
      this.#clearSeekTimer();
      const candidate = this.#presentationCandidate();
      if (candidate) {
        this.#present(candidate.frame, candidate.planes);
        this.#clearStarvation();
      } else {
        this.#armStarvation();
      }
      if (this.#scrubbing && !this.#frames.has(this.#desiredFrame))
        this.#requestWindow(this.#desiredFrame, "scrub");
      return;
    }
    if (event.type === "stalled") {
      this.#windowPending = false;
      this.#windowTarget = null;
      this.#armStarvation();
      return;
    }
    this.#fail(event.reason, event.type === "unsupported");
  }

  #present(
    frame: number,
    planes: PlaneTransfer,
    trimAfterRender = false,
  ): void {
    if (this.#presentedPlanes === planes) {
      if (trimAfterRender) this.#trimFrames();
      return;
    }
    try {
      this.#callbacks.render(planes, frame);
      this.#presentedPlanes = planes;
      this.#presentedFrame = frame;
      if (trimAfterRender) this.#trimFrames();
      this.#callbacks.onFrame?.(frame);
    } catch (error) {
      this.#fail(boundedReferenceReason(error), false);
    }
  }

  #prefetchIfNeeded(): void {
    if (!this.#playing || this.#windowPending || !this.#track) return;
    const buffered = this.bufferedFrames;
    const last = buffered.at(-1);
    if (last === undefined || this.#desiredFrame < last - 1) return;
    const duration = this.#track.durationFrames;
    const target =
      duration === null
        ? last + FRAME_WINDOW_BEHIND + 1
        : Math.min(duration - 1, last + FRAME_WINDOW_BEHIND + 1);
    if (target > this.#desiredFrame) this.#requestWindow(target, "play");
  }

  #presentationCandidate(): {
    frame: number;
    planes: PlaneTransfer;
  } | null {
    const exact = this.#frames.get(this.#desiredFrame);
    if (exact) return { frame: this.#desiredFrame, planes: exact };
    if (this.#scrubbing) {
      const frame = this.#nearestBufferedFrame();
      const planes = frame === null ? undefined : this.#frames.get(frame);
      return frame !== null && planes ? { frame, planes } : null;
    }
    if (!this.#playing) return null;
    const frame = this.bufferedFrames
      .filter(
        (candidate) =>
          candidate <= this.#desiredFrame &&
          (this.#presentedFrame === null || candidate > this.#presentedFrame),
      )
      .at(-1);
    if (frame === undefined) return null;
    const planes = this.#frames.get(frame);
    return planes ? { frame, planes } : null;
  }

  #nearestBufferedFrame(): number | null {
    let nearest: number | null = null;
    let distance = Number.POSITIVE_INFINITY;
    for (const frame of this.#frames.keys()) {
      const candidateDistance = Math.abs(frame - this.#desiredFrame);
      if (candidateDistance < distance) {
        nearest = frame;
        distance = candidateDistance;
      }
    }
    return nearest;
  }

  #presentNearestScrubFrame(): void {
    const frame = this.#nearestBufferedFrame();
    if (frame === null) return;
    const planes = this.#frames.get(frame);
    if (planes) this.#present(frame, planes);
  }

  #trimFrames(): void {
    const ordered = [...this.bufferedFrames];
    while (ordered.length > MAX_OPEN_FRAMES) {
      const oldestBehind = ordered.findIndex(
        (frame) => frame < this.#desiredFrame,
      );
      const remove = this.#playing
        ? oldestBehind >= 0
          ? ordered.splice(oldestBehind, 1)[0]
          : ordered.pop()
        : Math.abs((ordered[0] ?? 0) - this.#desiredFrame) >
            Math.abs((ordered.at(-1) ?? 0) - this.#desiredFrame)
          ? ordered.shift()
          : ordered.pop();
      if (remove !== undefined) {
        const removed = this.#frames.get(remove);
        this.#frames.delete(remove);
        if (removed) this.#releasePlane(removed);
      }
    }
  }

  #releasePlane(planes: PlaneTransfer): void {
    if (!this.#worker || planes.buffer.byteLength === 0) return;
    this.#worker.postMessage(
      {
        type: "release",
        generation: this.#generation,
        buffer: planes.buffer,
      } satisfies DecoderCommand,
      [planes.buffer],
    );
  }

  #armStarvation(): void {
    if (!this.#playing || this.#starvationTimer !== null || this.#failed)
      return;
    this.#starvationTimer = setTimeout(() => {
      this.#starvationTimer = null;
      if (!this.#frames.has(this.#desiredFrame))
        this.#fail(
          `Reference decode starved before frame ${String(this.#desiredFrame)}.`,
          false,
        );
    }, this.#starvationMs);
  }

  #clearStarvation(): void {
    if (this.#starvationTimer !== null) {
      clearTimeout(this.#starvationTimer);
      this.#starvationTimer = null;
    }
  }

  #clearSeekTimer(): void {
    if (this.#seekTimer !== null) {
      clearTimeout(this.#seekTimer);
      this.#seekTimer = null;
    }
  }

  #fail(reason: unknown, unsupported: boolean): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#clearStarvation();
    this.#clearSeekTimer();
    const bounded = boundedReferenceReason(reason);
    if (this.#loadWaiter) {
      clearTimeout(this.#loadWaiter.timer);
      this.#loadWaiter.reject(new Error(bounded));
    }
    this.#loadWaiter = null;
    this.#callbacks.onFailure?.({
      failureClass: classifyReferenceFailure(bounded, unsupported),
      reason: bounded,
      frame: this.#desiredFrame,
      playing: this.#playing,
    });
  }
}
