<script lang="ts">
  import { onMount } from 'svelte';
  import { replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import { messageFrom, searchWorkspace } from '$lib/api.js';
  import { pretty } from '$lib/ids.js';
  import type { SearchHit } from '$lib/api.js';
  import { excerpt } from '$lib/format.js';
  import { createMediaCache } from '$lib/asset-media.svelte.js';
  import ProjectCover from '$lib/ProjectCover.svelte';

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

  /* Sorting happens over what has been fetched, not on the server: the API
     streams by kind and then id, so a global ORDER BY would break the cursor
     that makes paging work. The control says "loaded" so it does not pretend
     to be more than that. */
  type Sort = 'relevance' | 'newest' | 'oldest' | 'name';
  const SORTS: Array<{ id: Sort; label: string }> = [
    { id: 'relevance', label: 'Default' },
    { id: 'newest', label: 'Newest' },
    { id: 'oldest', label: 'Oldest' },
    { id: 'name', label: 'Name' }
  ];
  let sort = $state<Sort>('relevance');

  /* Posters, fetched per visible asset row exactly like the project grid. */
  const media = createMediaCache();

  const titleOf = (hit: SearchHit): string =>
    hit.type === 'share' ? hit.title : hit.type === 'comment' ? hit.body_text : hit.name;

  const sorted = $derived.by(() => {
    if (sort === 'relevance') return hits;
    const copy = [...hits];
    if (sort === 'name')
      copy.sort((a, b) => titleOf(a).localeCompare(titleOf(b), undefined, { sensitivity: 'base' }));
    else
      copy.sort((a, b) =>
        sort === 'newest' ? b.updated_at - a.updated_at : a.updated_at - b.updated_at
      );
    return copy;
  });

  const when = (ms: number): string =>
    new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

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
  <div class="controls">
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
  {#if searched}
    <label class="sortpick">
      Sort
      <select bind:value={sort} aria-label="Sort results">
        {#each SORTS as option (option.id)}
          <option value={option.id}>{option.label}</option>
        {/each}
      </select>
    </label>
  {/if}
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if searched && sort !== 'relevance' && nextCursor}
    <!-- Sorting reorders what has been loaded. Saying so beats a list that
         silently is not what it claims to be. -->
    <p class="empty small">Sorting the {hits.length} results loaded so far. Load more to sort the rest.</p>
  {/if}

  <section aria-label="Results" class="results" aria-busy={busy}>
    {#if !searched}
      <p class="empty">Type at least two characters. Searches assets, comments, projects, people and shares.</p>
    {:else if hits.length === 0 && busy}
      <!-- Ghost rows while the first results are on their way. -->
      <div class="ghosts" aria-hidden="true">
        {#each [54, 38, 61, 30] as width, index (index)}
          <span class="hit static">
            <span class="skeleton thumb"></span>
            <span class="skeleton ghost-kind"></span>
            <span class="skeleton ghost-name" style:width={`${String(width)}%`}></span>
          </span>
        {/each}
      </div>
    {:else if hits.length === 0}
      <p class="empty">Nothing matched "{searched}".</p>
    {/if}
    {#each sorted as hit (hit.type + hit.id)}
      {#if hit.type === 'asset'}
        {@const entry = media.entries[hit.id]}
        <a
          class="hit"
          href={`/projects/${hit.project_id}/assets/${pretty(hit.public_id, hit.name)}`}
          use:media.observe={{ id: hit.id, current_version_id: hit.current_version_id }}
        >
          <span class="thumb">
            {#if entry?.media?.posterUrl}
              <img src={entry.media.posterUrl} alt="" loading="lazy" decoding="async" />
            {/if}
          </span>
          <span class="kind">Asset</span>
          <span class="name">{hit.name}</span>
          <span class="when tc">{when(hit.updated_at)}</span>
        </a>
      {:else if hit.type === 'project'}
        <a class="hit" href={`/projects/${pretty(hit.public_id, hit.name)}`}>
          <span class="thumb"><ProjectCover project={{ id: hit.id, name: hit.name, palette: hit.palette, cover_url: hit.cover_url }} monogram={false} /></span>
          <span class="kind">Project</span>
          <span class="name">{hit.name}</span>
          <span class="when tc">{when(hit.updated_at)}</span>
        </a>
      {:else if hit.type === 'person'}
        <!-- Not a link: a person is not a page here, and a hit that goes
             nowhere is worse than one that plainly does not. -->
        <span class="hit static">
          <span class="thumb initials" aria-hidden="true">{hit.name.slice(0, 1).toUpperCase()}</span>
          <span class="kind">Person</span>
          <span class="name">{hit.name}</span>
          <span class="sub">{hit.email}</span>
        </span>
      {:else if hit.type === 'share'}
        <a class="hit" href={`/projects/${hit.project_id}/shares`}>
          <span class="thumb glyph" aria-hidden="true">
            <svg viewBox="0 0 16 16" width="14" height="14"><path d="M11.5 5.5a2 2 0 10-1.9-2.6L6.4 4.6a2 2 0 100 2.8l3.2 1.7a2 2 0 10.5-.9L6.9 6.5a2 2 0 000-1l3.2-1.7c.36.44.9.7 1.4.7z" fill="currentColor" /></svg>
          </span>
          <span class="kind">Share</span>
          <span class="name">{hit.title}</span>
          <span class="when tc">{when(hit.updated_at)}</span>
        </a>
      {:else}
        {@const entry = media.entries[hit.asset_id]}
        <a
          class="hit"
          href={`/projects/${hit.project_id}/assets/${hit.asset_id}${commentFrame(hit) === null ? '' : `?f=${commentFrame(hit)}`}`}
          use:media.observe={{ id: hit.asset_id, current_version_id: hit.version_id }}
        >
          <span class="thumb">
            {#if entry?.media?.posterUrl}
              <img src={entry.media.posterUrl} alt="" loading="lazy" decoding="async" />
            {/if}
          </span>
          <span class="kind">Comment</span>
          <span class="name">{excerpt(hit.body_text)}</span>
          <span class="when tc">{when(hit.updated_at)}</span>
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
  /* Phone: six scopes overflow 390px; the row scrolls instead of clipping,
     with a fade telling the thumb there is more. */
  @media (max-width: 720px) {
    .scopes {
      overflow-x: auto;
      scrollbar-width: none;
      -webkit-overflow-scrolling: touch;
      margin: 14px 0 20px;
      mask-image: linear-gradient(90deg, #000 calc(100% - 28px), transparent);
    }
    .scopes > :global(button) { flex: none; white-space: nowrap; }
  }
  .scope { border: 0; border-radius: var(--radius); background: var(--ink-100); color: var(--ink-text-dim); padding: 7px 14px; font-size: var(--text-13); font-weight: 500; }
  .scope:hover { color: var(--ink-text); }
  .scope[aria-pressed='true'] { background: var(--ink-300); color: var(--ink-text); }
  .controls { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  .sortpick { display: inline-flex; align-items: center; gap: 7px; color: var(--ink-text-dim); font-size: var(--text-12); }
  .sortpick select { border: 0; border-radius: var(--radius); background: var(--ink-100); color: var(--ink-text); padding: 5px 8px; font-size: var(--text-12); font-family: inherit; }
  .empty.small { font-size: var(--text-12); }

  .results { max-width: 860px; display: grid; gap: 2px; }
  /* Ghost rows while results load (see .skeleton in tokens.css). */
  .ghosts { display: grid; gap: 2px; }
  .ghosts .thumb { background: none; }
  .ghost-kind { flex: none; width: 64px; height: 11px; opacity: 0.6; }
  .ghost-name { height: 13px; }
  /* A row with a picture in it: the thumbnail sets the height, so the row is
     centred rather than sitting on a baseline that no longer exists. */
  .hit { display: flex; align-items: center; gap: 14px; padding: 8px 14px; margin: 0 -14px; border: 0; border-radius: var(--radius); background: none; color: var(--ink-text); text-decoration: none; text-align: left; font-size: var(--text-13); }
  .hit:hover { background: var(--ink-100); }
  .thumb { flex: none; width: 64px; height: 36px; border-radius: 2px; overflow: hidden; background: var(--ink-200); display: grid; place-items: center; color: var(--ink-text-dim); }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .thumb :global(.cover) { width: 100%; height: 100%; }
  .thumb.initials { font-weight: 600; font-size: var(--text-13); }
  .kind { flex: none; width: 64px; color: var(--ink-text-dim); font-size: var(--text-12); }
  .name { flex: 1; min-width: 0; font-weight: 500; overflow-wrap: anywhere; }
  .when { flex: none; color: var(--ink-text-dim); font-size: var(--text-12); }
  .more { justify-self: start; margin-top: 10px; border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 9px 16px; font-size: var(--text-13); font-weight: 500; }
  .more:hover { background: var(--ink-300); }
  .empty { color: var(--ink-text-dim); }
  .error { color: var(--warn); }
  button:focus-visible, a:focus-visible, input:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: 2px; }
</style>
