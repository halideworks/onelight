<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { messageFrom, resetPassword } from '$lib/api.js';

  let password = $state('');
  let confirm = $state('');
  let error = $state('');
  let busy = $state(false);

  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    if (password !== confirm) {
      error = 'The two passwords do not match.';
      return;
    }
    busy = true;
    error = '';
    try {
      await resetPassword(page.params.token ?? '', password);
      await goto('/login?reset=done');
    } catch (caught) {
      error = messageFrom(caught, 'The reset link is invalid or has expired.');
    } finally {
      busy = false;
    }
  };
</script>

<svelte:head><title>Reset password | Onelight</title></svelte:head>

<main class="page">
  <section class="panel">
    <h1>Onelight</h1>
    <p class="sub">Choose a new password</p>
    <form onsubmit={submit}>
      <label>New password
        <input bind:value={password} name="new-password" type="password" autocomplete="new-password" required />
      </label>
      <label>Confirm new password
        <input bind:value={confirm} name="confirm-password" type="password" autocomplete="new-password" required />
      </label>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <button type="submit" disabled={busy}>{busy ? 'Saving' : 'Set new password'}</button>
    </form>
    <a class="foot" href="/login">Back to sign in</a>
  </section>
</main>

<style>
  /* Same kuwanomi field as the login page: one quiet vertical wash, dark
     anchor at top, light terminal at bottom. */
  .page {
    min-height: 100vh;
    display: grid;
    place-items: center;
    background: linear-gradient(180deg, #2a1520 0%, var(--kuwanomi-a) 36%, #5a7ba0 78%, var(--kuwanomi-b) 112%);
  }
  .panel { width: min(360px, calc(100vw - 48px)); padding: var(--pad-4); border-radius: var(--radius-lg); background: rgba(13, 15, 20, 0.9); }
  h1 { margin: 0 0 4px; font-family: var(--font-display); font-size: var(--text-28); font-weight: 700; letter-spacing: -0.01em; }
  .sub { margin: 0 0 28px; color: var(--ink-text-dim); font-size: var(--text-13); }
  form { display: grid; gap: 16px; }
  label { display: grid; gap: 6px; color: var(--ink-text-dim); font-size: var(--text-13); font-weight: 500; }
  input { border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 10px 11px; font-size: var(--text-13); }
  input:focus { outline: 1px solid var(--accent); }
  button { border: 0; border-radius: var(--radius); background: var(--ink-text); color: #10131a; padding: 10px; font-size: var(--text-13); font-weight: 600; }
  button:disabled { opacity: 0.6; cursor: wait; }
  .error { margin: 0; color: var(--warn); }
  .foot { display: inline-block; margin-top: 24px; color: var(--ink-text-dim); font-size: var(--text-13); }
  button:focus-visible, a:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
</style>
