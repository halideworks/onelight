<script lang="ts">
  import {
    frameAtCurrentTime,
    frameAtMediaTime,
    frameDuration,
    mediaTimeForFrameMiddle
  } from './frame-clock.js';
  import {
    SUPPORTED_RATES,
    formatTimecode,
    isDropFrameRate,
    timecodeFromFrames
  } from '@onelight/core';
  import AnnotationOverlay from './AnnotationOverlay.svelte';
  import Timeline from './Timeline.svelte';
  import type { AnnotationStroke, FrameAnnotation, PendingDrawing } from './annotations.js';
  import type { TimelineMarker } from './timeline.js';
  import type { PlayerRendition, SurroundMode, WatermarkOverlay } from './options.js';

  let {
    src,
    rate = { num: 24, den: 1 },
    dropFrame = false,
    captionsSrc = undefined,
    annotations = [],
    durationFrames = null,
    markers = [],
    renditions = [],
    allowDrawing = false,
    watermark = null,
    onframechange = undefined,
    onmarkerselect = undefined,
    ondrawingchange = undefined
  }: {
    src: string;
    rate?: { num: number; den: number };
    dropFrame?: boolean;
    captionsSrc?: string | undefined;
    annotations?: FrameAnnotation[];
    durationFrames?: number | null;
    markers?: TimelineMarker[];
    renditions?: PlayerRendition[];
    allowDrawing?: boolean;
    watermark?: WatermarkOverlay | null;
    onframechange?: ((frame: number) => void) | undefined;
    onmarkerselect?: ((markerId: string, frame: number) => void) | undefined;
    ondrawingchange?: ((drawing: PendingDrawing | null) => void) | undefined;
  } = $props();

  let video: HTMLVideoElement | undefined = $state();
  let videoWidth = $state(0);
  let videoHeight = $state(0);
  let frame = $state(0);
  let inFrame = $state<number | null>(null);
  let outFrame = $state<number | null>(null);
  let loop = $state(false);
  let hasRvfc = $state(false);
  let forwardSpeed = $state(0);
  let reverseSpeed = $state(0);
  let reverseTimer: ReturnType<typeof setInterval> | null = null;
  let rvfcStarted = false;

  const rateSupported = $derived(
    SUPPORTED_RATES.some((candidate) => candidate.num === rate.num && candidate.den === rate.den)
  );
  const timecode = $derived(
    rateSupported ? formatTimecode(timecodeFromFrames(frame, rate, dropFrame && isDropFrameRate(rate))) : null
  );
  const rateLabel = $derived(rate.den === 1 ? String(rate.num) : (rate.num / rate.den).toFixed(3));

  /* ---- rendition ladder ---- */
  const RUNG_HEIGHTS: Record<string, number> = { proxy_540: 540, proxy_1080: 1080, proxy_2160: 2160 };
  const RUNG_LABELS: Record<string, string> = { proxy_540: '540', proxy_1080: '1080', proxy_2160: '4K' };
  const ladder = $derived(
    renditions
      .filter((rendition) => RUNG_HEIGHTS[rendition.kind] !== undefined && rendition.url)
      .slice()
      .sort((a, b) => (RUNG_HEIGHTS[a.kind] ?? 0) - (RUNG_HEIGHTS[b.kind] ?? 0))
  );
  let quality = $state('auto');
  let currentSrc = $state('');
  let pendingRestore: { frame: number; playing: boolean; playbackRate: number } | null = null;

  /* Auto heuristic: the highest rung whose height does not exceed the stage
     in device pixels. The stage can never be taller than the viewport, so
     the bound is innerHeight x devicePixelRatio; below the lowest rung the
     lowest is used. Evaluated when the ladder or the selection changes, not
     continuously on resize, so playback does not flap between rungs while a
     window is dragged. */
  const autoRungUrl = (): string | null => {
    const first = ladder[0];
    if (!first) return null;
    const ratio = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    const bound = (typeof innerHeight === 'number' ? innerHeight : 1080) * ratio;
    let choice = first;
    for (const rung of ladder) {
      if ((RUNG_HEIGHTS[rung.kind] ?? Infinity) <= bound) choice = rung;
    }
    return choice.url;
  };

  const resolveSrc = (): string => {
    if (quality !== 'auto') {
      const pick = ladder.find((rung) => rung.kind === quality);
      if (pick) return pick.url;
    }
    return autoRungUrl() ?? src;
  };

  /* Rendition switching preserves the current frame: capture frame and play
     state, swap src, then loadedmetadata seeks back to the frame middle and
     restores playback. */
  $effect(() => {
    void quality;
    void ladder;
    void src;
    const next = resolveSrc();
    if (!next || next === currentSrc) return;
    if (!currentSrc || !video) {
      currentSrc = next;
      return;
    }
    stopReverse();
    pendingRestore = { frame, playing: !video.paused, playbackRate: video.playbackRate };
    video.pause();
    currentSrc = next;
  });

  /* ---- surround (design doc 24.1): stage background only, per user ---- */
  const SURROUND_KEY = 'onelight.surround';
  let surround = $state<SurroundMode>('dark');
  $effect(() => {
    try {
      const stored = localStorage.getItem(SURROUND_KEY);
      if (stored === 'dark' || stored === 'grey18' || stored === 'black') surround = stored;
    } catch {
      /* Storage can be unavailable; the default surround stands. */
    }
  });
  const setSurround = (mode: SurroundMode): void => {
    surround = mode;
    try {
      localStorage.setItem(SURROUND_KEY, mode);
    } catch {
      /* Non-persistent surround is still applied for the session. */
    }
  };
  /* All three surrounds are R=G=B: near-black, 18% grey, true black. */
  const surroundColor = $derived(
    surround === 'grey18' ? 'var(--grey-18, #7a7a7a)' : surround === 'black' ? '#000000' : 'var(--n-000, #0a0a0a)'
  );

  /* ---- drawing ---- */
  const INK_NEUTRAL = '#e9e9e9'; /* --n-900, neutral-safe ink */
  const INK_ACCENT = '#a5605a'; /* --warn, the one functional accent */
  const DRAW_WIDTH = 0.004; /* normalized fraction of the frame diagonal */
  let drawMode = $state(false);
  let drawTool = $state<'pen' | 'arrow' | 'rect'>('pen');
  let drawInk = $state<'neutral' | 'accent'>('accent');
  let pendingStrokes = $state<AnnotationStroke[]>([]);
  let drawingFrame = $state<number | null>(null);

  const emitDrawing = (): void => {
    ondrawingchange?.(
      pendingStrokes.length && drawingFrame !== null
        ? { frame: drawingFrame, strokes: pendingStrokes }
        : null
    );
  };

  const toggleDraw = (): void => {
    if (!allowDrawing) return;
    drawMode = !drawMode;
    if (drawMode) {
      pausePlayback();
      if (pendingStrokes.length === 0) drawingFrame = frame;
    } else if (pendingStrokes.length === 0) {
      drawingFrame = null;
    }
  };

  const commitStroke = (stroke: AnnotationStroke): void => {
    if (pendingStrokes.length === 0) drawingFrame = frame;
    pendingStrokes = [...pendingStrokes, stroke];
    emitDrawing();
  };

  const undoStroke = (): void => {
    pendingStrokes = pendingStrokes.slice(0, -1);
    if (pendingStrokes.length === 0 && !drawMode) drawingFrame = null;
    emitDrawing();
  };

  const clearStrokes = (): void => {
    pendingStrokes = [];
    if (!drawMode) drawingFrame = null;
    emitDrawing();
  };

  /* Hosts call this after attaching the drawing to a posted comment. */
  export function clearDrawing(): void {
    pendingStrokes = [];
    drawingFrame = null;
    drawMode = false;
    ondrawingchange?.(null);
  }

  const activeStrokes = $derived([
    ...annotations
      .filter((annotation) => annotation.frame === frame)
      .flatMap((annotation) => annotation.strokes),
    ...(drawingFrame === frame ? pendingStrokes : [])
  ]);

  /* ---- watermark (deterrent-grade session overlay, design doc section 11:
     a DOM layer over the footage that identifies the viewer; it is
     removable with DevTools and is documented as such. The tamper-resistant
     path is the burned per-link rendition). ---- */
  const wmLines = $derived((watermark?.lines ?? []).filter((line) => line && line.trim()));
  const wmMode = $derived(watermark?.mode ?? 'tile');
  const wmOpacity = $derived(Math.min(0.8, Math.max(0.05, watermark?.opacity ?? 0.28)));
  const wmText = $derived(wmLines.join('  '));

  const setFrame = (next: number): void => {
    if (next !== frame) {
      frame = next;
      onframechange?.(next);
    }
    if (loop && video && inFrame !== null && outFrame !== null && inFrame < outFrame && next >= outFrame) {
      video.currentTime = mediaTimeForFrameMiddle(inFrame, rate);
    }
  };

  /* rVFC chain: when requestVideoFrameCallback exists it is the only frame
     source. Frame identity comes from the presented mediaTime, never from
     currentTime. */
  const rvfcLoop = (_now: number, metadata: VideoFrameCallbackMetadata): void => {
    setFrame(frameAtMediaTime(metadata.mediaTime, rate));
    video?.requestVideoFrameCallback(rvfcLoop);
  };

  /* Non-rVFC fallback only. */
  const handleTimeUpdate = (): void => {
    if (!video) return;
    setFrame(frameAtCurrentTime(video.currentTime, rate));
  };

  const handleLoadedMetadata = (): void => {
    if (!video) return;
    hasRvfc = 'requestVideoFrameCallback' in video;
    if (hasRvfc && !rvfcStarted) {
      rvfcStarted = true;
      video.requestVideoFrameCallback(rvfcLoop);
    }
    if (pendingRestore) {
      const restore = pendingRestore;
      pendingRestore = null;
      seekFrame(restore.frame);
      if (restore.playing) {
        video.playbackRate = restore.playbackRate;
        void video.play();
      }
    }
    if (!hasRvfc) handleTimeUpdate();
  };

  const boundedFrame = (targetFrame: number): number => {
    const next = Math.max(0, Math.round(targetFrame));
    return durationFrames !== null && durationFrames !== undefined && durationFrames > 0
      ? Math.min(next, durationFrames - 1)
      : next;
  };

  /* Seek to frame middle. With rVFC, verify the presented mediaTime maps to
     the target frame and re-seek once if it does not. */
  const seekFrame = (targetFrame: number): void => {
    if (!video) return;
    const next = boundedFrame(targetFrame);
    video.currentTime = mediaTimeForFrameMiddle(next, rate);
    if (hasRvfc) {
      let retried = false;
      const verify = (_now: number, metadata: VideoFrameCallbackMetadata): void => {
        if (!video || retried) return;
        if (frameAtMediaTime(metadata.mediaTime, rate) !== next) {
          retried = true;
          video.currentTime = mediaTimeForFrameMiddle(next, rate);
        }
      };
      video.requestVideoFrameCallback(verify);
    } else {
      setFrame(next);
    }
  };

  const stopReverse = (): void => {
    if (reverseTimer !== null) {
      clearInterval(reverseTimer);
      reverseTimer = null;
    }
    reverseSpeed = 0;
  };

  const jumpTo = (targetFrame: number): void => {
    if (!video) return;
    stopReverse();
    forwardSpeed = 0;
    video.pause();
    seekFrame(targetFrame);
  };

  const step = (amount: number): void => {
    jumpTo(frame + amount);
  };

  const pausePlayback = (): void => {
    if (!video) return;
    stopReverse();
    forwardSpeed = 0;
    video.pause();
  };

  const playForward = (): void => {
    if (!video) return;
    const wasPlayingForward = !video.paused && forwardSpeed > 0 && reverseTimer === null;
    stopReverse();
    forwardSpeed = wasPlayingForward ? Math.min(4, forwardSpeed * 2) : 1;
    video.playbackRate = forwardSpeed;
    void video.play();
  };

  /* HTMLMediaElement cannot play backward: reverse shuttle is emulated by a
     stepping timer that seeks back speed frames per frame-duration tick. */
  const playReverse = (): void => {
    if (!video) return;
    video.pause();
    forwardSpeed = 0;
    reverseSpeed = reverseSpeed > 0 ? Math.min(4, reverseSpeed * 2) : 1;
    if (reverseTimer === null) {
      reverseTimer = setInterval(
        () => {
          if (!video) return;
          const nextTime = video.currentTime - reverseSpeed * frameDuration(rate);
          if (nextTime <= 0) {
            video.currentTime = mediaTimeForFrameMiddle(0, rate);
            stopReverse();
          } else {
            video.currentTime = nextTime;
          }
          if (!hasRvfc) handleTimeUpdate();
        },
        Math.max(16, Math.round(1000 * frameDuration(rate)))
      );
    }
  };

  export function seekToFrame(targetFrame: number): void {
    jumpTo(targetFrame);
  }

  const handleMarkerSelect = (markerId: string, markerFrame: number): void => {
    jumpTo(markerFrame);
    onmarkerselect?.(markerId, markerFrame);
  };

  const handleKeydown = (event: KeyboardEvent): void => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target.isContentEditable)
    )
      return;
    const key = event.key.toLowerCase();
    if (allowDrawing && key === 'd') {
      event.preventDefault();
      toggleDraw();
      return;
    }
    if (drawMode) {
      /* Transport shortcuts are suspended while drawing is armed so drawing
         gestures and tool use cannot scrub or restart playback. */
      if (event.key === 'Escape') {
        event.preventDefault();
        toggleDraw();
      }
      return;
    }
    if (event.key === 'ArrowLeft') { event.preventDefault(); step(event.shiftKey ? -10 : -1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); step(event.shiftKey ? 10 : 1); }
    if (event.key === 'Home') { event.preventDefault(); jumpTo(0); }
    if (event.key === 'End' && durationFrames && durationFrames > 0) {
      event.preventDefault();
      jumpTo(durationFrames - 1);
    }
    if (key === 'j') { event.preventDefault(); playReverse(); }
    if (key === 'k') { event.preventDefault(); pausePlayback(); }
    if (key === 'l') { event.preventDefault(); playForward(); }
    if (key === 'i') inFrame = frame;
    if (key === 'o') outFrame = frame;
  };

  /* Window resize does not fire the video element's resize event (that event
     is for intrinsic size changes), so track layout size with a ResizeObserver. */
  $effect(() => {
    if (!video) return;
    const element = video;
    const measure = (): void => {
      videoWidth = element.clientWidth;
      videoHeight = element.clientHeight;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  });

  $effect(() => {
    return () => {
      if (reverseTimer !== null) clearInterval(reverseTimer);
    };
  });
</script>

<svelte:window onkeydown={handleKeydown} />
<section class="player" aria-label="Review player">
  <div class="stage" style:background={surroundColor}>
    <div class="frame-box">
      <video
        bind:this={video}
        src={currentSrc || src}
        controls={!drawMode}
        playsinline
        ontimeupdate={hasRvfc ? undefined : handleTimeUpdate}
        onloadedmetadata={handleLoadedMetadata}
      >
        <track kind="captions" srclang="en" label="English captions" src={captionsSrc ?? 'data:text/vtt;charset=utf-8,WEBVTT'} />
      </video>
      <AnnotationOverlay
        strokes={activeStrokes}
        width={videoWidth}
        height={videoHeight}
        interactive={drawMode}
        tool={drawTool}
        color={drawInk === 'accent' ? INK_ACCENT : INK_NEUTRAL}
        strokeWidth={DRAW_WIDTH}
        onstroke={commitStroke}
      />
      {#if wmLines.length}
        <div
          class="watermark"
          class:tiled={wmMode === 'tile'}
          data-position={watermark?.position ?? 'bottom_right'}
          style:opacity={wmOpacity}
          aria-hidden="true"
        >
          {#if wmMode === 'tile'}
            {#each Array.from({ length: 12 }, (_v, index) => index) as cell (cell)}
              <span class="wm-cell">{wmText}</span>
            {/each}
          {:else}
            <span class="wm-cell">{wmText}</span>
          {/if}
        </div>
      {/if}
    </div>
  </div>
  <div class="transport">
    <div class="transport-row">
      <button type="button" onclick={() => step(-1)} aria-label="Previous frame">Previous frame</button>
      <button type="button" onclick={() => step(1)} aria-label="Next frame">Next frame</button>
      <span class="readout">
        {#if timecode}<span class="tc tc-main">{timecode}</span>{/if}
        <span class="tc tc-sub">{frame} fr&nbsp; {rateLabel}{dropFrame && isDropFrameRate(rate) ? ' DF' : ''}</span>
      </span>
      <button type="button" onclick={() => { inFrame = frame; }} aria-label="Set loop in">Set in</button>
      <button type="button" onclick={() => { outFrame = frame; }} aria-label="Set loop out">Set out</button>
      <button type="button" aria-pressed={loop} onclick={() => { loop = !loop; }}>Loop</button>
    </div>
    <div class="transport-row settings">
      {#if allowDrawing}
        <button type="button" aria-pressed={drawMode} onclick={toggleDraw}>Draw</button>
        {#if drawMode}
          <div class="seg" role="group" aria-label="Drawing tool">
            <button type="button" aria-pressed={drawTool === 'pen'} onclick={() => { drawTool = 'pen'; }}>Pen</button>
            <button type="button" aria-pressed={drawTool === 'arrow'} onclick={() => { drawTool = 'arrow'; }}>Arrow</button>
            <button type="button" aria-pressed={drawTool === 'rect'} onclick={() => { drawTool = 'rect'; }}>Rect</button>
          </div>
          <div class="seg" role="group" aria-label="Ink color">
            <button type="button" aria-pressed={drawInk === 'accent'} onclick={() => { drawInk = 'accent'; }}>Accent</button>
            <button type="button" aria-pressed={drawInk === 'neutral'} onclick={() => { drawInk = 'neutral'; }}>Grey</button>
          </div>
          <button type="button" onclick={undoStroke} disabled={pendingStrokes.length === 0}>Undo</button>
          <button type="button" onclick={clearStrokes} disabled={pendingStrokes.length === 0}>Clear</button>
        {/if}
      {/if}
      <span class="grow"></span>
      <span class="ctl-label" id="surround-label">Surround</span>
      <div class="seg" role="group" aria-labelledby="surround-label">
        <button type="button" aria-pressed={surround === 'dark'} onclick={() => setSurround('dark')}>Dark</button>
        <button type="button" aria-pressed={surround === 'grey18'} onclick={() => setSurround('grey18')}>18% Grey</button>
        <button type="button" aria-pressed={surround === 'black'} onclick={() => setSurround('black')}>Black</button>
      </div>
      {#if ladder.length}
        <span class="ctl-label" id="quality-label">Quality</span>
        <div class="seg" role="group" aria-labelledby="quality-label">
          <button type="button" aria-pressed={quality === 'auto'} onclick={() => { quality = 'auto'; }}>Auto</button>
          {#each ladder as rung (rung.kind)}
            <button type="button" aria-pressed={quality === rung.kind} onclick={() => { quality = rung.kind; }}>
              {RUNG_LABELS[rung.kind] ?? rung.kind}
            </button>
          {/each}
        </div>
      {/if}
    </div>
    {#if durationFrames !== null && durationFrames !== undefined && durationFrames > 0}
      <Timeline
        {frame}
        {durationFrames}
        {rate}
        dropFrame={dropFrame && isDropFrameRate(rate)}
        {inFrame}
        {outFrame}
        {markers}
        onseek={jumpTo}
        onmarkerselect={handleMarkerSelect}
      />
    {/if}
  </div>
  <p class="range tc">{inFrame === null ? 'In not set' : `In ${inFrame}`}, {outFrame === null ? 'Out not set' : `Out ${outFrame}`}</p>
</section>

<style>
  /* Review room world: strictly neutral, R=G=B, no gradients, no tinted
     chrome. The stage background is the surround control's territory. */
  .player { background: var(--n-050, #101010); color: var(--n-800, #c4c4c4); padding: 16px; }
  .stage { display: grid; place-items: center; min-height: 120px; }
  .frame-box { position: relative; max-width: 100%; }
  video { display: block; max-width: 100%; max-height: 72vh; background: #000000; }
  .watermark {
    position: absolute;
    inset: 0;
    pointer-events: none;
    overflow: hidden;
    color: #ffffff;
    font-size: 13px;
    z-index: 2;
  }
  .watermark.tiled {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    grid-template-rows: repeat(4, 1fr);
    place-items: center;
  }
  .watermark.tiled .wm-cell { transform: rotate(-24deg); white-space: nowrap; }
  .watermark:not(.tiled) { display: flex; padding: 12px; }
  .watermark:not(.tiled)[data-position='top_left'] { align-items: flex-start; justify-content: flex-start; }
  .watermark:not(.tiled)[data-position='top_right'] { align-items: flex-start; justify-content: flex-end; }
  .watermark:not(.tiled)[data-position='bottom_left'] { align-items: flex-end; justify-content: flex-start; }
  .watermark:not(.tiled)[data-position='bottom_right'] { align-items: flex-end; justify-content: flex-end; }
  .watermark:not(.tiled)[data-position='center'] { align-items: center; justify-content: center; }
  .transport { padding-top: 12px; font-family: var(--font-ui, system-ui); }
  .transport-row { display: flex; align-items: center; justify-content: center; gap: 12px; flex-wrap: wrap; }
  .transport-row.settings { margin-top: 10px; justify-content: flex-start; }
  .grow { flex: 1; }
  .readout { display: grid; text-align: center; gap: 2px; }
  .tc { font-variant-numeric: tabular-nums; letter-spacing: 0.02em; }
  .tc-main { font-size: 16px; color: var(--n-900, #e9e9e9); }
  .tc-sub { font-size: 12px; color: var(--n-600, #767676); }
  .ctl-label { font-size: 13px; color: var(--n-600, #767676); }
  button { border: 0; border-radius: 3px; background: var(--n-200, #232323); color: var(--n-800, #c4c4c4); padding: 8px 12px; font-size: 13px; }
  button:hover { background: var(--n-300, #2e2e2e); color: var(--n-900, #e9e9e9); }
  button:disabled { color: var(--n-500, #565656); background: var(--n-150, #1c1c1c); }
  button[aria-pressed='true'] { background: var(--n-400, #3d3d3d); color: var(--n-900, #e9e9e9); }
  button:focus-visible { outline: 1px solid var(--n-800, #c4c4c4); outline-offset: 2px; }
  .seg { display: flex; gap: 2px; background: var(--n-150, #1c1c1c); border-radius: 3px; padding: 2px; }
  .seg button { background: none; padding: 5px 10px; }
  .seg button[aria-pressed='true'] { background: var(--n-400, #3d3d3d); color: var(--n-900, #e9e9e9); }
  .range { margin: 10px 0 0; text-align: center; color: var(--n-600, #767676); font-size: 13px; }
</style>
