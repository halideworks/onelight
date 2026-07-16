<script lang="ts">
  import { onMount } from 'svelte';
  import { api, messageFrom } from '$lib/api.js';
  import { formatBytes } from '$lib/upload.js';
  import { pretty } from '$lib/ids.js';

  /* What the workspace weighs, per project, plus the media volume's capacity
     where the host reports one. Admin only, like the endpoint. */

  type Counters = {
    originals_bytes: number;
    renditions_bytes: number;
    asset_count: number;
    version_count: number;
  };
  type Usage = {
    totals: Counters;
    disk: { total_bytes: number; free_bytes: number } | null;
    projects: Array<Counters & { id: string; name: string }>;
  };

  let usage = $state<Usage | null>(null);
  let error = $state('');

  onMount(() => {
    void (async () => {
      try {
        usage = await api<Usage>('/api/v1/workspace/usage');
      } catch (caught) {
        error = messageFrom(caught, 'Storage usage is not available.');
      }
    })();
  });

  const totalOf = (row: Counters): number => row.originals_bytes + row.renditions_bytes;

  /* Largest first: the question this page answers is "where did the disk
     go", and the answer should be the first row. */
  const rows = $derived(
    usage ? [...usage.projects].sort((a, b) => totalOf(b) - totalOf(a)) : []
  );
  const grandTotal = $derived(usage ? totalOf(usage.totals) : 0);

  /* The bar draws each project against the biggest one, so relative weight is
     readable without doing arithmetic on the numbers beside it. */
  const barScale = $derived(rows.length ? Math.max(...rows.map(totalOf), 1) : 1);
</script>

<svelte:head><title>Storage | Onelight</title></svelte:head>

<main class="page">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/settings">Settings</a></nav>
  <h1>Storage</h1>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {:else if usage}
    <p class="lede">
      <strong class="tc">{formatBytes(grandTotal)}</strong> across
      {usage.totals.asset_count} {usage.totals.asset_count === 1 ? 'asset' : 'assets'} and
      {usage.totals.version_count} {usage.totals.version_count === 1 ? 'version' : 'versions'}:
      <span class="tc">{formatBytes(usage.totals.originals_bytes)}</span> of originals,
      <span class="tc">{formatBytes(usage.totals.renditions_bytes)}</span> of renditions.
    </p>
    {#if usage.disk}
      <p class="disk">
        <span class="diskbar" aria-hidden="true">
          <span class="diskfill" style={`width: ${Math.min(100, ((usage.disk.total_bytes - usage.disk.free_bytes) / Math.max(usage.disk.total_bytes, 1)) * 100)}%;`}></span>
        </span>
        <span class="tc">{formatBytes(usage.disk.free_bytes)}</span> free of
        <span class="tc">{formatBytes(usage.disk.total_bytes)}</span> on the media volume.
      </p>
    {/if}
    <p class="note">Trashed assets are included until the purge removes them.</p>

    {#if rows.length === 0}
      <p class="empty">No projects yet.</p>
    {:else}
      <table>
        <thead>
          <tr>
            <th>Project</th>
            <th class="num">Assets</th>
            <th class="num">Versions</th>
            <th class="num">Originals</th>
            <th class="num">Renditions</th>
            <th class="num">Total</th>
            <th class="barcell" aria-hidden="true"></th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row (row.id)}
            <tr>
              <td class="name"><a href={`/projects/${pretty(row.id, row.name)}`}>{row.name}</a></td>
              <td class="num tc">{row.asset_count}</td>
              <td class="num tc">{row.version_count}</td>
              <td class="num tc">{formatBytes(row.originals_bytes)}</td>
              <td class="num tc">{formatBytes(row.renditions_bytes)}</td>
              <td class="num tc total">{formatBytes(totalOf(row))}</td>
              <td class="barcell">
                <span class="bar" aria-hidden="true">
                  <span class="fill originals" style={`width: ${(row.originals_bytes / barScale) * 100}%;`}></span>
                  <span class="fill renditions" style={`width: ${(row.renditions_bytes / barScale) * 100}%;`}></span>
                </span>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
      <p class="legend">
        <span class="key originals" aria-hidden="true"></span> originals
        <span class="key renditions" aria-hidden="true"></span> renditions
      </p>
    {/if}
  {:else}
    <p class="empty">Loading.</p>
  {/if}
</main>

<style>
  .page { min-height: calc(100vh - var(--topbar-h, 0px)); padding: 48px clamp(24px, 5vw, 96px); background: var(--ink-000); color: var(--ink-text); font-size: var(--text-13); }
  .crumbs { margin: 0 0 8px; }
  .crumbs a { color: var(--ink-text-dim); font-size: var(--text-13); text-decoration: none; }
  .crumbs a:hover { color: var(--ink-text); }
  h1 { margin: 0 0 20px; font-family: var(--font-display); font-size: clamp(28px, 4vw, 44px); font-weight: 700; letter-spacing: -0.02em; }
  .lede { margin: 0 0 6px; font-size: var(--text-16); }
  .lede strong { font-weight: 600; }
  .note { margin: 0 0 24px; color: var(--ink-text-dim); }

  table { width: 100%; max-width: 1100px; border-collapse: collapse; }
  th { text-align: left; padding: 8px 14px 8px 0; color: var(--ink-text-dim); font-weight: 500; }
  td { padding: 8px 14px 8px 0; }
  tbody tr { border-radius: var(--radius); }
  tbody tr:hover td { background: var(--ink-100); }
  td:first-child, th:first-child { padding-left: 8px; }
  .name a { color: var(--ink-text); text-decoration: none; }
  .name a:hover { color: var(--accent-bright); }
  .num { text-align: right; }
  .tc { font-variant-numeric: tabular-nums; }
  .total { font-weight: 600; }

  /* The weight, drawn: two segments per project, against the heaviest one. */
  .barcell { width: 26%; min-width: 140px; padding-right: 8px; }
  .bar { display: flex; height: 10px; border-radius: 2px; overflow: hidden; background: var(--ink-100); }
  .fill { display: block; height: 100%; }
  .fill.originals { background: var(--accent); }
  .fill.renditions { background: var(--ink-400, #33415a); }
  .legend { display: flex; align-items: center; gap: 8px; margin: 12px 0 0; color: var(--ink-text-dim); }
  .key { display: inline-block; width: 12px; height: 10px; border-radius: 2px; }
  .key.originals { background: var(--accent); }
  .key.renditions { background: var(--ink-400, #33415a); margin-left: 10px; }

  .disk { display: flex; align-items: center; gap: 10px; margin: 0 0 6px; }
  .diskbar { display: block; width: 220px; height: 10px; border-radius: 2px; overflow: hidden; background: var(--ink-100); }
  .diskfill { display: block; height: 100%; background: var(--ink-400, #33415a); }

  .empty { color: var(--ink-text-dim); }
  .error { color: var(--warn); }
  a:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: 2px; }
</style>
