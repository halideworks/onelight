<script lang="ts">
  import {
    SUPPORTED_RATES,
    formatTimecode,
    isDropFrameRate,
    timecodeFromFrames
  } from '@onelight/core';
  import { frameForX, markerInkFor, spanForRange, xForFrame } from './timeline.js';
  import { isRangeDrag } from './transport-state.js';
  import type { TimelineMarker } from './timeline.js';
  import { filmstripTiles, spriteSheetSize } from './filmstrip.js';
  import type { SpriteCue } from './filmstrip.js';

  let {
    frame,
    durationFrames,
    rate = { num: 24, den: 1 },
    dropFrame = false,
    inFrame = null,
    outFrame = null,
    markers = [],
    filmstrip = null,
    waveformUrl = null,
    disabled = false,
    rangeArmed = false,
    onseek = undefined,
    onmarkerselect = undefined,
    onrangeclick = undefined,
    onrangedrag = undefined,
    onrangedone = undefined
  }: {
    frame: number;
    durationFrames: number;
    rate?: { num: number; den: number };
    dropFrame?: boolean;
    inFrame?: number | null;
    outFrame?: number | null;
    markers?: TimelineMarker[];
    filmstrip?: { url: string; cues: SpriteCue[] } | null;
    waveformUrl?: string | null;
    /* Seeking is suspended (a drawing is armed upstream): pointer scrubbing
       and marker jumps are refused while this is true. */
    disabled?: boolean;
    /* The pointer paints in/out instead of scrubbing. Armed upstream by asking
       for a ranged note or for a loop with nothing marked; Alt does it for one
       gesture without arming anything. */
    rangeArmed?: boolean;
    onseek?: ((frame: number) => void) | undefined;
    onmarkerselect?: ((markerId: string, frame: number) => void) | undefined;
    /* A press that never travelled. The ordering rule is the player's. */
    onrangeclick?: ((frame: number) => void) | undefined;
    /* Live through a paint drag, both ends at once. */
    onrangedrag?: ((anchor: number, frame: number) => void) | undefined;
    /* The gesture is over, whichever kind it was. */
    onrangedone?: (() => void) | undefined;
  } = $props();

  let stack: HTMLDivElement | undefined = $state();
  let laneWidth = $state(0);
  let scrubbing = $state(false);
  let hovered = $state<TimelineMarker | null>(null);
  let hoveredPercent = $state(0);

  const lastFrame = $derived(Math.max(0, durationFrames - 1));
  const rateSupported = $derived(
    SUPPORTED_RATES.some((candidate) => candidate.num === rate.num && candidate.den === rate.den)
  );
  const percentFor = (target: number): number => xForFrame(target, durationFrames, 100);
  const timecodeFor = (target: number): string => {
    if (!rateSupported) return `${target} fr`;
    return formatTimecode(
      timecodeFromFrames(Math.min(Math.max(target, 0), lastFrame), rate, dropFrame && isDropFrameRate(rate))
    );
  };
  const firstLineOf = (text: string | null | undefined): string => {
    const line = (text ?? '').split('\n')[0]?.trim() ?? '';
    return line.length > 90 ? `${line.slice(0, 90)}...` : line;
  };
  const ioSpan = $derived(
    inFrame !== null && outFrame !== null && outFrame >= inFrame
      ? spanForRange(inFrame, outFrame, durationFrames)
      : null
  );

  /* Device-pixel-snapped playhead offset; see the comment at the element. */
  const playheadX = $derived.by(() => {
    if (laneWidth <= 0) return 0;
    const raw = (percentFor(shownFrame) / 100) * laneWidth;
    const ratio = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1;
    return Math.round(raw * ratio) / ratio;
  });

  /* ---- filmstrip lane (sprite sheet tiles across the width) ---- */
  const FILM_LANE_HEIGHT = 36;
  const showFilmstrip = $derived(Boolean(filmstrip && filmstrip.cues.length > 0));

  /* The sheet's real pixel size, measured from the image rather than inferred
     from the cues.

     It cannot be inferred: the worker tiles with tile=10x10, which always emits
     a full 10x10 canvas and pads the cells it did not fill. A clip with fewer
     than 100 cues therefore has a sheet taller than its cues reach -- 48 cues
     occupy 5 rows (max y+h = 450) of a sheet that is really 900 tall. Scaling
     background-size to that inferred 450 squashed the sheet 2:1 and stacked two
     rows of the grid inside every tile.

     Measuring also keeps this correct for any future grid shape, and costs
     nothing: the browser fetches the same URL for background-image, so this
     resolves from cache. */
  let measuredSheet = $state<{ width: number; height: number } | null>(null);
  $effect(() => {
    const url = filmstrip?.url;
    measuredSheet = null;
    if (!url) return;
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (!cancelled && image.naturalWidth > 0 && image.naturalHeight > 0)
        measuredSheet = {
          width: image.naturalWidth,
          height: image.naturalHeight
        };
    };
    image.src = url;
    return () => {
      cancelled = true;
    };
  });
  /* Until it is measured, the cue-implied size is the best guess available --
     and it is exact whenever the grid is full. */
  const sheet = $derived(
    measuredSheet ??
      (filmstrip ? spriteSheetSize(filmstrip.cues) : { width: 0, height: 0 })
  );
  const tiles = $derived(
    filmstrip && laneWidth > 0
      ? filmstripTiles({
          cues: filmstrip.cues,
          durationFrames,
          rate,
          width: laneWidth,
          /* Slot width follows the tile aspect at the lane height. */
          tileWidth: Math.max(
            24,
            Math.round((FILM_LANE_HEIGHT * (filmstrip.cues[0]?.w ?? 160)) / (filmstrip.cues[0]?.h ?? 90))
          )
        })
      : []
  );
  const tileStyle = (cue: SpriteCue, left: number, width: number): string => {
    const scale = FILM_LANE_HEIGHT / cue.h;
    return [
      `left: ${left}px`,
      `width: ${width}px`,
      `background-image: url(${JSON.stringify(filmstrip?.url ?? '')})`,
      `background-size: ${sheet.width * scale}px ${sheet.height * scale}px`,
      `background-position: ${-cue.x * scale}px ${-cue.y * scale}px`
    ].join('; ');
  };

  /* Track layout width for the tile mapping. The lane is width-driven, so a
     ResizeObserver on the stack keeps tiles honest across window resizes. */
  $effect(() => {
    if (!stack) return;
    const element = stack;
    const measure = (): void => {
      laneWidth = element.clientWidth;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  });

  const frameFromEvent = (event: PointerEvent): number => {
    if (!stack) return frame;
    const rect = stack.getBoundingClientRect();
    return frameForX(event.clientX - rect.left, durationFrames, rect.width);
  };

  /* Scrubbing tracks the POINTER and seeks once per animation frame.
     A seek per pointermove is 125 of them a second from an ordinary mouse, and
     each one pauses the element, assigns currentTime and arms a verify: the
     decoder never lands one before the next arrives, so the picture tears and
     the playhead crawls behind the finger. The newest target wins when the
     frame ticks, and the line is drawn from where the pointer actually is, so
     it stays glued to the hand however far behind the decoder falls. The
     presentation scrub has worked this way; the instrument had not. */
  let scrubPreview = $state<number | null>(null);
  let scrubTarget: number | null = null;
  let scrubRaf: number | null = null;

  const applyScrub = (): void => {
    scrubRaf = null;
    if (scrubTarget === null) return;
    const target = scrubTarget;
    scrubTarget = null;
    onseek?.(target);
  };

  const seekFromEvent = (event: PointerEvent): void => {
    const target = frameFromEvent(event);
    scrubPreview = target;
    scrubTarget = target;
    if (scrubRaf === null) scrubRaf = requestAnimationFrame(applyScrub);
  };

  /* The preview holds after release until the real frame catches up, so the
     line never snaps backwards to a stale position and then forwards again. */
  $effect(() => {
    void frame;
    if (!scrubbing) scrubPreview = null;
  });

  /* Where the playhead is drawn: the pointer while dragging, the player's own
     frame the rest of the time. */
  const shownFrame = $derived(scrubPreview ?? frame);

  /* A live paint gesture: where it started, in frames and in pixels. The pixel
     anchor is what decides click-or-drag, because a frame of travel means
     nothing on a two-hour timeline and everything on a two-second one. */
  let painting = $state<{ frame: number; x: number; moved: boolean } | null>(null);

  const handlePointerDown = (event: PointerEvent): void => {
    if (!event.isPrimary || disabled) return;
    event.preventDefault();
    try {
      stack?.setPointerCapture(event.pointerId);
    } catch {
      /* An inactive pointer id cannot be captured; the gesture still lands. */
    }
    if (rangeArmed || event.altKey) {
      painting = { frame: frameFromEvent(event), x: event.clientX, moved: false };
      return;
    }
    scrubbing = true;
    seekFromEvent(event);
  };

  const handlePointerMove = (event: PointerEvent): void => {
    /* If the pointerup was missed (capture failed, release off-track), no
       button is held any more: drop the latch so a bare hover cannot act. */
    if (painting) {
      if (event.buttons === 0) {
        endGesture(event);
        return;
      }
      if (!painting.moved && !isRangeDrag(painting.x, event.clientX)) return;
      painting = { ...painting, moved: true };
      onrangedrag?.(painting.frame, frameFromEvent(event));
      return;
    }
    if (!scrubbing) return;
    if (event.buttons === 0) {
      scrubbing = false;
      return;
    }
    seekFromEvent(event);
  };

  const endGesture = (event: PointerEvent): void => {
    if (scrubbing) {
      /* The last pointer position is the destination, precisely: waiting for
         the next animation frame would drop the final few pixels of the drag. */
      if (scrubRaf !== null) cancelAnimationFrame(scrubRaf);
      scrubRaf = null;
      applyScrub();
    }
    scrubbing = false;
    const paint = painting;
    painting = null;
    if (!paint) return;
    /* A press that never travelled is a click, and the click rule (first plants
       the in, later closes it, earlier moves it) belongs to whoever owns the
       marks. */
    if (!paint.moved) onrangeclick?.(frameFromEvent(event));
    onrangedone?.();
  };

  const cancelGesture = (): void => {
    if (scrubRaf !== null) cancelAnimationFrame(scrubRaf);
    scrubRaf = null;
    scrubTarget = null;
    scrubPreview = null;
    scrubbing = false;
    painting = null;
    onrangedone?.();
  };

  const showTip = (marker: TimelineMarker): void => {
    hovered = marker;
    /* Clamp so the tooltip stays inside the strip near the edges. */
    hoveredPercent = Math.min(88, Math.max(12, percentFor(marker.frameIn)));
  };

  const hideTip = (marker: TimelineMarker): void => {
    if (hovered?.id === marker.id) hovered = null;
  };

  const selectMarker = (marker: TimelineMarker): void => {
    if (disabled) return;
    onseek?.(marker.frameIn);
    onmarkerselect?.(marker.id, marker.frameIn);
  };

  const markerLabel = (marker: TimelineMarker): string => {
    const who = marker.author ?? 'Reviewer';
    const where =
      marker.frameOut != null && marker.frameOut > marker.frameIn
        ? `${timecodeFor(marker.frameIn)} to ${timecodeFor(marker.frameOut)}`
        : timecodeFor(marker.frameIn);
    const line = firstLineOf(marker.text);
    return line ? `${who}, ${where}: ${line}` : `${who}, ${where}`;
  };
</script>

<div class="timeline">
  <!-- Keyboard operation comes from the player's global map (arrows step,
       Home/End jump); the stack is a pointer scrubber across every lane.
       It carries no role of its own: the slider below is the control assistive
       tech should find, and the marker buttons keep their own semantics. This
       is only the hit area that lets a drag start anywhere in the stack. -->
  <div
    class="stack"
    role="presentation"
    class:disabled
    class:arming={rangeArmed}
    bind:this={stack}
    onpointerdown={handlePointerDown}
    onpointermove={handlePointerMove}
    onpointerup={endGesture}
    onpointercancel={cancelGesture}
  >
    <div
      class="track"
      role="slider"
      tabindex="0"
      aria-label="Timeline scrubber"
      aria-valuemin={0}
      aria-valuemax={lastFrame}
      aria-valuenow={Math.min(shownFrame, lastFrame)}
      aria-valuetext={timecodeFor(shownFrame)}
    >
      {#if ioSpan}
        <div
          class="io"
          style:left={`${ioSpan.left * 100}%`}
          style:width={`${ioSpan.width * 100}%`}
        ></div>
      {:else if inFrame !== null}
        <!-- An in with no out yet. Half a range is still a decision that has
             been made, and it has to be visible or the next click is a guess. -->
        <div class="io-open" style:left={`${percentFor(inFrame)}%`}></div>
      {/if}
    </div>
    {#if showFilmstrip}
      <!-- Thumbnails are duplicates of footage on screen: decorative for
           assistive tech, informative for eyes. -->
      <div class="film" aria-hidden="true">
        {#each tiles as tile, index (index)}
          <div class="tile" style={tileStyle(tile.cue, tile.left, tile.width)}></div>
        {/each}
      </div>
    {/if}
    {#if waveformUrl}
      <!-- The peaks sidecar is a pre-rendered image, not peak data; it is
           stretched to the lane and forced neutral (grayscale keeps R=G=B). -->
      <div class="wave" aria-hidden="true">
        <img src={waveformUrl} alt="" draggable="false" />
      </div>
    {/if}
    <div class="lane">
      {#each markers as marker (marker.id)}
        {#if marker.frameOut != null && marker.frameOut > marker.frameIn}
          {@const span = spanForRange(marker.frameIn, marker.frameOut, durationFrames)}
          <button
            type="button"
            class="span"
            class:completed={marker.completed}
            style:--ink={markerInkFor(marker.authorId)}
            style:left={`${span.left * 100}%`}
            style:width={`${Math.max(span.width * 100, 0.4)}%`}
            aria-label={markerLabel(marker)}
            onpointerdown={(event) => event.stopPropagation()}
            onclick={() => selectMarker(marker)}
            onpointerenter={() => showTip(marker)}
            onpointerleave={() => hideTip(marker)}
            onfocus={() => showTip(marker)}
            onblur={() => hideTip(marker)}
          ></button>
        {:else}
          <button
            type="button"
            class="mark"
            class:completed={marker.completed}
            style:--ink={markerInkFor(marker.authorId)}
            style:left={`${percentFor(marker.frameIn)}%`}
            aria-label={markerLabel(marker)}
            onpointerdown={(event) => event.stopPropagation()}
            onclick={() => selectMarker(marker)}
            onpointerenter={() => showTip(marker)}
            onpointerleave={() => hideTip(marker)}
            onfocus={() => showTip(marker)}
            onblur={() => hideTip(marker)}
          ></button>
        {/if}
      {/each}
    </div>
    <!-- The playhead moves by transform, not by left: a transform stays on
         the compositor, while a left change invalidates layout and repaints
         every lane under the line -- with the waveform open that meant
         re-rasterizing a filtered full-width image on every presented frame,
         which is exactly the stutter it caused.

         The offset snaps to device pixels: at fractional positions the 1px
         line antialiases smoothly while the border-drawn cap rounds to whole
         pixels, and the two drift against each other -- the cap visibly
         warbled over the line. On a shared device-pixel boundary they move
         as one mark. -->
    <div class="playhead" style:transform={`translateX(${playheadX}px)`}></div>
  </div>
  {#if hovered}
    <div class="tip" style:left={`${hoveredPercent}%`} role="status">
      <span class="tip-head">
        <strong>{hovered.author ?? 'Reviewer'}</strong>
        <span class="tc">{timecodeFor(hovered.frameIn)}</span>
      </span>
      {#if firstLineOf(hovered.text)}
        <span class="tip-body">{firstLineOf(hovered.text)}</span>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* Review-room chrome: neutral values only, separation by value step. */
  .timeline { position: relative; padding: 8px 0 2px; }
  .stack {
    position: relative;
    display: grid;
    gap: 1px;
    cursor: pointer;
    touch-action: none;
  }
  .stack.disabled { cursor: default; }
  .stack.disabled .lane button { cursor: default; }
  .track {
    position: relative;
    height: 18px;
    background: var(--n-150, #1c1c1c);
    border-radius: 2px 2px 0 0;
  }
  .track:focus-visible { outline: 1px solid var(--n-800, #c4c4c4); outline-offset: 2px; }
  .io {
    position: absolute;
    top: 0;
    bottom: 0;
    background: var(--n-300, #2e2e2e);
  }
  /* While the range is being painted it is the thing being looked at, so it
     takes a step up the neutral scale and its ends are drawn. */
  .stack.arming .io {
    background: var(--n-400, #3d3d3d);
    box-shadow: inset 2px 0 0 var(--n-800, #c4c4c4), inset -2px 0 0 var(--n-800, #c4c4c4);
  }
  .io-open {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    margin-left: -1px;
    background: var(--n-700, #9a9a9a);
  }
  .stack.arming .io-open { background: var(--n-900, #e9e9e9); }
  /* Armed, the pointer is a marking tool and says so. */
  .stack.arming { cursor: crosshair; }
  .film {
    position: relative;
    height: 36px;
    overflow: hidden;
    background: var(--n-100, #161616);
    /* Static content: scope any invalidation to the lane itself. */
    contain: layout paint style;
  }
  .tile {
    position: absolute;
    top: 0;
    height: 36px;
    background-repeat: no-repeat;
  }
  .wave {
    height: 26px;
    overflow: hidden;
    background: var(--n-100, #161616);
    contain: layout paint style;
  }
  .wave img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: fill;
    /* The sidecar PNG is tinted; grayscale forces it back to R=G=B. The
       filtered image rasterizes once because nothing invalidates the lane:
       the playhead above it is transform-only. */
    filter: grayscale(1);
    opacity: 0.7;
    pointer-events: none;
    user-select: none;
  }
  .playhead {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 1px;
    margin-left: -0.5px;
    background: var(--n-900, #e9e9e9);
    z-index: 2;
    pointer-events: none;
    /* Its own compositor layer: moving it repaints nothing else. */
    will-change: transform;
  }
  .playhead::before {
    content: '';
    position: absolute;
    top: 0;
    left: -3.5px;
    border: 4px solid transparent;
    border-top-color: var(--n-900, #e9e9e9);
  }
  .lane {
    position: relative;
    height: 16px;
    background: var(--n-100, #161616);
    border-radius: 0 0 2px 2px;
    contain: layout style;
  }
  .lane button {
    position: absolute;
    border: 0;
    padding: 0;
    cursor: pointer;
    background: var(--n-700, #9a9a9a);
  }
  .mark {
    top: 5px;
    width: 7px;
    height: 7px;
    margin-left: -3.5px;
    transform: rotate(45deg);
  }
  .mark:hover { background: var(--ink, var(--n-900, #e9e9e9)); filter: brightness(1.35); }
  .span {
    top: 5px;
    height: 7px;
    border-radius: 2px;
    background: var(--ink, var(--n-600, #767676));
  }
  .span:hover { filter: brightness(1.35); }
  /* Whose note it is, in the ink assigned to that person. The design doc bans
     tinted chrome near the frame but allows muted desaturated functional colour
     for markers, which is the only way to see at a glance that a run of notes is
     all from one person. */
  .lane button { background: var(--ink, var(--n-600, #767676)); }

  /* Resolved notes stay on the timeline and stay findable: same ink, hollowed
     out and dimmed. Filling them grey said "someone else's note"; removing them
     said "never happened". A ring says done. */
  .lane button.completed { background: transparent; box-shadow: inset 0 0 0 1.5px var(--ink, var(--n-500, #565656)); opacity: 0.65; }
  .lane button.completed:hover { opacity: 1; background: transparent; filter: none; }
  .span.completed { background: transparent; }
  .lane button:focus-visible { outline: 1px solid var(--n-800, #c4c4c4); outline-offset: 2px; }
  .tip {
    position: absolute;
    bottom: calc(100% + 2px);
    transform: translateX(-50%);
    display: grid;
    gap: 2px;
    max-width: 320px;
    padding: 7px 10px;
    background: var(--n-200, #232323);
    color: var(--n-800, #c4c4c4);
    border-radius: 3px;
    font-size: 13px;
    pointer-events: none;
    white-space: nowrap;
    z-index: 3;
  }
  .tip-head { display: flex; gap: 10px; align-items: baseline; }
  .tip-head strong { color: var(--n-900, #e9e9e9); font-weight: 600; }
  .tip .tc { font-variant-numeric: tabular-nums; color: var(--n-700, #9a9a9a); }
  .tip-body { overflow: hidden; text-overflow: ellipsis; }
</style>
