<script lang="ts">
  import type { TimelineMarker } from './timeline.js';

  let { marker }: { marker: TimelineMarker } = $props();
  let broken = $state(false);

  $effect(() => {
    void marker.avatarUrl;
    broken = false;
  });

  const initial = $derived(
    [...(marker.author?.trim() || 'Reviewer')][0]?.toUpperCase() ?? '?'
  );
</script>

{#if marker.avatarUrl && !broken}
  <img
    src={marker.avatarUrl}
    alt=""
    loading="lazy"
    decoding="async"
    draggable="false"
    onerror={() => {
      broken = true;
    }}
  />
{:else}
  <span
    class="generated"
    style:background-image={marker.generatedAvatarBackground ?? undefined}
    aria-hidden="true"
  >{initial}</span>
{/if}

<style>
  img, .generated {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
  }
  img { object-fit: cover; }
  .generated {
    background-size: 100% 100%;
    color: rgba(250, 248, 244, 0.92);
    font-weight: 600;
    user-select: none;
  }
</style>
