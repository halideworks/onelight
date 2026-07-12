<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { apiPost, getBootstrap, messageFrom, requestPasswordReset } from '$lib/api.js';
  import { auth } from '$lib/auth.svelte.js';

  let email = $state('');
  let password = $state('');
  let error = $state('');
  let busy = $state(false);
  let oidcEnabled = $state(false);
  let setupRequired = $state(false);
  let workspaceName = $state<string | null>(null);
  let forgotOpen = $state(false);
  let resetEmail = $state('');
  let resetSent = $state(false);
  let resetBusy = $state(false);
  let resetNote = $state(false);

  onMount(async () => {
    /* Arriving from a completed password reset: one quiet note, no banner. */
    resetNote = page.url.searchParams.get('reset') === 'done';
    /* GET /api/v1/bootstrap is the public pre-auth surface: OIDC
       availability, setup state, and the workspace name. */
    try {
      const bootstrap = await getBootstrap();
      oidcEnabled = bootstrap.oidc_enabled;
      setupRequired = bootstrap.setup_required;
      workspaceName = bootstrap.workspace_name;
    } catch {
      oidcEnabled = false;
    }
  });

  const openForgot = (): void => {
    forgotOpen = true;
    resetSent = false;
    resetEmail = email;
  };

  const sendReset = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    if (resetBusy) return;
    resetBusy = true;
    try {
      await requestPasswordReset(resetEmail.trim());
    } catch {
      /* Same neutral confirmation either way: the form must not reveal
         whether an address has an account. */
    } finally {
      resetBusy = false;
      resetSent = true;
    }
  };

  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    busy = true;
    error = '';
    try {
      await apiPost('/api/v1/auth/login', { email, password }, { redirectOn401: false });
      await auth.hydrate();
      await goto('/');
    } catch (caught) {
      error = messageFrom(caught, 'Sign in failed.');
    } finally {
      busy = false;
    }
  };
</script>

<svelte:head><title>Sign in | Onelight</title></svelte:head>

<main class="page">
  <section class="panel">
    <h1>Onelight</h1>
    <p class="sub">{workspaceName ? `Sign in to ${workspaceName}` : 'Sign in to your review workspace'}</p>
    {#if resetNote}<p class="note" role="status">Password updated. Sign in with the new one.</p>{/if}
    <form onsubmit={submit}>
      <label>Email <input bind:value={email} name="email" type="email" autocomplete="email" required /></label>
      <label>Password <input bind:value={password} name="password" type="password" autocomplete="current-password" required /></label>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <button type="submit" disabled={busy}>{busy ? 'Signing in' : 'Sign in'}</button>
    </form>
    {#if !forgotOpen}
      <button type="button" class="textbtn" onclick={openForgot}>Forgot password</button>
    {:else if resetSent}
      <p class="reset-note" role="status">If that address has an account, a reset link is on its way.</p>
    {:else}
      <form class="forgot" onsubmit={sendReset}>
        <label>Email for the reset link
          <input bind:value={resetEmail} name="reset-email" type="email" autocomplete="email" required />
        </label>
        <button type="submit" class="quiet" disabled={resetBusy}>{resetBusy ? 'Sending' : 'Send reset link'}</button>
      </form>
    {/if}
    {#if oidcEnabled}
      <div class="divider">or</div>
      <a class="sso" href="/api/v1/auth/oidc/start">Continue with SSO</a>
    {/if}
    {#if setupRequired}<a class="foot" href="/setup">First run setup</a>{/if}
  </section>
</main>

<style>
  /* Kuwanomi field per mockups/login.html: one quiet vertical wash, dark
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
  .divider { display: flex; align-items: center; gap: 12px; margin: 20px 0; color: var(--ink-text-dim); font-size: var(--text-13); }
  .divider::before, .divider::after { content: ''; flex: 1; height: 1px; background: var(--ink-300); }
  .sso { display: block; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 10px; font-size: var(--text-13); font-weight: 500; text-align: center; text-decoration: none; }
  .sso:hover { background: var(--ink-300); }
  .error { margin: 0; color: var(--warn); }
  .note { margin: 0 0 20px; color: var(--ok); font-size: var(--text-13); }
  .textbtn { display: block; margin-top: 20px; padding: 0; background: none; color: var(--ink-text-dim); font-size: var(--text-13); font-weight: 500; text-align: left; }
  .textbtn:hover { color: var(--ink-text); }
  .forgot { margin-top: 20px; display: grid; gap: 12px; }
  .reset-note { margin: 20px 0 0; color: var(--ink-text-dim); font-size: var(--text-13); }
  button.quiet { background: var(--ink-200); color: var(--ink-text); font-weight: 500; }
  button.quiet:hover { background: var(--ink-300); }
  .foot { display: inline-block; margin-top: 24px; color: var(--ink-text-dim); font-size: var(--text-13); }
  button:focus-visible, a:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
</style>
