<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { apiPost, messageFrom } from '$lib/api.js';
  import { auth } from '$lib/auth.svelte.js';

  let name = $state('');
  let password = $state('');
  let email = $state('');
  let error = $state('');
  let busy = $state(false);

  const token = $derived(page.params.token);

  $effect(() => {
    const current = token;
    if (!current) return;
    name = ''; password = ''; email = ''; error = '';
    void (async () => {
      try {
        const body = await apiPost<{ email?: string }>('/api/v1/invites/lookup', { token: current });
        if (current !== token) return;
        email = body.email ?? '';
      } catch {
        error = 'This invitation is no longer available.';
      }
    })();
  });

  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    busy = true;
    error = '';
    try {
      await apiPost('/api/v1/invites/accept', { token, name, password });
      await auth.hydrate();
      await goto('/');
    } catch (caught) {
      error = messageFrom(caught, 'Invitation could not be accepted.');
    } finally {
      busy = false;
    }
  };
</script>

<svelte:head><title>Join workspace | Onelight</title></svelte:head>

<main class="page">
  <section class="panel">
    <h1>Join Onelight</h1>
    <p class="sub">Use the invitation link to create your reviewer account.</p>
    <form onsubmit={submit}>
      <label>Name <input bind:value={name} name="name" required /></label>
      <label>Email <input value={email} readonly /></label>
      <label>Password <input bind:value={password} name="password" type="password" minlength="10" required /></label>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <button type="submit" disabled={busy}>{busy ? 'Joining' : 'Accept invitation'}</button>
    </form>
  </section>
</main>

<style>
  .page {
    min-height: 100vh;
    display: grid;
    place-items: center;
    background: linear-gradient(180deg, var(--yoai-a) 0%, var(--yoai-m) 55%, var(--yoai-b) 105%);
  }
  .panel { width: min(440px, calc(100vw - 48px)); padding: var(--pad-4); border-radius: var(--radius-lg); background: rgba(13, 15, 20, 0.9); }
  h1 { margin: 0 0 4px; font-family: var(--font-display); font-size: var(--text-28); font-weight: 700; letter-spacing: -0.01em; }
  .sub { margin: 0 0 28px; color: var(--ink-text-dim); font-size: var(--text-13); }
  form { display: grid; gap: 16px; }
  label { display: grid; gap: 6px; color: var(--ink-text-dim); font-size: var(--text-12); font-weight: 500; }
  input { border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 10px 11px; font-size: var(--text-13); }
  input:focus { outline: 1px solid var(--accent); }
  button { border: 0; border-radius: var(--radius); background: var(--ink-text); color: #10131a; padding: 10px; font-size: var(--text-13); font-weight: 600; }
  button:disabled { opacity: 0.6; cursor: wait; }
  .error { margin: 0; color: var(--warn); }
  button:focus-visible, input:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
</style>
