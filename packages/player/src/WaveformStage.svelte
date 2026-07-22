<script lang="ts">
  /* The audio stage: what a mix looks like when there is no picture.
   *
   * Two readings of the same seconds, stacked on one time axis. The waveform
   * is level over time, which is what you scrub by and what you point at when
   * you say "the hit is late". The spectrogram is where the energy sits, which
   * is what you point at when you say "there is a resonance around a kilohertz"
   * -- and it is the reading a waveform can never give, which is why an audio
   * page with only a waveform is half a page.
   *
   * Neither is an image the server drew. The waveform is drawn here from peak
   * data, so it is sharp at any width and coloured for the room it is in; the
   * spectrogram arrives as luminance and is mapped through a palette here for
   * the same reason.
   *
   * Motion discipline, learned in the timeline: nothing that changes every
   * frame may cause a repaint of the lanes. The playhead and the veil over
   * the part not yet played are transforms on their own layers; the canvases
   * are rasterized once per size change and then left alone.
   */
  import { frameForX, xForFrame } from './timeline.js';
  import {
    SPECTROGRAM_TICKS,
    autoGain,
    colorizeSpectrogram,
    readPeaks,
    spectrogramLut,
    spectrogramY,
    waveformBars
  } from './waveform.js';
  import type { PeaksData } from './waveform.js';

  let {
    peaksUrl = null,
    peaksImageUrl = null,
    spectrogramUrl = null,
    frame = 0,
    durationFrames = 0,
    inFrame = null,
    outFrame = null,
    view = 'both',
    washed = false,
    timecodeAt = undefined,
    onseek = undefined
  }: {
    /** Peak data sidecar (waveform_data). The preferred source. */
    peaksUrl?: string | null;
    /** The old pre-rendered waveform PNG, for versions transcoded before
        peak data existed. Drawn stretched, and honestly worse. */
    peaksImageUrl?: string | null;
    spectrogramUrl?: string | null;
    frame?: number;
    durationFrames?: number;
    inFrame?: number | null;
    outFrame?: number | null;
    /** Which readings are on: both, level alone, or frequency alone. */
    view?: 'both' | 'wave' | 'spec';
    /** Presentation rooms are the washed world; the review instrument is not. */
    washed?: boolean;
    /** Formats a frame as timecode for the hover readout. */
    timecodeAt?: ((frame: number) => string) | undefined;
    onseek?: ((frame: number) => void) | undefined;
  } = $props();

  /* Ink. The waveform carries the palette's straw and the spectrogram ramps
     from ink through persimmon to the same straw, so the two readings look
     like one instrument rather than two widgets. */
  const WAVE_INK = '#f7e1a0';
  const WAVE_INK_WASHED = '#fbf6ee';
  const SPECTRO_STOPS = ['#0e1620', '#934337', '#f7e1a0'] as const;
  const SPECTRO_STOPS_WASHED = ['#101e30', '#6b8e23', '#fbf6ee'] as const;

  let host: HTMLDivElement | undefined = $state();
  let waveCanvas: HTMLCanvasElement | undefined = $state();
  let specCanvas: HTMLCanvasElement | undefined = $state();
  let width = $state(0);
  let waveHeight = $state(0);
  let specHeight = $state(0);
  let peaks = $state<PeaksData | null>(null);
  let peaksFailed = $state(false);
  let spectrogram = $state<HTMLImageElement | null>(null);
  let hoverX = $state<number | null>(null);
  let scrubbing = $state(false);

  const lastFrame = $derived(Math.max(0, durationFrames - 1));
  const ratio = (): number =>
    typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1;

  /* Device-pixel-snapped, for the same reason the timeline's playhead is: a
     line at a fractional offset antialiases across two columns and reads as
     blurred against the crisp bars behind it. */
  const playheadX = $derived.by(() => {
    if (width <= 0 || durationFrames <= 0) return 0;
    const raw = (xForFrame(frame, durationFrames, 100) / 100) * width;
    const scale = ratio();
    return Math.round(raw * scale) / scale;
  });

  const spanFor = (from: number, to: number): { left: number; width: number } | null => {
    if (durationFrames <= 0 || from === null || to === null || to < from) return null;
    const left = xForFrame(from, durationFrames, 100);
    return { left, width: Math.max(0.3, xForFrame(to, durationFrames, 100) - left) };
  };
  const marked = $derived(
    inFrame !== null && outFrame !== null ? spanFor(inFrame, outFrame) : null
  );

  /* ---- peak data ---- */
  $effect(() => {
    const url = peaksUrl;
    peaks = null;
    peaksFailed = false;
    if (!url) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(String(response.status));
        const data = readPeaks(await response.arrayBuffer());
        if (cancelled) return;
        if (data) peaks = data;
        else peaksFailed = true;
      } catch {
        /* The stage still works: the spectrogram, the transport and the
           timeline do not depend on this, and an older version may only
           have the pre-rendered PNG. */
        if (!cancelled) peaksFailed = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  /* ---- spectrogram picture ---- */
  $effect(() => {
    const url = spectrogramUrl;
    spectrogram = null;
    if (!url) return;
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (!cancelled) spectrogram = image;
    };
    image.src = url;
    return () => {
      cancelled = true;
    };
  });

  /* ---- layout ---- */
  $effect(() => {
    if (!host) return;
    const element = host;
    const measure = (): void => {
      width = element.clientWidth;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  });

  const sizeCanvas = (canvas: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D | null => {
    const scale = ratio();
    const pixelWidth = Math.max(1, Math.round(w * scale));
    const pixelHeight = Math.max(1, Math.round(h * scale));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, w, h);
    return context;
  };

  /* ---- the waveform ----
     One lane per channel, mirrored around its own centre. Stereo draws two
     lanes because a note about the left channel is a real note; mono draws
     one, full height, rather than a thin ribbon in the middle of empty
     space. */
  $effect(() => {
    const canvas = waveCanvas;
    const data = peaks;
    const w = width;
    const h = waveHeight;
    if (!canvas || !data || w <= 0 || h <= 0) return;
    const context = sizeCanvas(canvas, w, h);
    if (!context) return;
    const gain = autoGain(data);
    const laneGap = data.channels > 1 ? 6 : 0;
    const laneHeight = (h - laneGap * (data.channels - 1)) / data.channels;
    context.fillStyle = washed ? WAVE_INK_WASHED : WAVE_INK;
    for (let channel = 0; channel < data.channels; channel += 1) {
      const top = channel * (laneHeight + laneGap);
      for (const bar of waveformBars(data, channel, w, laneHeight, gain))
        context.fillRect(bar.x, top + bar.top, bar.width, bar.bottom - bar.top);
    }
  });

  /* ---- the spectrogram ----
     The picture arrives grey and is recoloured here, then drawn at whatever
     size the lane is. The recolour runs on the source bitmap once per load,
     not per resize: it is a million pixels, and the scale-down is the cheap
     part. */
  /* $state, not a plain let: the drawing effect below reads this, and a
     non-reactive binding would leave the lane black until something else
     happened to invalidate it. */
  let colored = $state<HTMLCanvasElement | null>(null);
  $effect(() => {
    const image = spectrogram;
    colored = null;
    if (!image || image.naturalWidth === 0) return;
    const source = document.createElement('canvas');
    source.width = image.naturalWidth;
    source.height = image.naturalHeight;
    const context = source.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    context.drawImage(image, 0, 0);
    try {
      const pixels = context.getImageData(0, 0, source.width, source.height);
      colorizeSpectrogram(
        pixels.data,
        spectrogramLut(washed ? SPECTRO_STOPS_WASHED : SPECTRO_STOPS)
      );
      context.putImageData(pixels, 0, 0);
    } catch {
      /* A tainted canvas cannot be read. The grey picture is still a
         spectrogram; it just wears ffmpeg's palette instead of ours. */
    }
    colored = source;
  });

  $effect(() => {
    const canvas = specCanvas;
    const picture = colored;
    const w = width;
    const h = specHeight;
    if (!canvas || w <= 0 || h <= 0) return;
    const context = sizeCanvas(canvas, w, h);
    if (!context || !picture) return;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(picture, 0, 0, picture.width, picture.height, 0, 0, w, h);
  });

  /* ---- pointer ---- */
  const seekFromEvent = (event: PointerEvent): void => {
    if (!host || durationFrames <= 0) return;
    const rect = host.getBoundingClientRect();
    onseek?.(frameForX(event.clientX - rect.left, durationFrames, rect.width));
  };

  const handleDown = (event: PointerEvent): void => {
    if (!event.isPrimary || durationFrames <= 0) return;
    /* Scrubbing is a drag; a drag that starts a text selection paints the
       stage and its neighbours blue. */
    event.preventDefault();
    try {
      host?.setPointerCapture(event.pointerId);
    } catch {
      /* An inactive pointer id cannot be captured; the click still seeks. */
    }
    scrubbing = true;
    seekFromEvent(event);
  };

  const handleMove = (event: PointerEvent): void => {
    if (host) hoverX = event.clientX - host.getBoundingClientRect().left;
    if (!scrubbing) return;
    if (event.buttons === 0) {
      scrubbing = false;
      return;
    }
    seekFromEvent(event);
  };

  const endScrub = (): void => {
    scrubbing = false;
  };

  const hoverFrame = $derived(
    hoverX !== null && width > 0 && durationFrames > 0
      ? frameForX(hoverX, durationFrames, width)
      : null
  );
  const hoverLabel = $derived(
    hoverFrame !== null ? (timecodeAt?.(hoverFrame) ?? `${hoverFrame} fr`) : ''
  );
</script>

<!-- The stage is a scrubber, not a control in its own right: the player's
     timeline carries the slider semantics and the keyboard map. This is the
     picture, and pointing at the picture seeks, the way pointing at footage
     does not. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="audiostage"
  class:washed
  bind:this={host}
  onpointerdown={handleDown}
  onpointermove={handleMove}
  onpointerup={endScrub}
  onpointercancel={endScrub}
  onpointerleave={() => {
    hoverX = null;
    endScrub();
  }}
  style:grid-template-rows={view === 'both' && spectrogramUrl ? '1.15fr 1fr' : '1fr'}
>
  {#if view !== 'spec' || !spectrogramUrl}
  <div class="lane wave" bind:clientHeight={waveHeight}>
    {#if peaks}
      <canvas bind:this={waveCanvas} aria-hidden="true"></canvas>
    {:else if peaksImageUrl}
      <!-- The pre-rendered sidecar: a picture of a waveform, stretched to the
           lane, from a version transcoded before peak data existed. -->
      <img class="legacy" src={peaksImageUrl} alt="" draggable="false" />
    {:else}
      <p class="pending">{peaksFailed ? 'The waveform could not be read.' : 'Reading the waveform.'}</p>
    {/if}
  </div>
  {/if}

  {#if spectrogramUrl && view !== 'wave'}
    <div class="lane spec" bind:clientHeight={specHeight}>
      <canvas bind:this={specCanvas} aria-hidden="true"></canvas>
      <!-- The axis is drawn over the picture rather than beside it: the lane
           is short, and a gutter would take a third of it. -->
      <div class="axis" aria-hidden="true">
        {#each SPECTROGRAM_TICKS as tick (tick.hz)}
          <span class="tick" style:bottom={`${spectrogramY(tick.hz) * 100}%`}>{tick.label}</span>
        {/each}
      </div>
    </div>
  {/if}

  {#if marked}
    <div class="marked" style:left={`${marked.left}%`} style:width={`${marked.width}%`}></div>
  {/if}

  <!-- Everything after the playhead is dimmed. The veil is a full-width layer
       translated to the playhead and clipped by the stage, so following the
       playhead costs a transform and nothing else. -->
  <div class="veil" style:transform={`translateX(${playheadX}px)`}></div>
  <div class="playhead" style:transform={`translateX(${playheadX}px)`}></div>

  {#if hoverX !== null && hoverFrame !== null}
    <div class="guide" style:transform={`translateX(${hoverX}px)`}></div>
    <div class="hovertc" style:left={`${Math.min(Math.max(hoverX, 34), Math.max(width - 34, 34))}px`}>
      {hoverLabel}
    </div>
  {/if}
</div>

<style>
  .audiostage {
    position: relative;
    display: grid;
    gap: 2px;
    width: 100%;
    height: 100%;
    overflow: hidden;
    /* Waveform above, spectrogram below, in the proportion that keeps the
       waveform readable as a shape while the spectrogram stays tall enough
       to separate two octaves. */
    grid-template-rows: 1.15fr 1fr;
    background: var(--n-050, #101010);
    cursor: pointer;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
    contain: layout paint style;
  }
  .audiostage.washed { background: var(--ink-000, #0d1117); }
  .lane {
    position: relative;
    min-height: 0;
    overflow: hidden;
    background: var(--n-000, #0a0a0a);
  }
  .audiostage.washed .lane { background: #0b1119; }
  .lane canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
  .legacy {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: fill;
    opacity: 0.85;
  }
  .pending {
    margin: 0;
    display: grid;
    place-items: center;
    height: 100%;
    color: var(--n-600, #767676);
    font-size: 13px;
  }
  .axis {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .tick {
    position: absolute;
    left: 6px;
    transform: translateY(50%);
    padding: 0 4px;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: rgba(233, 233, 233, 0.72);
    background: rgba(10, 10, 10, 0.45);
    border-radius: 2px;
  }
  /* A hairline at each labelled decade, so the label refers to something. */
  .tick::after {
    content: '';
    position: absolute;
    left: 100%;
    top: 50%;
    width: 14px;
    height: 1px;
    background: rgba(233, 233, 233, 0.28);
  }
  .marked {
    position: absolute;
    top: 0;
    bottom: 0;
    background: rgba(233, 233, 233, 0.09);
    pointer-events: none;
  }
  .veil {
    position: absolute;
    inset: 0;
    left: 0;
    background: rgba(10, 10, 10, 0.5);
    pointer-events: none;
    will-change: transform;
  }
  .playhead {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 1px;
    margin-left: -0.5px;
    background: var(--n-900, #e9e9e9);
    pointer-events: none;
    z-index: 2;
    will-change: transform;
  }
  .guide {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 1px;
    background: rgba(233, 233, 233, 0.35);
    pointer-events: none;
    z-index: 2;
  }
  .hovertc {
    position: absolute;
    top: 4px;
    transform: translateX(-50%);
    padding: 2px 6px;
    background: rgba(10, 10, 10, 0.78);
    color: var(--n-900, #e9e9e9);
    border-radius: 2px;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    pointer-events: none;
    z-index: 3;
  }
</style>
