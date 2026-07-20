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
  import { applyMark, isVerifyStale, seeksLocked } from './transport-state.js';
  import { ANNOTATION_INKS } from './annotations.js';
  import type { AnnotationPoint, AnnotationStroke, FrameAnnotation, PendingDrawing } from './annotations.js';
  import { markerInkFor } from './timeline.js';
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
    drawDefaultColor = undefined,
    chrome = 'full',
    watermark = null,
    filmstrip = null,
    waveformUrl = null,
    onframechange = undefined,
    onmarkerselect = undefined,
    ondrawingchange = undefined,
    ondrawmodechange = undefined,
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
    /* The author's own ink (annotationInkFor them): the default drawing and
       text colour until they pick another. */
    drawDefaultColor?: string | undefined;
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
    /* Fires when draw mode or the active tool changes, whoever changed it. */
    ondrawmodechange?: ((on: boolean, tool: 'pen' | 'arrow' | 'rect' | 'text') => void) | undefined;
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
  /* A mark never creates an inverted range; the ordering rule lives in
     transport-state.ts where it is tested directly. */
  const setInMark = (at: number): void => {
    ({ in: inFrame, out: outFrame } = applyMark('in', at, inFrame, outFrame));
  };
  const setOutMark = (at: number): void => {
    ({ in: inFrame, out: outFrame } = applyMark('out', at, inFrame, outFrame));
  };
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
  /* Touch: the inline slider is hidden (no room under a thumb), so the sound
     button opens a small vertical slider instead of toggling mute. Queried at
     click time, not at mount: a convertible can change personality mid-session. */
  let volPop = $state(false);
  const soundClick = (): void => {
    if (typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches) volPop = !volPop;
    else muted = !muted;
  };
  const dismissVolPop = (event: PointerEvent): void => {
    if (volPop && !(event.target instanceof Element && event.target.closest('.soundwrap'))) volPop = false;
  };
  /* The level survives the session: restored before the video binds, saved
     whenever it moves. Mute is part of the same memory. */
  const VOLUME_KEY = 'onelight.player.volume';
  try {
    const stored = JSON.parse(localStorage.getItem(VOLUME_KEY) ?? '');
    if (typeof stored?.volume === 'number')
      volume = Math.min(1, Math.max(0, stored.volume));
    if (typeof stored?.muted === 'boolean') muted = stored.muted;
  } catch {
    /* No stored level, or storage unavailable: the defaults stand. */
  }
  $effect(() => {
    const level = { volume, muted };
    try {
      localStorage.setItem(VOLUME_KEY, JSON.stringify(level));
    } catch {
      /* Non-persistent; the level still applies for this session. */
    }
  });
  let fullscreen = $state(false);
  /* ---- scopes ----
     A luma waveform and an RGB parade, sampled from the on-screen frame at
     reduced resolution every animation frame. The proxy is same-origin, so
     the canvas never taints. These read the 8-bit proxy after the browser's
     own conversion; they are a judgement aid, not a mastering scope, and the
     panel says which one is on. */
  let scopesOn = $state(false);
  let scopeMode = $state<'waveform' | 'parade'>('waveform');
  let scopeCanvas = $state<HTMLCanvasElement | null>(null);
  const SCOPE_W = 512;
  const SCOPE_H = 180;
  const SAMPLE_W = 256;
  const SAMPLE_H = 144;
  let sampleCanvas: HTMLCanvasElement | null = null;
  /* What the last trace was drawn from -- time, mode, AND canvas, so a
     reopened panel's fresh canvas never inherits the memo of the old one.
     Skip the readback entirely while the picture sits still. */
  let scopeDrawnAt = -1;
  let scopeDrawnMode: 'waveform' | 'parade' | null = null;
  let scopeDrawnOn: HTMLCanvasElement | null = null;
  /* The trace buffer is reused between renders: a fresh ImageData per frame
     was 360 KB of allocation at playback rate, and the collector's pauses
     read as playhead jitter. */
  let scopeImage: ImageData | null = null;

  /* True when the trace is current (drawn, or nothing new to draw); false
     when the caller should retry shortly (mid-seek, decoder not ready). */
  const renderScope = (): boolean => {
    const target = scopeCanvas;
    if (!target || !video || video.videoWidth === 0) return false;
    /* Mid-seek the element still presents the old frame; drawing now would
       memoize stale pixels under the new time. Wait for the seek to land. */
    if (video.seeking) return false;
    if (
      video.paused &&
      video.currentTime === scopeDrawnAt &&
      scopeMode === scopeDrawnMode &&
      target === scopeDrawnOn
    )
      return true;
    if (!sampleCanvas) {
      sampleCanvas = document.createElement('canvas');
      sampleCanvas.width = SAMPLE_W;
      sampleCanvas.height = SAMPLE_H;
    }
    const sampler = sampleCanvas.getContext('2d', { willReadFrequently: true });
    const ctx = target.getContext('2d');
    if (!sampler || !ctx) return true;
    sampler.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H);
    let data: Uint8ClampedArray;
    try {
      data = sampler.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
    } catch {
      return true;
    }
    scopeDrawnAt = video.currentTime;
    scopeDrawnMode = scopeMode;
    scopeDrawnOn = target;
    if (!scopeImage) scopeImage = ctx.createImageData(SCOPE_W, SCOPE_H);
    const out = scopeImage;
    out.data.fill(0);
    const px = out.data;
    const plot = (x: number, value: number, r: number, g: number, b: number): void => {
      const y = Math.max(0, Math.min(SCOPE_H - 1, Math.round((1 - value / 255) * (SCOPE_H - 1))));
      const at = (y * SCOPE_W + x) * 4;
      px[at] = Math.min(255, (px[at] ?? 0) + r);
      px[at + 1] = Math.min(255, (px[at + 1] ?? 0) + g);
      px[at + 2] = Math.min(255, (px[at + 2] ?? 0) + b);
      px[at + 3] = 255;
    };
    if (scopeMode === 'waveform') {
      for (let sy = 0; sy < SAMPLE_H; sy += 1) {
        for (let sx = 0; sx < SAMPLE_W; sx += 1) {
          const at = (sy * SAMPLE_W + sx) * 4;
          const luma =
            0.2126 * (data[at] ?? 0) + 0.7152 * (data[at + 1] ?? 0) + 0.0722 * (data[at + 2] ?? 0);
          plot(Math.floor((sx / SAMPLE_W) * SCOPE_W), luma, 34, 44, 34);
        }
      }
    } else {
      const third = SCOPE_W / 3;
      for (let sy = 0; sy < SAMPLE_H; sy += 1) {
        for (let sx = 0; sx < SAMPLE_W; sx += 1) {
          const at = (sy * SAMPLE_W + sx) * 4;
          const x = (sx / SAMPLE_W) * third;
          plot(Math.floor(x), data[at] ?? 0, 48, 10, 10);
          plot(Math.floor(third + x), data[at + 1] ?? 0, 10, 48, 10);
          plot(Math.floor(third * 2 + x), data[at + 2] ?? 0, 10, 10, 48);
        }
      }
    }
    ctx.putImageData(out, 0, 0);
    ctx.strokeStyle = 'rgba(233, 233, 233, 0.16)';
    ctx.lineWidth = 1;
    for (const stop of [0, 0.25, 0.5, 0.75, 1]) {
      const y = Math.round((1 - stop) * (SCOPE_H - 1)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(SCOPE_W, y);
      ctx.stroke();
    }
    /* The graticule says what it measures: percent of full range, labelled
       at every line so a level can be read off the trace directly. */
    ctx.fillStyle = 'rgba(233, 233, 233, 0.55)';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    for (const stop of [0, 0.25, 0.5, 0.75, 1]) {
      const y = Math.round((1 - stop) * (SCOPE_H - 1));
      ctx.textBaseline = stop === 1 ? 'top' : stop === 0 ? 'bottom' : 'middle';
      ctx.fillText(
        `${String(Math.round(stop * 100))}%`,
        4,
        stop === 1 ? y + 3 : stop === 0 ? y - 2 : y,
      );
    }
    if (scopeMode === 'parade') {
      for (const x of [SCOPE_W / 3, (SCOPE_W / 3) * 2]) {
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, 0);
        ctx.lineTo(Math.round(x) + 0.5, SCOPE_H);
        ctx.stroke();
      }
    }
    return true;
  };

  /* Scope rendering is keyed to presented frames (`frame` advances per
     rVFC), not to a free-running 60 Hz rAF loop: 24 fps footage gets 24
     scope draws a second and the main thread keeps its headroom, which is
     what the playhead's smoothness is made of. The rAF chain below only
     spins while a draw could not land yet (mid-seek), and stops the moment
     it does. */
  $effect(() => {
    if (!scopesOn) return;
    void frame;
    void scopeMode;
    void scopeCanvas;
    let raf = 0;
    const attempt = (): void => {
      if (!renderScope()) raf = requestAnimationFrame(attempt);
    };
    attempt();
    return () => cancelAnimationFrame(raf);
  });

  const setScope = (mode: 'waveform' | 'parade'): void => {
    if (scopesOn && scopeMode === mode) {
      scopesOn = false;
      return;
    }
    scopeMode = mode;
    scopesOn = true;
  };

  /* Captions are off until asked for; the toggle drives the text track's
     mode directly, and a source change re-applies the choice. */
  let captionsOn = $state(false);
  const applyCaptions = (): void => {
    const track = video?.textTracks?.[0];
    if (track) track.mode = captionsOn && captionsSrc ? 'showing' : 'disabled';
  };
  const toggleCaptions = (): void => {
    captionsOn = !captionsOn;
    applyCaptions();
  };
  $effect(() => {
    void captionsSrc;
    void captionsOn;
    applyCaptions();
  });
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
  /* Whether the first frame of the current source has arrived; simple chrome
     fades the picture in on it. A new source starts unseen again. */
  let pictureIn = $state(false);
  $effect(() => {
    void (currentSrc || src);
    pictureIn = false;
  });

  /* ---- the presentation scrub (simple chrome's seek bar) ---- */

  let scrubEl = $state<HTMLDivElement | null>(null);
  let scrubbing = $state(false);
  /* Pixel width of the scrub, so the handle can ride a transform instead of
     a layout-invalidating left. */
  let scrubWidth = $state(0);
  $effect(() => {
    if (!scrubEl) return;
    const element = scrubEl;
    const measure = (): void => {
      scrubWidth = element.clientWidth;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  });
  /* The bar and handle track the POINTER while dragging, not the video:
     seeks land asynchronously and unevenly, and a handle that waits for them
     stutters behind the finger. The preview holds after release until the
     seek catches up, so there is no snap-back. */
  let scrubPreview = $state<number | null>(null);
  let scrubTargetFrame: number | null = null;
  let scrubRaf: number | null = null;
  const scrubPct = $derived.by(() => {
    const shown = scrubPreview ?? frame;
    return durationFrames && durationFrames > 1
      ? Math.min(1, Math.max(0, shown / (durationFrames - 1)))
      : 0;
  });
  $effect(() => {
    void frame;
    if (!scrubbing) scrubPreview = null;
  });
  /* One seek per animation frame: every pointer move updates the target, and
     the newest target wins when the frame ticks. */
  const scrubApply = (): void => {
    scrubRaf = null;
    if (scrubTargetFrame !== null) {
      const target = scrubTargetFrame;
      scrubTargetFrame = null;
      jumpTo(target);
    }
  };
  const scrubSeek = (event: PointerEvent): void => {
    if (!scrubEl || !durationFrames || durationFrames < 2) return;
    const box = scrubEl.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    const target = Math.round(pct * (durationFrames - 1));
    scrubPreview = target;
    scrubTargetFrame = target;
    if (scrubRaf === null) scrubRaf = requestAnimationFrame(scrubApply);
  };
  const onScrubDown = (event: PointerEvent): void => {
    if (seekLocked) return;
    scrubbing = true;
    scrubEl?.setPointerCapture(event.pointerId);
    scrubSeek(event);
  };
  const onScrubMove = (event: PointerEvent): void => {
    if (scrubbing) scrubSeek(event);
  };
  const onScrubUp = (event: PointerEvent): void => {
    if (!scrubbing) return;
    scrubbing = false;
    scrubEl?.releasePointerCapture(event.pointerId);
    /* The last pointer position is the destination, precisely. */
    if (scrubRaf !== null) cancelAnimationFrame(scrubRaf);
    scrubRaf = null;
    scrubApply();
  };
  const onScrubKeydown = (event: KeyboardEvent): void => {
    if (seekLocked) return;
    if (event.key === 'ArrowLeft') { event.preventDefault(); event.stopPropagation(); step(-1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); step(1); }
  };

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
  /* The ink palette on offer: the author's own colour leads (drawDefaultColor,
     hashed from who they are), then the shared brights, then neutral. */
  const inkChoices = $derived([
    ...(drawDefaultColor ? [drawDefaultColor] : []),
    ...ANNOTATION_INKS.filter((ink) => ink !== drawDefaultColor).slice(0, 4),
    '#ffffff',
    '#0a0a0a',
  ]);
  /* An uncommitted text placement: the input floats at its anchor until
     Enter commits it as a text stroke or Escape lets it go. */
  let textDraft = $state<{ point: AnnotationPoint; value: string } | null>(null);
  const DRAW_WIDTH = 0.004; /* normalized fraction of the frame diagonal */
  let drawMode = $state(false);
  let drawTool = $state<'pen' | 'arrow' | 'rect' | 'text'>('pen');
  let drawColor = $state('');
  /* The author's colour is the default until they pick one themselves. */
  let colorPicked = false;
  $effect(() => {
    const fallback = drawDefaultColor ?? INK_ACCENT;
    if (!colorPicked) drawColor = fallback;
  });
  /* Pages that host their own draw controls (the share rail) drive the mode
     from outside and hear about every change, including Escape in here. */
  export function setDraw(on: boolean, tool: 'pen' | 'arrow' | 'rect' | 'text' = 'pen'): void {
    if (!allowDrawing) return;
    drawTool = tool;
    if (drawMode !== on) toggleDraw();
    if (!on) textDraft = null;
  }
  export function setDrawColor(color: string): void {
    colorPicked = true;
    drawColor = color;
  }
  $effect(() => {
    ondrawmodechange?.(drawMode, drawTool);
  });
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

  const focusDraft = (element: HTMLInputElement): void => {
    element.focus();
  };

  const commitTextDraft = (): void => {
    const draft = textDraft;
    textDraft = null;
    if (!draft || !draft.value.trim()) return;
    commitStroke({
      tool: 'text',
      text: draft.value.trim(),
      color: drawColor,
      width: 0.035,
      points: [draft.point],
    });
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

  /* The canvas draws committed strokes and pending shapes; pending TEXT is
     DOM instead, so it can be grabbed, resized and re-opened until the note
     is posted. Once posted it comes back as a committed stroke and the
     canvas takes over.

     These recompute on every presented frame (they depend on `frame`), and
     almost every frame has no strokes. Returning the previous array when
     nothing changed keeps the identity stable, so the overlay's draw effect
     and the each-block do not run 24 times a second over empty lists. */
  let lastCanvasStrokes: AnnotationStroke[] = [];
  const canvasStrokes = $derived.by(() => {
    const next = [
      ...annotations
        .filter((annotation) => annotation.frame === frame)
        .flatMap((annotation) => annotation.strokes),
      ...(drawingFrame === frame
        ? pendingStrokes.filter((stroke) => stroke.tool !== 'text')
        : [])
    ];
    if (
      next.length === lastCanvasStrokes.length &&
      next.every((stroke, index) => stroke === lastCanvasStrokes[index])
    )
      return lastCanvasStrokes;
    lastCanvasStrokes = next;
    return next;
  });
  let lastPendingTexts: Array<{ stroke: AnnotationStroke; index: number }> = [];
  const pendingTexts = $derived.by(() => {
    const next =
      drawingFrame === frame
        ? pendingStrokes
            .map((stroke, index) => ({ stroke, index }))
            .filter((entry) => entry.stroke.tool === 'text')
        : [];
    if (
      next.length === lastPendingTexts.length &&
      next.every(
        (entry, at) =>
          entry.stroke === lastPendingTexts[at]?.stroke && entry.index === lastPendingTexts[at]?.index
      )
    )
      return lastPendingTexts;
    lastPendingTexts = next;
    return next;
  });

  /* ---- pending text editing: select, drag, resize, reopen ---- */

  let selectedTextAt = $state<number | null>(null);
  let textEdit = $state<{ index: number; value: string } | null>(null);
  let textDrag: {
    index: number;
    pointerId: number;
    grabX: number;
    grabY: number;
    moved: boolean;
  } | null = null;

  const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

  const updateStrokeAt = (index: number, next: AnnotationStroke | null): void => {
    pendingStrokes = next
      ? pendingStrokes.map((stroke, at) => (at === index ? next : stroke))
      : pendingStrokes.filter((_, at) => at !== index);
    if (pendingStrokes.length === 0 && !drawMode) drawingFrame = null;
    emitDrawing();
  };

  $effect(() => {
    if (!drawMode) {
      selectedTextAt = null;
      textEdit = null;
    }
    if (selectedTextAt !== null && pendingStrokes[selectedTextAt]?.tool !== 'text')
      selectedTextAt = null;
  });

  const textItemDown = (index: number, event: PointerEvent): void => {
    if (!drawMode || textEdit) return;
    event.preventDefault();
    event.stopPropagation();
    selectedTextAt = index;
    const anchor = pendingStrokes[index]?.points[0];
    if (!anchor || !frameBox) return;
    const rect = frameBox.getBoundingClientRect();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    textDrag = {
      index,
      pointerId: event.pointerId,
      grabX: event.clientX - (rect.left + anchor[0] * rect.width),
      grabY: event.clientY - (rect.top + anchor[1] * rect.height),
      moved: false,
    };
  };

  const textItemMove = (event: PointerEvent): void => {
    if (!textDrag || !frameBox) return;
    const rect = frameBox.getBoundingClientRect();
    const stroke = pendingStrokes[textDrag.index];
    if (!stroke) return;
    const x = clamp01((event.clientX - textDrag.grabX - rect.left) / rect.width);
    const y = clamp01((event.clientY - textDrag.grabY - rect.top) / rect.height);
    const anchor = stroke.points[0];
    if (anchor && Math.hypot(x - anchor[0], y - anchor[1]) > 0.002) textDrag.moved = true;
    if (textDrag.moved) updateStrokeAt(textDrag.index, { ...stroke, points: [[x, y]] });
  };

  const textItemUp = (index: number): void => {
    const drag = textDrag;
    textDrag = null;
    /* A grab that never moved is a click: reopen the words. */
    if (drag && !drag.moved) {
      const stroke = pendingStrokes[index];
      if (stroke?.text) textEdit = { index, value: stroke.text };
    }
  };

  const resizeText = (index: number, delta: number): void => {
    const stroke = pendingStrokes[index];
    if (!stroke) return;
    /* The floor is small on purpose: a caption-sized aside next to a detail
       is a legitimate note. The canvas renderer scales with the frame, so a
       small size stays proportionally small at every viewport. */
    const next = Math.min(0.09, Math.max(0.008, (stroke.width ?? 0.035) + delta));
    updateStrokeAt(index, { ...stroke, width: next });
  };

  const commitTextEdit = (): void => {
    const edit = textEdit;
    textEdit = null;
    if (!edit) return;
    const stroke = pendingStrokes[edit.index];
    if (!stroke) return;
    const value = edit.value.trim();
    /* Emptied words are a removal, not an empty label. */
    updateStrokeAt(edit.index, value ? { ...stroke, text: value } : null);
  };

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

  /* Hosts set the marked range directly (a ranged note re-arming its span);
     the same ordering rule as the I/O keys applies. */
  export function setRange(inAt: number, outAt: number): void {
    if (outAt <= inAt) return;
    inFrame = boundedFrame(inAt);
    outFrame = boundedFrame(outAt);
  }

  export function clearRange(): void {
    inFrame = null;
    outFrame = null;
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
        else setInMark(frame);
      }
      if (key === 'o') {
        event.preventDefault();
        if (event.shiftKey) { if (outFrame !== null) jumpTo(outFrame); }
        else setOutMark(frame);
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

<svelte:window onkeydown={handleKeydown} onpointerdown={dismissVolPop} />
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
        class:arrived={pictureIn}
        src={currentSrc || src}
        bind:muted
        bind:volume
        playsinline
        ontimeupdate={hasRvfc ? undefined : handleTimeUpdate}
        onloadedmetadata={handleLoadedMetadata}
        onloadeddata={() => { pictureIn = true; }}
        onplay={() => onplaystate?.(true)}
        onpause={() => onplaystate?.(false)}
      >
        <track kind="captions" srclang="en" label="English captions" src={captionsSrc ?? 'data:text/vtt;charset=utf-8,WEBVTT'} />
      </video>
      <AnnotationOverlay
        strokes={canvasStrokes}
        width={videoWidth}
        height={videoHeight}
        interactive={drawMode}
        tool={drawTool}
        color={drawColor}
        strokeWidth={DRAW_WIDTH}
        onstroke={commitStroke}
        ontextplace={(point) => {
          /* Clicking the frame with words already in a box applies them; it
             does not move the caret to a new spot. The overlay's pointerdown
             lands before the input's blur, so committing here first keeps
             the typed text from being replaced by the empty draft the blur
             handler would then read. An empty box just moves. */
          if (textDraft?.value.trim()) {
            commitTextDraft();
            return;
          }
          if (textEdit) {
            commitTextEdit();
            return;
          }
          textDraft = { point, value: '' };
        }}
      />
      {#each pendingTexts as entry (entry.index)}
        {#if textEdit && textEdit.index === entry.index}
          <input
            class="textdraft"
            style={`left: ${(entry.stroke.points[0]?.[0] ?? 0) * 100}%; top: ${(entry.stroke.points[0]?.[1] ?? 0) * 100}%; color: ${entry.stroke.color ?? drawColor}; font-size: ${Math.max(12, (entry.stroke.width ?? 0.035) * Math.hypot(videoWidth, videoHeight))}px;`}
            bind:value={textEdit.value}
            maxlength="120"
            use:focusDraft
            onkeydown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') commitTextEdit();
              else if (event.key === 'Escape') textEdit = null;
            }}
            onblur={commitTextEdit}
          />
        {:else}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="textitem"
            class:live={drawMode}
            class:selected={selectedTextAt === entry.index}
            style={`left: ${(entry.stroke.points[0]?.[0] ?? 0) * 100}%; top: ${(entry.stroke.points[0]?.[1] ?? 0) * 100}%; color: ${entry.stroke.color ?? drawColor}; font-size: ${Math.max(12, (entry.stroke.width ?? 0.035) * Math.hypot(videoWidth, videoHeight))}px;`}
            onpointerdown={(event) => textItemDown(entry.index, event)}
            onpointermove={textItemMove}
            onpointerup={() => textItemUp(entry.index)}
            onpointercancel={() => { textDrag = null; }}
          >
            {entry.stroke.text}
            {#if selectedTextAt === entry.index && drawMode}
              <span class="texttools" onpointerdown={(event) => event.stopPropagation()}>
                <button type="button" aria-label="Smaller" onclick={() => resizeText(entry.index, -0.006)}>
                  <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M2 6h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none" /></svg>
                </button>
                <button type="button" aria-label="Larger" onclick={() => resizeText(entry.index, 0.006)}>
                  <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M2 6h8M6 2v8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none" /></svg>
                </button>
                <button type="button" aria-label="Remove" onclick={() => updateStrokeAt(entry.index, null)}>
                  <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none" /></svg>
                </button>
              </span>
            {/if}
          </div>
        {/if}
      {/each}
      {#if textDraft}
        <!-- The caret lives in the DOM; the committed stroke lives on the
             canvas. Enter commits, Escape lets it go, and clicking elsewhere
             in text mode simply moves the draft. -->
        <input
          class="textdraft"
          style={`left: ${textDraft.point[0] * 100}%; top: ${textDraft.point[1] * 100}%; color: ${drawColor}; font-size: ${Math.max(12, 0.035 * Math.hypot(videoWidth, videoHeight))}px;`}
          bind:value={textDraft.value}
          placeholder="Say it here"
          maxlength="120"
          use:focusDraft
          onkeydown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') commitTextDraft();
            else if (event.key === 'Escape') textDraft = null;
          }}
          onblur={commitTextDraft}
        />
      {/if}
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
          <button type="button" class="linky" onclick={() => onshare?.(frame)} title="Copy link at this frame">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M6.5 9.5l3-3M7.5 4.5l1.2-1.2a2.4 2.4 0 013.4 3.4L10.9 7.9M5.1 8.1L3.9 9.3a2.4 2.4 0 003.4 3.4l1.2-1.2" /></svg>
            <span class="lbl">Copy link at this frame</span>
          </button>
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
          <button type="button" class="icon" onclick={playReverse} aria-label="Play reverse (J)" title="Reverse (J)">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10L2 8zM14 3v10L8 8z" /></svg>
          </button>
          <button type="button" class="icon step" onclick={() => step(-1)} disabled={seekLocked} aria-label="Previous frame" title="Previous frame (left arrow or ,)">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11 3v10L4 8z" /><rect x="2" y="3" width="1.6" height="10" /></svg>
          </button>
          <button type="button" class="icon play" onclick={() => (playing ? pausePlayback() : playForward())} aria-label={playing ? 'Pause (K)' : 'Play (L)'} title={playing ? 'Pause (space or K)' : 'Play (space or L)'}>
            {#if playing}
              <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3" width="3.4" height="10" /><rect x="9.1" y="3" width="3.4" height="10" /></svg>
            {:else}
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3l9 5-9 5z" /></svg>
            {/if}
          </button>
          <button type="button" class="icon step" onclick={() => step(1)} disabled={seekLocked} aria-label="Next frame" title="Next frame (right arrow or .)">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3v10l7-5z" /><rect x="12.4" y="3" width="1.6" height="10" /></svg>
          </button>
        </div>
        <span class="shuttle tc">{shuttleLabel}</span>

        <!-- The marks and what they are set to, on the two bands: the readout
             used to live under the timeline, nowhere near the buttons that set
             it. A client presenting mode has no use for either. -->
        {#if chrome === 'full'}
        <div class="marks">
          <button type="button" onclick={() => setInMark(frame)} aria-label="Set loop in" title="Mark in (I)">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M5 3H3v10h2v-1.5H4.5v-7H5zM7 8l4-3v6z" fill="currentColor" /></svg>
            <span class="lbl">Set in</span>
          </button>
          <button type="button" onclick={() => setOutMark(frame)} aria-label="Set loop out" title="Mark out (O)">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M11 3h2v10h-2v-1.5h.5v-7H11zM9 8L5 5v6z" fill="currentColor" /></svg>
            <span class="lbl">Set out</span>
          </button>
          <button type="button" aria-pressed={loop} onclick={() => { loop = !loop; }} title="Loop the marked range (P)">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6.5a3.5 3.5 0 013.5-3.5H12M12 3l-1.8-1.8M12 3l-1.8 1.8M13 9.5A3.5 3.5 0 019.5 13H4M4 13l1.8 1.8M4 13l1.8-1.8" /></svg>
            <span class="lbl">Loop</span>
          </button>
          {#if inFrame !== null || outFrame !== null}
            <button type="button" class="icon clearmarks" onclick={() => { inFrame = null; outFrame = null; }} aria-label="Clear marks" title="Clear marks (X)">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" fill="none" /></svg>
            </button>
          {/if}
        </div>
        <span class="marks-readout tc">
          <span class:unset={inFrame === null}>{inFrame === null ? 'in --' : tcAt(inFrame)}</span>
          <span class="marks-sep" aria-hidden="true">/</span>
          <span class:unset={outFrame === null}>{outFrame === null ? 'out --' : tcAt(outFrame)}</span>
        </span>
        {/if}
      </div>

      <div class="side right volume">
        {#if captionsSrc}
          <button
            type="button"
            class="icon captions"
            aria-pressed={captionsOn}
            onclick={toggleCaptions}
            aria-label={captionsOn ? 'Hide captions' : 'Show captions'}
            title="Captions"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="3.5" width="13" height="9" rx="1.5" stroke="currentColor" stroke-width="1.2" fill="none" /><path d="M7 7.2a1.6 1.6 0 1 0 0 1.6M12 7.2a1.6 1.6 0 1 0 0 1.6" stroke="currentColor" stroke-width="1.2" fill="none" /></svg>
          </button>
        {/if}
        <span class="soundwrap">
          <button type="button" class="icon" aria-pressed={muted} onclick={soundClick} aria-label={muted ? 'Unmute' : 'Mute'} title="Mute (M)">
            {#if muted || volume === 0}
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7 3L4 6H2v4h2l3 3z" /><path d="M10.5 6.5l3 3M13.5 6.5l-3 3" stroke="currentColor" stroke-width="1.3" fill="none" /></svg>
            {:else}
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7 3L4 6H2v4h2l3 3z" /><path d="M9.5 5.8a3 3 0 0 1 0 4.4M11.6 4a5.6 5.6 0 0 1 0 8" stroke="currentColor" stroke-width="1.3" fill="none" /></svg>
            {/if}
          </button>
          {#if volPop}
            <div class="volpop" role="group" aria-label="Volume">
              <input
                class="volv"
                type="range"
                orient="vertical"
                min="0"
                max="1"
                step="any"
                bind:value={volume}
                oninput={() => { muted = volume === 0; }}
                aria-label="Volume"
              />
            </div>
          {/if}
        </span>
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
        <button type="button" class="icon" onclick={toggleFullscreen} aria-pressed={fullscreen} aria-label={fullscreen ? 'Exit full screen' : 'Full screen'} title="Full screen (F)">
          {#if fullscreen}
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2v4H2M10 14v-4h4" stroke="currentColor" stroke-width="1.4" fill="none" /></svg>
          {:else}
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6V2h4M14 10v4h-4" stroke="currentColor" stroke-width="1.4" fill="none" /></svg>
          {/if}
        </button>
      </div>
    </div>
  {/snippet}

  {#if scopesOn && chrome === 'full'}
    <div class="scopes">
      <canvas
        bind:this={scopeCanvas}
        width={SCOPE_W}
        height={SCOPE_H}
        aria-label={scopeMode === 'waveform' ? 'Luma waveform' : 'RGB parade'}
      ></canvas>
      <span class="scopes-note">{scopeMode === 'waveform' ? 'Luma waveform' : 'RGB parade'}, read from the playback proxy</span>
    </div>
  {/if}

  <div class="transport">
    {#if !fullscreen}{@render deck()}{/if}
    <!-- The settings row is the full instrument's. Simple chrome hosts its
         draw controls in the page (the notes rail), so the row never shows. -->
    {#if chrome === 'full'}
    <div class="transport-row settings">
      {#if allowDrawing}
        <button type="button" aria-pressed={drawMode} onclick={toggleDraw}>Draw</button>
        {#if drawMode}
          <div class="seg" role="group" aria-label="Drawing tool">
            <button type="button" aria-pressed={drawTool === 'pen'} onclick={() => { drawTool = 'pen'; }}>Pen</button>
            <button type="button" aria-pressed={drawTool === 'arrow'} onclick={() => { drawTool = 'arrow'; }}>Arrow</button>
            <button type="button" aria-pressed={drawTool === 'rect'} onclick={() => { drawTool = 'rect'; }}>Rect</button>
            <button type="button" aria-pressed={drawTool === 'text'} onclick={() => { drawTool = 'text'; }}>Text</button>
          </div>
          <div class="inkrow" role="group" aria-label="Ink colour">
            {#each inkChoices as ink (ink)}
              <button
                type="button"
                class="ink"
                aria-pressed={drawColor === ink}
                aria-label={`Ink ${ink}`}
                style={`background: ${ink};`}
                onclick={() => setDrawColor(ink)}
              ></button>
            {/each}
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
      <span class="ctl-label" id="scopes-label">Scopes</span>
      <div class="seg" role="group" aria-labelledby="scopes-label">
        <button type="button" aria-pressed={scopesOn && scopeMode === 'waveform'} onclick={() => setScope('waveform')}>Waveform</button>
        <button type="button" aria-pressed={scopesOn && scopeMode === 'parade'} onclick={() => setScope('parade')}>Parade</button>
      </div>
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
      {#if chrome === 'simple'}
        <!-- The presentation scrub, purpose-built: one thin line, the played
             part bright, a handle that shows itself when the pointer is
             near. The review Timeline is an instrument; this is a progress
             bar for watching. -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div
          class="scrub"
          class:scrubbing
          bind:this={scrubEl}
          role="slider"
          aria-label="Position"
          aria-valuemin="0"
          aria-valuemax={durationFrames - 1}
          aria-valuenow={frame}
          tabindex="0"
          onpointerdown={onScrubDown}
          onpointermove={onScrubMove}
          onpointerup={onScrubUp}
          onpointercancel={onScrubUp}
          onkeydown={onScrubKeydown}
        >
          <!-- Position rides transforms: scaleX for the played run and a
               translated carrier for the handle, so per-frame motion stays on
               the compositor. The hover grow keeps its own transform on the
               handle inside the carrier. -->
          <div class="scrub-track">
            <div class="scrub-played" style={`transform: scaleX(${scrubPct});`}></div>
            <!-- Notes are visible on the simple bar too: a tick in the
                 author's ink per note, a translucent band for a range. -->
            {#if durationFrames && durationFrames > 1}
              {#each markers as marker (marker.id)}
                {@const pct = Math.min(1, marker.frameIn / (durationFrames - 1))}
                {#if marker.frameOut != null && marker.frameOut > marker.frameIn}
                  <button
                    type="button"
                    class="scrub-mark span"
                    style={`--ink: ${markerInkFor(marker.authorId)}; left: ${(pct * 100).toFixed(3)}%; width: ${(((Math.min(marker.frameOut, durationFrames - 1) - marker.frameIn) / (durationFrames - 1)) * 100).toFixed(3)}%;`}
                    aria-label={`Note from ${marker.author ?? 'a reviewer'}`}
                    onpointerdown={(event) => event.stopPropagation()}
                    onclick={(event) => { event.stopPropagation(); handleMarkerSelect(marker.id, marker.frameIn); }}
                  ></button>
                {:else}
                  <button
                    type="button"
                    class="scrub-mark"
                    style={`--ink: ${markerInkFor(marker.authorId)}; left: ${(pct * 100).toFixed(3)}%;`}
                    aria-label={`Note from ${marker.author ?? 'a reviewer'}`}
                    onpointerdown={(event) => event.stopPropagation()}
                    onclick={(event) => { event.stopPropagation(); handleMarkerSelect(marker.id, marker.frameIn); }}
                  ></button>
                {/if}
              {/each}
            {/if}
            <div class="scrub-carrier" style={`transform: translateX(${(scrubPct * scrubWidth).toFixed(2)}px);`}>
              <div class="scrub-handle"></div>
            </div>
          </div>
        </div>
      {:else}
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
  /* The floating text entry: bare type on the footage, no box furniture --
     what is typed is what the note will burn. */
  .textdraft { position: absolute; transform: none; min-width: 40px; max-width: 70%; border: 0; border-radius: 3px; background: rgba(10, 10, 10, 0.55); padding: 2px 6px; font-family: Switzer, system-ui, sans-serif; font-weight: 600; outline: 1px dashed rgba(233, 233, 233, 0.5); z-index: 3; }
  .textdraft::placeholder { color: rgba(233, 233, 233, 0.45); }
  /* Pending words on the frame: same face the canvas will burn, plus a halo
     from shadows. Live items grab; a click reopens them. */
  .textitem { position: absolute; z-index: 3; max-width: 70%; font-family: Switzer, system-ui, sans-serif; font-weight: 600; line-height: 1.15; white-space: pre-wrap; user-select: none; text-shadow: 0 1px 3px rgba(10, 10, 10, 0.9), 0 -1px 3px rgba(10, 10, 10, 0.9), 1px 0 3px rgba(10, 10, 10, 0.9), -1px 0 3px rgba(10, 10, 10, 0.9); }
  .textitem.live { cursor: grab; touch-action: none; }
  .textitem.live:active { cursor: grabbing; }
  .textitem.selected { outline: 1px dashed rgba(233, 233, 233, 0.55); outline-offset: 3px; }
  .texttools { position: absolute; bottom: 100%; left: 0; margin-bottom: 7px; display: flex; gap: 2px; padding: 2px; border-radius: 3px; background: rgba(10, 12, 16, 0.85); }
  .texttools button { display: grid; place-items: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 2px; background: none; color: var(--n-800, #c4c4c4); cursor: pointer; }
  .texttools button:hover { background: var(--n-300, #2e2e2e); color: #fff; }
  .inkrow { display: flex; align-items: center; gap: 5px; }
  .ink { width: 18px; height: 18px; padding: 0; border: 0; border-radius: 50%; cursor: pointer; opacity: 0.75; }
  .ink:hover { opacity: 1; }
  .ink[aria-pressed='true'] { opacity: 1; box-shadow: 0 0 0 2px var(--n-050, #101010), 0 0 0 3.5px var(--n-800, #c4c4c4); }

  /* The presentation scrub: a thin line with its handle always on it, so it
     reads as a seek bar before anyone touches it. Painted in the neutral
     scale, so a themed room recolours it with everything else. */
  .scrub { padding: 12px 0 8px; cursor: pointer; touch-action: none; outline: none; }
  .scrub-track { position: relative; height: 5px; border-radius: 3px; background: var(--n-150, #1c1c1c); transition: height 140ms ease; }
  .scrub-mark { position: absolute; top: -3px; bottom: -3px; width: 3px; padding: 0; border: 0; border-radius: 1px; background: var(--ink); transform: translateX(-50%); cursor: pointer; opacity: 0.9; }
  .scrub-mark.span { transform: none; min-width: 3px; opacity: 0.5; border-radius: 2px; }
  .scrub-mark:hover { opacity: 1; }
  .scrub:hover .scrub-track, .scrub.scrubbing .scrub-track, .scrub:focus-visible .scrub-track { height: 7px; }
  .scrub-played { position: absolute; top: 0; bottom: 0; left: 0; width: 100%; border-radius: 3px; background: var(--n-900, #e9e9e9); transform-origin: left center; will-change: transform; }
  .scrub-carrier { position: absolute; top: 0; bottom: 0; left: 0; width: 0; will-change: transform; }
  /* The handle is the promise that this can be grabbed: a bright dot with a
     dark ring so it reads on any wash, grown a little under the pointer. */
  .scrub-handle { position: absolute; top: 50%; left: 0; width: 15px; height: 15px; border-radius: 50%; background: var(--n-900, #e9e9e9); border: 2px solid rgba(10, 12, 16, 0.55); box-shadow: 0 1px 6px rgba(0, 0, 0, 0.45); transform: translate(-50%, -50%); transition: transform 140ms ease; }
  .scrub:hover .scrub-handle, .scrub.scrubbing .scrub-handle, .scrub:focus-visible .scrub-handle { transform: translate(-50%, -50%) scale(1.2); }
  @media (prefers-reduced-motion: reduce) {
    .scrub-track, .scrub-handle { transition: none; }
  }
  /* The picture eases in on first data instead of popping, in every chrome
     (David, 2026-07-17: all media arrives, none of it flashes). Only the
     FIRST frame of a source fades; seeks and steps are untouched, so frame
     accuracy and color judgement lose nothing. */
  video:not(.arrived) { opacity: 0; }
  video.arrived { opacity: 1; transition: opacity 360ms ease; }
  @media (prefers-reduced-motion: reduce) {
    video:not(.arrived) { opacity: 1; }
    video.arrived { transition: none; }
  }
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
  .scopes { flex: none; display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 10px 0 0; }
  .scopes canvas { display: block; width: min(100%, 720px); height: 180px; background: var(--n-000, #0a0a0a); border: 1px solid var(--n-200, #232323); border-radius: var(--radius, 3px); }
  .scopes-note { font-size: var(--text-12, 0.75rem); color: var(--n-500, #565656); }
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
  .marks button, .linky { display: inline-flex; align-items: center; gap: 6px; }
  .marks svg, .linky svg { flex: none; opacity: 0.8; }
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
  .fs-controls .marks-readout { color: rgba(255, 255, 255, 0.72); text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9); }
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
  /* The input is 18px tall so a click anywhere on the bar lands (a 3px hit
     area missed almost every click); the visible track stays thin, drawn by
     the track pseudo-elements inside it. Range inputs set their value at the
     clicked position natively once they can actually be hit. */
  .vol { width: 84px; height: 18px; appearance: none; background: none; border-radius: 2px; padding: 0; cursor: pointer; }
  .vol::-webkit-slider-runnable-track { height: 3px; border-radius: 2px; background: var(--vol-track, var(--n-300, #2e2e2e)); }
  .vol::-moz-range-track { height: 3px; border-radius: 2px; background: var(--vol-track, var(--n-300, #2e2e2e)); }
  .vol::-moz-range-progress { height: 3px; border-radius: 2px; background: var(--n-700, #9a9a9a); }
  .vol::-webkit-slider-thumb { appearance: none; width: 11px; height: 11px; margin-top: -4px; border-radius: 50%; background: var(--n-800, #c4c4c4); }
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

  /* Phone. The desktop deck is a ~460px three-column instrument; at 390 its
     side columns collapsed to zero and the marks slid under the volume
     slider. Reflow, do not shrink: numbers and transport share the top
     bands, marks get their own, and the row's edges (copy link, volume)
     become a final row of their own. */
  @media (max-width: 720px) {
    /* Content decides the height on a scrolling phone page: height:100% of an
       indefinite parent painted the deck over whatever followed the player. */
    .player { height: auto; padding: 12px; }
    /* The desktop stage takes "the height the transport does not use", but on
       a phone the page scrolls and that flex height collapses to min-height —
       every clip became a 120px letterbox. Here the footage's own shape sizes
       the stage: full width at its aspect, capped so vertical clips lead the
       screen without swallowing it. */
    .stage {
      flex: none;
      width: 100%;
      min-height: 0;
      aspect-ratio: var(--ar, 1.7778);
      max-height: 58vh;
      margin: 0 auto;
    }
    /* Fullscreen answers to the screen, not to the scroll layout: leaving
       the aspect box in force blew the picture up past the viewport. */
    .stage:fullscreen {
      aspect-ratio: auto;
      max-height: none;
      width: 100vw;
      height: 100vh;
    }
    /* Two full bands, no half-empty rows. The deck dissolves into the row
       (display: contents) so its pieces and the side clusters share one flex
       layout: timecode, transport and marks fill the first line; the copy
       link, the in/out readout and the sound/screen icons share the second.
       The frame counter and shuttle label are the colourist's dialect and
       stay off the phone. */
    .transport-row.main { display: flex; flex-wrap: wrap; align-items: center; row-gap: 6px; column-gap: 8px; }
    .deck { display: contents; }
    .readout { order: 1; min-width: 0; text-align: left; }
    .tc-main, .tc-main.copyable { font-size: 14px; }
    .cluster { order: 2; flex: 1 1 auto; justify-content: center; }
    .marks { order: 3; }
    .readout-sub, .shuttle { display: none; }
    .side { order: 4; }
    .marks-readout { order: 5; }
    .side.right { order: 6; margin-left: auto; }
    /* Reverse-play is a keyboard verb (J); on a phone it is a fourth thumb
       target the row cannot afford. Clearing marks is X's job: re-marking
       replaces, so the fourth marks button is spent width too. */
    .cluster > .icon:first-child { display: none; }
    .clearmarks { display: none; }
    .marks .lbl, .linky .lbl { display: none; }
    .marks button { width: 42px; justify-content: center; padding: 0; }
    .marks svg, .linky svg { opacity: 1; }
    .linky { width: 42px; justify-content: center; padding: 0; }

    /* The tool row scrolls sideways as one quiet band instead of stacking
       four rows of segmented controls between the picture and the timeline. */
    .transport-row.settings {
      flex-wrap: nowrap;
      justify-content: flex-start;
      overflow-x: auto;
      scrollbar-width: none;
      -webkit-overflow-scrolling: touch;
      mask-image: linear-gradient(90deg, #000 calc(100% - 28px), transparent);
    }
    .transport-row.settings > * { flex: none; }
    .transport-row.settings .grow { display: none; }
    .ctl-label { white-space: nowrap; }
  }
  /* The touch volume: a vertical slider in a small shelf above the sound
     button (the inline 3px slider is unusable under a thumb, but loudness
     still needs a control — hardware keys do not reach a muted element on
     every platform). */
  .soundwrap { position: relative; display: inline-flex; }
  .volpop {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 50%;
    transform: translateX(-50%);
    z-index: 6;
    display: grid;
    place-items: center;
    padding: 12px 10px;
    border-radius: var(--radius, 3px);
    background: var(--n-200, #232323);
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
  }
  .volv { writing-mode: vertical-rl; direction: rtl; appearance: slider-vertical; width: 18px; height: 96px; cursor: pointer; accent-color: var(--n-800, #c4c4c4); }
  /* Touch: hardware buttons own loudness on the lock screen, not in a page —
     the slider moves to the popover — and every control grows to a real
     target. */
  @media (pointer: coarse) {
    .vol { display: none; }
    .side.volume .vol { margin-right: 0; }
    .deck button { min-height: 40px; }
    .icon { min-width: 40px; min-height: 40px; justify-content: center; }
    /* 40px targets do not fit the desktop deck's fixed 34px band — left
       fixed, the readout row clips into whatever sits below the player.
       (Moot under 720px, where the deck dissolves into the row.) */
    .deck { grid-template-rows: auto auto; }
  }
</style>
