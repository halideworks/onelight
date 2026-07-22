<script lang="ts">
  import { navigating } from '$app/state';

  /* A navigation that resolves instantly should never show a bar: the flash
     would make fast feel slow. The bar earns its paint by the trip taking
     longer than 120ms, crawls while the route loads, and on arrival fills,
     fades, and lets go. Transform-only, so it lives on the compositor and
     costs the waiting page nothing. */
  let { neutral = false }: { neutral?: boolean } = $props();

  let shown = $state(false);
  let progress = $state(0);
  let crawling = $state(false);
  let fading = $state(false);
  let delay: ReturnType<typeof setTimeout> | null = null;
  let linger: ReturnType<typeof setTimeout> | null = null;
  let raf: number | null = null;

  $effect(() => {
    if (navigating.to) {
      if (linger) { clearTimeout(linger); linger = null; }
      fading = false;
      delay ??= setTimeout(() => {
        delay = null;
        shown = true;
        progress = 0;
        crawling = false;
        /* Paint the zero-width bar first, then let the slow transition carry
           it; without the frame in between there is nothing to glide from. */
        raf = requestAnimationFrame(() => {
          raf = requestAnimationFrame(() => {
            crawling = true;
            progress = 0.92;
          });
        });
      }, 120);
    } else {
      if (delay) { clearTimeout(delay); delay = null; }
      if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
      if (shown) {
        crawling = false;
        progress = 1;
        fading = true;
        linger = setTimeout(() => {
          shown = false;
          fading = false;
          progress = 0;
          linger = null;
        }, 480);
      }
    }
    return () => {
      if (delay) { clearTimeout(delay); delay = null; }
      if (linger) { clearTimeout(linger); linger = null; }
      if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
    };
  });
</script>

{#if shown}
  <div
    class="bar"
    class:crawling
    class:fading
    class:neutral
    style:transform={`scaleX(${String(progress)})`}
    aria-hidden="true"
  ></div>
{/if}

<style>
  /* The crawl spends most of its travel early and never finishes on its own:
     finishing is the navigation's job. */
  .bar {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 2px;
    z-index: 200;
    background: var(--accent);
    transform-origin: left;
    transition: transform var(--dur-quick) var(--ease-out);
    pointer-events: none;
  }
  .bar.neutral { background: var(--n-600, #767676); }
  .bar.crawling { transition-duration: 9s; }
  .bar.fading {
    opacity: 0;
    transition:
      transform var(--dur-quick) var(--ease-out),
      opacity var(--dur) var(--ease-out) var(--dur-quick);
  }
  @media (prefers-reduced-motion: reduce) {
    .bar { transition: none; }
  }
</style>
