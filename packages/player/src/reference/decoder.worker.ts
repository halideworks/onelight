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
  MAX_DECODE_QUEUE,
  MAX_OPEN_FRAMES,
  MAX_PLANE_BUFFERS,
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
};

type DecodeOperation = {
  generation: number;
  target: number;
  first: number;
  last: number;
  retainThrough: number;
  lastOutputFrame: number | null;
  pendingCopies: Set<Promise<void>>;
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
    if (current.lastOutputFrame !== null && index < current.lastOutputFrame)
      throw new UnsupportedReferenceError(
        "Decoded frames arrived outside presentation order.",
      );
    current.lastOutputFrame = index;
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
    if (current.pendingCopies.size >= MAX_OPEN_FRAMES) {
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
        }
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
      });
    current.pendingCopies.add(copy);
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
  if (current && current.pendingCopies.size >= MAX_DECODE_QUEUE)
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

const waitForDecoderDrain = async (
  state: OpenState,
  generation: number,
): Promise<void> => {
  while (
    generation === activeGeneration &&
    state.decoder.state === "configured" &&
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

const decodeWindow = async (
  generation: number,
  target: number,
  mode: "seek" | "play",
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

  const first = Math.max(0, target - FRAME_WINDOW_BEHIND);
  const canContinue =
    mode === "play" &&
    state.playIterator !== null &&
    state.playTarget !== null &&
    target >= state.playTarget &&
    target - state.playTarget <= MAX_OPEN_FRAMES * 2 &&
    (planes.has(first) || emittedFrames.has(first));
  if (!canContinue) cancelDecode();
  const last =
    state.track.durationFrames === null
      ? target + FRAME_WINDOW_AHEAD
      : Math.min(state.track.durationFrames - 1, target + FRAME_WINDOW_AHEAD);
  const retainThrough =
    state.track.durationFrames === null
      ? last + 2
      : Math.min(state.track.durationFrames - 1, last + 2);
  operation = {
    generation,
    target,
    first,
    last,
    retainThrough,
    lastOutputFrame: null,
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
      if (mode === "play") state.playIterator = iterator;
    }

    let crossedWindowBoundary = false;
    let reachedEnd = false;
    while (true) {
      if (crossedWindowBoundary) {
        await waitForDecoderDrain(state, generation);
        if (
          generation !== activeGeneration ||
          !operation ||
          operation.generation !== generation ||
          operation.failed
        )
          return;
        if ((operation.lastOutputFrame ?? -1) >= last) break;
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
      if (packetTimeBeyondWindow(packet, state, last))
        crossedWindowBoundary = true;
    }

    /*
     * VideoDecoder.flush() makes the next chunk require a key frame. A
     * continuous window therefore waits for the last requested output while
     * leaving the decoder configured and its packet iterator intact. Random
     * seeks and end of stream flush, then deliberately abandon that iterator.
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
    if (mode === "play" && !reachedEnd) state.playTarget = target;
    else {
      state.playIterator = null;
      state.playTarget = null;
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
    case "play":
      void decodeWindow(command.generation, command.frame, "play");
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
