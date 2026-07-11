<script lang="ts">
  import { api, messageFrom } from '$lib/api.js';
  import { auth } from '$lib/auth.svelte.js';
  import { whenAbsolute, whenRelative } from '$lib/format.js';

  type Job = {
    id: string;
    kind: string;
    status: 'queued' | 'processing' | 'complete' | 'failed' | 'dead';
    attempts: number;
    max_attempts: number;
    run_after: number;
    created_at: number;
    started_at: number | null;
    finished_at: number | null;
    error: string | null;
    payload: { workspace_id?: string; project_id?: string; asset_id?: string; version_id?: string };
  };

  const TABS = ['all', 'queued', 'processing', 'complete', 'failed', 'dead'] as const;
  type Tab = (typeof TABS)[number];

  let tab = $state<Tab>('all');
  let items = $state<Job[]>([]);
  let nextCursor = $state<string | null>(null);
  let loaded = $state(false);
  let error = $state('');

  const isAdmin = $derived(auth.user?.role === 'admin');

  const query = (cursor?: string): string => {
    const params = new URLSearchParams({ limit: '50' });
    if (tab !== 'all') params.set('status', tab);
    if (cursor) params.set('cursor', cursor);
    return params.toString();
  };

  const load = async (): Promise<void> => {
    try {
      const pageData = await api<{ items: Job[]; next_cursor: string | null }>(`/api/v1/admin/jobs?${query()}`);
      items = pageData.items;
      nextCursor = pageData.next_cursor;
      loaded = true;
      error = '';
    } catch (caught) {
      error = messageFrom(caught, 'Jobs could not be loaded.');
    }
  };

  const loadMore = async (): Promise<void> => {
    if (!nextCursor) return;
    try {
      const pageData = await api<{ items: Job[]; next_cursor: string | null }>(`/api/v1/admin/jobs?${query(nextCursor)}`);
      items = [...items, ...pageData.items];
      nextCursor = pageData.next_cursor;
    } catch (caught) {
      error = messageFrom(caught, 'More jobs could not be loaded.');
    }
  };

  $effect(() => {
    void tab;
    if (isAdmin) void load();
  });

  /* Gentle auto-refresh while anything is in flight; stops when the tab is
     hidden or the queue settles. Refresh replaces the newest page. */
  const active = $derived(items.some((job) => job.status === 'queued' || job.status === 'processing'));
  $effect(() => {
    if (!isAdmin || !active) return;
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 5000);
    return () => clearInterval(interval);
  });

  const assetLink = (job: Job): string | null =>
    job.payload.project_id && job.payload.asset_id
      ? `/projects/${job.payload.project_id}/assets/${job.payload.asset_id}`
      : null;
</script>

<svelte:head><title>Job queue | Onelight</title></svelte:head>

<main class="page">
  <a href="/settings">Settings</a>
  <h1>Job queue</h1>
  {#if !auth.ready}
    <p class="empty">Checking access.</p>
  {:else if !isAdmin}
    <p class="empty">This page is for workspace admins.</p>
  {:else}
    <div class="tabs" role="group" aria-label="Job status filter">
      {#each TABS as status (status)}
        <button type="button" class="tab" aria-pressed={tab === status} onclick={() => (tab = status)}>
          {status === 'all' ? 'All' : status.charAt(0).toUpperCase() + status.slice(1)}
        </button>
      {/each}
    </div>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <section aria-label="Jobs" class="list">
      {#if loaded && items.length === 0}
        <p class="empty">Nothing {tab === 'all' ? 'in the queue' : tab}.</p>
      {/if}
      {#each items as job (job.id)}
        <article class={`s-${job.status}`}>
          <div class="row">
            <span class="kind">{job.kind}</span>
            <span class="status">{job.status}</span>
            <span class="tc attempts" title="Attempts used of maximum">{job.attempts} / {job.max_attempts}</span>
            <span class="when tc" title={whenAbsolute(job.created_at)}>created {whenRelative(job.created_at)}</span>
            {#if job.status === 'queued' && job.run_after > Date.now()}
              <span class="when tc" title={whenAbsolute(job.run_after)}>runs {whenRelative(job.run_after)}</span>
            {/if}
            {#if job.started_at}
              <span class="when tc" title={whenAbsolute(job.started_at)}>started {whenRelative(job.started_at)}</span>
            {/if}
            {#if job.finished_at}
              <span class="when tc" title={whenAbsolute(job.finished_at)}>finished {whenRelative(job.finished_at)}</span>
            {/if}
            <span class="grow"></span>
            {#if assetLink(job)}
              <a class="target" href={assetLink(job)}>asset</a>
            {/if}
            {#if job.payload.project_id}
              <a class="target" href={`/projects/${job.payload.project_id}`}>project</a>
            {/if}
          </div>
          {#if job.error}
            <p class="joberror" class:dead={job.status === 'dead'}>{job.error}</p>
          {/if}
        </article>
      {/each}
      {#if nextCursor}
        <button type="button" class="more" onclick={loadMore}>Load older</button>
      {/if}
    </section>
  {/if}
</main>

<style>
  /* App world, no borders: rows separate by value step. */
  .page { min-height: 100vh; padding: 48px clamp(24px, 8vw, 120px); background: var(--ink-000); }
  a { color: var(--ink-text-dim); }
  h1 { margin: 48px 0 24px; font-family: var(--font-display); font-size: clamp(40px, 7vw, 72px); font-weight: 700; letter-spacing: -0.02em; }
  .tabs { display: flex; flex-wrap: wrap; gap: 2px; margin-bottom: 28px; }
  .tab { border: 0; border-radius: var(--radius); background: var(--ink-100); color: var(--ink-text-dim); padding: 7px 14px; font-size: var(--text-13); font-weight: 500; }
  .tab:hover { color: var(--ink-text); }
  .tab[aria-pressed='true'] { background: var(--ink-300); color: var(--ink-text); }
  .list { max-width: 980px; display: grid; gap: 2px; }
  article { padding: 12px 14px; margin: 0 -14px; border-radius: var(--radius); background: var(--ink-100); font-size: var(--text-13); }
  .row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 14px; }
  .kind { min-width: 90px; font-weight: 600; }
  .status { min-width: 80px; color: var(--ink-text-dim); }
  article.s-processing .status { color: var(--info); }
  article.s-failed .status, article.s-dead .status { color: var(--warn); font-weight: 600; }
  article.s-complete .status { color: var(--ok); }
  .attempts { min-width: 48px; color: var(--ink-text-dim); }
  .when { color: var(--ink-text-dim); font-size: var(--text-12); }
  .grow { flex: 1; }
  .target { color: var(--accent); text-decoration: none; font-weight: 500; }
  .target:hover { color: var(--accent-bright); }
  .joberror { margin: 8px 0 0; color: var(--warn); overflow-wrap: anywhere; }
  .joberror.dead { font-weight: 600; }
  .more { justify-self: start; margin-top: 10px; border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 9px 16px; font-size: var(--text-12); font-weight: 500; }
  .more:hover { background: var(--ink-300); }
  .empty { color: var(--ink-text-dim); }
  .error { color: var(--warn); }
  button { cursor: pointer; }
  button:focus-visible, a:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: 2px; }
</style>
