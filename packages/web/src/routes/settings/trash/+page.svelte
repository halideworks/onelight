<script lang="ts">
  import { onMount } from 'svelte';
  import { api, apiPost, messageFrom } from '$lib/api.js';
  import { whenAbsolute, whenRelative } from '$lib/format.js';
  import { pretty } from '$lib/ids.js';

  /* What has been thrown away, workspace-wide, while it can still come back.
     The purge sweep is what actually deletes; until it runs, restore puts an
     asset back where it was. */

  type TrashedAsset = {
    id: string;
    name: string;
    kind: string;
    project_id: string;
    project_name: string;
    deleted_at: number | null;
  };

  let items = $state<TrashedAsset[]>([]);
  let error = $state('');
  let loaded = $state(false);
  let busy = $state<string | null>(null);

  const load = async (): Promise<void> => {
    try {
      items = (await api<{ items: TrashedAsset[] }>('/api/v1/trash')).items;
      error = '';
    } catch (caught) {
      error = messageFrom(caught, 'The trash is not available.');
    } finally {
      loaded = true;
    }
  };

  onMount(() => {
    void load();
  });

  const restore = async (asset: TrashedAsset): Promise<void> => {
    busy = asset.id;
    try {
      await apiPost(`/api/v1/assets/${asset.id}/restore`, {});
      items = items.filter((entry) => entry.id !== asset.id);
      error = '';
    } catch (caught) {
      error = messageFrom(caught, 'It could not be restored.');
    } finally {
      busy = null;
    }
  };
</script>

<svelte:head><title>Trash | Onelight</title></svelte:head>

<main class="page">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/settings">Settings</a></nav>
  <h1>Trash</h1>
  {#if error}<p class="error" role="alert">{error}</p>{/if}

  {#if items.length === 0 && loaded && !error}
    <p class="empty">The trash is empty. Assets land here when someone moves them to trash, and the purge sweep removes them for good.</p>
  {:else if items.length > 0}
    <p class="note">Restore puts an asset back where it was. The purge sweep removes what stays here.</p>
    <table>
      <thead>
        <tr><th>Asset</th><th>Project</th><th>Trashed</th><th></th></tr>
      </thead>
      <tbody>
        {#each items as asset (asset.id)}
          <tr>
            <td class="name">{asset.name}</td>
            <td><a href={`/projects/${pretty(asset.project_id, asset.project_name)}`}>{asset.project_name}</a></td>
            <td class="tc" title={asset.deleted_at ? whenAbsolute(asset.deleted_at) : ''}>
              {asset.deleted_at ? whenRelative(asset.deleted_at) : ''}
            </td>
            <td class="act">
              <button type="button" disabled={busy === asset.id} onclick={() => void restore(asset)}>
                {busy === asset.id ? 'Restoring' : 'Restore'}
              </button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</main>

<style>
  .page { min-height: calc(100vh - var(--topbar-h, 0px)); padding: 48px clamp(24px, 5vw, 96px); background: var(--ink-000); color: var(--ink-text); font-size: var(--text-13); }
  .crumbs { margin: 0 0 8px; }
  .crumbs a { color: var(--ink-text-dim); font-size: var(--text-13); text-decoration: none; }
  .crumbs a:hover { color: var(--ink-text); }
  h1 { margin: 0 0 20px; font-family: var(--font-display); font-size: clamp(28px, 4vw, 44px); font-weight: 700; letter-spacing: -0.02em; }
  .note { margin: 0 0 16px; color: var(--ink-text-dim); }

  table { width: 100%; max-width: 1000px; border-collapse: collapse; }
  th { text-align: left; padding: 7px 16px 7px 0; color: var(--ink-text-dim); font-weight: 500; }
  td { padding: 7px 16px 7px 0; }
  td:first-child, th:first-child { padding-left: 8px; }
  tbody tr:hover td { background: var(--ink-100); }
  .tc { font-variant-numeric: tabular-nums; white-space: nowrap; color: var(--ink-text-dim); }
  td a { color: var(--ink-text); text-decoration: none; }
  td a:hover { color: var(--accent-bright); }
  .act { text-align: right; }
  button { border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 6px 14px; font-size: var(--text-13); font-weight: 500; }
  button:hover { background: var(--ink-300); }
  button:disabled { opacity: 0.5; }
  .empty { color: var(--ink-text-dim); }
  .error { margin: 0 0 12px; color: var(--warn); }
  a:focus-visible, button:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: 2px; }
</style>
