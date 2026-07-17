<script lang="ts">
  import type { AnnotationPoint, AnnotationStroke } from './annotations.js';

  let {
    strokes = [],
    width = 0,
    height = 0,
    interactive = false,
    tool = 'pen',
    color = '#e9e9e9',
    strokeWidth = 0.004,
    onstroke = undefined,
    ontextplace = undefined
  }: {
    strokes?: AnnotationStroke[];
    width?: number;
    height?: number;
    interactive?: boolean;
    tool?: 'pen' | 'arrow' | 'rect' | 'text';
    color?: string;
    /* Normalized fraction of the frame diagonal (see annotations.ts). */
    strokeWidth?: number;
    onstroke?: ((stroke: AnnotationStroke) => void) | undefined;
    /* Text placement: a click in text mode names the spot; the host owns the
       input box (a canvas cannot hold a caret). */
    ontextplace?: ((point: AnnotationPoint) => void) | undefined;
  } = $props();

  let canvas: HTMLCanvasElement | undefined = $state();
  let inProgress = $state<AnnotationStroke | null>(null);

  /* Draw mode can be disarmed mid-drag (the D shortcut exits while the pointer
     is still down). Drop any in-progress stroke when the overlay stops being
     interactive so a later re-arm cannot extend or commit the stale stroke on
     a bare pointermove/pointerup. */
  $effect(() => {
    if (!interactive) inProgress = null;
  });

  /* Widths below 1 are normalized fractions of the frame diagonal (the form
     this player writes); 1 or more is legacy device pixels. */
  const lineWidthFor = (stroke: AnnotationStroke): number => {
    const raw = stroke.width ?? 3;
    return raw < 1 ? Math.max(1, raw * Math.hypot(width, height)) : raw;
  };

  const draw = (context: CanvasRenderingContext2D, stroke: AnnotationStroke): void => {
    const points = stroke.points;
    if (points.length === 0 || width <= 0 || height <= 0) return;
    if (stroke.tool === 'text') {
      const anchor = points[0];
      if (!anchor || !stroke.text) return;
      const size = lineWidthFor({ ...stroke, width: stroke.width ?? 0.035 });
      context.font = `600 ${size}px Switzer, system-ui, sans-serif`;
      context.textBaseline = 'top';
      /* A dark halo first, so the type reads on any footage. */
      context.lineJoin = 'round';
      context.lineWidth = Math.max(2, size * 0.16);
      context.strokeStyle = 'rgba(10, 10, 10, 0.85)';
      context.strokeText(stroke.text, anchor[0] * width, anchor[1] * height);
      context.fillStyle = stroke.color ?? '#a5605a';
      context.fillText(stroke.text, anchor[0] * width, anchor[1] * height);
      return;
    }
    context.strokeStyle = stroke.color ?? '#a5605a';
    context.lineWidth = lineWidthFor(stroke);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    const first = points[0];
    if (!first) return;
    const x = first[0] * width;
    const y = first[1] * height;
    context.beginPath();
    context.moveTo(x, y);
    if (stroke.tool === 'rect' || stroke.tool === 'ellipse') {
      const last = points[points.length - 1] ?? first;
      const endX = last[0] * width;
      const endY = last[1] * height;
      if (stroke.tool === 'rect') context.rect(x, y, endX - x, endY - y);
      else context.ellipse((x + endX) / 2, (y + endY) / 2, Math.abs(endX - x) / 2, Math.abs(endY - y) / 2, 0, 0, Math.PI * 2);
    } else {
      for (const point of points.slice(1)) context.lineTo(point[0] * width, point[1] * height);
      if (stroke.tool === 'arrow') {
        /* Arrowheads are computed in pixel space after projecting the endpoints,
           so the head cannot skew when width and height scale independently. */
        const last = points[points.length - 1] ?? first;
        const endX = last[0] * width;
        const endY = last[1] * height;
        const angle = Math.atan2(endY - y, endX - x);
        const size = 0.02 * Math.hypot(width, height);
        context.moveTo(endX, endY);
        context.lineTo(endX - Math.cos(angle - 0.5) * size, endY - Math.sin(angle - 0.5) * size);
        context.moveTo(endX, endY);
        context.lineTo(endX - Math.cos(angle + 0.5) * size, endY - Math.sin(angle + 0.5) * size);
      }
    }
    context.stroke();
  };

  /* One effect, but the canvas is only ever resized when the size really
     changed: assigning canvas.width resets and reallocates the backing store
     even when the value is identical, and this effect used to run on every
     presented frame (the strokes prop changes identity as the playhead
     moves). A full-size canvas reallocation per frame was a real part of the
     seek-bar stutter. */
  $effect(() => {
    if (!canvas) return;
    const ratio = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    const deviceWidth = Math.max(1, Math.round(width * ratio));
    const deviceHeight = Math.max(1, Math.round(height * ratio));
    if (canvas.width !== deviceWidth) canvas.width = deviceWidth;
    if (canvas.height !== deviceHeight) canvas.height = deviceHeight;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const context = canvas.getContext('2d');
    if (context) {
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      for (const stroke of strokes) draw(context, stroke);
      if (inProgress) draw(context, inProgress);
    }
  });

  const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

  const pointFrom = (event: PointerEvent): AnnotationPoint | null => {
    if (!canvas || width <= 0 || height <= 0) return null;
    const rect = canvas.getBoundingClientRect();
    return [
      clamp01((event.clientX - rect.left) / width),
      clamp01((event.clientY - rect.top) / height)
    ];
  };

  const handlePointerDown = (event: PointerEvent): void => {
    if (!interactive || !event.isPrimary) return;
    const point = pointFrom(event);
    if (!point) return;
    event.preventDefault();
    if (tool === 'text') {
      ontextplace?.(point);
      return;
    }
    try {
      canvas?.setPointerCapture(event.pointerId);
    } catch {
      /* An inactive pointer id cannot be captured; drawing still works. */
    }
    inProgress = { tool, color, width: strokeWidth, points: [point] };
  };

  const handlePointerMove = (event: PointerEvent): void => {
    if (!interactive || !inProgress) return;
    const point = pointFrom(event);
    if (!point) return;
    const points = inProgress.points;
    if (tool === 'pen') {
      /* Thin the polyline: skip points closer than ~0.3% of the frame. */
      const last = points[points.length - 1];
      if (last && Math.hypot(point[0] - last[0], point[1] - last[1]) < 0.003) return;
      inProgress = { ...inProgress, points: [...points, point] };
    } else {
      const first = points[0];
      if (!first) return;
      inProgress = { ...inProgress, points: [first, point] };
    }
  };

  const handlePointerUp = (event: PointerEvent): void => {
    if (!interactive || !inProgress) return;
    const point = pointFrom(event);
    const points = inProgress.points;
    const first = points[0];
    let committed: AnnotationStroke | null = null;
    if (first && point) {
      if (tool === 'pen') {
        const all = [...points, point];
        if (all.length >= 2) committed = { ...inProgress, points: all };
      } else if (Math.hypot(point[0] - first[0], point[1] - first[1]) >= 0.005) {
        committed = { ...inProgress, points: [first, point] };
      }
    }
    inProgress = null;
    if (committed) onstroke?.(committed);
  };

  const handlePointerCancel = (): void => {
    inProgress = null;
  };
</script>

<canvas
  bind:this={canvas}
  class:interactive
  aria-hidden="true"
  onpointerdown={handlePointerDown}
  onpointermove={handlePointerMove}
  onpointerup={handlePointerUp}
  onpointercancel={handlePointerCancel}
></canvas>

<style>
  canvas { display: block; pointer-events: none; position: absolute; inset: 0; }
  canvas.interactive { pointer-events: auto; cursor: crosshair; touch-action: none; }
</style>
