<script lang="ts">
  import { onMount } from 'svelte';

  /* A live luma waveform of the playing picture: the review room's
     instrument in miniature. Columns of the frame plot their luma against
     height, cream on the veil, with graticule lines at 0, 50, and 100
     percent. Reads straight off the video element on the page. */

  let { source }: { source: () => HTMLVideoElement | null | undefined } = $props();

  let canvas = $state<HTMLCanvasElement | undefined>();

  onMount(() => {
    const element = canvas;
    if (!element) return;
    const context = element.getContext('2d');
    if (!context) return;
    const off = document.createElement('canvas');
    const COLS = 128;
    const ROWS = 72;
    off.width = COLS;
    off.height = ROWS;
    const offContext = off.getContext('2d', { willReadFrequently: true });
    if (!offContext) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = 220;
    const H = 68;
    element.width = W * dpr;
    element.height = H * dpr;
    context.scale(dpr, dpr);

    let raf = 0;
    let lastTime = -1;
    const draw = (): void => {
      raf = requestAnimationFrame(draw);
      const video = source();
      if (!video || video.readyState < 2) return;
      if (video.currentTime === lastTime && video.paused) return;
      lastTime = video.currentTime;
      offContext.drawImage(video, 0, 0, COLS, ROWS);
      let data: Uint8ClampedArray;
      try {
        data = offContext.getImageData(0, 0, COLS, ROWS).data;
      } catch {
        return;
      }
      context.clearRect(0, 0, W, H);
      /* Graticule: 0, 50, 100 percent. */
      context.fillStyle = 'rgba(250, 248, 244, 0.16)';
      context.fillRect(0, 0.5, W, 1);
      context.fillRect(0, H / 2, W, 1);
      context.fillRect(0, H - 1.5, W, 1);
      context.fillStyle = 'rgba(247, 225, 160, 0.5)';
      for (let x = 0; x < COLS; x += 1) {
        const px = (x / COLS) * W;
        for (let y = 0; y < ROWS; y += 2) {
          const i = (y * COLS + x) * 4;
          const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
          context.fillRect(px, H - 2 - (luma / 255) * (H - 4), 1.4, 1);
        }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  });
</script>

<canvas bind:this={canvas} aria-hidden="true"></canvas>

<style>
  canvas {
    display: block;
    width: 100%;
    height: auto;
  }
</style>
