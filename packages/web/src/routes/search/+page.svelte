<script lang="ts">
  import { onMount } from 'svelte';
  import { goto, replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import { api, messageFrom } from '$lib/api.js';
  import { excerpt } from '$lib/format.js';

  type AssetHit = { type: 'asset'; id: string; name: string; project_id: string };
  type CommentHit = { type: 'comment'; id: string; body_text: string; asset_id: string; version_id: string };
  type Hit = AssetHit | CommentHit;
  type Scope = 'all' | 'assets' | 'comments';

  const PAGE_SIZE = 30;
  const SCOPES: Array<{ id: Scope; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'assets', label: 'Assets' },
    { id: 'comments', label: 'Comments' }
  ];

  let input = $state<HTMLInputElement | null>(null);
  let q = $state('');
  let scope = $state<Scope>('all');
  let hits = $state<Hit[]>([]);
  let searched = $state('');
  let shown = $state(PAGE_SIZE);
  let error = $state('');
  let busy = $state(false);

  /* The API returns both result families in one response with no scope or
     cursor parameters, so scoping and paging happen client-side. */
  const filtered = $derived(
    hits.filter((hit) => scope === 'all' || (scope === 'assets' ? hit.type === 'asset' : hit.type === 'comment'))
  );
  const visible = $derived(filtered.slice(0, shown));

  const run = async (query: string): Promise<void> => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      hits = [];
      searched = '';
      error = '';
      return;
    }
    busy = true;
    try {
      hits = (await api<{ items: Hit[] }>(`/api/v1/search?q=${encodeURIComponent(trimmed)}`)).items;
      searched = trimmed;
      shown = PAGE_SIZE;
      error = '';
    } catch (caught) {
      error = messageFrom(caught, 'Search failed.');
    } finally {
      busy = false;
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const onInput = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      void run(q);
      replaceState(q.trim() ? `/search?q=${encodeURIComponent(q.trim())}` : '/search', {});
    }, 300);
  };

  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    clearTimeout(timer);
    void run(q);
  };

  /* Comment hits carry asset_id but not project_id; resolve it on demand so
     the deep link lands in the right review room. */
  const projectByAsset = new Map<string, string>();
  const openComment = async (hit: CommentHit): Promise<void> => {
    try {
      let projectId = projectByAsset.get(hit.asset_id);
      if (!projectId) {
        projectId = (await api<{ project_id: string }>(`/api/v1/assets/${hit.asset_id}`)).project_id;
        projectByAsset.set(hit.asset_id, projectId);
      }
      await goto(`/projects/${projectId}/assets/${hit.asset_id}`);
    } catch (caught) {
      error = messageFrom(caught, 'The asset for this comment is not available.');
    }
  };

  onMount(() => {
    q = page.url.searchParams.get('q') ?? '';
    if (q) void run(q);
    input?.focus();
    const focusSearch = (): void => {
      input?.focus();
      input?.select();
    };
    window.addEventListener('onelight:focus-search', focusSearch);
    return () => window.removeEventListener('onelight:focus-search', focusSearch);
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
        onclick={() => { scope = item.id; shown = PAGE_SIZE; }}
      >{item.label}</button>
    {/each}
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}

  <section aria-label="Results" class="results" aria-busy={busy}>
    {#if !searched}
      <p class="empty">Type at least two characters to search asset names and comment text.</p>
    {:else if filtered.length === 0 && !busy}
      <p class="empty">Nothing matched "{searched}".</p>
    {/if}
    {#each visible as hit (hit.type + hit.id)}
      {#if hit.type === 'asset'}
        <a class="hit" href={`/projects/${hit.project_id}/assets/${hit.id}`}>
          <span class="kind">Asset</span>
          <span class="name">{hit.name}</span>
        </a>
      {:else}
        <button type="button" class="hit" onclick={() => openComment(hit)}>
          <span class="kind">Comment</span>
          <span class="name">{excerpt(hit.body_text)}</span>
        </button>
      {/if}
    {/each}
    {#if filtered.length > shown}
      <button type="button" class="more" onclick={() => (shown += PAGE_SIZE)}>
        Show more ({filtered.length - shown} left)
      </button>
    {/if}
  </section>
</main>

<style>
  /* App world, no borders: separation by value step and space. */
  .page { min-height: 100vh; padding: 48px clamp(24px, 8vw, 120px); background: var(--ink-000); }
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
  .kind { flex: none; width: 64px; color: var(--ink-text-dim); font-size: var(--text-12); }
  .name { font-weight: 500; overflow-wrap: anywhere; }
  .more { justify-self: start; margin-top: 10px; border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 9px 16px; font-size: var(--text-12); font-weight: 500; }
  .more:hover { background: var(--ink-300); }
  .empty { color: var(--ink-text-dim); }
  .error { color: var(--warn); }
  button:focus-visible, a:focus-visible, input:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: 2px; }
</style>
