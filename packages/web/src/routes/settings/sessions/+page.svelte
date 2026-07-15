<script lang="ts">
  import { onMount } from 'svelte';
  import { api, apiDelete, messageFrom } from '$lib/api.js';
  import { whenAbsolute, whenRelative } from '$lib/format.js';

  type Session = {
    id: string;
    created_at: number;
    expires_at: number;
    last_seen_at: number;
    ip: string | null;
    user_agent: string | null;
  };

  let sessions = $state<Session[]>([]);
  let loaded = $state(false);
  let error = $state('');

  const load = async (): Promise<void> => {
    try {
      sessions = (await api<{ items: Session[] }>('/api/v1/sessions')).items;
      loaded = true;
      error = '';
    } catch (caught) {
      error = messageFrom(caught, 'Sessions could not be loaded.');
    }
  };

  /* The API does not flag which row is this browser's session, so every
     revoke carries the sign-out warning. Revoking the current session makes
     the next request 401 and the client returns to /login. */
  const revoke = async (session: Session): Promise<void> => {
    if (!confirm('Revoke this session? If it is the one you are using right now, you will be signed out.')) return;
    try {
      await apiDelete(`/api/v1/sessions/${session.id}`);
    } catch (caught) {
      error = messageFrom(caught, 'The session could not be revoked.');
      return;
    }
    await load();
  };

  const describeAgent = (agent: string | null): string => {
    if (!agent) return 'Unknown client';
    const browser =
      /Firefox\/[\d.]+/.exec(agent)?.[0] ??
      (/Edg\//.test(agent) ? 'Edge' : undefined) ??
      (/Chrome\//.test(agent) ? 'Chrome' : undefined) ??
      (/Safari\//.test(agent) ? 'Safari' : undefined) ??
      agent.split(' ')[0] ??
      'Unknown client';
    const os = /\(([^)]+)\)/.exec(agent)?.[1]?.split(';')[0]?.trim();
    return os ? `${browser.split('/')[0]} on ${os}` : browser.split('/')[0] ?? 'Unknown client';
  };

  onMount(load);
</script>

<svelte:head><title>Sessions | Onelight</title></svelte:head>

<main class="page">
  <a href="/settings">Settings</a>
  <h1>Sessions</h1>
  <p class="lede">Browsers currently signed in to your account. Revoking the session you are using right now signs you out.</p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <section aria-label="Active sessions" class="list">
    {#if loaded && sessions.length === 0}<p class="empty">No active sessions.</p>{/if}
    {#each sessions as session (session.id)}
      <article>
        <div class="info">
          <strong>{describeAgent(session.user_agent)}</strong>
          <span class="meta">
            {session.ip ?? 'unknown address'}
            <span class="sep" aria-hidden="true"></span>
            <span title={whenAbsolute(session.last_seen_at)}>active {whenRelative(session.last_seen_at)}</span>
            <span class="sep" aria-hidden="true"></span>
            <span title={whenAbsolute(session.created_at)}>signed in {whenRelative(session.created_at)}</span>
          </span>
          {#if session.user_agent}<span class="agent">{session.user_agent}</span>{/if}
        </div>
        <button type="button" onclick={() => revoke(session)}>Revoke</button>
      </article>
    {/each}
  </section>
</main>

<style>
  /* App world, no borders: rows separate by value step. */
  .page { min-height: calc(100vh - var(--topbar-h, 0px)); padding: 48px clamp(24px, 8vw, 120px); background: var(--ink-000); }
  a { color: var(--ink-text-dim); }
  h1 { margin: 48px 0 12px; font-family: var(--font-display); font-size: clamp(40px, 7vw, 72px); font-weight: 700; letter-spacing: -0.02em; }
  .lede { max-width: 560px; margin: 0 0 32px; color: var(--ink-text-dim); }
  .list { max-width: 760px; display: grid; gap: 2px; }
  article { display: flex; justify-content: space-between; align-items: center; gap: 20px; padding: 14px; margin: 0 -14px; border-radius: var(--radius); background: var(--ink-100); }
  .info { display: grid; gap: 4px; min-width: 0; font-size: var(--text-13); }
  .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; color: var(--ink-text-dim); font-variant-numeric: tabular-nums; }
  .sep { width: 3px; height: 3px; border-radius: 50%; background: var(--ink-300); }
  .agent { color: var(--ink-text-dim); font-size: var(--text-13); overflow-wrap: anywhere; }
  button { border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 9px 16px; font-size: var(--text-13); font-weight: 600; }
  button:hover { background: var(--ink-300); }
  button:focus-visible, a:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: 2px; }
  .empty { color: var(--ink-text-dim); }
  .error { color: var(--warn); }
</style>
