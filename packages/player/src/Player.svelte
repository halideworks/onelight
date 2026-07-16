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
    chrome = 'full',
    watermark = null,
    filmstrip = null,
    waveformUrl = null,
    onframechange = undefined,
    onmarkerselect = undefined,
    ondrawingchange = undefined,
    onplaystate = undefined,
    onshare = undefined,
    onrangechange = undefined,
    oncopytimecode = undefined
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
    /* How much of the instrument to show.
     *
     * 'full' is the review room: everything here is a tool someone works the
     * frame with. 'simple' presents the picture to a client instead, and the
     * working tools go away -- the in/out marks and their readout, the lane
     * toggles, the surround field, the quality ladder. What is left is what
     * watching needs: the picture, the timecode, transport, volume, full
     * screen, and the timeline. Playback and frame accuracy are identical in
     * both; this only decides what is on screen. */
    chrome?: 'full' | 'simple';
    watermark?: WatermarkOverlay | null;
    filmstrip?: { url: string; cues: SpriteCue[] } | null;
    waveformUrl?: string | null;
    onframechange?: ((frame: number) => void) | undefined;
    onmarkerselect?: ((markerId: string, frame: number) => void) | undefined;
    ondrawingchange?: ((drawing: PendingDrawing | null) => void) | undefined;
    onplaystate?: ((playing: boolean) => void) | undefined;
    /* The page owns the URL; the player only knows which frame you are on. */
    onshare?: ((frame: number) => void) | undefined;
    /* In/out already exist here for looping. A note that covers a range wants
       exactly the same two numbers, so they are published rather than
       reinvented in a second piece of UI. */
    onrangechange?: ((range: { in: number | null; out: number | null }) => void) | undefined;
    /* Copying is the page's business -- it owns the clipboard fallback that a
       non-secure origin needs -- so the player hands over the text and shows
       what the page reports back. */
    oncopytimecode?: ((text: string) => Promise<boolean>) | undefined;
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
  /* Fullscreen targets the stage, not the frame box: the box has to keep
     hugging the picture (the annotation canvas is inset:0 on it, so any
     letterboxing inside the box would put drawings off the footage), and the
     stage is what centres it and paints the surround. */
  let stage = $state<HTMLDivElement | null>(null);
  /* 16/9 until the first metadata arrives, so the stage has a shape to reserve
     instead of collapsing and then jumping. */
  let aspect = $state(16 / 9);
  /* The stage's own box, measured. The picture is then the largest rectangle of
     the right shape that fits inside it -- which is what "use the space" means,
     and it cannot be expressed in CSS without either breaking the aspect ratio
     or letterboxing inside the box (and the annotation canvas is inset:0 on the
     box, so letterboxing there puts drawings off the footage). A height budget
     like 72vh was a guess that ignored whatever the transport actually left. */
  let stageWidth = $state(0);
  let stageHeight = $state(0);
  const boxWidth = $derived(
    stageWidth > 0 && stageHeight > 0
      ? Math.floor(Math.min(stageWidth, stageHeight * aspect))
      : 0
  );
  $effect(() => {
    if (!stage) return;
    const element = stage;
    const measure = (): void => {
      stageWidth = element.clientWidth;
      stageHeight = element.clientHeight;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  });
  let muted = $state(false);
  let volume = $state(1);
  let fullscreen = $state(false);
  /* Fullscreen controls appear on movement and get out of the way again. The
     footage is the point; chrome parked over it is not. */
  const OVERLAY_IDLE_MS = 2200;
  let overlayAwake = $state(true);
  let overlayHot = $state(false);
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const clearIdle = (): void => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  /* Only arm the fade when there is something to watch: fullscreen, playing,
     and no pointer resting on the controls. A paused still frame with no
     controls is a stuck window, not a clean one. */
  const armIdle = (): void => {
    clearIdle();
    if (!fullscreen || !playing) return;
    idleTimer = setTimeout(() => {
      if (!overlayHot) overlayAwake = false;
    }, OVERLAY_IDLE_MS);
  };
  const wakeOverlay = (): void => {
    overlayAwake = true;
    armIdle();
  };
  /* Depends on playing as well as fullscreen. Arming only on entry meant the
     timer fired while still paused, found nothing to do, and never scheduled
     again once playback started -- so the controls never faded at all. */
  $effect(() => {
    void fullscreen;
    void playing;
    overlayAwake = true;
    armIdle();
    return clearIdle;
  });
  /* Reverse is emulated by a timer with the element paused, so "playing" is not
     video.paused: it is either shuttle direction being live. */
  const playing = $derived(forwardSpeed > 0 || reverseSpeed > 0);
  const shuttleLabel = $derived(
    reverseSpeed > 1 ? `${String(reverseSpeed)}x rev` : forwardSpeed > 1 ? `${String(forwardSpeed)}x` : ''
  );

  $effect(() => {
    onrangechange?.({ in: inFrame, out: outFrame });
  });

  const rateSupported = $derived(
    SUPPORTED_RATES.some((candidate) => candidate.num === rate.num && candidate.den === rate.den)
  );
  const timecode = $derived(
    rateSupported ? formatTimecode(timecodeFromFrames(frame, rate, dropFrame && isDropFrameRate(rate))) : null
  );
  const rateLabel = $derived(rate.den === 1 ? String(rate.num) : (rate.num / rate.den).toFixed(3));
  /* The readout confirms the copy in place, then goes back to being a clock.
     Long enough to notice, short enough that the timecode is readable again by
     the time you look back. */
  let tcCopied = $state(false);
  let tcCopiedTimer: ReturnType<typeof setTimeout> | null = null;
  const copyTimecode = async (): Promise<void> => {
    if (!timecode || !oncopytimecode) return;
    if (!(await oncopytimecode(timecode))) return;
    tcCopied = true;
    if (tcCopiedTimer) clearTimeout(tcCopiedTimer);
    tcCopiedTimer = setTimeout(() => {
      tcCopied = false;
    }, 1200);
  };

  /* Marks are shown as timecode, like everything else a person reads here. */
  const tcAt = (value: number): string =>
    rateSupported
      ? formatTimecode(timecodeFromFrames(value, rate, dropFrame && isDropFrameRate(rate)))
      : String(value);

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
    /* The picture's own shape, which every rendition of a version shares. The
       stage is sized from this rather than from the decoded pixels, so
       switching 540 to 1080 rescales the picture inside a box that does not
       move. */
    if (video.videoWidth > 0 && video.videoHeight > 0)
      aspect = video.videoWidth / video.videoHeight;
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

  /* Fullscreen the stage: it carries the surround and centres the frame box,
     and the frame box must stay exactly the size of the picture so the
     annotation canvas (inset:0 on it) keeps landing on the footage. */
  const toggleFullscreen = (): void => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stage?.requestFullscreen?.().catch(() => undefined);
  };
  $effect(() => {
    const sync = (): void => {
      fullscreen = document.fullscreenElement === stage;
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
    /* The map an editor already has in their hands. JKL was here; the rest is
       what they reach for next and found missing -- space above all, which is
       the first key anyone presses at a review. */
    if (event.key === ' ' || event.key === 'Spacebar') {
      /* Space toggles, rather than being a third way to play: at a review it is
         pressed to stop on the thing you are about to talk about. */
      event.preventDefault();
      if (playing) pausePlayback();
      else playForward();
      return;
    }
    if (event.key === 'ArrowLeft') { event.preventDefault(); step(event.shiftKey ? -10 : -1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); step(event.shiftKey ? 10 : 1); }
    /* Comma and period step frames on every NLE worth naming; with shift they
       take the same ten-frame stride as the arrows. */
    if (key === ',') { event.preventDefault(); step(event.shiftKey ? -10 : -1); }
    if (key === '.') { event.preventDefault(); step(event.shiftKey ? 10 : 1); }
    if (event.key === 'Home') { event.preventDefault(); jumpTo(0); }
    if (event.key === 'End' && durationFrames && durationFrames > 0) {
      event.preventDefault();
      jumpTo(durationFrames - 1);
    }
    if (key === 'j') { event.preventDefault(); playReverse(); }
    if (key === 'k') { event.preventDefault(); pausePlayback(); }
    if (key === 'l') { event.preventDefault(); playForward(); }
    /* The marking keys travel with the marking UI. Left live under a simple
       chrome they would set an in point nothing draws and start a loop nothing
       explains, from keys a client has no reason to know they pressed. */
    if (chrome === 'full') {
      /* Shift jumps to the mark rather than setting it: I/O set, Shift+I/O go. */
      if (key === 'i') {
        event.preventDefault();
        if (event.shiftKey) { if (inFrame !== null) jumpTo(inFrame); }
        else inFrame = frame;
      }
      if (key === 'o') {
        event.preventDefault();
        if (event.shiftKey) { if (outFrame !== null) jumpTo(outFrame); }
        else outFrame = frame;
      }
      /* X clears the marks: Avid's "mark clear" muscle memory. */
      if (key === 'x') { event.preventDefault(); inFrame = null; outFrame = null; }
      if (key === 'p') { event.preventDefault(); loop = !loop; }
    }
    if (key === 'f') { event.preventDefault(); toggleFullscreen(); }
    if (key === 'm') { event.preventDefault(); muted = !muted; }
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
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="stage"
    bind:this={stage}
    style:background={surroundColor}
    style:--ar={String(aspect)}
    onpointermove={fullscreen ? wakeOverlay : undefined}
    onpointerleave={fullscreen ? () => { overlayHot = false; } : undefined}
  >
    <div class="frame-box" bind:this={frameBox} style:width={boxWidth > 0 ? `${String(boxWidth)}px` : undefined}>
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
      {#if fullscreen}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="fs-controls"
          class:awake={overlayAwake}
          onpointerenter={() => { overlayHot = true; wakeOverlay(); }}
          onpointerleave={() => { overlayHot = false; wakeOverlay(); }}
        >
          {@render deck()}
        </div>
      {/if}
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
  {#snippet deck()}
    <!-- One row. Everything that drives playback -- timecode, transport, marks
         -- rides the centre together, because they are one instrument and the
         eye should find them in one place. Copy-link and volume are the only
         things that are not playback, so they take the two edges of the same
         row rather than wrapping onto a second one. -->
    <div class="transport-row main">
      <div class="side">
        {#if onshare}
          <button type="button" class="linky" onclick={() => onshare?.(frame)}>Copy link at this frame</button>
        {/if}
      </div>

      <div class="deck">
        <!-- Direct children of the grid: each lands on its own band, so the
             primary controls share one line and the labels share the next. -->
        <span class="readout">
          {#if timecode}
            {#if oncopytimecode}
              <!-- The timecode is the thing people retype into an email. One
                   click takes it, and the readout itself says so rather than a
                   toast somewhere else on the page. -->
              <button
                type="button"
                class="tc tc-main copyable"
                class:copied={tcCopied}
                aria-label={`Copy timecode ${timecode}`}
                onclick={() => void copyTimecode()}
              >{tcCopied ? 'Copied' : timecode}</button>
            {:else}
              <span class="tc tc-main">{timecode}</span>
            {/if}
          {/if}
        </span>
        <span class="readout-sub tc">{frame} fr&nbsp; {rateLabel}{dropFrame && isDropFrameRate(rate) ? ' DF' : ''}</span>

        <!-- Shuttle and step, in the order an editor's hand expects: J K L with
             frame steps either side of the playhead. Icons, not sentences: these
             are pressed hundreds of times an hour. -->
        <div class="cluster">
          <button type="button" class="icon" onclick={playReverse} aria-label="Play reverse (J)" title="Reverse — J">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10L2 8zM14 3v10L8 8z" /></svg>
          </button>
          <button type="button" class="icon step" onclick={() => step(-1)} disabled={seekLocked} aria-label="Previous frame" title="Previous frame — ← or ,">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11 3v10L4 8z" /><rect x="2" y="3" width="1.6" height="10" /></svg>
          </button>
          <button type="button" class="icon play" onclick={() => (playing ? pausePlayback() : playForward())} aria-label={playing ? 'Pause (K)' : 'Play (L)'} title={playing ? 'Pause — space or K' : 'Play — space or L'}>
            {#if playing}
              <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3" width="3.4" height="10" /><rect x="9.1" y="3" width="3.4" height="10" /></svg>
            {:else}
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3l9 5-9 5z" /></svg>
            {/if}
          </button>
          <button type="button" class="icon step" onclick={() => step(1)} disabled={seekLocked} aria-label="Next frame" title="Next frame — → or .">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3v10l7-5z" /><rect x="12.4" y="3" width="1.6" height="10" /></svg>
          </button>
        </div>
        <span class="shuttle tc">{shuttleLabel}</span>

        <!-- The marks and what they are set to, on the two bands: the readout
             used to live under the timeline, nowhere near the buttons that set
             it. A client presenting mode has no use for either. -->
        {#if chrome === 'full'}
        <div class="marks">
          <button type="button" onclick={() => { inFrame = frame; }} aria-label="Set loop in" title="Mark in — I">Set in</button>
          <button type="button" onclick={() => { outFrame = frame; }} aria-label="Set loop out" title="Mark out — O">Set out</button>
          <button type="button" aria-pressed={loop} onclick={() => { loop = !loop; }} title="Loop the marked range — P">Loop</button>
          {#if inFrame !== null || outFrame !== null}
            <button type="button" class="icon clearmarks" onclick={() => { inFrame = null; outFrame = null; }} aria-label="Clear marks" title="Clear marks — X">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" fill="none" /></svg>
            </button>
          {/if}
        </div>
        <span class="marks-readout tc">
          <span class:unset={inFrame === null}>{inFrame === null ? 'in —' : tcAt(inFrame)}</span>
          <span class="marks-sep" aria-hidden="true">/</span>
          <span class:unset={outFrame === null}>{outFrame === null ? 'out —' : tcAt(outFrame)}</span>
        </span>
        {/if}
      </div>

      <div class="side right volume">
        <button type="button" class="icon" aria-pressed={muted} onclick={() => { muted = !muted; }} aria-label={muted ? 'Unmute' : 'Mute'} title="Mute — M">
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
          step="any"
          bind:value={volume}
          oninput={() => { if (volume > 0) muted = false; }}
          aria-label="Volume"
        />
        <button type="button" class="icon" onclick={toggleFullscreen} aria-pressed={fullscreen} aria-label={fullscreen ? 'Exit full screen' : 'Full screen'} title="Full screen — F">
          {#if fullscreen}
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2v4H2M10 14v-4h4" stroke="currentColor" stroke-width="1.4" fill="none" /></svg>
          {:else}
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6V2h4M14 10v4h-4" stroke="currentColor" stroke-width="1.4" fill="none" /></svg>
          {/if}
        </button>
      </div>
    </div>
  {/snippet}

  <div class="transport">
    {#if !fullscreen}{@render deck()}{/if}
    <!-- Nothing to settle, no row: a simple chrome with no drawing would
         otherwise leave a band of empty space under the transport. -->
    {#if allowDrawing || chrome === 'full'}
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
      {#if chrome === 'full'}
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
      {/if}
    </div>
    {/if}
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
</section>

<style>
  /* Review room world: strictly neutral, R=G=B, no gradients, no tinted
     chrome. The stage background is the surround control's territory. */
  /* A column so the stage can be handed the height the transport does not use.
     Without a definite height to divide, the stage sized to its content and the
     content sized to the stage -- a loop that settled wherever it happened to
     start, which is why the picture sat in a box far smaller than the window. */
  .player { display: flex; flex-direction: column; min-height: 0; height: 100%; background: var(--n-050, #101010); color: var(--n-800, #c4c4c4); padding: 16px; }
  /* The stage reserves the picture's shape and the frame box fills it, so the
     box is exactly the picture: no letterboxing inside it, which is what keeps
     the annotation canvas (inset:0 on the box) on the footage.

     Sized by min(available width, height budget x aspect), so it is as large as
     it can be and -- because every rendition of a version shares an aspect --
     identical for 540 and 1080. Switching quality rescales the picture without
     moving the box, which is what it looked like before: the 540 proxy is
     960px wide and simply rendered smaller. */
  /* The stage is given the height the transport does not use, and the picture
     fills it: width comes from boxWidth, measured, not from a vh guess. */
  .stage { flex: 1; display: grid; place-items: center; min-height: 120px; overflow: hidden; }
  .frame-box { position: relative; width: min(100%, calc(72vh * var(--ar, 1.7778))); max-height: 100%; }
  video { display: block; width: 100%; height: auto; background: #000000; }
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
  .transport { flex: none; padding-top: 12px; font-family: var(--font-ui, system-ui); }
  .transport-row { display: flex; align-items: center; justify-content: center; gap: 12px; flex-wrap: wrap; }
  /* One row, three tracks. The outer two are equal, so whatever they hold, the
     deck in the middle stays on the stage's centre line. Copy-link and volume
     are the only things here that are not playback, so they take the edges --
     of this row, not of a second one. */
  .transport-row.main { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 16px; }
  .side { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .side.right { justify-self: end; }
  /* The instrument: timecode, transport, marks. One grid, two rows, and the
     rows are the point. Every control lives on a fixed 34px band so the play
     button, the timecode and Set in all sit on one line; every secondary label
     lives on the band underneath. Before this each group was its own flex
     column finding its own centre, so a two-line readout pushed its neighbours
     around and nothing lined up with anything. */
  .deck { display: grid; grid-template-columns: auto auto auto; grid-template-rows: 34px 14px; align-items: center; column-gap: 24px; row-gap: 0; justify-self: center; }
  .deck > .readout { grid-row: 1; grid-column: 1; justify-self: end; }
  .deck > .readout-sub { grid-row: 2; grid-column: 1; justify-self: end; }
  .deck > .cluster { grid-row: 1; grid-column: 2; justify-self: center; }
  .deck > .shuttle { grid-row: 2; grid-column: 2; justify-self: center; }
  .deck > .marks { grid-row: 1; grid-column: 3; justify-self: start; }
  .deck > .marks-readout { grid-row: 2; grid-column: 3; justify-self: start; }
  .cluster { display: flex; align-items: center; gap: 2px; }
  .marks { display: flex; align-items: center; gap: 2px; }
  .marks-readout { display: flex; align-items: center; gap: 6px; font-size: 11px; line-height: 1; color: var(--n-700, #9a9a9a); }
  .marks-readout .unset { color: var(--n-500, #565656); }
  .marks-sep { color: var(--n-400, #3d3d3d); }
  .clearmarks { width: 24px; height: 24px; margin-left: 4px; }
  /* Volume and fullscreen are different jobs and should not read as one
     control: the slider needs air before the screen button. */
  .side.volume { gap: 8px; }
  .side.volume .vol { margin-right: 10px; }
  /* Timecode reads as a number, not as prose: fixed width so it does not jitter. */
  .readout { display: flex; align-items: center; min-width: 108px; justify-content: flex-end; }
  .readout-sub { display: flex; align-items: center; font-size: 11px; line-height: 1; color: var(--n-600, #767676); }
  /* Every button on the primary band is the same height, or "aligned" is a
     coincidence that breaks the first time a label changes. */
  .deck button { height: 30px; display: inline-flex; align-items: center; }
  .icon { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; padding: 0; }
  .deck .icon.play { width: 34px; height: 34px; }

  /* Fullscreen controls: over the picture, and gone when they are not wanted.
     They only fade while playing -- a still frame with no controls is a stuck
     window, not a clean one. */
  .fs-controls { position: absolute; left: 0; right: 0; bottom: 0; z-index: 4; padding: 64px 24px 16px; background: linear-gradient(180deg, rgba(0, 0, 0, 0) 0%, rgba(0, 0, 0, 0.55) 45%, rgba(0, 0, 0, 0.92) 100%); opacity: 0; transition: opacity 220ms ease; pointer-events: none; }
  .fs-controls.awake { opacity: 1; pointer-events: auto; }
  /* Over footage the chrome cannot borrow contrast from a grey page: the
     scrim carries the buttons, and the readout goes full white with a shadow
     so a timecode stays legible over blown highlights. */
  .fs-controls .tc-main { color: #ffffff; text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9); }
  .fs-controls .tc-sub, .fs-controls .marks-readout { color: rgba(255, 255, 255, 0.72); text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9); }
  .fs-controls .marks-readout .unset { color: rgba(255, 255, 255, 0.45); }
  .fs-controls button { background: rgba(28, 28, 28, 0.82); color: #ffffff; }
  .fs-controls button:hover { background: rgba(62, 62, 62, 0.92); }
  .fs-controls .icon.play { background: rgba(255, 255, 255, 0.92); color: #101010; }
  .fs-controls .icon.play:hover { background: #ffffff; }
  .fs-controls .linky { background: none; color: rgba(255, 255, 255, 0.8); text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9); }
  .fs-controls .linky:hover { background: none; color: #ffffff; }
  @media (prefers-reduced-motion: reduce) {
    .fs-controls { transition: none; }
  }
  /* Icon buttons: square, quiet, and the same value step as everything else in
     the room. No accent colour -- this chrome sits next to the frame. */
  .icon { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; padding: 0; }
  .icon svg { width: 16px; height: 16px; fill: currentColor; }
  .icon.play { width: 38px; height: 38px; background: var(--n-300, #2e2e2e); color: var(--n-900, #e9e9e9); }
  .icon.play:hover { background: var(--n-400, #3d3d3d); }
  .icon.step svg { opacity: 0.9; }
  .shuttle { color: var(--n-700, #9a9a9a); font-size: 11px; line-height: 1; font-weight: 600; min-height: 1em; }
  /* Volume: a neutral track, no accent fill. */
  .vol { width: 84px; height: 3px; appearance: none; background: var(--n-300, #2e2e2e); border-radius: 2px; padding: 0; }
  .vol::-webkit-slider-thumb { appearance: none; width: 11px; height: 11px; border-radius: 50%; background: var(--n-800, #c4c4c4); }
  .vol::-moz-range-thumb { width: 11px; height: 11px; border: 0; border-radius: 50%; background: var(--n-800, #c4c4c4); }
  .vol:hover::-webkit-slider-thumb { background: var(--n-900, #e9e9e9); }
  .vol:hover::-moz-range-thumb { background: var(--n-900, #e9e9e9); }
  /* Fullscreen: the stage fills the screen and keeps painting the surround, and
     the picture grows until it hits whichever edge binds first -- full width on
     a wide screen, full height on a tall one. The frame box still hugs the
     picture, so drawings stay on the footage. */
  .stage:fullscreen { width: 100vw; height: 100vh; }
  .transport-row.settings { margin-top: 10px; justify-content: flex-start; }
  .grow { flex: 1; }
  .readout { display: grid; text-align: center; gap: 2px; }
  .tc { font-variant-numeric: tabular-nums; letter-spacing: 0.02em; }
  .tc-main { font-size: 16px; color: var(--n-900, #e9e9e9); }
  /* A button that has to stay a readout: no chrome until you go near it, and a
     fixed width so taking the copy does not make the row jump. */
  .tc-main.copyable { border: 0; background: none; padding: 0 4px; border-radius: 3px; font: inherit; font-size: 16px; letter-spacing: inherit; cursor: pointer; transition: background 120ms ease, color 120ms ease; }
  .tc-main.copyable:hover { background: rgba(255, 255, 255, 0.08); }
  .tc-main.copyable:focus-visible { outline: 1px solid var(--accent-bright, #6ad6e0); outline-offset: 1px; }
  .tc-main.copied { color: var(--ok, #7fd1a8); }
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
