<script lang="ts">
  import { onMount } from 'svelte';
  import { api, messageFrom } from '$lib/api.js';
  import { whenAbsolute, whenRelative } from '$lib/format.js';

  /* The audit log, read the way it is written: newest first, filterable by
     action, paged by cursor. Names are resolved from the member list so the
     table says who, not which ulid. */

  type Entry = {
    id: string;
    actor_user_id: string | null;
    action: string;
    target: string | null;
    meta: Record<string, unknown>;
    at: number;
  };
  type User = { id: string; name: string; email: string };

  let entries = $state<Entry[]>([]);
  let nextCursor = $state<string | null>(null);
  let users = $state<Record<string, User>>({});
  let action = $state('');
  let error = $state('');
  let loading = $state(false);

  const load = async (append: boolean): Promise<void> => {
    loading = true;
    try {
      const query = new URLSearchParams({ limit: '50' });
      if (action.trim()) query.set('action', action.trim());
      if (append && nextCursor) query.set('cursor', nextCursor);
      const pageData = await api<{ items: Entry[]; next_cursor: string | null }>(
        `/api/v1/audit?${query.toString()}`
      );
      entries = append ? [...entries, ...pageData.items] : pageData.items;
      nextCursor = pageData.next_cursor;
      error = '';
    } catch (caught) {
      error = messageFrom(caught, 'The audit log is not available.');
    } finally {
      loading = false;
    }
  };

  onMount(() => {
    void load(false);
    void (async () => {
      try {
        const loaded = await api<{ items: User[] }>('/api/v1/users');
        users = Object.fromEntries(loaded.items.map((user) => [user.id, user]));
      } catch {
        /* Ids stand in for names. */
      }
    })();
  });

  let filterTimer: ReturnType<typeof setTimeout> | null = null;
  const filterAsYouType = (): void => {
    if (filterTimer !== null) clearTimeout(filterTimer);
    filterTimer = setTimeout(() => void load(false), 300);
  };

  const who = (entry: Entry): string =>
    entry.actor_user_id ? (users[entry.actor_user_id]?.name ?? entry.actor_user_id) : 'System';

  /* The meta is a small record; one line of key: value reads faster than
     JSON braces in a table cell. */
  const metaLine = (meta: Record<string, unknown>): string =>
    Object.entries(meta)
      .map(([key, value]) => `${key}: ${String(value)}`)
      .join(', ');
</script>

<svelte:head><title>Audit log | Onelight</title></svelte:head>

<main class="page">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/settings">Settings</a></nav>
  <h1>Audit log</h1>

  <div class="bar">
    <input
      type="search"
      bind:value={action}
      oninput={filterAsYouType}
      placeholder="Filter by action, e.g. user.login"
      aria-label="Filter by action"
    />
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </div>

  {#if entries.length === 0 && !loading}
    <p class="empty">{action ? 'Nothing matches that action.' : 'Nothing has been recorded yet.'}</p>
  {:else}
    <table>
      <thead>
        <tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Detail</th></tr>
      </thead>
      <tbody>
        {#each entries as entry (entry.id)}
          <tr>
            <td class="tc when" title={whenAbsolute(entry.at)}>{whenRelative(entry.at)}</td>
            <td class="whocell">{who(entry)}</td>
            <td><span class="action tc">{entry.action}</span></td>
            <td class="tc target">{entry.target ?? ''}</td>
            <td class="detail">{metaLine(entry.meta)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if nextCursor}
      <button type="button" class="more" disabled={loading} onclick={() => void load(true)}>
        {loading ? 'Loading' : 'Load more'}
      </button>
    {/if}
  {/if}
</main>

<style>
  .page { min-height: calc(100vh - var(--topbar-h, 0px)); padding: 48px clamp(24px, 5vw, 96px); background: var(--ink-000); color: var(--ink-text); font-size: var(--text-13); }
  .crumbs { margin: 0 0 8px; }
  .crumbs a { color: var(--ink-text-dim); font-size: var(--text-13); text-decoration: none; }
  .crumbs a:hover { color: var(--ink-text); }
  h1 { margin: 0 0 20px; font-family: var(--font-display); font-size: clamp(28px, 4vw, 44px); font-weight: 700; letter-spacing: -0.02em; }

  .bar { display: flex; align-items: center; gap: 16px; margin: 0 0 16px; }
  input[type='search'] { width: min(360px, 100%); border: 0; border-radius: var(--radius); background: var(--ink-100); color: var(--ink-text); padding: 9px 12px; font: inherit; }

  table { width: 100%; max-width: 1400px; border-collapse: collapse; }
  th { text-align: left; padding: 7px 16px 7px 0; color: var(--ink-text-dim); font-weight: 500; }
  td { padding: 7px 16px 7px 0; vertical-align: top; }
  td:first-child, th:first-child { padding-left: 8px; }
  tbody tr:hover td { background: var(--ink-100); }
  .tc { font-variant-numeric: tabular-nums; }
  .when { white-space: nowrap; color: var(--ink-text-dim); }
  .whocell { white-space: nowrap; }
  .action { display: inline-block; padding: 1px 7px; border-radius: 9px; background: var(--ink-200); font-size: var(--text-12); }
  .target { color: var(--ink-text-dim); overflow-wrap: anywhere; }
  .detail { color: var(--ink-text-dim); overflow-wrap: anywhere; }

  .more { margin-top: 14px; border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 8px 16px; font-size: var(--text-13); font-weight: 500; }
  .more:hover { background: var(--ink-300); }
  .more:disabled { opacity: 0.5; }
  .empty { color: var(--ink-text-dim); }
  .error { margin: 0; color: var(--warn); }
  a:focus-visible, input:focus-visible, button:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: 2px; }
</style>
