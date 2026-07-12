<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { apiPost, getBootstrap, messageFrom } from '$lib/api.js';
  import { auth } from '$lib/auth.svelte.js';

  let workspaceName = $state('');
  let name = $state('');
  let email = $state('');
  let password = $state('');
  let error = $state('');
  let busy = $state(false);

  onMount(async () => {
    /* Setup runs once; when the bootstrap says it is already complete this
       page only leads to a 404 on submit, so send visitors to sign in. */
    try {
      if (!(await getBootstrap()).setup_required) await goto('/login');
    } catch {
      /* Leave the form usable if the bootstrap is unreachable. */
    }
  });

  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    busy = true;
    error = '';
    try {
      await apiPost('/api/v1/setup', { workspace_name: workspaceName, name, email, password });
      await auth.hydrate();
      await goto('/');
    } catch (caught) {
      error = messageFrom(caught, 'Setup failed.');
    } finally {
      busy = false;
    }
  };
</script>

<svelte:head><title>First run | Onelight</title></svelte:head>

<main class="page">
  <section class="panel">
    <p class="eyebrow">First light</p>
    <h1>Create your workspace</h1>
    <form onsubmit={submit}>
      <label>Workspace <input bind:value={workspaceName} name="workspace_name" required /></label>
      <label>Your name <input bind:value={name} name="name" required /></label>
      <label>Email <input bind:value={email} name="email" type="email" required /></label>
      <label>Password <input bind:value={password} name="password" type="password" minlength="10" required /></label>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <button type="submit" disabled={busy}>{busy ? 'Creating workspace' : 'Create workspace'}</button>
    </form>
  </section>
</main>

<style>
  .page {
    min-height: 100vh;
    display: grid;
    place-items: center;
    background: linear-gradient(180deg, #2a1520 0%, var(--kuwanomi-a) 36%, #5a7ba0 78%, var(--kuwanomi-b) 112%);
  }
  .panel { width: min(480px, calc(100vw - 48px)); padding: var(--pad-4); border-radius: var(--radius-lg); background: rgba(13, 15, 20, 0.9); }
  .eyebrow { margin: 0 0 6px; color: var(--accent-bright); font-size: var(--text-13); }
  h1 { margin: 0 0 28px; font-family: var(--font-display); font-size: var(--text-28); font-weight: 700; letter-spacing: -0.01em; }
  form { display: grid; gap: 16px; }
  label { display: grid; gap: 6px; color: var(--ink-text-dim); font-size: var(--text-12); font-weight: 500; }
  input { border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 10px 11px; font-size: var(--text-13); }
  input:focus { outline: 1px solid var(--accent); }
  button { border: 0; border-radius: var(--radius); background: var(--accent); color: #081014; padding: 10px; font-size: var(--text-13); font-weight: 600; }
  button:disabled { opacity: 0.6; cursor: wait; }
  .error { margin: 0; color: var(--warn); }
  button:focus-visible, input:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
</style>
