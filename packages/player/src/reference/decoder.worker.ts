import {
  ALL_FORMATS,
  EncodedPacketSink,
  Input,
  UrlSource,
  type EncodedPacket,
  type InputVideoTrack,
} from "mediabunny";
import { FrameWindow } from "./frame-window.js";
import {
  MAX_DECODE_QUEUE,
  referenceFrameAtTimestamp,
  referenceTimestampIsExact,
  timestampForReferenceFrame,
  type DecodedTrack,
  type DecoderCommand,
  type DecoderEvent,
  type ExpectedTrack,
  type PlaneTransfer,
  type ReferenceColorContract,
} from "./protocol.js";

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
};

type DecodeOperation = {
  generation: number;
  target: number;
  lastOutputFrame: number | null;
  failed: boolean;
};

class UnsupportedReferenceError extends Error {}

const port = globalThis as unknown as WorkerPort;
const frames = new FrameWindow<VideoFrame>();
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

const colorFrom = (
  value: VideoColorSpace | VideoColorSpaceInit,
): ReferenceColorContract | null => {
  const primaries = value.primaries;
  const transfer = value.transfer;
  const matrix = value.matrix;
  const fullRange = value.fullRange;
  if (
    typeof primaries !== "string" ||
    typeof transfer !== "string" ||
    typeof matrix !== "string" ||
    typeof fullRange !== "boolean"
  )
    return null;
  return {
    primaries,
    transfer,
    matrix,
    range: fullRange ? "pc" : "tv",
  };
};

const colorsAgree = (
  actual: ReferenceColorContract,
  expected: ReferenceColorContract,
): boolean =>
  actual.primaries === expected.primaries &&
  actual.transfer === expected.transfer &&
  actual.matrix === expected.matrix &&
  actual.range === expected.range;

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
  if (expected.codec !== null && actual.codec !== expected.codec)
    throw new UnsupportedReferenceError(
      "Rendition codec does not match the decoder contract.",
    );
  if (!colorsAgree(actual.color, expected.outputColor))
    throw new UnsupportedReferenceError(
      "Rendition color metadata does not match the decoder contract.",
    );
};

const resetDecoder = (state: OpenState): void => {
  if (state.decoder.state === "closed") return;
  state.decoder.reset();
  state.decoder.configure(state.config);
};

const cancelDecode = (): void => {
  operation = null;
  frames.clear();
  if (openState) resetDecoder(openState);
};

const closeState = (): void => {
  operation = null;
  frames.clear();
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
  frames.clear();
  post({
    type: unsupported ? "unsupported" : "error",
    generation,
    reason: reason.slice(0, 500),
  });
};

const handleDecodedFrame = (frame: VideoFrame): void => {
  const state = openState;
  const current = operation;
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
    frames.insert(index, frame);
  } catch (error) {
    frame.close();
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

const copyFramePlanes = async (
  frame: VideoFrame,
  expectedColor: ReferenceColorContract,
): Promise<PlaneTransfer> => {
  if (frame.format !== "I420" && frame.format !== "NV12")
    throw new UnsupportedReferenceError(
      `Decoded pixel format ${frame.format ?? "unknown"} is not I420 or NV12.`,
    );
  const color = colorFrom(frame.colorSpace);
  if (!color)
    throw new UnsupportedReferenceError(
      "Decoded frame color metadata is incomplete.",
    );
  if (!colorsAgree(color, expectedColor))
    throw new UnsupportedReferenceError(
      "Decoded frame color metadata conflicts with rendition metadata.",
    );

  const buffer = new ArrayBuffer(frame.allocationSize());
  const layout = await frame.copyTo(buffer);
  const visible = frame.visibleRect ?? {
    x: 0,
    y: 0,
    width: frame.codedWidth,
    height: frame.codedHeight,
  };
  return {
    format: frame.format,
    buffer,
    layout: layout.map((plane) => ({
      offset: plane.offset,
      stride: plane.stride,
    })),
    codedWidth: frame.codedWidth,
    codedHeight: frame.codedHeight,
    displayWidth: frame.displayWidth,
    displayHeight: frame.displayHeight,
    visibleRect: {
      x: visible.x,
      y: visible.y,
      width: visible.width,
      height: visible.height,
    },
    timestampUs: frame.timestamp,
    durationUs: frame.duration,
    color,
  };
};

const emitFrames = async (
  state: OpenState,
  generation: number,
): Promise<void> => {
  const decoded = frames.drain();
  for (let index = 0; index < decoded.length; index += 1) {
    const entry = decoded[index];
    if (!entry) continue;
    if (generation !== activeGeneration) {
      for (const remaining of decoded.slice(index)) remaining.value.close();
      return;
    }
    try {
      const planes = await copyFramePlanes(
        entry.value,
        state.expected.outputColor,
      );
      entry.value.close();
      if (generation !== activeGeneration) return;
      post({ type: "frame", generation, frame: entry.frame, planes }, [
        planes.buffer,
      ]);
    } catch (error) {
      entry.value.close();
      for (const remaining of decoded.slice(index + 1)) remaining.value.close();
      failOperation(
        generation,
        boundedReason(error),
        error instanceof UnsupportedReferenceError,
      );
      return;
    }
  }
};

const decodeWindow = async (
  generation: number,
  target: number,
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

  cancelDecode();
  operation = {
    generation,
    target,
    lastOutputFrame: null,
    failed: false,
  };
  frames.setTarget(target);

  const { last } = frames.bounds;
  const targetTimestamp =
    timestampForReferenceFrame(
      target,
      state.track.firstTimestampUs,
      state.track.frameRate,
    ) / 1_000_000;

  try {
    const keyPacket = await state.packetSink.getKeyPacket(targetTimestamp, {
      verifyKeyPackets: true,
    });
    if (generation !== activeGeneration) return;
    if (!keyPacket)
      throw new UnsupportedReferenceError(
        "No keyframe is available before the requested frame.",
      );

    let beyondWindow = 0;
    for await (const packet of state.packetSink.packets(keyPacket)) {
      if (
        generation !== activeGeneration ||
        !operation ||
        operation.generation !== generation ||
        operation.failed
      )
        return;
      await waitForQueueCapacity(state, generation);
      if (generation !== activeGeneration) return;
      state.decoder.decode(packet.toEncodedVideoChunk());
      if (packetTimeBeyondWindow(packet, state, last)) {
        beyondWindow += 1;
        if (beyondWindow >= 3) break;
      }
    }

    await state.decoder.flush();
    if (
      generation !== activeGeneration ||
      !operation ||
      operation.generation !== generation ||
      operation.failed
    )
      return;
    if (!frames.has(target)) {
      frames.clear();
      post({ type: "stalled", generation, frame: target });
      return;
    }
    await emitFrames(state, generation);
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
): Promise<void> => {
  closeState();
  const input = new Input({
    source: new UrlSource(url),
    formats: ALL_FORMATS,
  });
  try {
    if (typeof VideoDecoder === "undefined")
      throw new UnsupportedReferenceError(
        "WebCodecs VideoDecoder is unavailable.",
      );
    const track = await input.getPrimaryVideoTrack();
    if (generation !== activeGeneration) {
      input.dispose();
      return;
    }
    if (!track)
      throw new UnsupportedReferenceError("The rendition has no video track.");
    await finishOpen(generation, input, track, expected);
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
  const support = await VideoDecoder.isConfigSupported(config);
  if (!support.supported || !support.config)
    throw new UnsupportedReferenceError(
      "WebCodecs does not support the rendition codec.",
    );
  const supportedConfig = support.config;
  const color = colorFrom(colorInit);
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
    firstTimestampUs,
    color,
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
  };
  post({ type: "ready", generation, track: decodedTrack });
};

const handleCommand = (command: DecoderCommand): void => {
  if (
    !Number.isSafeInteger(command.generation) ||
    command.generation <= activeGeneration
  )
    return;
  activeGeneration = command.generation;

  switch (command.type) {
    case "open":
      void open(command.generation, command.url, command.expected);
      break;
    case "seek":
      void decodeWindow(command.generation, command.frame);
      break;
    case "play":
      void decodeWindow(command.generation, command.frame);
      break;
    case "pause":
      cancelDecode();
      break;
    case "close":
      closeState();
      break;
  }
};

port.onmessage = (event): void => {
  handleCommand(event.data);
};
