<script lang="ts">
  import { ReferenceGlRenderer } from './reference/gl-renderer.js';
  import type { PlaneTransfer } from './reference/protocol.js';

  let {
    requireAcceleration = true,
    onrenderererror = undefined
  }: {
    requireAcceleration?: boolean;
    onrenderererror?: ((reason: string) => void) | undefined;
  } = $props();

  let canvas: HTMLCanvasElement | undefined = $state();
  let renderer: ReferenceGlRenderer | undefined;

  const boundedReason = (error: unknown): string =>
    (error instanceof Error ? error.message : String(error)).slice(0, 500);

  const getRenderer = (): ReferenceGlRenderer => {
    if (!canvas) throw new Error('Reference stage is not mounted.');
    renderer ??= new ReferenceGlRenderer(canvas, { requireAcceleration });
    return renderer;
  };

  export function render(planes: PlaneTransfer): void {
    try {
      getRenderer().render(planes);
    } catch (error) {
      const reason = boundedReason(error);
      onrenderererror?.(reason);
      throw error;
    }
  }

  export function close(): void {
    renderer?.close();
    renderer = undefined;
  }

  export function element(): HTMLCanvasElement | null {
    return canvas ?? null;
  }

  const handleContextLoss = (): void => {
    onrenderererror?.('Reference renderer context was lost.');
  };

  $effect(() => {
    void requireAcceleration;
    return () => close();
  });

  $effect(() => {
    if (!canvas) return;
    const element = canvas;
    element.addEventListener('webglcontextlost', handleContextLoss);
    return () => element.removeEventListener('webglcontextlost', handleContextLoss);
  });
</script>

<canvas bind:this={canvas} class="reference-stage" aria-hidden="true"></canvas>

<style>
  .reference-stage {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: #000;
  }
</style>
