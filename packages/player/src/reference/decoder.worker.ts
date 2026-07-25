import {
  ALL_FORMATS,
  EncodedPacketSink,
  Input,
  UrlSource,
  type EncodedPacket,
  type InputVideoTrack,
} from "mediabunny";
import {
  FRAME_WINDOW_AHEAD,
  FRAME_WINDOW_BEHIND,
  decodeOutputIsOutOfOrder,
  decodeWindowIsComplete,
  MAX_DECODE_QUEUE,
  MAX_DECODE_REORDER,
  MAX_OPEN_FRAMES,
  MAX_PLANE_BUFFERS,
  RETAIN_REORDER_SLACK,
  referenceFrameAtTimestamp,
  referenceTimestampIsExact,
  timestampForReferenceFrame,
  type DecodedTrack,
  type DecoderCommand,
  type DecoderEvent,
  type ExpectedTrack,
  type PlaneTransfer,
  type ReferenceHardwareAcceleration,
  type ReferenceOpenStage,
} from "./protocol.js";
import {
  copyRawFramePlanes,
  referenceColorFrom,
  referenceColorsAgree,
  UnsupportedRawPlaneError,
} from "./raw-planes.js";

type WorkerPort = {
  onmessage: ((event: MessageEvent<DecoderCommand>) => void) | null;
  postMessage(message: DecoderEvent, transfer?: Transferable[]): void;
};

type OpenState = {
  input: Input;
  packetSink: EncodedPacketSink;
  decoder: VideoDecoder;
  config: VideoDecoderConfig;
  expected: ExpectedTrack;
  track: DecodedTrack;
  playIterator: AsyncIterator<EncodedPacket> | null;
  playTarget: number | null;
  /* Highest presentation frame whose packet has been fed to the decoder on
     the live iterator. A window whose first frame is at or before this mark
     can continue the warm pipeline: the frame is either already copied or
     still in flight inside the decoder. */
  maxFedFrame: number | null;
};

/*
 * Backpressure ceiling for decoded-frame copies. Feeding is gated at
 * MAX_DECODE_QUEUE pending copies, but a decoder releasing its internal
 * pipeline (a B-frame reorder burst) can momentarily exceed the feed gate
 * without anything being wrong. Only a runaway well past any real pipeline
 * depth is treated as a failure instead of a stall.
 */
const COPY_BURST_CAP = MAX_OPEN_FRAMES + 10;

type DecodeOperation = {
  generation: number;
  target: number;
  first: number;
  last: number;
  retainThrough: number;
  maxOutputFrame: number | null;
  pendingCopies: Set<Promise<void>>;
  copyingFrames: Set<number>;
  failed: boolean;
};

class UnsupportedReferenceError extends Error {}

const port = globalThis as unknown as WorkerPort;
const planes = new Map<number, PlaneTransfer>();
const emittedFrames = new Set<number>();
const recycledBuffers: ArrayBuffer[] = [];
let activeGeneration = 0;
let openState: OpenState | null = null;
let operation: DecodeOperation | null = null;

const boundedReason = (error: unknown): string => {
  const reason = error instanceof Error ? error.message : String(error);
  return reason.slice(0, 500);
};

const post = (event: DecoderEvent, transfer: Transferable[] = []): void => {
  if (event.generation !== activeGeneration) return;
  port.postMessage(event, transfer);
};

const postOpenStage = (
  generation: number,
  stage: ReferenceOpenStage,
  detail?: string,
): void => {
  post({ type: "opening", generation, stage, ...(detail ? { detail } : {}) });
};

const assertExpectedTrack = (
  actual: DecodedTrack,
  expected: ExpectedTrack,
): void => {
  if (
    actual.frameRate.num !== expected.frameRate.num ||
    actual.frameRate.den !== expected.frameRate.den
  )
    throw new UnsupportedReferenceError(
      "Rendition frame rate does not match the decoder contract.",
    );
  if (
    expected.durationFrames !== null &&
    actual.durationFrames !== null &&
    actual.durationFrames !== expected.durationFrames
  )
    throw new UnsupportedReferenceError(
      "Rendition duration does not match the decoder contract.",
    );
  if (expected.codedWidth !== null && actual.codedWidth !== expected.codedWidth)
    throw new UnsupportedReferenceError(
      "Rendition width does not match the decoder contract.",
    );
  if (
    expected.codedHeight !== null &&
    actual.codedHeight !== expected.codedHeight
  )
    throw new UnsupportedReferenceError(
      "Rendition height does not match the decoder contract.",
    );
  if (
    expected.codec !== null &&
    actual.codec.toLowerCase() !== expected.codec.toLowerCase()
  )
    throw new UnsupportedReferenceError(
      "Rendition codec does not match the decoder contract.",
    );
  if (!referenceColorsAgree(actual.color, expected.outputColor))
    throw new UnsupportedReferenceError(
      "Rendition color metadata does not match the decoder contract.",
    );
};

const resetDecoder = (state: OpenState): void => {
  if (state.decoder.state === "closed") return;
  state.decoder.reset();
  state.decoder.configure(state.config);
};

const clearPlaneState = (): void => {
  for (const plane of planes.values())
    if (
      plane.buffer.byteLength > 0 &&
      recycledBuffers.length < MAX_PLANE_BUFFERS
    )
      recycledBuffers.push(plane.buffer);
  planes.clear();
  emittedFrames.clear();
};

const takeRecycledBuffer = (byteLength: number): ArrayBuffer | undefined => {
  const index = recycledBuffers.findIndex(
    (buffer) => buffer.byteLength === byteLength,
  );
  if (index < 0) return undefined;
  return recycledBuffers.splice(index, 1)[0];
};

const cancelDecode = (): void => {
  operation = null;
  clearPlaneState();
  if (openState) {
    openState.playIterator = null;
    openState.playTarget = null;
    openState.maxFedFrame = null;
    resetDecoder(openState);
  }
};

const closeState = (): void => {
  operation = null;
  clearPlaneState();
  const state = openState;
  openState = null;
  if (!state) return;
  if (state.decoder.state !== "closed") state.decoder.close();
  state.input.dispose();
};

const failOperation = (
  generation: number,
  reason: string,
  unsupported: boolean,
): void => {
  if (
    generation !== activeGeneration ||
    !operation ||
    operation.generation !== generation ||
    operation.failed
  )
    return;
  operation.failed = true;
  clearPlaneState();
  post({
    type: unsupported ? "unsupported" : "error",
    generation,
    reason: reason.slice(0, 500),
  });
};

const handleDecodedFrame = (frame: VideoFrame): void => {
  const state = openState;
  const current = operation;
  let closed = false;
  if (!state || !current || current.generation !== activeGeneration) {
    frame.close();
    return;
  }
  try {
    const index = referenceFrameAtTimestamp(
      frame.timestamp,
      state.track.firstTimestampUs,
      state.track.frameRate,
    );
    if (
      index < 0 ||
      !referenceTimestampIsExact(
        frame.timestamp,
        index,
        state.track.firstTimestampUs,
        state.track.frameRate,
      )
    )
      throw new UnsupportedReferenceError(
        "Decoded frame timestamp does not map to an exact rendition frame.",
      );
    if (decodeOutputIsOutOfOrder(index, current.maxOutputFrame))
      throw new UnsupportedReferenceError(
        "Decoded frames arrived outside presentation order.",
      );
    if (current.maxOutputFrame === null || index > current.maxOutputFrame)
      current.maxOutputFrame = index;
    if (
      index < current.first ||
      index > current.retainThrough ||
      planes.has(index) ||
      emittedFrames.has(index)
    ) {
      frame.close();
      closed = true;
      return;
    }
    if (current.pendingCopies.size >= COPY_BURST_CAP) {
      frame.close();
      closed = true;
      throw new Error("Decoded-frame copy resource cap exceeded.");
    }
    const codedRect = frame.codedRect ?? {
      x: 0,
      y: 0,
      width: frame.codedWidth,
      height: frame.codedHeight,
    };
    const copy = copyRawFramePlanes(
      frame,
      state.expected.outputColor,
      state.expected.outputChromaLocation,
      takeRecycledBuffer(frame.allocationSize({ rect: codedRect })),
    )
      .then((copied) => {
        if (
          current.generation === activeGeneration &&
          operation === current &&
          !current.failed
        ) {
          planes.set(index, copied);
          emitPlanes(current.generation, current.first, current.last);
        } else if (
          copied.buffer.byteLength > 0 &&
          recycledBuffers.length < MAX_PLANE_BUFFERS
        )
          recycledBuffers.push(copied.buffer);
      })
      .catch((error: unknown) => {
        failOperation(
          current.generation,
          boundedReason(error),
          error instanceof UnsupportedReferenceError ||
            error instanceof UnsupportedRawPlaneError,
        );
      })
      .finally(() => {
        frame.close();
        closed = true;
        current.pendingCopies.delete(copy);
        current.copyingFrames.delete(index);
      });
    current.pendingCopies.add(copy);
    current.copyingFrames.add(index);
  } catch (error) {
    if (!closed) frame.close();
    failOperation(
      current.generation,
      boundedReason(error),
      error instanceof UnsupportedReferenceError,
    );
  }
};

const waitForQueueCapacity = async (
  state: OpenState,
  generation: number,
): Promise<void> => {
  const current = operation;
  while (
    generation === activeGeneration &&
    current &&
    operation === current &&
    !current.failed &&
    current.pendingCopies.size >= MAX_DECODE_QUEUE
  )
    await Promise.race(current.pendingCopies);
  while (
    generation === activeGeneration &&
    state.decoder.state === "configured" &&
    state.decoder.decodeQueueSize >= MAX_DECODE_QUEUE
  )
    await new Promise<void>((resolve) => {
      const onDequeue = (): void => {
        state.decoder.removeEventListener("dequeue", onDequeue);
        resolve();
      };
      state.decoder.addEventListener("dequeue", onDequeue, { once: true });
      setTimeout(onDequeue, 250);
    });
};

const packetTimeBeyondWindow = (
  packet: EncodedPacket,
  state: OpenState,
  lastFrame: number,
): boolean => {
  const lastTimestamp =
    timestampForReferenceFrame(
      lastFrame + 1,
      state.track.firstTimestampUs,
      state.track.frameRate,
    ) / 1_000_000;
  return packet.timestamp >= lastTimestamp;
};

const emitPlanes = (generation: number, first: number, last: number): void => {
  for (let frame = first; frame <= last; frame += 1) {
    if (emittedFrames.has(frame)) continue;
    const copied = planes.get(frame);
    if (!copied) break;
    planes.delete(frame);
    emittedFrames.add(frame);
    post({ type: "frame", generation, frame, planes: copied }, [copied.buffer]);
  }
};

/* Sent already, copied and waiting its turn to be sent, or being copied. */
const windowOutputsComplete = (
  current: DecodeOperation,
  last: number,
): boolean =>
  decodeWindowIsComplete(
    current.first,
    last,
    (frame) =>
      emittedFrames.has(frame) ||
      planes.has(frame) ||
      current.copyingFrames.has(frame),
  );

/*
 * Wait until the decoder has output every frame of the window (or run out of
 * queued work and need more input). Deliberately NOT a drain-to-zero: emptying
 * the decoder's internal pipeline at every window boundary put a refill bubble
 * into sustained playback several times a second. Waiting on outputs keeps the
 * pipeline warm across windows; only seeks and end of stream flush.
 */
const waitForWindowOutputs = async (
  state: OpenState,
  generation: number,
  last: number,
): Promise<void> => {
  while (
    generation === activeGeneration &&
    state.decoder.state === "configured" &&
    operation !== null &&
    !windowOutputsComplete(operation, last) &&
    state.decoder.decodeQueueSize > 0
  ) {
    await new Promise<void>((resolve) => {
      const onDequeue = (): void => {
        state.decoder.removeEventListener("dequeue", onDequeue);
        resolve();
      };
      state.decoder.addEventListener("dequeue", onDequeue, { once: true });
      setTimeout(onDequeue, 250);
    });
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

/*
 * One decode per sample: the keyframe at or before the target, presented at
 * its true frame index. A fast drag across a one-second GOP costs one decode
 * instead of a walk of up to the whole GOP, so the picture follows the
 * pointer at display rate even on software decoders. Exactness returns with
 * the release gesture's normal seek.
 */
const decodeCoarseKeyframe = async (
  generation: number,
  target: number,
  state: OpenState,
): Promise<void> => {
  cancelDecode();
  const targetTimestamp =
    timestampForReferenceFrame(
      target,
      state.track.firstTimestampUs,
      state.track.frameRate,
    ) / 1_000_000;
  /* The operation exists before the first await so a failure anywhere in the
     sample reports through failOperation instead of relying on timers. Its
     window is re-pointed at the keyframe once that is known. */
  const current: DecodeOperation = {
    generation,
    target,
    first: target,
    last: target,
    retainThrough: target,
    maxOutputFrame: null,
    copyingFrames: new Set<number>(),
    pendingCopies: new Set(),
    failed: false,
  };
  operation = current;
  try {
    const keyPacket = await state.packetSink.getKeyPacket(targetTimestamp, {
      verifyKeyPackets: true,
    });
    if (generation !== activeGeneration) return;
    if (!keyPacket)
      throw new UnsupportedReferenceError(
        "No keyframe is available before the requested frame.",
      );
    const keyIndex = referenceFrameAtTimestamp(
      Math.round(keyPacket.timestamp * 1_000_000),
      state.track.firstTimestampUs,
      state.track.frameRate,
    );
    /* Always re-emit: the transport may have recycled an earlier emission of
       this keyframe while the pointer was elsewhere. */
    emittedFrames.delete(keyIndex);
    current.target = keyIndex;
    current.first = keyIndex;
    current.last = keyIndex;
    current.retainThrough = keyIndex;
    state.decoder.decode(keyPacket.toEncodedVideoChunk());
    await state.decoder.flush();
    await Promise.all(current.pendingCopies);
    if (
      generation !== activeGeneration ||
      operation !== current ||
      current.failed
    )
      return;
    if (!planes.has(keyIndex) && !emittedFrames.has(keyIndex)) {
      clearPlaneState();
      post({ type: "stalled", generation, frame: keyIndex });
      return;
    }
    emitPlanes(generation, keyIndex, keyIndex);
    post({ type: "window", generation, target: keyIndex });
  } catch (error) {
    if (generation !== activeGeneration) return;
    failOperation(
      generation,
      boundedReason(error),
      error instanceof UnsupportedReferenceError,
    );
  }
};

const decodeWindow = async (
  generation: number,
  target: number,
  mode: "seek" | "play" | "scrub" | "scrub-coarse",
  rate: 1 | 2 | 4 = 1,
): Promise<void> => {
  const state = openState;
  if (!state) {
    post({
      type: "error",
      generation,
      reason: "No reference source is open.",
    });
    return;
  }
  if (
    !Number.isSafeInteger(target) ||
    target < 0 ||
    (state.track.durationFrames !== null &&
      target >= state.track.durationFrames)
  ) {
    post({
      type: "error",
      generation,
      reason: "Requested reference frame is outside the rendition.",
    });
    return;
  }

  if (mode === "scrub-coarse") {
    await decodeCoarseKeyframe(generation, target, state);
    return;
  }

  const first =
    mode === "scrub" ? target : Math.max(0, target - FRAME_WINDOW_BEHIND);
  /* Continuation is safe when the window's first frame is already copied,
     already emitted, or still in flight inside the warm decoder pipeline
     (its packet was fed on the live iterator). The distance cap scales with
     the shuttle rate: at 4x the clock legitimately advances four frames per
     tick, and a fixed cap made every hiccup a keyframe re-walk. */
  const canContinuePlayback =
    mode === "play" &&
    state.playIterator !== null &&
    state.playTarget !== null &&
    target >= state.playTarget &&
    target - state.playTarget <= MAX_OPEN_FRAMES * 2 * rate &&
    (planes.has(first) ||
      emittedFrames.has(first) ||
      (state.maxFedFrame !== null && first <= state.maxFedFrame + 1));
  const canContinueScrub =
    mode === "scrub" &&
    state.playIterator !== null &&
    state.playTarget !== null &&
    target > state.playTarget &&
    target - state.playTarget <= MAX_OPEN_FRAMES * 4;
  const canContinue = canContinuePlayback || canContinueScrub;
  if (!canContinue) cancelDecode();
  const last =
    mode === "scrub"
      ? target
      : state.track.durationFrames === null
        ? target + FRAME_WINDOW_AHEAD
        : Math.min(state.track.durationFrames - 1, target + FRAME_WINDOW_AHEAD);
  const retainCeiling =
    (mode === "scrub" ? target : last) + RETAIN_REORDER_SLACK;
  const retainThrough =
    state.track.durationFrames === null
      ? retainCeiling
      : Math.min(state.track.durationFrames - 1, retainCeiling);
  operation = {
    generation,
    target,
    first,
    last,
    retainThrough,
    maxOutputFrame: null,
    copyingFrames: new Set<number>(),
    pendingCopies: new Set(),
    failed: false,
  };
  const targetTimestamp =
    timestampForReferenceFrame(
      target,
      state.track.firstTimestampUs,
      state.track.frameRate,
    ) / 1_000_000;

  try {
    let iterator = state.playIterator;
    if (!canContinue || !iterator) {
      const keyPacket = await state.packetSink.getKeyPacket(targetTimestamp, {
        verifyKeyPackets: true,
      });
      if (generation !== activeGeneration) return;
      if (!keyPacket)
        throw new UnsupportedReferenceError(
          "No keyframe is available before the requested frame.",
        );
      iterator = state.packetSink.packets(keyPacket)[Symbol.asyncIterator]();
      if (mode === "play" || mode === "scrub") state.playIterator = iterator;
    }

    let crossedWindowBoundary = false;
    let reachedEnd = false;
    while (true) {
      if (crossedWindowBoundary) {
        await waitForWindowOutputs(state, generation, last);
        if (
          generation !== activeGeneration ||
          !operation ||
          operation.generation !== generation ||
          operation.failed
        )
          return;
        if (windowOutputsComplete(operation, last)) break;
        /* A window that stays incomplete well past its own end is chasing a
           frame the decoder can no longer produce. Feeding on would walk the
           rest of the source; stop and let the emitted prefix stand, so the
           transport sees one short window instead of a freeze. */
        if ((state.maxFedFrame ?? 0) > last + MAX_DECODE_REORDER) break;
      }
      await waitForQueueCapacity(state, generation);
      if (generation !== activeGeneration) return;
      const result = await iterator.next();
      if (result.done) {
        reachedEnd = true;
        break;
      }
      const packet = result.value;
      if (
        generation !== activeGeneration ||
        !operation ||
        operation.generation !== generation ||
        operation.failed
      )
        return;
      state.decoder.decode(packet.toEncodedVideoChunk());
      const fedFrame = referenceFrameAtTimestamp(
        Math.round(packet.timestamp * 1_000_000),
        state.track.firstTimestampUs,
        state.track.frameRate,
      );
      if (state.maxFedFrame === null || fedFrame > state.maxFedFrame)
        state.maxFedFrame = fedFrame;
      if (packetTimeBeyondWindow(packet, state, last))
        crossedWindowBoundary = true;
    }

    /*
     * VideoDecoder.flush() makes the next chunk require a key frame. A
     * continuous playback and forward scrubbing therefore wait for the last
     * requested output while leaving the decoder configured and their packet
     * iterator intact. Random seeks and end of stream flush, then deliberately
     * abandon that iterator.
     */
    if (mode === "seek" || reachedEnd) await state.decoder.flush();
    const current = operation;
    if (current) await Promise.all(current.pendingCopies);
    if (
      generation !== activeGeneration ||
      !operation ||
      operation.generation !== generation ||
      operation.failed
    )
      return;
    if (!planes.has(target) && !emittedFrames.has(target)) {
      clearPlaneState();
      post({ type: "stalled", generation, frame: target });
      return;
    }
    emitPlanes(generation, first, last);
    for (const [frame, plane] of planes)
      if (frame < first) {
        planes.delete(frame);
        if (
          plane.buffer.byteLength > 0 &&
          recycledBuffers.length < MAX_PLANE_BUFFERS
        )
          recycledBuffers.push(plane.buffer);
      }
    if ((mode === "play" || mode === "scrub") && !reachedEnd)
      state.playTarget = target;
    else {
      state.playIterator = null;
      state.playTarget = null;
      state.maxFedFrame = null;
    }
    for (const emitted of emittedFrames)
      if (emitted < first - MAX_OPEN_FRAMES) emittedFrames.delete(emitted);
    if (generation === activeGeneration) {
      post({ type: "window", generation, target });
    }
  } catch (error) {
    if (generation !== activeGeneration) return;
    failOperation(
      generation,
      boundedReason(error),
      error instanceof UnsupportedReferenceError,
    );
  }
};

const open = async (
  generation: number,
  url: string,
  expected: ExpectedTrack,
  hardwareAcceleration: ReferenceHardwareAcceleration,
): Promise<void> => {
  closeState();
  let reportedResponse = false;
  const input = new Input({
    source: new UrlSource(url, {
      requestInit: { credentials: "same-origin" },
      fetchFn: async (input, init) => {
        const response = await fetch(input, init);
        if (!reportedResponse) {
          reportedResponse = true;
          postOpenStage(
            generation,
            "fetching rendition metadata",
            `HTTP ${String(response.status)}`,
          );
        }
        return response;
      },
    }),
    formats: ALL_FORMATS,
  });
  try {
    if (typeof VideoDecoder === "undefined")
      throw new UnsupportedReferenceError(
        "WebCodecs VideoDecoder is unavailable.",
      );
    postOpenStage(generation, "fetching rendition metadata");
    const track = await input.getPrimaryVideoTrack();
    if (generation !== activeGeneration) {
      input.dispose();
      return;
    }
    if (!track)
      throw new UnsupportedReferenceError("The rendition has no video track.");
    postOpenStage(generation, "reading track contract");
    await finishOpen(generation, input, track, expected, hardwareAcceleration);
  } catch (error) {
    input.dispose();
    if (generation !== activeGeneration) return;
    post({
      type:
        error instanceof UnsupportedReferenceError ? "unsupported" : "error",
      generation,
      reason: boundedReason(error),
    });
  }
};

const finishOpen = async (
  generation: number,
  input: Input,
  inputTrack: InputVideoTrack,
  expected: ExpectedTrack,
  hardwareAcceleration: ReferenceHardwareAcceleration,
): Promise<void> => {
  const [
    config,
    codedWidth,
    codedHeight,
    displayWidth,
    displayHeight,
    colorInit,
    firstTimestamp,
    duration,
  ] = await Promise.all([
    inputTrack.getDecoderConfig(),
    inputTrack.getCodedWidth(),
    inputTrack.getCodedHeight(),
    inputTrack.getDisplayWidth(),
    inputTrack.getDisplayHeight(),
    inputTrack.getColorSpace(),
    inputTrack.getFirstTimestamp(),
    inputTrack.getDurationFromMetadata(),
  ]);
  if (generation !== activeGeneration) {
    input.dispose();
    return;
  }
  if (!config)
    throw new UnsupportedReferenceError(
      "The rendition codec has no WebCodecs configuration.",
    );
  postOpenStage(generation, "qualifying WebCodecs");
  const requestedConfig: VideoDecoderConfig = {
    ...config,
    hardwareAcceleration,
  };
  const support = await VideoDecoder.isConfigSupported(requestedConfig);
  if (!support.supported || !support.config)
    throw new UnsupportedReferenceError(
      "WebCodecs does not support the rendition codec.",
    );
  const supportedConfig = support.config;
  const color = referenceColorFrom(colorInit);
  if (!color)
    throw new UnsupportedReferenceError(
      "Rendition color metadata is incomplete.",
    );
  const firstTimestampUs = Math.round(firstTimestamp * 1_000_000);
  const durationFrames =
    expected.durationFrames ??
    (duration === null
      ? null
      : Math.round(
          ((duration - firstTimestamp) * expected.frameRate.num) /
            expected.frameRate.den,
        ));
  const decodedTrack: DecodedTrack = {
    frameRate: expected.frameRate,
    durationFrames,
    codedWidth,
    codedHeight,
    displayWidth,
    displayHeight,
    codec: supportedConfig.codec,
    decoderPreference: hardwareAcceleration,
    firstTimestampUs,
    color,
    chromaLocation: expected.outputChromaLocation,
  };
  assertExpectedTrack(decodedTrack, expected);

  const packetSink = new EncodedPacketSink(inputTrack);
  const decoder = new VideoDecoder({
    output: handleDecodedFrame,
    error: (error) => {
      const current = operation;
      if (current)
        failOperation(current.generation, boundedReason(error), false);
    },
  });
  decoder.configure(supportedConfig);
  openState = {
    input,
    packetSink,
    decoder,
    config: supportedConfig,
    expected,
    track: decodedTrack,
    playIterator: null,
    playTarget: null,
    maxFedFrame: null,
  };
  post({ type: "ready", generation, track: decodedTrack });
};

const handleCommand = (command: DecoderCommand): void => {
  if (command.type === "release") {
    if (
      command.generation === activeGeneration &&
      command.buffer.byteLength > 0 &&
      recycledBuffers.length < MAX_PLANE_BUFFERS
    )
      recycledBuffers.push(command.buffer);
    return;
  }
  if (
    !Number.isSafeInteger(command.generation) ||
    command.generation <= activeGeneration
  )
    return;
  activeGeneration = command.generation;

  switch (command.type) {
    case "open":
      void open(
        command.generation,
        command.url,
        command.expected,
        command.hardwareAcceleration ?? "no-preference",
      );
      break;
    case "seek":
      void decodeWindow(command.generation, command.frame, "seek");
      break;
    case "scrub":
      void decodeWindow(
        command.generation,
        command.frame,
        command.coarse ? "scrub-coarse" : "scrub",
      );
      break;
    case "play":
      void decodeWindow(
        command.generation,
        command.frame,
        "play",
        command.rate,
      );
      break;
    case "pause":
      cancelDecode();
      break;
    case "close":
      closeState();
      recycledBuffers.length = 0;
      break;
  }
};

port.onmessage = (event): void => {
  handleCommand(event.data);
};
