<script lang="ts">
  import { onMount } from 'svelte';
  import { api, apiDelete, apiPost, messageFrom } from '$lib/api.js';
  import { askConfirm } from '$lib/confirm.svelte.js';
  import { whenAbsolute, whenRelative } from '$lib/format.js';

  /* Outbound webhooks: what fires, where it goes. Deliveries are signed
     (X-Onelight-Signature, HMAC-SHA256 of the body with the hook's secret)
     and retried with backoff by the delivery pump. */

  type Webhook = {
    id: string;
    url: string;
    events: string[];
    active: boolean;
    created_at: number;
  };

  /* The kinds the server actually emits today. */
  const KNOWN_EVENTS = [
    'project.created',
    'asset.created',
    'asset.version_created',
    'version.probed',
    'version.transcode',
    'comment.created',
    'comment.updated',
    'comment.deleted'
  ];

  let hooks = $state<Webhook[]>([]);
  let error = $state('');
  let loaded = $state(false);

  let url = $state('');
  let secret = $state('');
  let picked = $state<string[]>(['comment.created']);
  let creating = $state(false);
  let revealedSecret = $state('');

  const load = async (): Promise<void> => {
    try {
      hooks = (await api<{ items: Webhook[] }>('/api/v1/webhooks')).items;
      error = '';
    } catch (caught) {
      error = messageFrom(caught, 'Webhooks are not available.');
    } finally {
      loaded = true;
    }
  };

  onMount(() => {
    void load();
  });

  const toggleEvent = (event: string): void => {
    picked = picked.includes(event)
      ? picked.filter((entry) => entry !== event)
      : [...picked, event];
  };

  const create = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    if (!url.trim() || picked.length === 0 || creating) return;
    creating = true;
    revealedSecret = '';
    try {
      const created = await apiPost<{ id: string; secret?: string }>('/api/v1/webhooks', {
        url: url.trim(),
        ...(secret.trim() ? { secret: secret.trim() } : {}),
        events: picked
      });
      if (created.secret) revealedSecret = created.secret;
      url = '';
      secret = '';
      await load();
    } catch (caught) {
      error = messageFrom(caught, 'The webhook could not be created.');
    } finally {
      creating = false;
    }
  };

  const remove = async (hook: Webhook): Promise<void> => {
    if (
      !(await askConfirm({
        title: 'Delete this webhook?',
        body: `${hook.url} stops receiving events immediately.`,
        confirmLabel: 'Delete',
        danger: true
      }))
    )
      return;
    try {
      await apiDelete(`/api/v1/webhooks/${hook.id}`);
      hooks = hooks.filter((entry) => entry.id !== hook.id);
      error = '';
    } catch (caught) {
      error = messageFrom(caught, 'The webhook could not be deleted.');
    }
  };
</script>

<svelte:head><title>Webhooks | Onelight</title></svelte:head>

<main class="page">
  <h1>Webhooks</h1>
  <p class="note">Each delivery is signed with the hook's secret (X-Onelight-Signature, HMAC-SHA256 of the body) and retried with backoff.</p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}

  <form class="create" onsubmit={create}>
    <label class="field">Endpoint URL
      <input type="url" bind:value={url} placeholder="https://example.com/hooks/onelight" required />
    </label>
    <label class="field">Secret
      <input type="text" bind:value={secret} placeholder="Generated when left empty" autocomplete="off" minlength="16" />
    </label>
    <fieldset>
      <legend>Events</legend>
      <div class="events">
        {#each KNOWN_EVENTS as event (event)}
          <label class="check">
            <input type="checkbox" checked={picked.includes(event)} onchange={() => toggleEvent(event)} />
            <span class="tc">{event}</span>
          </label>
        {/each}
      </div>
    </fieldset>
    <button type="submit" class="primary" disabled={creating || !url.trim() || picked.length === 0}>
      {creating ? 'Creating' : 'Add webhook'}
    </button>
  </form>

  {#if revealedSecret}
    <p class="revealed" role="status">
      Secret for the new hook, shown once: <span class="tc">{revealedSecret}</span>
    </p>
  {/if}

  {#if hooks.length === 0 && loaded && !error}
    <p class="empty">No webhooks yet.</p>
  {:else if hooks.length > 0}
    <table>
      <thead>
        <tr><th>Endpoint</th><th>Events</th><th>Created</th><th></th></tr>
      </thead>
      <tbody>
        {#each hooks as hook (hook.id)}
          <tr>
            <td class="url">{hook.url}</td>
            <td class="eventscell">{hook.events.join(', ')}</td>
            <td class="tc" title={whenAbsolute(hook.created_at)}>{whenRelative(hook.created_at)}</td>
            <td class="act"><button type="button" onclick={() => void remove(hook)}>Delete</button></td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</main>

<style>
  .page { padding: 44px 0 72px; color: var(--ink-text); font-size: var(--text-13); }
  h1 { margin: 0 0 8px; font-family: var(--font-display); font-size: clamp(26px, 3vw, 36px); font-weight: 700; letter-spacing: -0.02em; }
  .note { margin: 0 0 20px; color: var(--ink-text-dim); }

  .create { display: grid; gap: 12px; max-width: 640px; padding: var(--pad-2); border-radius: var(--radius-lg); background: var(--ink-100); margin-bottom: 24px; }
  .field { display: grid; gap: 6px; color: var(--ink-text-dim); font-weight: 500; }
  .field input { border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 8px 10px; font: inherit; }
  fieldset { border: 0; margin: 0; padding: 0; }
  legend { padding: 0; margin: 0 0 6px; color: var(--ink-text-dim); font-weight: 500; }
  .events { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 4px; }
  .check { display: flex; align-items: center; gap: 8px; }
  .check input { accent-color: var(--accent); margin: 0; }
  .primary { justify-self: start; border: 0; border-radius: var(--radius); background: var(--accent); color: #0b1214; padding: 9px 16px; font-size: var(--text-13); font-weight: 600; }
  .primary:hover { background: var(--accent-bright); }
  .primary:disabled { opacity: 0.5; }

  .revealed { margin: 0 0 20px; padding: 10px 12px; border-radius: var(--radius); background: color-mix(in oklab, var(--note) 14%, var(--ink-100)); }
  .tc { font-variant-numeric: tabular-nums; }

  table { width: 100%; max-width: 1100px; border-collapse: collapse; }
  th { text-align: left; padding: 7px 16px 7px 0; color: var(--ink-text-dim); font-weight: 500; }
  td { padding: 7px 16px 7px 0; vertical-align: top; }
  td:first-child, th:first-child { padding-left: 8px; }
  tbody tr:hover td { background: var(--ink-100); }
  .url { overflow-wrap: anywhere; }
  .eventscell { color: var(--ink-text-dim); }
  .act { text-align: right; }
  .act button { border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 6px 14px; font-weight: 500; }
  .act button:hover { background: var(--warn); color: #12080a; }
  .empty { color: var(--ink-text-dim); }
  .error { margin: 0 0 12px; color: var(--warn); }
  button:focus-visible, input:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: 2px; }
</style>
