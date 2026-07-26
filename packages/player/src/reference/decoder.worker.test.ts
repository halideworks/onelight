import { describe, expect, it, vi } from "vitest";
import {
  timestampForReferenceFrame,
  type DecoderCommand,
  type DecoderEvent,
  type ExpectedTrack,
} from "./protocol.js";

/*
 * The decode worker driven directly, with mediabunny and WebCodecs replaced by
 * fakes that let a test decide exactly when a decoded frame appears and when
 * its plane copy finishes. That timing is the whole point: the scheduler's
 * hard cases are all about work that is still in flight when the window moves.
 *
 * The fake decoder emits one frame per decode() call, in the order fed, which
 * is what WebKit does and what Chromium does not.
 */

const RATE = { num: 30, den: 1 };
const CODED = { width: 4, height: 4 };

const expected: ExpectedTrack = {
  frameRate: RATE,
  durationFrames: 200,
  codedWidth: CODED.width,
  codedHeight: CODED.height,
  codec: null,
  outputColor: {
    primaries: "bt709",
    transfer: "bt709",
    matrix: "bt709",
    range: "tv",
  },
  outputChromaLocation: "left",
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

/* One decoded frame. Its copy can be held open so a test can move the window
   while the copy is still outstanding. */
type FakeFrame = {
  frame: VideoFrame;
  copyGate: Deferred<PlaneLayout[]> | null;
  closed: () => boolean;
};

const makeFrame = (index: number, holdCopy: boolean): FakeFrame => {
  const gate = holdCopy ? deferred<PlaneLayout[]>() : null;
  let closed = false;
  const layout: PlaneLayout[] = [
    { offset: 0, stride: 4 },
    { offset: 16, stride: 2 },
    { offset: 20, stride: 2 },
  ];
  const frame = {
    format: "I420" as const,
    codedWidth: CODED.width,
    codedHeight: CODED.height,
    displayWidth: CODED.width,
    displayHeight: CODED.height,
    codedRect: { x: 0, y: 0, width: CODED.width, height: CODED.height },
    visibleRect: { x: 0, y: 0, width: CODED.width, height: CODED.height },
    timestamp: timestampForReferenceFrame(index, 0, RATE),
    duration: 33_333,
    colorSpace: {
      primaries: "bt709",
      transfer: "bt709",
      matrix: "bt709",
      fullRange: false,
    },
    allocationSize: () => 24,
    copyTo: (): Promise<PlaneLayout[]> =>
      gate ? gate.promise : Promise.resolve(layout),
    close: () => {
      closed = true;
    },
  } as unknown as VideoFrame;
  return {
    frame,
    copyGate: gate,
    closed: () => closed,
    layoutValue: layout,
  } as FakeFrame & {
    layoutValue: PlaneLayout[];
  };
};

type DecoderRig = {
  queue: FakeFrame[];
  fedFrames: number[];
  emit: (frames: FakeFrame[]) => void;
};

/* A decoder class bound to one rig. Each worker load gets its own, because a
   previous test's worker keeps running its feed loop in the background and
   would otherwise consume the next test's queued frames. */
const makeDecoderClass = (rig: DecoderRig): unknown => {
  let live: { output: (frame: VideoFrame) => void } | null = null;
  rig.emit = (frames) => {
    for (const frame of frames) live?.output(frame.frame);
  };
  return class FakeVideoDecoder {
    static isConfigSupported(
      config: VideoDecoderConfig,
    ): Promise<{ supported: boolean; config: VideoDecoderConfig }> {
      return Promise.resolve({ supported: true, config });
    }

    state = "unconfigured";
    decodeQueueSize = 0;
    readonly output: (frame: VideoFrame) => void;

    constructor(init: {
      output: (frame: VideoFrame) => void;
      error: (error: Error) => void;
    }) {
      this.output = init.output;
      live = { output: init.output };
    }

    configure(): void {
      this.state = "configured";
    }

    decode(chunk: { timestamp: number }): void {
      rig.fedFrames.push(
        Math.round((chunk.timestamp * RATE.num) / (1_000_000 * RATE.den)),
      );
      /* Decode-order emission: one output per input, in the order fed. */
      const next = rig.queue.shift();
      if (next) this.output(next.frame);
    }

    reset(): void {
      this.state = "unconfigured";
    }

    close(): void {
      this.state = "closed";
    }

    addEventListener(_type: string, listener: () => void): void {
      setTimeout(listener, 0);
    }

    removeEventListener(): void {
      /* the fake never keeps listeners */
    }

    flush(): Promise<void> {
      return Promise.resolve();
    }
  };
};

const packetFor = (
  index: number,
): {
  timestamp: number;
  toEncodedVideoChunk: () => { timestamp: number };
} => ({
  timestamp: timestampForReferenceFrame(index, 0, RATE) / 1_000_000,
  toEncodedVideoChunk: () => ({
    timestamp: timestampForReferenceFrame(index, 0, RATE),
  }),
});

vi.mock("mediabunny", () => {
  class Input {
    getPrimaryVideoTrack(): Promise<object> {
      return Promise.resolve({
        getDecoderConfig: () => Promise.resolve({ codec: "avc1.640028" }),
        getCodedWidth: () => Promise.resolve(CODED.width),
        getCodedHeight: () => Promise.resolve(CODED.height),
        getDisplayWidth: () => Promise.resolve(CODED.width),
        getDisplayHeight: () => Promise.resolve(CODED.height),
        getColorSpace: () =>
          Promise.resolve({
            primaries: "bt709",
            transfer: "bt709",
            matrix: "bt709",
            fullRange: false,
          }),
        getFirstTimestamp: () => Promise.resolve(0),
        getDurationFromMetadata: () => Promise.resolve(200 / 30),
      });
    }
    dispose(): void {
      /* nothing to release in the fake */
    }
  }
  class EncodedPacketSink {
    getKeyPacket(timestamp: number): Promise<object> {
      const frame = Math.round((timestamp * RATE.num) / RATE.den);
      return Promise.resolve(packetFor(Math.max(0, frame - (frame % 60))));
    }
    packets(start: { timestamp: number }): AsyncIterable<object> {
      let index = Math.round((start.timestamp * RATE.num) / RATE.den);
      return {
        [Symbol.asyncIterator]: () => ({
          next: () =>
            Promise.resolve({ value: packetFor(index++), done: false }),
        }),
      } as AsyncIterable<object>;
    }
  }
  return {
    ALL_FORMATS: [],
    Input,
    EncodedPacketSink,
    UrlSource: class {},
  };
});

type WorkerGlobal = {
  onmessage: ((event: MessageEvent<DecoderCommand>) => void) | null;
  postMessage: (event: DecoderEvent, transfer?: Transferable[]) => void;
};

const settle = async (): Promise<void> => {
  /* The worker hops a macrotask per feed iteration, and its feed loop runs
     until the window is satisfied or it has fed well past the window's end,
     so a fixed number of microtask turns is not enough to reach quiescence. */
  for (let turn = 0; turn < 60; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
  }
};

const waitFor = async (
  predicate: () => boolean,
  label: string,
): Promise<void> => {
  for (let turn = 0; turn < 400; turn += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${label}`);
};

/* A worker module instance keeps feeding after a test stops looking at it,
   and it posts through globalThis, so it would write into the next test's
   event log. Shut the previous one down before loading another. */
let closePrevious: (() => void) | null = null;

const loadWorker = async (): Promise<{
  send: (command: DecoderCommand) => void;
  events: DecoderEvent[];
  rig: DecoderRig;
}> => {
  closePrevious?.();
  await settle();
  vi.resetModules();
  const rig: DecoderRig = {
    queue: [],
    fedFrames: [],
    emit: () => undefined,
  };
  const events: DecoderEvent[] = [];
  const scope = globalThis as unknown as WorkerGlobal;
  scope.postMessage = (event) => {
    events.push(event);
  };
  (globalThis as unknown as { VideoDecoder: unknown }).VideoDecoder =
    makeDecoderClass(rig);
  await import("./decoder.worker.js");
  const send = (command: DecoderCommand): void => {
    scope.onmessage?.({ data: command } as MessageEvent<DecoderCommand>);
  };
  closePrevious = () => {
    send({ type: "close", generation: Number.MAX_SAFE_INTEGER });
  };
  return { send, events, rig };
};

const openAt = async (
  send: (command: DecoderCommand) => void,
  generation: number,
): Promise<void> => {
  send({ type: "open", generation, url: "/proxy.mp4", expected });
  await settle();
};

const framesOf = (events: DecoderEvent[]): number[] =>
  events
    .filter((event) => event.type === "frame")
    .map((event) => (event.type === "frame" ? event.frame : -1));

const settledWindow = (events: DecoderEvent[], generation: number): boolean =>
  events.some(
    (event) =>
      (event.type === "window" || event.type === "stalled") &&
      event.generation === generation,
  );

describe("reference decode worker scheduling", () => {
  it("emits frames in ascending order from a decoder that emits in decode order", async () => {
    const { send, events, rig } = await loadWorker();
    await openAt(send, 1);
    expect(events.some((event) => event.type === "ready")).toBe(true);

    /* Shuffled the way a B-frame stream arrives: 2 before 0 and 1. */
    rig.queue = [2, 0, 1, 3, 4].map((index) => makeFrame(index, false));
    send({ type: "seek", generation: 2, frame: 0 });
    await waitFor(
      () => framesOf(events).length >= 3,
      "the reordered frames to be emitted",
    );

    const emitted = framesOf(events);
    expect(emitted).toEqual([...emitted].sort((left, right) => left - right));
    expect(emitted.slice(0, 3)).toEqual([0, 1, 2]);
  });

  /*
   * A decoder drains its pipeline on its own schedule, so a frame can be
   * copied after its window has closed and the next window has been asked
   * for. Every window command is a new generation, and such a copy used to be
   * discarded on completion -- its packet already spent by the forward-only
   * iterator, so the frame could never be produced again and the transport
   * simply skipped it. A continuation now carries that work across.
   */
  it("keeps a plane copy that lands after the window advanced", async () => {
    const { send, events, rig } = await loadWorker();
    await openAt(send, 1);

    rig.queue = [0, 1, 2, 3, 4].map((index) => makeFrame(index, false));
    send({ type: "play", generation: 2, frame: 0, rate: 1 });
    await waitFor(
      () => settledWindow(events, 2),
      "the first play window to satisfy its target",
    );
    expect(framesOf(events)).toContain(0);

    // The pipeline drains one more frame, and its copy is still open.
    const late = makeFrame(5, true);
    rig.emit([late]);
    await settle();
    expect(framesOf(events)).not.toContain(5);

    // The clock advances: a continuation of the same decode stream.
    send({ type: "play", generation: 3, frame: 1, rate: 1 });
    await settle();

    late.copyGate?.resolve([
      { offset: 0, stride: 4 },
      { offset: 16, stride: 2 },
      { offset: 20, stride: 2 },
    ]);
    await waitFor(
      () => framesOf(events).includes(5),
      "the copy that landed after the window advanced to reach the transport",
    );

    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(
      rig.fedFrames.filter((frame) => frame === 5).length,
      "the frame is delivered from the copy, not decoded a second time",
    ).toBe(1);
  });

  /*
   * The play shape reaches one frame back where the seek shape reaches three
   * ahead, so the first play window after a seek does not tile with it. The
   * worker owes the transport the frame in between: the emission record
   * survives the refused continuation, the window's first is pulled back over
   * the hole, and the fresh keyframe walk produces it.
   */
  it("backfills the hole between a seek window and the first play window", async () => {
    const { send, events, rig } = await loadWorker();
    await openAt(send, 1);

    rig.queue = [0, 1, 2, 3, 4].map((index) => makeFrame(index, false));
    send({ type: "seek", generation: 2, frame: 0 });
    await waitFor(
      () => settledWindow(events, 2),
      "the seek window to satisfy its target",
    );
    expect(framesOf(events)).toEqual([0, 1, 2, 3]);

    /* The seek abandoned its iterator, so this play cannot continue the
       pipeline and re-walks from the keyframe: the fake supplies the
       re-decoded frames in decode order. */
    rig.queue = Array.from({ length: 12 }, (_, index) =>
      makeFrame(index, false),
    );
    send({ type: "play", generation: 3, frame: 6, rate: 1 });
    await waitFor(
      () => settledWindow(events, 3),
      "the first play window to satisfy its target",
    );

    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(framesOf(events)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  /*
   * The same carry when playback itself is the predecessor: the deeper play
   * window can finish after the clock has already asked for the next one, and
   * the refused continuation used to wipe the frames the old window had
   * decoded but not delivered. One frame lost per window jump.
   */
  it("keeps emission contiguous across a refused play continuation", async () => {
    const { send, events, rig } = await loadWorker();
    await openAt(send, 1);

    rig.queue = [0, 1, 2, 3, 4, 5].map((index) => makeFrame(index, false));
    send({ type: "play", generation: 2, frame: 0, rate: 1 });
    await waitFor(
      () => settledWindow(events, 2),
      "the first play window to satisfy its target",
    );
    expect(framesOf(events)).toEqual([0, 1, 2, 3, 4]);

    /* Eight frames on is within playback's continuation distance but past
       what the pipeline has fed, so the continuation is refused and the
       stream re-walks -- through the ground the old window already covered. */
    rig.queue = Array.from({ length: 14 }, (_, index) =>
      makeFrame(index, false),
    );
    send({ type: "play", generation: 3, frame: 8, rate: 1 });
    await waitFor(
      () => settledWindow(events, 3),
      "the refused continuation's window to satisfy its target",
    );

    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(framesOf(events)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
  });

  /*
   * A cold window whose shape reaches behind a keyframe sitting inside it
   * promises frames the walk from that keyframe can never produce. It used to
   * chase them far past the window and then deliver nothing at all -- the
   * emitter broke on the missing first frame. The window now starts honestly
   * at the keyframe.
   */
  it("starts an honest window at the keyframe when the shape reaches behind it", async () => {
    const { send, events, rig } = await loadWorker();
    await openAt(send, 1);

    /* The fake sink's keyframes sit at multiples of 60: a seek to 61 shapes
       its window from 59, behind the keyframe. */
    rig.queue = Array.from({ length: 11 }, (_, index) =>
      makeFrame(60 + index, false),
    );
    send({ type: "seek", generation: 2, frame: 61 });
    await waitFor(
      () => settledWindow(events, 2),
      "the keyframe-aligned seek window to settle",
    );

    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(
      events.some((event) => event.type === "window" && event.generation === 2),
    ).toBe(true);
    expect(framesOf(events)).toEqual([60, 61, 62, 63, 64]);
  });

  /*
   * A platform decoder can wedge: it dequeues fed packets and produces
   * nothing until reset. A stalled play window used to leave the dead stream
   * standing, so every following command "continued" it -- eleven straight
   * stalls on real Safari before the distance cap forced a fresh walk. The
   * stall now resets the stream and keeps the emission record, so the next
   * command walks from a keyframe and backfills what the wedge swallowed.
   */
  it("resets a dead play stream on stall and backfills on the next command", async () => {
    const { send, events, rig } = await loadWorker();
    await openAt(send, 1);

    rig.queue = [0, 1, 2, 3, 4, 5].map((index) => makeFrame(index, false));
    send({ type: "play", generation: 2, frame: 0, rate: 1 });
    await waitFor(
      () => settledWindow(events, 2),
      "the first play window to satisfy its target",
    );
    expect(framesOf(events)).toEqual([0, 1, 2, 3, 4]);

    /* The decoder wedges: packets keep being accepted, no output appears. */
    send({ type: "play", generation: 3, frame: 6, rate: 1 });
    await waitFor(
      () =>
        events.some(
          (event) => event.type === "stalled" && event.generation === 3,
        ),
      "the wedged window to report a stall",
    );

    /* The decoder recovers (a reset cured it): the fresh walk re-decodes
       from the keyframe and the transport receives every missing frame. */
    rig.queue = Array.from({ length: 13 }, (_, index) =>
      makeFrame(index, false),
    );
    send({ type: "play", generation: 4, frame: 7, rate: 1 });
    await waitFor(
      () => settledWindow(events, 4),
      "the recovery window to satisfy its target",
    );

    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(framesOf(events)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  /*
   * The mirror: a discontinuity resets the decoder and re-walks from a
   * keyframe, so work from the abandoned window must not leak into the new
   * one under a generation it was never decoded for.
   */
  it("drops a plane copy that lands across a discontinuity", async () => {
    const { send, events, rig } = await loadWorker();
    await openAt(send, 1);

    rig.queue = [0, 1, 2, 3, 4].map((index) => makeFrame(index, false));
    send({ type: "play", generation: 2, frame: 0, rate: 1 });
    await waitFor(
      () => settledWindow(events, 2),
      "the first play window to satisfy its target",
    );

    const late = makeFrame(5, true);
    rig.emit([late]);
    await settle();

    send({ type: "seek", generation: 3, frame: 120 });
    await settle();
    const before = framesOf(events).length;

    late.copyGate?.resolve([
      { offset: 0, stride: 4 },
      { offset: 16, stride: 2 },
      { offset: 20, stride: 2 },
    ]);
    await settle();

    expect(framesOf(events).length).toBe(before);
    expect(framesOf(events)).not.toContain(5);
  });
});
