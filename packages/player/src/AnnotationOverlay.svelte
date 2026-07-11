<script lang="ts">
  export type Point = [number, number, number?];
  export type Stroke = { tool?: 'pen' | 'line' | 'arrow' | 'rect' | 'ellipse'; color?: string; width?: number; points: Point[] };

  export let strokes: Stroke[] = [];
  export let width = 0;
  export let height = 0;

  const draw = (context: CanvasRenderingContext2D, stroke: Stroke): void => {
    const points = stroke.points;
    if (points.length === 0 || width <= 0 || height <= 0) return;
    context.strokeStyle = stroke.color ?? '#a5605a';
    context.lineWidth = stroke.width ?? 3;
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

  let canvas: HTMLCanvasElement;

  $: if (canvas) {
    const ratio = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const context = canvas.getContext('2d');
    if (context) {
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      for (const stroke of strokes) draw(context, stroke);
    }
  }
</script>

<canvas bind:this={canvas} aria-hidden="true"></canvas>

<style>
  canvas { display: block; pointer-events: none; position: absolute; inset: 0; }
</style>
