<script lang="ts">
  import { copyText } from '$lib/clipboard.js';
  import { onMount } from 'svelte';
  import { api, apiDelete, apiPost, messageFrom } from '$lib/api.js';

  type Token = { id: string; name: string; token_prefix: string; created_at: number; last_used_at: number | null };
  let tokens = $state<Token[]>([]);
  let name = $state('');
  let revealed = $state('');
  let error = $state('');

  const load = async (): Promise<void> => {
    try {
      tokens = (await api<{ items: Token[] }>('/api/v1/tokens')).items;
    } catch (caught) {
      error = messageFrom(caught, 'Tokens could not be loaded.');
    }
  };

  const create = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    error = '';
    try {
      const body = await apiPost<{ token?: string }>('/api/v1/tokens', { name });
      revealed = body.token ?? '';
      name = '';
      await load();
    } catch (caught) {
      error = messageFrom(caught, 'Token could not be created.');
    }
  };

  const revoke = async (id: string): Promise<void> => {
    try {
      await apiDelete(`/api/v1/tokens/${id}`);
      await load();
    } catch (caught) {
      error = messageFrom(caught, 'Token could not be revoked.');
    }
  };

  onMount(load);
</script>

<svelte:head><title>API tokens | Onelight</title></svelte:head>
<main class="page">
  <a href="/settings">Settings</a>
  <h1>API tokens</h1>
  <p class="lede">Create tokens for command-line tools and integrations. The secret is shown once.</p>
  <form onsubmit={create} class="create">
    <label>Name <input bind:value={name} required maxlength="200" placeholder="Resolve export" /></label>
    <button type="submit">Create token</button>
  </form>
  {#if revealed}<section class="revealed" aria-live="polite"><strong>Copy this token now</strong><input readonly value={revealed} aria-label="New API token" /><button type="button" onclick={() => void copyText(revealed)}>Copy token</button></section>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <section aria-label="Active tokens" class="list">
    {#if tokens.length === 0}<p class="empty">No active tokens.</p>{/if}
    {#each tokens as token (token.id)}<article><div><strong>{token.name}</strong><span>{token.token_prefix}...</span></div><button type="button" onclick={() => revoke(token.id)}>Revoke</button></article>{/each}
  </section>
</main>

<style>
  /* App world, no borders: rows and fields separate by value step. */
  .page { min-height: calc(100vh - var(--topbar-h, 0px)); padding: 48px clamp(24px, 8vw, 120px); background: var(--ink-000); }
  a { color: var(--ink-text-dim); }
  h1 { margin: 48px 0 12px; font-family: var(--font-display); font-size: clamp(40px, 7vw, 72px); font-weight: 700; letter-spacing: -0.02em; }
  .lede { max-width: 560px; color: var(--ink-text-dim); }
  .create, .revealed { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; margin: 32px 0; }
  label { display: grid; gap: 8px; color: var(--ink-text-dim); font-size: var(--text-13); }
  input { min-width: min(420px, 80vw); border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 10px 12px; }
  button { border: 0; border-radius: var(--radius); background: var(--accent); color: #071216; padding: 11px 16px; font-weight: 600; }
  button:hover { background: var(--accent-bright); }
  button:focus-visible, a:focus-visible, input:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: 2px; }
  .revealed { padding: 16px; border-radius: var(--radius); background: var(--ink-100); }
  .revealed strong { flex-basis: 100%; }
  .list { max-width: 760px; }
  article { display: flex; justify-content: space-between; gap: 20px; align-items: center; padding: 14px; margin: 0 -14px 2px; border-radius: var(--radius); background: var(--ink-100); }
  article div { display: grid; gap: 4px; }
  article span, .empty { color: var(--ink-text-dim); }
  .error { color: var(--warn); }
</style>
