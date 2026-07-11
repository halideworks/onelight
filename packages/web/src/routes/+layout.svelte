<script lang="ts">
  import '../lib/tokens.css';
</script>

<slot />

<style>
  /* App-level defaults live here, not in tokens.css: the token file is a
     verbatim port of mockups/tokens.css (phase-0 T19). */
  :global(body) {
    min-height: 100vh;
    background: var(--ink-000);
    color: var(--ink-text);
  }
  :global(input),
  :global(textarea),
  :global(select) {
    font: inherit;
  }
</style>
