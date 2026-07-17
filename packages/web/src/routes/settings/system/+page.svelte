<script lang="ts">
  import { onMount } from 'svelte';
  import { api, messageFrom } from '$lib/api.js';
  import { formatBytes } from '$lib/upload.js';
  import { whenRelative } from '$lib/format.js';

  /* The operational picture on one page: what is running, what it weighs,
     whether it is being backed up, and how deep every queue is. Admin only,
     like the endpoint. */

  type Status = {
    version: string;
    started_at: number | null;
    db_size_bytes: number | null;
    backups: { count: number; newest_at: number | null } | null;
    disk: { total_bytes: number; free_bytes: number } | null;
    media_jobs: Record<string, number>;
    export_jobs: Record<string, number>;
    webhook_deliveries: Record<string, number>;
  };

  let status = $state<Status | null>(null);
  let error = $state('');

  const load = async (): Promise<void> => {
    try {
      status = await api<Status>('/api/v1/admin/system');
      error = '';
    } catch (caught) {
      error = messageFrom(caught, 'System status is not available.');
    }
  };

  onMount(() => {
    void load();
    const timer = setInterval(() => void load(), 15000);
    return () => clearInterval(timer);
  });

  const uptime = (startedAt: number): string => {
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
    return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
  };

  /* A queue table row per status, zeros omitted; the display order puts what
     needs attention first. */
  const QUEUE_ORDER = ['failed', 'dead', 'queued', 'delivering', 'processing', 'complete', 'delivered'];
  const queueRows = (counts: Record<string, number>): Array<[string, number]> =>
    QUEUE_ORDER.filter((key) => (counts[key] ?? 0) > 0).map((key) => [key, counts[key] ?? 0]);
  const attention = (counts: Record<string, number>): boolean =>
    (counts.failed ?? 0) > 0 || (counts.dead ?? 0) > 0;

  /* Backups are the panel that must never quietly look fine while stale:
     anything older than a day is called out. */
  const backupStale = $derived(
    Boolean(status?.backups?.newest_at && Date.now() - (status.backups.newest_at ?? 0) > 24 * 3600 * 1000)
  );

  const queueSections = $derived(
    status
      ? [
          { label: 'Media jobs', counts: status.media_jobs, href: '/settings/jobs' },
          { label: 'Exports', counts: status.export_jobs, href: null },
          { label: 'Webhook deliveries', counts: status.webhook_deliveries, href: '/settings/webhooks' }
        ]
      : []
  );
</script>

<svelte:head><title>System | Onelight</title></svelte:head>

<main class="page">
  <h1>System</h1>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {:else if status}
    <div class="cards">
      <section class="card" aria-label="Server">
        <h2>Server</h2>
        <dl>
          <dt>Version</dt>
          <dd class="tc">{status.version}</dd>
          {#if status.started_at}
            <dt>Up for</dt>
            <dd class="tc">{uptime(status.started_at)}</dd>
          {/if}
        </dl>
        <p class="hint">Liveness for monitors: <code>GET /healthz</code>.</p>
      </section>

      <section class="card" aria-label="Database">
        <h2>Database</h2>
        <dl>
          {#if status.db_size_bytes !== null}
            <dt>Size</dt>
            <dd class="tc">{formatBytes(status.db_size_bytes)}</dd>
          {/if}
          {#if status.backups}
            <dt>Snapshots</dt>
            <dd class="tc">{status.backups.count}</dd>
            <dt>Newest</dt>
            <dd class:warn={backupStale}>
              {status.backups.newest_at ? whenRelative(status.backups.newest_at) : 'none yet'}
              {#if backupStale}(stale){/if}
            </dd>
          {/if}
        </dl>
        {#if !status.backups}
          <p class="warn">Backups are off. Set BACKUP_DIR to write periodic database snapshots.</p>
        {/if}
      </section>

      {#if status.disk}
        <section class="card" aria-label="Media volume">
          <h2>Media volume</h2>
          <p class="disk">
            <span class="diskbar" aria-hidden="true">
              <span class="diskfill" style={`width: ${Math.min(100, ((status.disk.total_bytes - status.disk.free_bytes) / Math.max(status.disk.total_bytes, 1)) * 100)}%;`}></span>
            </span>
          </p>
          <dl>
            <dt>Free</dt>
            <dd class="tc">{formatBytes(status.disk.free_bytes)}</dd>
            <dt>Total</dt>
            <dd class="tc">{formatBytes(status.disk.total_bytes)}</dd>
          </dl>
          <p class="hint"><a href="/settings/storage">Where it went, per project.</a></p>
        </section>
      {/if}

      <section class="card" aria-label="Queues" class:attention={attention(status.media_jobs) || attention(status.export_jobs) || attention(status.webhook_deliveries)}>
        <h2>Queues</h2>
        {#each queueSections as section (section.label)}
          <div class="queue">
            <h3>
              {#if section.href}<a href={section.href}>{section.label}</a>{:else}{section.label}{/if}
            </h3>
            {#if queueRows(section.counts).length === 0}
              <p class="empty">Empty.</p>
            {:else}
              <ul>
                {#each queueRows(section.counts) as [state, count] (state)}
                  <li class:warn={state === 'failed' || state === 'dead'}>
                    <span class="tc">{count}</span> {state}
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/each}
      </section>
    </div>
    <p class="hint footer">Refreshes every 15 seconds. Restore steps live in docs/BACKUPS.md.</p>
  {:else}
    <p class="empty">Loading.</p>
  {/if}
</main>

<style>
  .page { padding: 44px 0 72px; color: var(--ink-text); font-size: var(--text-13); }
  h1 { margin: 0 0 20px; font-family: var(--font-display); font-size: clamp(26px, 3vw, 36px); font-weight: 700; letter-spacing: -0.02em; }

  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; max-width: 1200px; }
  .card { background: var(--ink-100); border-radius: var(--radius); padding: 20px; }
  .card.attention { border-left: 3px solid var(--warn); }
  h2 { margin: 0 0 12px; font-size: var(--text-16); font-weight: 600; }
  h3 { margin: 0 0 4px; font-size: var(--text-13); font-weight: 500; color: var(--ink-text-dim); }
  h3 a { color: var(--ink-text-dim); }
  h3 a:hover { color: var(--accent-bright); }

  dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 16px; margin: 0; }
  dt { color: var(--ink-text-dim); }
  dd { margin: 0; }
  .tc { font-variant-numeric: tabular-nums; }

  .queue { margin: 0 0 12px; }
  .queue:last-child { margin-bottom: 0; }
  .queue ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px 14px; }

  .disk { margin: 0 0 10px; }
  .diskbar { display: block; width: 100%; height: 10px; border-radius: 2px; overflow: hidden; background: var(--ink-200); }
  .diskfill { display: block; height: 100%; background: var(--ink-400, #33415a); }

  .hint { margin: 12px 0 0; color: var(--ink-text-dim); }
  .hint.footer { margin-top: 20px; }
  .hint a { color: var(--ink-text-dim); }
  .hint a:hover { color: var(--accent-bright); }
  code { font-size: var(--text-12); background: var(--ink-200); padding: 1px 5px; border-radius: 2px; }
  .empty { margin: 0; color: var(--ink-text-dim); }
  .warn { color: var(--warn); }
  .error { color: var(--warn); }
  a:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: 2px; }
</style>
