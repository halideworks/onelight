<script lang="ts">
  /* The still viewer: the instrument for reviewing a picture.
   *
   * A still was shown here as an <img> with a max-height, which is a preview,
   * not a review. Judging a frame grab, a key art comp or a title card means
   * getting to the pixels: fit to see the composition, one-to-one to see the
   * grain, past that to see an edge -- with nearest-neighbour above 100% so
   * what is on screen is the file's pixels and not the browser's opinion of
   * them.
   *
   * The drawing overlay, the ink, and the "one pending drawing at a time"
   * contract are the player's, deliberately: a note drawn on a still and a
   * note drawn on a frame are the same kind of note, they post through the
   * same endpoint, and they should be made with the same hand.
   */
  import AnnotationOverlay from './AnnotationOverlay.svelte';
  import { ANNOTATION_INKS } from './annotations.js';
  import type { AnnotationPoint, AnnotationStroke, FrameAnnotation } from './annotations.js';
  import {
    IDENTITY,
    MIN_SCALE,
    boxToPoint,
    clampPan,
    clampScale,
    fitScale,
    steppedScale,
    zoomAbout,
    zoomLabel
  } from './image-view.js';
  import type { ViewState } from './image-view.js';

  let {
    src,
    alt = '',
    compareSrc = null,
    compareLabel = 'Previous version',
    annotations = [],
    allowDrawing = false,
    drawDefaultColor = undefined,
    chrome = 'full',
    watermark = null,
    ondrawingchange = undefined,
    ondrawmodechange = undefined
  }: {
    src: string;
    alt?: string;
    /** The same asset's previous version, for A/B. Null when there is none. */
    compareSrc?: string | null;
    compareLabel?: string;
    annotations?: FrameAnnotation[];
    allowDrawing?: boolean;
    drawDefaultColor?: string | undefined;
    /* 'simple' is a client's room: the tools that are for working go away and
       what is left is the picture and the zoom. */
    chrome?: 'full' | 'simple';
    watermark?: { lines: string[]; opacity?: number } | null;
    ondrawingchange?: ((drawing: { frame: number; strokes: AnnotationStroke[] } | null) => void) | undefined;
    ondrawmodechange?: ((on: boolean, tool: 'pen' | 'arrow' | 'rect' | 'text') => void) | undefined;
  } = $props();

  /* A still is one frame, and notes on it anchor there. The number is not
     decoration: it is what makes an image comment the same shape as every
     other comment in the system. */
  const STILL_FRAME = 0;

  let stage: HTMLDivElement | undefined = $state();
  let picture: HTMLImageElement | undefined = $state();
  let boxWidth = $state(0);
  let boxHeight = $state(0);
  let naturalWidth = $state(0);
  let naturalHeight = $state(0);
  let view = $state<ViewState>({ ...IDENTITY });
  /* Fit until someone chooses otherwise; after that the choice survives a
     window resize, which "always refit" would quietly undo mid-inspection. */
  let userZoomed = $state(false);
  let arrived = $state(false);
  let compareMode = $state<'off' | 'slider' | 'blink'>('off');
  /* Where the wipe sits, 0..1 across the picture. */
  let wipe = $state(0.5);
  let blinkShowing = $state<'current' | 'previous'>('current');
  let panning = $state(false);

  const image = $derived({ width: naturalWidth, height: naturalHeight });
  const box = $derived({ width: boxWidth, height: boxHeight });
  const fit = $derived(fitScale(image, box));
  /* A picture larger than the box fits below the smallest zoom step, so the
     floor follows the fit rather than the step list. */
  const floor = $derived(Math.min(fit, MIN_SCALE));
  /* Above one-to-one the pixels are the point: no smoothing, so a hard edge
     stays hard and a single-pixel line stays one pixel. */
  const pixelated = $derived(view.scale > 1.01);
  const shown = $derived({
    width: image.width * view.scale,
    height: image.height * view.scale
  });

  const applyFit = (): void => {
    userZoomed = false;
    view = { scale: clampScale(fit, floor), x: 0, y: 0 };
  };

  const setScale = (scale: number): void => {
    userZoomed = true;
    view = clampPan({ scale: clampScale(scale, floor), x: view.x, y: view.y }, image, box);
  };

  /* Refit while the view is still the fitted one: a resized window, a rail
     opening, or the first metadata arriving all change the box. */
  $effect(() => {
    void fit;
    if (!userZoomed) view = { scale: clampScale(fit, floor), x: 0, y: 0 };
  });

  $effect(() => {
    if (!stage) return;
    const element = stage;
    const measure = (): void => {
      boxWidth = element.clientWidth;
      boxHeight = element.clientHeight;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  });

  /* A new source is a new picture: measurements and the fade start over. */
  $effect(() => {
    void src;
    arrived = false;
    naturalWidth = 0;
    naturalHeight = 0;
  });

  const handleLoad = (): void => {
    if (!picture) return;
    naturalWidth = picture.naturalWidth;
    naturalHeight = picture.naturalHeight;
    arrived = true;
  };

  /* ---- pointer ---- */
  let grab: { pointerId: number; x: number; y: number } | null = null;

  const pointerInBox = (event: PointerEvent): { x: number; y: number } => {
    const rect = stage?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: event.clientX - rect.left - rect.width / 2,
      y: event.clientY - rect.top - rect.height / 2
    };
  };

  const handleWheel = (event: WheelEvent): void => {
    if (!stage) return;
    event.preventDefault();
    const rect = stage.getBoundingClientRect();
    const pointer = {
      x: event.clientX - rect.left - rect.width / 2,
      y: event.clientY - rect.top - rect.height / 2
    };
    /* Exponential in the wheel delta, so a trackpad flick and a mouse notch
       both feel proportional rather than one of them crawling. */
    userZoomed = true;
    view = zoomAbout(view, Math.exp(-event.deltaY * 0.0016), pointer, image, box, floor);
  };

  const handlePointerDown = (event: PointerEvent): void => {
    if (drawMode || !event.isPrimary) return;
    /* Without this the browser starts its own drag-select on the way past:
       the picture and the controls around it turn selection-blue under the
       pointer, which is exactly what you cannot see through while you are
       inspecting a picture. */
    event.preventDefault();
    const at = pointerInBox(event);
    grab = { pointerId: event.pointerId, x: at.x - view.x, y: at.y - view.y };
    panning = true;
    try {
      stage?.setPointerCapture(event.pointerId);
    } catch {
      /* An inactive pointer id cannot be captured; the drag still tracks. */
    }
  };

  const handlePointerMove = (event: PointerEvent): void => {
    if (!grab || event.buttons === 0) {
      if (grab && event.buttons === 0) endPan();
      return;
    }
    const at = pointerInBox(event);
    userZoomed = true;
    view = clampPan({ scale: view.scale, x: at.x - grab.x, y: at.y - grab.y }, image, box);
  };

  const endPan = (): void => {
    grab = null;
    panning = false;
  };

  const handleDoubleClick = (event: MouseEvent): void => {
    if (drawMode) return;
    if (view.scale > fit * 1.01) {
      applyFit();
      return;
    }
    const rect = stage?.getBoundingClientRect();
    const pointer = rect
      ? {
          x: event.clientX - rect.left - rect.width / 2,
          y: event.clientY - rect.top - rect.height / 2
        }
      : { x: 0, y: 0 };
    userZoomed = true;
    view = zoomAbout(view, 1 / view.scale, pointer, image, box, floor);
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
      if (event.key === 'Escape') {
        event.preventDefault();
        toggleDraw();
      }
      return;
    }
    /* The keys a viewer already knows from every other picture tool. */
    if (key === '0') { event.preventDefault(); applyFit(); }
    if (key === '1') { event.preventDefault(); setScale(1); }
    if (event.key === '+' || event.key === '=') { event.preventDefault(); setScale(steppedScale(view.scale, 1)); }
    if (event.key === '-' || event.key === '_') { event.preventDefault(); setScale(steppedScale(view.scale, -1, floor)); }
    const step = event.shiftKey ? 200 : 60;
    if (event.key === 'ArrowLeft') { event.preventDefault(); nudge(step, 0); }
    if (event.key === 'ArrowRight') { event.preventDefault(); nudge(-step, 0); }
    if (event.key === 'ArrowUp') { event.preventDefault(); nudge(0, step); }
    if (event.key === 'ArrowDown') { event.preventDefault(); nudge(0, -step); }
    if (compareSrc && key === 'b') {
      event.preventDefault();
      compareMode = compareMode === 'blink' ? 'off' : 'blink';
    }
  };

  const nudge = (dx: number, dy: number): void => {
    userZoomed = true;
    view = clampPan({ scale: view.scale, x: view.x + dx, y: view.y + dy }, image, box);
  };

  /* ---- A/B against the previous version ----
     The wipe is the honest comparison for a still: same pixels, same place,
     one boundary you control. Blink is the other half of the pair, because
     small shifts are invisible side by side and obvious when they flicker. */
  $effect(() => {
    if (compareMode !== 'blink') {
      blinkShowing = 'current';
      return;
    }
    const timer = setInterval(() => {
      blinkShowing = blinkShowing === 'current' ? 'previous' : 'current';
    }, 700);
    return () => clearInterval(timer);
  });
  $effect(() => {
    if (!compareSrc) compareMode = 'off';
  });

  const startWipe = (event: PointerEvent): void => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const move = (moveEvent: PointerEvent): void => {
      wipe = Math.min(1, Math.max(0, (moveEvent.clientX - rect.left) / rect.width));
    };
    move(event);
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /* ---- drawing (the player's contract, on a still) ---- */
  const INK_ACCENT = '#a5605a';
  const DRAW_WIDTH = 0.004;
  let drawMode = $state(false);
  let drawTool = $state<'pen' | 'arrow' | 'rect' | 'text'>('pen');
  let drawColor = $state('');
  let colorPicked = false;
  let pendingStrokes = $state<AnnotationStroke[]>([]);
  let textDraft = $state<{ point: AnnotationPoint; value: string } | null>(null);

  $effect(() => {
    const fallback = drawDefaultColor ?? INK_ACCENT;
    if (!colorPicked) drawColor = fallback;
  });
  $effect(() => {
    ondrawmodechange?.(drawMode, drawTool);
  });

  const inkChoices = $derived([
    ...(drawDefaultColor ? [drawDefaultColor] : []),
    ...ANNOTATION_INKS.filter((ink) => ink !== drawDefaultColor).slice(0, 4),
    '#ffffff',
    '#0a0a0a'
  ]);

  const emitDrawing = (): void => {
    ondrawingchange?.(
      pendingStrokes.length ? { frame: STILL_FRAME, strokes: pendingStrokes } : null
    );
  };

  const commitStroke = (stroke: AnnotationStroke): void => {
    pendingStrokes = [...pendingStrokes, stroke];
    emitDrawing();
  };

  const toggleDraw = (): void => {
    if (!allowDrawing) return;
    drawMode = !drawMode;
    if (!drawMode) textDraft = null;
  };

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
  export function clearDrawing(): void {
    pendingStrokes = [];
    drawMode = false;
    textDraft = null;
    ondrawingchange?.(null);
  }
  /* The picture as posted, for a chosen thumbnail: the file itself, at its
     own resolution, not the zoomed view on screen. */
  export function captureFrame(maxWidth = 1280): Promise<Blob | null> {
    const element = picture;
    if (!element || element.naturalWidth === 0) return Promise.resolve(null);
    const scale = Math.min(1, maxWidth / element.naturalWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(element.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(element.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) return Promise.resolve(null);
    context.drawImage(element, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob), 'image/png');
    });
  }

  const undoStroke = (): void => {
    pendingStrokes = pendingStrokes.slice(0, -1);
    emitDrawing();
  };
  const clearStrokes = (): void => {
    pendingStrokes = [];
    emitDrawing();
  };

  const canvasStrokes = $derived([
    ...annotations.flatMap((annotation) => annotation.strokes),
    ...pendingStrokes
  ]);

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
      points: [draft.point]
    });
  };

  const wmLines = $derived((watermark?.lines ?? []).filter((line) => line && line.trim()));
  const wmOpacity = $derived(Math.min(0.8, Math.max(0.05, watermark?.opacity ?? 0.28)));
</script>

<svelte:window onkeydown={handleKeydown} />
<section class="viewer" aria-label="Still viewer">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="stage"
    class:panning
    class:drawing={drawMode}
    bind:this={stage}
    onwheel={handleWheel}
    onpointerdown={handlePointerDown}
    onpointermove={handlePointerMove}
    onpointerup={endPan}
    onpointercancel={endPan}
    ondblclick={handleDoubleClick}
  >
    <!-- The picture and everything registered to it ride one transform, so a
         drawing stays on the pixels it was made on at any zoom. -->
    <div
      class="plate"
      style:width={`${shown.width}px`}
      style:height={`${shown.height}px`}
      style:transform={`translate(${view.x}px, ${view.y}px)`}
    >
      <img
        class="picture"
        class:arrived
        class:pixelated
        bind:this={picture}
        {src}
        {alt}
        draggable="false"
        onload={handleLoad}
      />
      {#if compareSrc && compareMode === 'slider'}
        <!-- The previous version, revealed to the left of the wipe. -->
        <div class="wipe" style:width={`${wipe * 100}%`}>
          <img
            class="picture previous"
            src={compareSrc}
            alt={compareLabel}
            draggable="false"
            style:width={`${shown.width}px`}
          />
        </div>
      {:else if compareSrc && compareMode === 'blink' && blinkShowing === 'previous'}
        <img class="picture previous over" src={compareSrc} alt={compareLabel} draggable="false" />
      {/if}
      <AnnotationOverlay
        strokes={canvasStrokes}
        width={shown.width}
        height={shown.height}
        interactive={drawMode}
        tool={drawTool}
        color={drawColor}
        strokeWidth={DRAW_WIDTH}
        onstroke={commitStroke}
        ontextplace={(point) => {
          if (textDraft?.value.trim()) {
            commitTextDraft();
            return;
          }
          textDraft = { point, value: '' };
        }}
      />
      {#if textDraft}
        <input
          class="textdraft"
          style={`left: ${textDraft.point[0] * 100}%; top: ${textDraft.point[1] * 100}%; color: ${drawColor}; font-size: ${Math.max(12, 0.035 * Math.hypot(shown.width, shown.height))}px;`}
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
      {#if wmLines.length}
        <div class="watermark" style:opacity={wmOpacity} aria-hidden="true">
          {#each Array.from({ length: 12 }, (_value, index) => index) as cell (cell)}
            <span class="wm-cell">{wmLines.join('  ')}</span>
          {/each}
        </div>
      {/if}
    </div>
    {#if compareSrc && compareMode === 'slider'}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="wipebar" onpointerdown={startWipe}>
        <div class="wipeline" style:left={`${wipe * 100}%`}></div>
      </div>
    {/if}
    {#if compareMode !== 'off'}
      <span class="ablabel">{blinkShowing === 'previous' || compareMode === 'slider' ? compareLabel : 'This version'}</span>
    {/if}
  </div>

  <div class="controls">
    <div class="zoomgroup" role="group" aria-label="Zoom">
      <button type="button" class="icon" onclick={() => setScale(steppedScale(view.scale, -1, floor))} aria-label="Zoom out" title="Zoom out (-)">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none" /></svg>
      </button>
      <span class="zoom tc">{zoomLabel(view.scale)}</span>
      <button type="button" class="icon" onclick={() => setScale(steppedScale(view.scale, 1))} aria-label="Zoom in" title="Zoom in (+)">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 8h10M8 3v10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none" /></svg>
      </button>
    </div>
    <div class="seg" role="group" aria-label="Zoom presets">
      <button type="button" aria-pressed={!userZoomed} onclick={applyFit} title="Fit the picture (0)">Fit</button>
      <button type="button" aria-pressed={Math.abs(view.scale - 1) < 0.005} onclick={() => setScale(1)} title="One image pixel per screen pixel (1)">100%</button>
      <button type="button" aria-pressed={view.scale >= 4} onclick={() => setScale(4)} title="Inspect the pixels">400%</button>
    </div>
    {#if naturalWidth > 0}
      <span class="dims tc">{naturalWidth} x {naturalHeight}</span>
    {/if}
    <span class="grow"></span>
    {#if compareSrc}
      <span class="ctl-label" id="ab-label">Compare</span>
      <div class="seg" role="group" aria-labelledby="ab-label">
        <button type="button" aria-pressed={compareMode === 'off'} onclick={() => { compareMode = 'off'; }}>Off</button>
        <button type="button" aria-pressed={compareMode === 'slider'} onclick={() => { compareMode = 'slider'; }}>Wipe</button>
        <button type="button" aria-pressed={compareMode === 'blink'} onclick={() => { compareMode = 'blink'; }} title="Alternate the two versions (B)">Blink</button>
      </div>
    {/if}
    {#if allowDrawing && chrome === 'full'}
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
      {/if}
    {/if}
  </div>
</section>

<style>
  /* The still viewer lives in the review room: neutral values only. */
  .viewer { display: flex; flex-direction: column; min-height: 0; height: 100%; background: var(--n-050, #101010); color: var(--n-800, #c4c4c4); padding: 16px; }
  .stage {
    position: relative;
    flex: 1;
    min-height: 160px;
    display: grid;
    place-items: center;
    overflow: hidden;
    background: var(--n-000, #0a0a0a);
    cursor: grab;
    touch-action: none;
    /* A pan is a drag, and a drag over anything selectable paints it blue.
       Nothing on the stage is text anyone reads: the readouts live in the
       control row below it. */
    user-select: none;
    -webkit-user-select: none;
    /* A checkered ground would say "transparency"; a flat near-black says
       nothing, which is what a surround should say. */
  }
  .stage.panning { cursor: grabbing; }
  .stage.drawing { cursor: crosshair; }
  .plate { position: relative; will-change: transform; }
  .picture {
    display: block;
    width: 100%;
    height: 100%;
    opacity: 0;
    transition: opacity 220ms ease;
  }
  .picture.arrived { opacity: 1; }
  .picture.pixelated { image-rendering: pixelated; }
  .wipe { position: absolute; inset: 0; overflow: hidden; }
  .wipe .picture { position: absolute; top: 0; left: 0; height: 100%; width: auto; max-width: none; opacity: 1; }
  .picture.over { position: absolute; inset: 0; opacity: 1; }
  .wipebar { position: absolute; inset: 0; cursor: ew-resize; }
  .wipeline { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--n-900, #e9e9e9); }
  .wipeline::after {
    content: '';
    position: absolute;
    top: 50%;
    left: 50%;
    width: 22px;
    height: 22px;
    margin: -11px 0 0 -11px;
    border-radius: 50%;
    background: var(--n-900, #e9e9e9);
    opacity: 0.9;
  }
  .ablabel {
    position: absolute;
    left: 10px;
    top: 10px;
    padding: 3px 7px;
    border-radius: 2px;
    background: rgba(10, 10, 10, 0.72);
    color: var(--n-900, #e9e9e9);
    font-size: 12px;
    pointer-events: none;
  }
  .textdraft { position: absolute; min-width: 40px; max-width: 70%; border: 0; border-radius: 3px; background: rgba(10, 10, 10, 0.55); padding: 2px 6px; font-family: Switzer, system-ui, sans-serif; font-weight: 600; outline: 1px dashed rgba(233, 233, 233, 0.5); z-index: 3; }
  .watermark { position: absolute; inset: 0; display: grid; grid-template-columns: repeat(3, 1fr); place-items: center; pointer-events: none; overflow: hidden; }
  .wm-cell { font-size: 13px; color: #ffffff; transform: rotate(-24deg); white-space: nowrap; }

  .controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding-top: 12px; }
  .grow { flex: 1; }
  .zoomgroup { display: flex; align-items: center; gap: 4px; }
  .zoom { min-width: 56px; text-align: center; }
  .tc { font-variant-numeric: tabular-nums; }
  .dims { color: var(--n-600, #767676); font-size: 13px; }
  .ctl-label { color: var(--n-600, #767676); font-size: 13px; }
  button {
    border: 0;
    border-radius: 2px;
    padding: 5px 10px;
    background: var(--n-200, #232323);
    color: var(--n-800, #c4c4c4);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  button:hover { background: var(--n-300, #2e2e2e); color: var(--n-900, #e9e9e9); }
  button[aria-pressed='true'] { background: var(--n-400, #3d3d3d); color: var(--n-900, #e9e9e9); }
  button:disabled { opacity: 0.45; cursor: default; }
  button.icon { display: grid; place-items: center; width: 30px; height: 28px; padding: 0; }
  .seg { display: flex; gap: 1px; }
  .seg button { border-radius: 0; }
  .seg button:first-child { border-radius: 2px 0 0 2px; }
  .seg button:last-child { border-radius: 0 2px 2px 0; }
  .inkrow { display: flex; align-items: center; gap: 5px; }
  .ink { width: 18px; height: 18px; padding: 0; border: 0; border-radius: 50%; cursor: pointer; opacity: 0.75; }
  .ink:hover { opacity: 1; }
  .ink[aria-pressed='true'] { opacity: 1; box-shadow: 0 0 0 2px var(--n-050, #101010), 0 0 0 3.5px var(--n-800, #c4c4c4); }

  @media (pointer: coarse) {
    button { min-height: var(--tap, 44px); }
    button.icon { width: var(--tap, 44px); }
  }
</style>
