<script lang="ts">
  import { arrives } from './media-load.js';
  import { parseSpriteVtt } from './asset-media.svelte.js';
  import type { SpriteTile } from './asset-media.svelte.js';

  /* Poster thumbnail with sprite hover scrub. Mouse X maps linearly onto the
     sprite's VTT cue list; the sheet geometry (tile rects and sheet size)
     loads lazily on first hover so the grid stays one poster request per
     card. Thumbnails are plain fills, never gradients. */

  interface Props {
    poster: string | null;
    sprite: string | null;
    spriteVtt: string | null;
    alt: string;
  }

  const { poster, sprite, spriteVtt, alt }: Props = $props();

  let width = $state(0);
  let tiles = $state<SpriteTile[] | null>(null);
  let sheet = $state<{ w: number; h: number } | null>(null);
  let fraction = $state<number | null>(null);
  let loadStarted = false;

  const ensureGeometry = (): void => {
    if (loadStarted || !sprite || !spriteVtt) return;
    loadStarted = true;
    void (async () => {
      try {
        const response = await fetch(spriteVtt);
        if (!response.ok) return;
        const parsed = parseSpriteVtt(await response.text());
        if (parsed.length === 0) return;
        const image = new Image();
        image.onload = () => {
          sheet = { w: image.naturalWidth, h: image.naturalHeight };
          tiles = parsed;
        };
        image.src = sprite;
      } catch {
        /* Scrub stays off; the poster still shows. */
      }
    })();
  };

  const onMove = (event: PointerEvent): void => {
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (bounds.width <= 0) return;
    fraction = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
  };

  const scrub = $derived.by(() => {
    if (fraction === null || !tiles || !sheet || !sprite || width <= 0) return null;
    const index = Math.min(tiles.length - 1, Math.floor(fraction * tiles.length));
    const tile = tiles[index];
    const scale = width / tile.w;
    return {
      image: sprite,
      size: `${sheet.w * scale}px ${sheet.h * scale}px`,
      position: `${-tile.x * scale}px ${-tile.y * scale}px`
    };
  });
</script>

<!-- Hover scrub is a mouse-only preview; keyboard users get the full
     scrubber in the review room, so this stays presentational. -->
<div
  class="thumb"
  role="presentation"
  bind:clientWidth={width}
  onpointerenter={ensureGeometry}
  onpointermove={onMove}
  onpointerleave={() => (fraction = null)}
>
  {#if scrub}
    <div
      class="sheet"
      style={`background-image: url("${scrub.image}"); background-size: ${scrub.size}; background-position: ${scrub.position};`}
    ></div>
    <div class="playhead" style={`left: ${(fraction ?? 0) * 100}%;`} aria-hidden="true"></div>
  {:else if poster}
    <img src={poster} {alt} loading="lazy" decoding="async" draggable="false" use:arrives />
  {:else}
    <div class="blank" aria-hidden="true"></div>
  {/if}
</div>

<style>
  .thumb {
    position: relative;
    aspect-ratio: 16 / 9;
    border-radius: var(--radius);
    background: var(--ink-100);
    overflow: hidden;
  }
  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    /* Ease in on arrival; the ink ground beneath holds the frame until the
       pixels are whole, so no progressive scan ever shows. */
    opacity: 0;
  }
  img:global([data-arrived]) {
    opacity: 1;
    transition: opacity 280ms ease;
  }
  /* A poster that 404'd: hide the broken glyph and let the ink ground stand. */
  img:global([data-failed]) { visibility: hidden; }
  @media (prefers-reduced-motion: reduce) {
    img { opacity: 1; }
    img:global([data-arrived]) { transition: none; }
  }
  .sheet {
    position: absolute;
    inset: 0;
    background-repeat: no-repeat;
  }
  .playhead {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: rgba(232, 228, 220, 0.65);
  }
  .blank {
    width: 100%;
    height: 100%;
    background: var(--ink-100);
  }
</style>
