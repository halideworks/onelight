<script lang="ts">
  import {
    frameAtCurrentTime,
    frameAtMediaTime,
    frameDuration,
    mediaTimeInsideFrame
  } from './frame-clock.js';
  import {
    SUPPORTED_RATES,
    formatTimecode,
    isDropFrameRate,
    timecodeFromFrames
  } from '@onelight/core';
  import AnnotationOverlay from './AnnotationOverlay.svelte';
  import Timeline from './Timeline.svelte';
  import { isVerifyStale, seeksLocked } from './transport-state.js';
  import type { AnnotationStroke, FrameAnnotation, PendingDrawing } from './annotations.js';
  import type { TimelineMarker } from './timeline.js';
  import type { SpriteCue } from './filmstrip.js';
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
    filmstrip = null,
    waveformUrl = null,
    onframechange = undefined,
    onmarkerselect = undefined,
    ondrawingchange = undefined,
    onplaystate = undefined
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
    filmstrip?: { url: string; cues: SpriteCue[] } | null;
    waveformUrl?: string | null;
    onframechange?: ((frame: number) => void) | undefined;
    onmarkerselect?: ((markerId: string, frame: number) => void) | undefined;
    ondrawingchange?: ((drawing: PendingDrawing | null) => void) | undefined;
    onplaystate?: ((playing: boolean) => void) | undefined;
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
  /* The transport chrome is ours, not the browser's. Native controls duplicated
     a transport this player already has -- and does better: frame steps, JKL
     shuttle, in/out, a filmstrip scrubber -- while putting their own scrubber,
     timer and focus ring right against the footage, in a room the design doc
     requires to stay strictly neutral. */
  let frameBox = $state<HTMLDivElement | null>(null);
  let muted = $state(false);
  let volume = $state(1);
  let fullscreen = $state(false);
  /* Reverse is emulated by a timer with the element paused, so "playing" is not
     video.paused: it is either shuttle direction being live. */
  const playing = $derived(forwardSpeed > 0 || reverseSpeed > 0);
  const shuttleLabel = $derived(
    reverseSpeed > 1 ? `${String(reverseSpeed)}x rev` : forwardSpeed > 1 ? `${String(forwardSpeed)}x` : ''
  );

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
     state, swap src, then loadedmetadata seeks back into the frame and
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
    /* Preserve the first capture across back-to-back switches: a second switch
       effect must not re-read the already-paused state and lose the fact that
       playback was running before the first swap. */
    pendingRestore ??= { frame, playing: !video.paused, playbackRate: video.playbackRate };
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
    surround === 'grey18' ? 'var(--grey-18, #767676)' : surround === 'black' ? '#000000' : 'var(--n-000, #0a0a0a)'
  );

  /* ---- timeline lane visibility, persisted per user ---- */
  const FILM_LANE_KEY = 'onelight.lane.filmstrip';
  const WAVE_LANE_KEY = 'onelight.lane.waveform';
  let showFilmLane = $state(true);
  let showWaveLane = $state(true);
  $effect(() => {
    try {
      showFilmLane = localStorage.getItem(FILM_LANE_KEY) !== '0';
      showWaveLane = localStorage.getItem(WAVE_LANE_KEY) !== '0';
    } catch {
      /* Storage can be unavailable; both lanes stay on. */
    }
  });
  const toggleLane = (lane: 'film' | 'wave'): void => {
    const next = lane === 'film' ? !showFilmLane : !showWaveLane;
    if (lane === 'film') showFilmLane = next;
    else showWaveLane = next;
    try {
      localStorage.setItem(lane === 'film' ? FILM_LANE_KEY : WAVE_LANE_KEY, next ? '1' : '0');
    } catch {
      /* Non-persistent visibility still applies for the session. */
    }
  };
  const hasFilmstrip = $derived(Boolean(filmstrip && filmstrip.cues.length > 0));

  /* ---- drawing ---- */
  const INK_NEUTRAL = '#e9e9e9'; /* --n-900, neutral-safe ink */
  const INK_ACCENT = '#a5605a'; /* --warn, the one functional accent */
  const DRAW_WIDTH = 0.004; /* normalized fraction of the frame diagonal */
  let drawMode = $state(false);
  let drawTool = $state<'pen' | 'arrow' | 'rect'>('pen');
  let drawInk = $state<'neutral' | 'accent'>('accent');
  let pendingStrokes = $state<AnnotationStroke[]>([]);
  let drawingFrame = $state<number | null>(null);

  /* While a drawing is armed with a committed stroke, seeks are blocked so a
     stray Previous/Next, timeline scrub, or marker jump cannot re-anchor the
     pending strokes to a different frame's pixels (transport keys are already
     suspended in draw mode). The hint below tells the reviewer why. */
  const seekLocked = $derived(seeksLocked(drawMode, pendingStrokes.length));

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
      video.currentTime = mediaTimeInsideFrame(inFrame, rate);
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
      /* A restore supersedes any queued deep-link seek. */
      pendingSeekFrame = null;
      /* Cancel a reverse shuttle that may have been started against the old
         media before this metadata arrived; otherwise the restored forward
         playback and the reverse interval would fight. */
      stopReverse();
      seekFrame(restore.frame);
      if (restore.playing) {
        video.playbackRate = restore.playbackRate;
        void video.play();
      }
    } else if (pendingSeekFrame !== null) {
      const queued = pendingSeekFrame;
      pendingSeekFrame = null;
      seekFrame(queued);
    }
    if (!hasRvfc) handleTimeUpdate();
  };

  const boundedFrame = (targetFrame: number): number => {
    const next = Math.max(0, Math.round(targetFrame));
    return durationFrames !== null && durationFrames !== undefined && durationFrames > 0
      ? Math.min(next, durationFrames - 1)
      : next;
  };

  /* Seeks requested before the media has metadata (frame deep links on
     mount) queue here and run from handleLoadedMetadata. */
  let pendingSeekFrame: number | null = null;

  /* Bumped by every seekFrame call. Each one-shot verify closes over the
     generation it was queued at and stands down if a newer seek has landed,
     so a stale verify from an earlier fast-scrub target cannot re-seek the
     playhead backward after the pointer settles. */
  let seekGeneration = 0;

  /* Seek a quarter into the frame (see SEEK_POSITION_IN_FRAME). With rVFC,
     verify the presented mediaTime maps to
     the target frame and re-seek once if it does not. */
  const seekFrame = (targetFrame: number): void => {
    if (!video || video.readyState === 0) {
      pendingSeekFrame = boundedFrame(targetFrame);
      return;
    }
    const next = boundedFrame(targetFrame);
    const generation = ++seekGeneration;
    video.currentTime = mediaTimeInsideFrame(next, rate);
    if (hasRvfc) {
      let retried = false;
      const verify = (_now: number, metadata: VideoFrameCallbackMetadata): void => {
        if (!video || retried) return;
        /* A later seek has superseded this one: leave the playhead where the
           newer target put it. */
        if (isVerifyStale(generation, seekGeneration)) return;
        if (frameAtMediaTime(metadata.mediaTime, rate) !== next) {
          retried = true;
          video.currentTime = mediaTimeInsideFrame(next, rate);
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

  /* Any explicit transport action cancels a rendition-switch restore in
     flight: the reviewer's intent supersedes the frame/play state captured
     before the swap, and letting the restore run would fight it (for example
     restore.play() racing a reverse shuttle the reviewer just started). */
  const cancelPendingRestore = (): void => {
    pendingRestore = null;
  };

  const jumpTo = (targetFrame: number): void => {
    /* Refuse user seeks while a drawing is armed with a committed stroke, so
       the anchor cannot drift off the frame the strokes were drawn on. */
    if (seekLocked) return;
    cancelPendingRestore();
    stopReverse();
    forwardSpeed = 0;
    video?.pause();
    seekFrame(targetFrame);
  };

  const step = (amount: number): void => {
    jumpTo(frame + amount);
  };

  /* Fullscreen the frame box, not the video element: the annotation overlay and
     watermark are siblings of the <video> and have to come with it. */
  const toggleFullscreen = (): void => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void frameBox?.requestFullscreen?.().catch(() => undefined);
  };
  $effect(() => {
    const sync = (): void => {
      fullscreen = document.fullscreenElement === frameBox;
    };
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  });

  const pausePlayback = (): void => {
    if (!video) return;
    cancelPendingRestore();
    stopReverse();
    forwardSpeed = 0;
    video.pause();
  };

  const playForward = (): void => {
    if (!video) return;
    cancelPendingRestore();
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
    cancelPendingRestore();
    video.pause();
    forwardSpeed = 0;
    reverseSpeed = reverseSpeed > 0 ? Math.min(4, reverseSpeed * 2) : 1;
    if (reverseTimer === null) {
      reverseTimer = setInterval(
        () => {
          if (!video) return;
          const nextTime = video.currentTime - reverseSpeed * frameDuration(rate);
          if (nextTime <= 0) {
            video.currentTime = mediaTimeInsideFrame(0, rate);
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
    <div class="frame-box" bind:this={frameBox}>
      <video
        bind:this={video}
        src={currentSrc || src}
        bind:muted
        bind:volume
        playsinline
        ontimeupdate={hasRvfc ? undefined : handleTimeUpdate}
        onloadedmetadata={handleLoadedMetadata}
        onplay={() => onplaystate?.(true)}
        onpause={() => onplaystate?.(false)}
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
    <div class="transport-row main">
      <!-- Shuttle and step, in the order an editor's hand expects: J K L with
           frame steps either side of the playhead. Icons, not sentences: these
           are pressed hundreds of times an hour. -->
      <div class="cluster">
        <button type="button" class="icon" onclick={playReverse} aria-label="Play reverse (J)" title="Reverse — J">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10L2 8zM14 3v10L8 8z" /></svg>
        </button>
        <button type="button" class="icon step" onclick={() => step(-1)} disabled={seekLocked} aria-label="Previous frame" title="Previous frame — ←">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11 3v10L4 8z" /><rect x="2" y="3" width="1.6" height="10" /></svg>
        </button>
        <button type="button" class="icon play" onclick={() => (playing ? pausePlayback() : playForward())} aria-label={playing ? 'Pause (K)' : 'Play (L)'} title={playing ? 'Pause — K' : 'Play — L'}>
          {#if playing}
            <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3" width="3.4" height="10" /><rect x="9.1" y="3" width="3.4" height="10" /></svg>
          {:else}
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3l9 5-9 5z" /></svg>
          {/if}
        </button>
        <button type="button" class="icon step" onclick={() => step(1)} disabled={seekLocked} aria-label="Next frame" title="Next frame — →">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3v10l7-5z" /><rect x="12.4" y="3" width="1.6" height="10" /></svg>
        </button>
        {#if shuttleLabel}<span class="shuttle tc">{shuttleLabel}</span>{/if}
      </div>

      <span class="readout">
        {#if timecode}<span class="tc tc-main">{timecode}</span>{/if}
        <span class="tc tc-sub">{frame} fr&nbsp; {rateLabel}{dropFrame && isDropFrameRate(rate) ? ' DF' : ''}</span>
      </span>

      <div class="cluster">
        <button type="button" onclick={() => { inFrame = frame; }} aria-label="Set loop in">Set in</button>
        <button type="button" onclick={() => { outFrame = frame; }} aria-label="Set loop out">Set out</button>
        <button type="button" aria-pressed={loop} onclick={() => { loop = !loop; }}>Loop</button>
      </div>

      <span class="grow"></span>

      <div class="cluster">
        <button type="button" class="icon" aria-pressed={muted} onclick={() => { muted = !muted; }} aria-label={muted ? 'Unmute' : 'Mute'}>
          {#if muted || volume === 0}
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7 3L4 6H2v4h2l3 3z" /><path d="M10.5 6.5l3 3M13.5 6.5l-3 3" stroke="currentColor" stroke-width="1.3" fill="none" /></svg>
          {:else}
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7 3L4 6H2v4h2l3 3z" /><path d="M9.5 5.8a3 3 0 0 1 0 4.4M11.6 4a5.6 5.6 0 0 1 0 8" stroke="currentColor" stroke-width="1.3" fill="none" /></svg>
          {/if}
        </button>
        <input
          class="vol"
          type="range"
          min="0"
          max="1"
          step="0.05"
          bind:value={volume}
          oninput={() => { if (volume > 0) muted = false; }}
          aria-label="Volume"
        />
        <button type="button" class="icon" onclick={toggleFullscreen} aria-pressed={fullscreen} aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}>
          {#if fullscreen}
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2v4H2M10 14v-4h4" stroke="currentColor" stroke-width="1.4" fill="none" /></svg>
          {:else}
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6V2h4M14 10v4h-4" stroke="currentColor" stroke-width="1.4" fill="none" /></svg>
          {/if}
        </button>
      </div>
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
          {#if seekLocked}
            <span class="draw-hint" role="status">Seeking is locked while this drawing is unsent.</span>
          {/if}
        {/if}
      {/if}
      <span class="grow"></span>
      {#if (hasFilmstrip || waveformUrl) && durationFrames !== null && durationFrames > 0}
        <span class="ctl-label" id="lanes-label">Lanes</span>
        <div class="seg" role="group" aria-labelledby="lanes-label">
          {#if hasFilmstrip}
            <button type="button" aria-pressed={showFilmLane} onclick={() => toggleLane('film')}>Filmstrip</button>
          {/if}
          {#if waveformUrl}
            <button type="button" aria-pressed={showWaveLane} onclick={() => toggleLane('wave')}>Waveform</button>
          {/if}
        </div>
      {/if}
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
        filmstrip={showFilmLane ? filmstrip : null}
        waveformUrl={showWaveLane ? waveformUrl : null}
        disabled={seekLocked}
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
  /* The main row is a real transport: clusters, not a sentence of buttons. */
  .transport-row.main { justify-content: flex-start; gap: 16px; }
  .cluster { display: flex; align-items: center; gap: 2px; }
  .cluster > button + button { margin-left: 0; }
  .grow { flex: 1; }
  /* Icon buttons: square, quiet, and the same value step as everything else in
     the room. No accent colour -- this chrome sits next to the frame. */
  .icon { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; padding: 0; }
  .icon svg { width: 16px; height: 16px; fill: currentColor; }
  .icon.play { width: 38px; height: 38px; background: var(--n-300, #2e2e2e); color: var(--n-900, #e9e9e9); }
  .icon.play:hover { background: var(--n-400, #3d3d3d); }
  .icon.step svg { opacity: 0.9; }
  .shuttle { margin-left: 6px; color: var(--n-700, #9a9a9a); font-size: 12px; font-weight: 600; }
  /* Volume: a neutral track, no accent fill. */
  .vol { width: 84px; height: 3px; appearance: none; background: var(--n-300, #2e2e2e); border-radius: 2px; padding: 0; }
  .vol::-webkit-slider-thumb { appearance: none; width: 11px; height: 11px; border-radius: 50%; background: var(--n-800, #c4c4c4); }
  .vol::-moz-range-thumb { width: 11px; height: 11px; border: 0; border-radius: 50%; background: var(--n-800, #c4c4c4); }
  .vol:hover::-webkit-slider-thumb { background: var(--n-900, #e9e9e9); }
  .vol:hover::-moz-range-thumb { background: var(--n-900, #e9e9e9); }
  /* Fullscreen puts the frame box on a black field, not a grey one. */
  .frame-box:fullscreen { display: grid; place-items: center; width: 100vw; height: 100vh; background: #000000; }
  .frame-box:fullscreen video { max-height: 100vh; max-width: 100vw; }
  .transport-row.settings { margin-top: 10px; justify-content: flex-start; }
  .grow { flex: 1; }
  .readout { display: grid; text-align: center; gap: 2px; }
  .tc { font-variant-numeric: tabular-nums; letter-spacing: 0.02em; }
  .tc-main { font-size: 16px; color: var(--n-900, #e9e9e9); }
  .tc-sub { font-size: 13px; color: var(--n-600, #767676); }
  .ctl-label { font-size: 13px; color: var(--n-600, #767676); }
  .draw-hint { font-size: 13px; color: var(--n-600, #767676); }
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
