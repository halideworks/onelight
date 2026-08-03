<script lang="ts">
  import { onMount } from 'svelte';
  import GhostRows from '$lib/GhostRows.svelte';
  import { api, apiPost, messageFrom } from '$lib/api.js';
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
    mail: { state: 'ready' | 'disabled' | 'error'; detail: string | null };
    media_jobs: Record<string, number>;
    export_jobs: Record<string, number>;
    webhook_deliveries: Record<string, number>;
  };

  /* What the server actually resolved, subsystem by subsystem. Compose passes
     only the keys it names, so a setting can be present in .env, read back
     fine, and never reach the container: this is where an operator sees that
     rather than guessing from behaviour. Secret values are never sent. */
  type ConfigVar = {
    name: string;
    set: boolean;
    source: 'environment' | 'default' | 'derived' | 'unset';
    value: string | null;
    secret: boolean;
    summary: string;
    issue: string | null;
  };
  type ConfigView = {
    available: boolean;
    subsystems: Array<{
      name: string;
      title: string;
      active: boolean | null;
      detail: string | null;
      vars: ConfigVar[];
    }>;
    issues: Array<{ name: string; message: string }>;
  };

  let status = $state<Status | null>(null);
  let config = $state<ConfigView | null>(null);
  let configOpen = $state(false);
  let error = $state('');
  let mailTesting = $state(false);
  let mailTestResult = $state('');
  let mailTestFailed = $state(false);

  const sendTestEmail = async (): Promise<void> => {
    mailTesting = true;
    mailTestResult = '';
    mailTestFailed = false;
    try {
      const result = await apiPost<{ sent: true; to: string }>('/api/v1/admin/system/test-email', {});
      mailTestResult = `Sent to ${result.to}. Check that inbox.`;
    } catch (caught) {
      mailTestFailed = true;
      mailTestResult = messageFrom(caught, 'The test email could not be sent.');
    } finally {
      mailTesting = false;
    }
  };

  const load = async (): Promise<void> => {
    try {
      status = await api<Status>('/api/v1/admin/system');
      error = '';
    } catch (caught) {
      error = messageFrom(caught, 'System status is not available.');
    }
    /* Best effort and separate: configuration is a slower-moving fact than
       queue depth, and a platform that cannot report it (Workers) must not
       take the whole page down. */
    try {
      config = await api<ConfigView>('/api/v1/admin/system/config');
    } catch {
      config = null;
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

      <section class="card" aria-label="Email">
        <h2>Email</h2>
        {#if status.mail.state === 'ready'}
          <p>Outgoing email is configured.</p>
          <button type="button" class="mailtest" onclick={() => void sendTestEmail()} disabled={mailTesting}>
            {mailTesting ? 'Sending' : 'Send a test email'}
          </button>
        {:else if status.mail.state === 'error'}
          <p class="warn">The mail configuration is present but unusable{status.mail.detail ? `: ${status.mail.detail}` : '.'}</p>
        {:else}
          <p class="warn">Email is off.</p>
        {/if}
        {#if mailTestResult}
          <p class:warn={mailTestFailed} role="status">{mailTestResult}</p>
        {/if}
        <p class="hint"><a href="/settings/email">Configure email.</a></p>
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
    {#if config?.available}
      <section class="config" aria-label="Configuration">
        <h2>
          Configuration
          <button type="button" class="toggle" onclick={() => (configOpen = !configOpen)} aria-expanded={configOpen}>
            {configOpen ? 'Hide settings' : 'Show settings'}
          </button>
        </h2>
        <p class="hint">
          What this server resolved at startup. A setting can be present in your <code>.env</code> and still not
          reach the container, so this is the value actually in force. Secrets show only as set.
        </p>

        {#if config.issues.length > 0}
          <ul class="issues" role="alert">
            {#each config.issues as issue (issue.name)}
              <li class="warn">{issue.message}</li>
            {/each}
          </ul>
        {/if}

        <ul class="subsystems">
          {#each config.subsystems.filter((item) => item.active !== null) as item (item.name)}
            <li>
              <span class="dot" class:on={item.active} aria-hidden="true"></span>
              <span class="subname">{item.title}</span>
              <span class="state">{item.active ? 'active' : (item.detail ?? 'inactive')}</span>
            </li>
          {/each}
        </ul>

        {#if configOpen}
          {#each config.subsystems as item (item.name)}
            <div class="group">
              <h3>{item.title}</h3>
              <table>
                <tbody>
                  {#each item.vars as entry (entry.name)}
                    <tr class:warn={Boolean(entry.issue)}>
                      <th scope="row"><code>{entry.name}</code></th>
                      <td class="value tc">
                        {#if entry.secret}
                          <span class="muted">{entry.set ? 'set' : 'not set'}</span>
                        {:else if entry.value === null}
                          <span class="muted">not set</span>
                        {:else}
                          {entry.value}
                        {/if}
                      </td>
                      <td class="src muted">{entry.source === 'environment' ? 'configured' : entry.source}</td>
                      <td class="why muted">{entry.issue ?? entry.summary}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/each}
        {/if}
      </section>
    {/if}

    <p class="hint footer">Refreshes every 15 seconds. To restore, stop the server and copy a snapshot
      back over the database file.</p>
  {:else}
    <GhostRows rows={5} />
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

  .card p { margin: 0 0 10px; }
  .card p:last-child { margin-bottom: 0; }
  .mailtest { border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 8px 14px; font-size: var(--text-13); }
  .mailtest:hover { background: var(--ink-300); }
  .mailtest:disabled { opacity: 0.5; }

  /* Configuration reads as a list of facts, not a dashboard: value steps and
     space, no rules between rows. */
  .config { max-width: 1200px; margin: 24px 0 0; background: var(--ink-100); border-radius: var(--radius); padding: 20px; }
  .config h2 { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
  .toggle { border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 6px 12px; font-size: var(--text-13); font-weight: 400; }
  .toggle:hover { background: var(--ink-300); }
  .toggle:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: 2px; }

  .subsystems { list-style: none; margin: 14px 0 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 6px 20px; }
  .subsystems li { display: flex; align-items: baseline; gap: 8px; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ink-300); flex: none; }
  .dot.on { background: var(--ok); }
  .subname { color: var(--ink-text); }
  .state { color: var(--ink-text-dim); }

  .issues { list-style: none; margin: 14px 0 0; padding: 0; }

  .group { margin: 20px 0 0; }
  .group h3 { margin: 0 0 6px; }
  .config table { width: 100%; border-collapse: collapse; }
  .config th { text-align: left; font-weight: 400; padding: 3px 16px 3px 0; vertical-align: top; }
  .config td { padding: 3px 16px 3px 0; vertical-align: top; }
  .config td.value { white-space: nowrap; max-width: 22ch; overflow: hidden; text-overflow: ellipsis; }
  .config td.why { width: 55%; }
  .muted { color: var(--ink-text-dim); }
  .config tr.warn th, .config tr.warn td { color: var(--warn); }

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
