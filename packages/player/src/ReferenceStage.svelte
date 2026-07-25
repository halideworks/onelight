<script lang="ts">
  import { ReferenceGlRenderer } from './reference/gl-renderer.js';
  import type { ReferenceDisplayTransfer } from './reference/color-math.js';
  import type { PlaneTransfer } from './reference/protocol.js';

  let {
    requireAcceleration = true,
    displayTransfer = 'srgb',
    onrenderererror = undefined
  }: {
    requireAcceleration?: boolean;
    displayTransfer?: ReferenceDisplayTransfer;
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

  let lastPlanes: PlaneTransfer | null = null;

  export function render(planes: PlaneTransfer): void {
    lastPlanes = planes;
    try {
      getRenderer().render(planes, displayTransfer);
    } catch (error) {
      const reason = boundedReason(error);
      onrenderererror?.(reason);
      throw error;
    }
  }

  /* An editor comparing 2.2 against 2.4 does it on a held frame; the choice
     must repaint that frame, not wait for the next presentation. The held
     buffer can have been transferred back to the decoder (detached, zero
     byteLength) -- then there is nothing to repaint and the next presented
     frame carries the new transfer. */
  $effect(() => {
    void displayTransfer;
    if (!renderer || !lastPlanes || lastPlanes.buffer.byteLength === 0) return;
    try {
      renderer.render(lastPlanes, displayTransfer);
    } catch {
      /* The next presentation repaints; a stale buffer is not an error. */
    }
  });

  export function close(): void {
    renderer?.close();
    renderer = undefined;
    lastPlanes = null;
  }

  export function element(): HTMLCanvasElement | null {
    return canvas ?? null;
  }

  /* Null until the first render creates the context. */
  export function colorManagedOutput(): boolean | null {
    return renderer ? renderer.colorManagedOutput : null;
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
