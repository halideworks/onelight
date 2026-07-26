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
  MAX_OPEN_FRAMES,
  PLAY_WINDOW_AHEAD,
  type DecodedTrack,
  type DecoderCommand,
  type DecoderEvent,
  type PlaneTransfer,
  type ReferenceColorContract,
  type ReferenceHardwareAcceleration,
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
  /* Which WebCodecs decoder the worker should request. Reference playback is
     correctness-first, so the transport can escalate to "prefer-software"
     when a platform hardware decoder mishandles a surface (e.g. odd-width
     4:2:0), where a bundled software decoder is deterministic. */
  hardwareAcceleration?: ReferenceHardwareAcceleration;
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

/* Frames between consecutive scrub window requests beyond which the drag is
   fast enough that keyframe-only sampling reads better than exact decode. */
const COARSE_SCRUB_STEP = 8;

export class ReferencePictureBackend implements PictureBackend {
  readonly #callbacks: ReferenceBackendCallbacks;
  readonly #workerFactory: () => WorkerLike;
  readonly #openTimeoutMs: number;
  readonly #starvationMs: number;
  readonly #seekTimeoutMs: number;
  readonly #hardwareAcceleration: ReferenceHardwareAcceleration;
  readonly #frames = new Map<number, PlaneTransfer>();
  #worker: WorkerLike | null = null;
  #track: DecodedTrack | null = null;
  #generation = 0;
  #desiredFrame = 0;
  #playing = false;
  #rate: PicturePlaybackRate = 1;
  #windowPending = false;
  #windowTarget: number | null = null;
  #windowCoarse = false;
  #scrubbing = false;
  #lastScrubRequest: number | null = null;
  #lastPlayRequest: { target: number; bufferedEnd: number | null } | null =
    null;
  #loadWaiter: LoadWaiter | null = null;
  #openStage = "starting decoder worker";
  #starvationTimer: ReturnType<typeof setTimeout> | null = null;
  #seekTimer: ReturnType<typeof setTimeout> | null = null;
  #failed = false;
  #presentedPlanes: PlaneTransfer | null = null;
  #presentedFrame: number | null = null;
  #decodedColor: ReferenceColorContract | null = null;

  constructor(
    callbacks: ReferenceBackendCallbacks,
    options: ReferenceBackendOptions = {},
  ) {
    this.#callbacks = callbacks;
    this.#workerFactory = options.workerFactory ?? defaultWorkerFactory;
    this.#openTimeoutMs = options.openTimeoutMs ?? 5_000;
    this.#starvationMs = options.starvationMs ?? 900;
    this.#seekTimeoutMs = options.seekTimeoutMs ?? 5_000;
    this.#hardwareAcceleration =
      options.hardwareAcceleration ?? "no-preference";
  }

  get bufferedFrames(): readonly number[] {
    return [...this.#frames.keys()].sort((left, right) => left - right);
  }

  get track(): DecodedTrack | null {
    return this.#track;
  }

  /* The color the decoder actually produced, which is not always the color
     the container declared: a platform decoder may hand back a range-expanded
     surface. Reported so the diagnostic says which one was rendered. */
  get decodedColor(): ReferenceColorContract | null {
    return this.#decodedColor;
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
    this.#decodedColor = null;
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
      hardwareAcceleration: this.#hardwareAcceleration,
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
    this.#lastScrubRequest = null;
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
    /* A pending coarse sample answers with a keyframe, not the release
       frame: the release always settles exactly. */
    if (
      !this.#windowPending ||
      this.#windowTarget !== this.#desiredFrame ||
      this.#windowCoarse
    )
      this.#requestWindow(this.#desiredFrame, "seek");
  }

  play(frame: number, rate: PicturePlaybackRate): void {
    this.#scrubbing = false;
    this.#playing = true;
    this.#rate = rate;
    this.#lastPlayRequest = null;
    this.seek(frame);
  }

  pause(): void {
    this.#playing = false;
    this.#lastPlayRequest = null;
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
    this.#lastScrubRequest = null;
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
    /* A pointer covering many frames between samples wants picture updates
       over exactness: coarse decodes only the nearest keyframe (one decode
       per sample instead of a GOP walk). Slow drags and the release seek
       stay exact. */
    const coarse =
      type === "scrub" &&
      this.#lastScrubRequest !== null &&
      Math.abs(frame - this.#lastScrubRequest) >= COARSE_SCRUB_STEP;
    this.#lastScrubRequest = type === "scrub" ? frame : null;
    this.#windowCoarse = coarse;
    this.#clearSeekTimer();
    this.#seekTimer = setTimeout(() => {
      this.#seekTimer = null;
      if (
        generation === this.#generation &&
        !this.#frames.has(frame) &&
        /* A coarse sample answers with the keyframe at or before the target,
           so any nearer buffered frame proves it did its job. */
        !(coarse && this.#nearestBufferedFrame() !== null)
      )
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
      ...(type === "scrub" ? { coarse } : {}),
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
      this.#decodedColor = event.planes.color;
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
      else this.#prefetchIfNeeded();
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
    const last = this.bufferedFrames.at(-1);
    /* The pipeline advances at the clock's pace: the play window for the
       current frame already reaches PLAY_WINDOW_AHEAD past it, which is all
       the cache can hold next to one frame behind. Requesting blocks beyond
       that overflows the cache, the trim then drops the newest frames, and a
       frame dropped during playback is unrecoverable -- the worker emits each
       frame exactly once from a forward-only packet iterator. The window
       handler calls this the moment a window completes, so the pipeline is
       continuous rather than paced by whichever clock tick happens to find
       its frame cached. */
    const duration = this.#track.durationFrames;
    const horizonCeiling = this.#desiredFrame + PLAY_WINDOW_AHEAD;
    const horizon =
      duration === null
        ? horizonCeiling
        : Math.min(duration - 1, horizonCeiling);
    if (last !== undefined && last >= horizon) return;
    /* Re-requesting the identical window while nothing has changed would
       ping-pong: the worker emits each frame once, so an already-complete
       window answers instantly with nothing and the completion handler would
       ask again. Any progress -- a new frame arriving or the clock advancing
       -- changes the signature and lifts the guard. */
    if (
      this.#lastPlayRequest !== null &&
      this.#lastPlayRequest.target === this.#desiredFrame &&
      this.#lastPlayRequest.bufferedEnd === (last ?? null)
    )
      return;
    this.#lastPlayRequest = {
      target: this.#desiredFrame,
      bufferedEnd: last ?? null,
    };
    this.#requestWindow(this.#desiredFrame, "play");
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
