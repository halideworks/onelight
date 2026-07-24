import { describe, expect, it, vi } from "vitest";
import type {
  DecoderCommand,
  DecoderEvent,
  PlaneTransfer,
} from "./protocol.js";
import { ReferencePictureBackend } from "./reference-backend.js";

class TestWorker {
  onmessage: ((event: MessageEvent<DecoderEvent>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly commands: DecoderCommand[] = [];
  terminated = false;

  postMessage(command: DecoderCommand): void {
    this.commands.push(command);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(event: DecoderEvent): void {
    this.onmessage?.({ data: event } as MessageEvent<DecoderEvent>);
  }
}

const expected = {
  frameRate: { num: 24, den: 1 },
  durationFrames: 100,
  codedWidth: null,
  codedHeight: 1080,
  codec: null,
  outputColor: {
    primaries: "bt709",
    transfer: "bt709",
    matrix: "bt709",
    range: "tv" as const,
  },
  outputChromaLocation: "left" as const,
};

const track = {
  frameRate: expected.frameRate,
  durationFrames: 100,
  codedWidth: 1920,
  codedHeight: 1080,
  displayWidth: 1920,
  displayHeight: 1080,
  codec: "avc1.640028",
  decoderPreference: "no-preference" as const,
  firstTimestampUs: 0,
  color: expected.outputColor,
  chromaLocation: "left" as const,
};

const planes = (seed: number): PlaneTransfer => ({
  format: "I420",
  buffer: new Uint8Array([seed]).buffer,
  layout: [
    { offset: 0, stride: 1 },
    { offset: 0, stride: 1 },
    { offset: 0, stride: 1 },
  ],
  codedWidth: 2,
  codedHeight: 2,
  displayWidth: 2,
  displayHeight: 2,
  codedRect: { x: 0, y: 0, width: 2, height: 2 },
  visibleRect: { x: 0, y: 0, width: 2, height: 2 },
  timestampUs: seed,
  durationUs: 41667,
  color: expected.outputColor,
  chromaLocation: "left",
});

const openBackend = async (
  worker: TestWorker,
  render: (planes: PlaneTransfer, frame: number) => void,
): Promise<ReferencePictureBackend> => {
  const backend = new ReferencePictureBackend(
    { render },
    { workerFactory: () => worker },
  );
  const opening = backend.load({ url: "/proxy.mp4", expected }, 10);
  const open = worker.commands[0];
  expect(open?.type).toBe("open");
  worker.emit({
    type: "ready",
    generation: open?.generation ?? 0,
    track,
  });
  await opening;
  return backend;
};

describe("reference picture backend", () => {
  it("copies the source contract into a structured-clone-safe worker message", async () => {
    const source = { url: "/proxy.mp4", expected };
    const worker = new TestWorker();
    const backend = new ReferencePictureBackend(
      { render: vi.fn() },
      { workerFactory: () => worker },
    );
    const loading = backend.load(source, 0);
    const open = worker.commands[0];
    expect(open?.type).toBe("open");
    if (open?.type !== "open") return;
    expect(open.expected).toEqual(source.expected);
    expect(open.expected).not.toBe(source.expected);
    expect(open.expected.frameRate).not.toBe(source.expected.frameRate);
    expect(open.expected.outputColor).not.toBe(source.expected.outputColor);
    worker.emit({
      type: "ready",
      generation: open.generation,
      track,
    });
    await loading;
    backend.close();
  });

  it("presents only the exact desired frame and retains at most six", async () => {
    const worker = new TestWorker();
    const render = vi.fn<(planes: PlaneTransfer, frame: number) => void>();
    const backend = await openBackend(worker, render);
    const seek = worker.commands.at(-1);
    expect(seek).toMatchObject({ type: "seek", frame: 10 });
    const generation = seek?.generation ?? 0;
    for (let frame = 8; frame <= 14; frame += 1)
      worker.emit({
        type: "frame",
        generation,
        frame,
        planes: planes(frame),
      });
    worker.emit({ type: "window", generation, target: 10 });
    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls.at(-1)?.[1]).toBe(10);
    expect(backend.bufferedFrames.length).toBe(6);
  });

  it("waits for the bounded initial window before playback", async () => {
    const worker = new TestWorker();
    const backend = await openBackend(worker, vi.fn());
    const generation = worker.commands.at(-1)?.generation ?? 0;
    const buffered = backend.waitUntilBuffered(10);
    for (let frame = 10; frame <= 13; frame += 1)
      worker.emit({
        type: "frame",
        generation,
        frame,
        planes: planes(frame),
      });
    await buffered;
    expect(backend.bufferedFrames).toEqual([10, 11, 12, 13]);
  });

  it("lets clock progression finish bounded work but cancels discontinuities", async () => {
    const worker = new TestWorker();
    const backend = await openBackend(worker, vi.fn());
    const pendingCount = worker.commands.length;
    backend.play(10, 1);
    backend.seek(20);
    expect(worker.commands).toHaveLength(pendingCount);
    backend.seek(50, true);
    expect(worker.commands).toHaveLength(pendingCount + 1);
    expect(worker.commands.at(-1)).toMatchObject({
      type: "play",
      frame: 50,
    });
  });

  it("returns evicted plane buffers to the worker pool", async () => {
    const worker = new TestWorker();
    await openBackend(worker, vi.fn());
    const generation = worker.commands.at(-1)?.generation ?? 0;
    for (let frame = 8; frame <= 14; frame += 1)
      worker.emit({
        type: "frame",
        generation,
        frame,
        planes: planes(frame),
      });
    expect(worker.commands.some((command) => command.type === "release")).toBe(
      true,
    );
  });

  it("keeps an arriving exact frame alive while enforcing the cache bound", async () => {
    const worker = new TestWorker();
    const render = vi.fn<(planes: PlaneTransfer, frame: number) => void>();
    const backend = await openBackend(worker, render);
    const generation = worker.commands.at(-1)?.generation ?? 0;
    for (let frame = 4; frame <= 9; frame += 1)
      worker.emit({
        type: "frame",
        generation,
        frame,
        planes: planes(frame),
      });
    const exact = planes(10);
    worker.emit({
      type: "frame",
      generation,
      frame: 10,
      planes: exact,
    });
    expect(render).toHaveBeenCalledWith(exact, 10);
    expect(backend.bufferedFrames).toHaveLength(6);
    const release = [...worker.commands]
      .reverse()
      .find((command) => command.type === "release");
    expect(release).toMatchObject({ type: "release" });
    if (release?.type === "release")
      expect(release.buffer).not.toBe(exact.buffer);
  });

  it("cancels stale window events after a newer seek", async () => {
    const worker = new TestWorker();
    const render = vi.fn<(planes: PlaneTransfer, frame: number) => void>();
    const backend = await openBackend(worker, render);
    const firstGeneration = worker.commands.at(-1)?.generation ?? 0;
    backend.seek(50);
    const secondGeneration = worker.commands.at(-1)?.generation ?? 0;
    expect(secondGeneration).toBeGreaterThan(firstGeneration);
    worker.emit({
      type: "frame",
      generation: firstGeneration,
      frame: 10,
      planes: planes(10),
    });
    worker.emit({
      type: "frame",
      generation: secondGeneration,
      frame: 50,
      planes: planes(50),
    });
    expect(render.mock.calls.at(-1)?.[1]).toBe(50);
  });

  it("reports one bounded failure and terminates cleanly", async () => {
    const worker = new TestWorker();
    const failure = vi.fn();
    const backend = new ReferencePictureBackend(
      { render: vi.fn(), onFailure: failure },
      { workerFactory: () => worker },
    );
    const opening = backend.load({ url: "/proxy.mp4", expected }, 10);
    const generation = worker.commands[0]?.generation ?? 0;
    worker.emit({
      type: "unsupported",
      generation,
      reason: `VideoDecoder unsupported ${"x".repeat(1000)}`,
    });
    await expect(opening).rejects.toThrow("VideoDecoder unsupported");
    worker.emit({
      type: "unsupported",
      generation,
      reason: "another failure",
    });
    expect(failure).toHaveBeenCalledTimes(1);
    expect(failure.mock.calls[0]?.[0].reason.length).toBeLessThanOrEqual(500);
    backend.close();
    expect(worker.terminated).toBe(true);
  });

  it("fails closed when worker open never returns", async () => {
    vi.useFakeTimers();
    try {
      const worker = new TestWorker();
      const failure = vi.fn();
      const backend = new ReferencePictureBackend(
        { render: vi.fn(), onFailure: failure },
        {
          workerFactory: () => worker,
          openTimeoutMs: 25,
        },
      );
      const opening = backend.load({ url: "/proxy.mp4", expected }, 10);
      const rejection = expect(opening).rejects.toThrow(
        "timed out while starting decoder worker",
      );
      await vi.advanceTimersByTimeAsync(25);
      await rejection;
      expect(failure).toHaveBeenCalledOnce();
      expect(failure.mock.calls[0]?.[0].failureClass).toBe("decode");
      backend.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
