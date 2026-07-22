<script lang="ts">
  /* Breathing placeholder rows for a list or table still on its way. The
     shape says "rows are coming"; the .skeleton vocabulary (tokens.css) says
     "not yet". Widths stagger deterministically so the block reads as text
     rather than as bars. */
  let { rows = 4, neutral = false }: { rows?: number; neutral?: boolean } = $props();
</script>

<div class="ghostrows" class:neutral aria-hidden="true">
  {#each { length: rows } as _, index (index)}
    <span class="skeleton row" style:width={`${String(38 + ((index * 23) % 47))}%`}></span>
  {/each}
</div>

<style>
  .ghostrows { display: grid; gap: 12px; padding: 6px 0; }
  .ghostrows.neutral { --skeleton-ink: var(--n-150); }
  .row { height: 13px; }
</style>
