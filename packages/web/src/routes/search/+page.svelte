<script lang="ts">
  import { onMount } from 'svelte';
  import { replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import { messageFrom, searchWorkspace } from '$lib/api.js';
  import type { SearchHit } from '$lib/api.js';
  import { excerpt } from '$lib/format.js';

  type Scope = 'all' | 'assets' | 'comments' | 'projects' | 'people' | 'shares';

  const PAGE_SIZE = 30;
  const SCOPES: Array<{ id: Scope; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'assets', label: 'Assets' },
    { id: 'comments', label: 'Comments' },
    { id: 'projects', label: 'Projects' },
    { id: 'people', label: 'People' },
    { id: 'shares', label: 'Shares' }
  ];

  let input = $state<HTMLInputElement | null>(null);
  let q = $state('');
  let scope = $state<Scope>('all');
  let hits = $state<SearchHit[]>([]);
  let nextCursor = $state<string | null>(null);
  let searched = $state('');
  let error = $state('');
  let busy = $state(false);

  /* Scope and cursor are server-side (GET /search?scope&cursor); the page
     only accumulates the returned keyset pages. */
  let requestSeq = 0;

  const run = async (query: string): Promise<void> => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      requestSeq += 1;
      hits = [];
      nextCursor = null;
      searched = '';
      error = '';
      return;
    }
    busy = true;
    const seq = ++requestSeq;
    try {
      const result = await searchWorkspace({ q: trimmed, scope, limit: PAGE_SIZE });
      if (seq !== requestSeq) return;
      hits = result.items;
      nextCursor = result.next_cursor;
      searched = trimmed;
      error = '';
    } catch (caught) {
      if (seq === requestSeq) error = messageFrom(caught, 'Search failed.');
    } finally {
      if (seq === requestSeq) busy = false;
    }
  };

  const loadMore = async (): Promise<void> => {
    if (!nextCursor || !searched) return;
    busy = true;
    const seq = ++requestSeq;
    try {
      const result = await searchWorkspace({
        q: searched,
        scope,
        limit: PAGE_SIZE,
        cursor: nextCursor
      });
      if (seq !== requestSeq) return;
      hits = [...hits, ...result.items];
      nextCursor = result.next_cursor;
    } catch (caught) {
      if (seq === requestSeq) error = messageFrom(caught, 'Search failed.');
    } finally {
      if (seq === requestSeq) busy = false;
    }
  };

  const syncUrl = (): void => {
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (scope !== 'all') params.set('scope', scope);
    const query = params.toString();
    replaceState(query ? `/search?${query}` : '/search', {});
  };

  /* Frame-anchored comment hits deep link into the player's ?f= seek. The
     field is optional on the wire; read it defensively. */
  const commentFrame = (hit: SearchHit): number | null => {
    const value = (hit as { frame_in?: unknown }).frame_in;
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const onInput = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      void run(q);
      syncUrl();
    }, 300);
  };

  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    clearTimeout(timer);
    void run(q);
    syncUrl();
  };

  const setScope = (next: Scope): void => {
    scope = next;
    syncUrl();
    void run(q);
  };

  onMount(() => {
    q = page.url.searchParams.get('q') ?? '';
    const urlScope = page.url.searchParams.get('scope');
    if (urlScope === 'assets' || urlScope === 'comments') scope = urlScope;
    if (q) void run(q);
    input?.focus();
    const focusSearch = (): void => {
      input?.focus();
      input?.select();
    };
    window.addEventListener('onelight:focus-search', focusSearch);
    return () => {
      /* Drop the pending debounce so it cannot fire a fetch after the page
         has navigated away. */
      clearTimeout(timer);
      window.removeEventListener('onelight:focus-search', focusSearch);
    };
  });
</script>

<svelte:head><title>Search | Onelight</title></svelte:head>

<main class="page">
  <h1>Search</h1>
  <form onsubmit={submit} role="search">
    <input
      bind:this={input}
      bind:value={q}
      oninput={onInput}
      type="search"
      placeholder="Asset names and comment text"
      aria-label="Search assets and comments"
      autocomplete="off"
      spellcheck="false"
    />
  </form>
  <div class="scopes" role="group" aria-label="Search scope">
    {#each SCOPES as item (item.id)}
      <button
        type="button"
        class="scope"
        aria-pressed={scope === item.id}
        onclick={() => setScope(item.id)}
      >{item.label}</button>
    {/each}
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}

  <section aria-label="Results" class="results" aria-busy={busy}>
    {#if !searched}
      <p class="empty">Type at least two characters. Searches assets, comments, projects, people and shares.</p>
    {:else if hits.length === 0 && !busy}
      <p class="empty">Nothing matched "{searched}".</p>
    {/if}
    {#each hits as hit (hit.type + hit.id)}
      {#if hit.type === 'asset'}
        <a class="hit" href={`/projects/${hit.project_id}/assets/${hit.id}`}>
          <span class="kind">Asset</span>
          <span class="name">{hit.name}</span>
        </a>
      {:else if hit.type === 'project'}
        <a class="hit" href={`/projects/${hit.id}`}>
          <span class="kind">Project</span>
          <span class="name">{hit.name}</span>
        </a>
      {:else if hit.type === 'person'}
        <!-- Not a link: a person is not a page here, and a hit that goes
             nowhere is worse than one that plainly does not. -->
        <span class="hit static">
          <span class="kind">Person</span>
          <span class="name">{hit.name}</span>
          <span class="sub">{hit.email}</span>
        </span>
      {:else if hit.type === 'share'}
        <a class="hit" href={`/projects/${hit.project_id}/shares`}>
          <span class="kind">Share</span>
          <span class="name">{hit.title}</span>
        </a>
      {:else}
        <a class="hit" href={`/projects/${hit.project_id}/assets/${hit.asset_id}${commentFrame(hit) === null ? '' : `?f=${commentFrame(hit)}`}`}>
          <span class="kind">Comment</span>
          <span class="name">{excerpt(hit.body_text)}</span>
        </a>
      {/if}
    {/each}
    {#if nextCursor}
      <button type="button" class="more" onclick={() => void loadMore()}>
        Show more
      </button>
    {/if}
  </section>
</main>

<style>
  /* App world, no borders: separation by value step and space. */
  .page { min-height: calc(100vh - var(--topbar-h, 0px)); padding: 48px clamp(24px, 8vw, 120px); background: var(--ink-000); }
  h1 { margin: 0 0 24px; font-family: var(--font-display); font-size: clamp(40px, 7vw, 72px); font-weight: 700; letter-spacing: -0.02em; }
  input { width: min(560px, 100%); border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 12px 14px; font-size: var(--text-14); }
  input::placeholder { color: var(--ink-text-dim); }
  .scopes { display: flex; gap: 2px; margin: 18px 0 28px; }
  .scope { border: 0; border-radius: var(--radius); background: var(--ink-100); color: var(--ink-text-dim); padding: 7px 14px; font-size: var(--text-13); font-weight: 500; }
  .scope:hover { color: var(--ink-text); }
  .scope[aria-pressed='true'] { background: var(--ink-300); color: var(--ink-text); }
  .results { max-width: 760px; display: grid; gap: 2px; }
  .hit { display: flex; align-items: baseline; gap: 14px; padding: 12px 14px; margin: 0 -14px; border: 0; border-radius: var(--radius); background: none; color: var(--ink-text); text-decoration: none; text-align: left; font-size: var(--text-13); }
  .hit:hover { background: var(--ink-100); }
  .kind { flex: none; width: 64px; color: var(--ink-text-dim); font-size: var(--text-13); }
  .name { font-weight: 500; overflow-wrap: anywhere; }
  .more { justify-self: start; margin-top: 10px; border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 9px 16px; font-size: var(--text-13); font-weight: 500; }
  .more:hover { background: var(--ink-300); }
  .empty { color: var(--ink-text-dim); }
  .error { color: var(--warn); }
  button:focus-visible, a:focus-visible, input:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: 2px; }
</style>
