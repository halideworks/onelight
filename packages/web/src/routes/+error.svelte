<script lang="ts">
  import { page } from '$app/state';
  import { pageWashFor } from '$lib/washes.js';

  /* An error has no project to take its identity from, so it takes the default
     wash. Same grammar as every other page outside the review room: vertical,
     dark anchor at the top, resolving into ink within the first screenful. */
  const wash = pageWashFor(null);

  const headline = $derived(
    page.status === 404
      ? 'This page is not here.'
      : page.status === 403
        ? 'This is not yours to open.'
        : page.status === 401
          ? 'This needs a sign in.'
          : 'Something went wrong.'
  );

  /* SvelteKit fills routing errors in with their status text ("Not Found"),
     which only repeats the headline. Say the useful thing instead, and fall
     back to the server's message where there is a real one. */
  const detail = $derived(
    page.status === 404
      ? 'The link may be mistyped, or what was here has moved or been removed.'
      : page.error?.message && page.error.message !== 'Not Found'
        ? page.error.message
        : ''
  );
</script>

<svelte:head>
  <title>{headline} | Onelight</title>
</svelte:head>

<main class="shell" style={`background: ${wash}`}>
  <div class="mid">
    <p class="eyebrow tc">{page.status}</p>
    <h1>{headline}</h1>
    {#if detail}<p class="detail">{detail}</p>{/if}
    <p class="actions"><a href="/">Go to Onelight</a></p>
  </div>
</main>

<style>
  .shell {
    min-height: calc(100vh - var(--topbar-h, 0px));
    display: grid;
    align-content: center;
    padding: 48px clamp(24px, 8vw, 120px);
    color: var(--ink-text);
    background-attachment: fixed;
  }
  .mid {
    max-width: 760px;
  }
  .eyebrow {
    margin: 0;
    color: var(--ink-text-dim);
    font-size: var(--text-13);
    font-weight: 500;
  }
  h1 {
    margin: 16px 0 0;
    font-family: var(--font-display);
    font-size: clamp(44px, 8vw, 92px);
    line-height: 0.98;
    font-weight: 500;
  }
  .detail {
    max-width: 46ch;
    margin: 24px 0 0;
    color: var(--ink-text-dim);
    font-size: var(--text-16);
    line-height: 1.5;
  }
  .actions {
    margin: 40px 0 0;
  }
  .actions a {
    color: var(--ink-text);
    font-size: var(--text-13);
    font-weight: 500;
    text-decoration: none;
    /* The one underline on the page, so the way out is findable without a
       button competing with the headline. */
    border-bottom: 1px solid rgba(255, 255, 255, 0.28);
    padding-bottom: 2px;
  }
  .actions a:hover {
    border-bottom-color: var(--ink-text);
  }
  .actions a:focus-visible {
    outline: 2px solid var(--accent-bright);
    outline-offset: 3px;
  }
</style>
