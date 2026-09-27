<script lang="ts">
  import { undo } from '$lib/workbench/undo.svelte.js';

  let { neutral = false }: { neutral?: boolean } = $props();
</script>

{#if undo.message || undo.busy}
  <aside class:neutral class:error={undo.error} aria-label="Recent action">
    <p role="status">{undo.busy ? 'Undoing changes...' : undo.message}</p>
    {#if undo.canUndo || undo.busy}
      <button type="button" disabled={undo.busy} onclick={() => void undo.run()} title={`Undo ${undo.label}`}>
        {undo.busy ? 'Undoing...' : 'Undo'}
      </button>
    {/if}
    <button class="dismiss" type="button" aria-label="Dismiss action notification" onclick={() => undo.dismiss()} disabled={undo.busy}>Close</button>
  </aside>
{/if}

<style>
  aside { position: fixed; bottom: max(20px, env(safe-area-inset-bottom)); left: 50%; transform: translateX(-50%); z-index: 50; display: flex; align-items: center; gap: 14px; width: max-content; max-width: min(680px, calc(100vw - 32px)); padding: 12px 14px 12px 18px; border-radius: var(--radius-lg); background: var(--ink-300); color: var(--ink-text); font-size: var(--text-13); }
  p { margin: 0; overflow-wrap: anywhere; line-height: 1.5; }
  button { flex: none; min-height: 36px; border: 0; border-radius: var(--radius); padding: 7px 12px; background: var(--ink-100); color: inherit; font: inherit; font-weight: 600; }
  button:hover:not(:disabled) { background: var(--ink-200); }
  button:disabled { opacity: 0.6; }
  button:focus-visible { outline: 1px solid currentColor; outline-offset: 2px; }
  .dismiss { background: transparent; font-weight: 400; }
  .error p { font-weight: 500; }
  .neutral { background: var(--n-300); color: var(--n-900); }
  .neutral button { background: var(--n-100); }
  .neutral button:hover:not(:disabled) { background: var(--n-200); }
  .neutral .dismiss { background: transparent; }
  @media (max-width: 480px) { aside { gap: 8px; padding: 10px 12px; flex-wrap: wrap; } p { flex: 1 1 100%; } }
  @media (pointer: coarse) { button { min-height: 44px; } }
</style>
