<script lang="ts">
  import { onMount } from 'svelte';
  import { apiDelete, apiPatch, apiPost, messageFrom } from '$lib/api.js';
  import { auth } from '$lib/auth.svelte.js';
  import Avatar from '$lib/Avatar.svelte';

  /* Who you are, to everyone else: your name, and your picture. The picture
     is optional -- without one, the generated avatar carries your initial on
     a wash that is deterministically yours. */

  let error = $state('');
  let saved = $state('');
  let uploading = $state(false);

  const note = (text: string): void => {
    saved = text;
    setTimeout(() => {
      if (saved === text) saved = '';
    }, 1600);
  };

  onMount(() => {
    if (!auth.ready) void auth.hydrate();
  });

  /* ---- name, edited in place ---- */

  let renaming = $state(false);
  let name = $state('');

  const focusInput = (element: HTMLInputElement): void => {
    element.focus();
    element.select();
  };

  const commitRename = async (): Promise<void> => {
    const next = name.trim();
    renaming = false;
    if (!next || next === auth.user?.name) return;
    try {
      await apiPatch('/api/v1/users/me', { name: next });
      await auth.hydrate();
      error = '';
      note('Name saved');
    } catch (caught) {
      error = messageFrom(caught, 'The name could not be saved.');
    }
  };

  /* ---- the picture ---- */

  const upload = async (event: Event): Promise<void> => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    uploading = true;
    error = '';
    try {
      const response = await fetch('/api/v1/users/me/avatar', {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? 'The picture could not be uploaded.');
      }
      await auth.hydrate();
      note('Picture saved');
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'The picture could not be uploaded.';
    } finally {
      uploading = false;
    }
  };

  const remove = async (): Promise<void> => {
    error = '';
    try {
      const response = await fetch('/api/v1/users/me/avatar', { method: 'DELETE' });
      if (!response.ok) throw new Error('The picture could not be removed.');
      await auth.hydrate();
      note('Picture removed');
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'The picture could not be removed.';
    }
  };

  /* ---- two-factor ---- */

  let enrolment = $state<{ secret: string; otpauth_url: string } | null>(null);
  let totpInput = $state('');
  let backupCodes = $state<string[] | null>(null);
  let totpBusy = $state(false);
  let totpError = $state('');
  let disabling = $state(false);

  const beginTotp = async (): Promise<void> => {
    totpBusy = true;
    totpError = '';
    backupCodes = null;
    try {
      enrolment = await apiPost<{ secret: string; otpauth_url: string }>('/api/v1/users/me/totp', {});
      totpInput = '';
    } catch (caught) {
      totpError = messageFrom(caught, 'Enrolment could not start.');
    } finally {
      totpBusy = false;
    }
  };

  const verifyTotpCode = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    if (totpBusy) return;
    totpBusy = true;
    totpError = '';
    try {
      const result = await apiPost<{ backup_codes: string[] }>('/api/v1/users/me/totp/verify', {
        code: totpInput.trim()
      });
      backupCodes = result.backup_codes;
      enrolment = null;
      totpInput = '';
      await auth.hydrate();
      note('Two-factor is on');
    } catch (caught) {
      totpError = messageFrom(caught, 'That code did not match.');
    } finally {
      totpBusy = false;
    }
  };

  const disableTotp = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    if (totpBusy) return;
    totpBusy = true;
    totpError = '';
    try {
      await apiDelete('/api/v1/users/me/totp', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: totpInput.trim() })
      });
      disabling = false;
      totpInput = '';
      backupCodes = null;
      await auth.hydrate();
      note('Two-factor is off');
    } catch (caught) {
      totpError = messageFrom(caught, 'Turning two-factor off needs a valid code.');
    } finally {
      totpBusy = false;
    }
  };
</script>

<svelte:head><title>Profile | Onelight</title></svelte:head>

<main class="page">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/settings">Settings</a></nav>
  <div class="headrow">
    <h1>Profile</h1>
    {#if saved}<span class="saved" aria-live="polite">{saved}</span>{/if}
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}

  {#if auth.user}
    <div class="card">
      <div class="facecol">
        <Avatar name={auth.user.name} id={auth.user.id} url={auth.user.avatar_url ?? null} size={112} />
        <div class="faceactions">
          <label class="uploadlabel" class:disabled={uploading}>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={uploading}
              onchange={(event) => void upload(event)}
            />
            <span>{uploading ? 'Uploading' : auth.user.avatar_url ? 'Change picture' : 'Upload a picture'}</span>
          </label>
          {#if auth.user.avatar_url}
            <button type="button" class="quiet" onclick={() => void remove()}>Use the generated one</button>
          {/if}
        </div>
        <p class="hint">PNG, JPEG, or WebP, up to 512 KB. Without one, your initial sits on a wash that is yours alone.</p>
      </div>
      <div class="idcol">
        {#if renaming}
          <input
            class="nameedit"
            bind:value={name}
            use:focusInput
            aria-label="Your name"
            maxlength="200"
            onkeydown={(event) => {
              if (event.key === 'Enter') void commitRename();
              else if (event.key === 'Escape') renaming = false;
            }}
            onblur={() => void commitRename()}
          />
        {:else}
          <button
            type="button"
            class="nametext"
            title="Click to rename"
            onclick={() => {
              name = auth.user?.name ?? '';
              renaming = true;
            }}
          >{auth.user.name}</button>
        {/if}
        <p class="email">{auth.user.email}</p>
        <p class="hint">Your name signs every note you leave. Sessions and passwords live under <a href="/settings/sessions">Sessions</a>.</p>
      </div>
    </div>

    <div class="card totp">
      <div class="idcol">
        <h2>Two-factor sign-in</h2>
        {#if totpError}<p class="error" role="alert">{totpError}</p>{/if}
        {#if backupCodes}
          <p class="hint">
            Two-factor is on. These backup codes are shown once; keep them somewhere safe.
            Each one signs you in exactly one time if the authenticator is lost.
          </p>
          <ul class="codes">
            {#each backupCodes as code (code)}<li class="tc">{code}</li>{/each}
          </ul>
          <button type="button" class="quiet" onclick={() => { backupCodes = null; }}>Done, I saved them</button>
        {:else if enrolment}
          <p class="hint">
            Add the key to your authenticator app, then prove it with a code.
            <a href={enrolment.otpauth_url}>Open in an authenticator</a> on this device, or enter the key by hand.
          </p>
          <p class="secret tc">{enrolment.secret}</p>
          <form class="totpform" onsubmit={verifyTotpCode}>
            <input
              bind:value={totpInput}
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="12"
              aria-label="Six digit code"
              placeholder="123456"
              required
            />
            <button type="submit" class="uploadbtn" disabled={totpBusy}>{totpBusy ? 'Checking' : 'Turn on'}</button>
            <button type="button" class="quiet" onclick={() => { enrolment = null; totpError = ''; }}>Cancel</button>
          </form>
        {:else if auth.user.totp_enabled}
          {#if disabling}
            <p class="hint">Turning two-factor off needs a code from the authenticator, or a backup code.</p>
            <form class="totpform" onsubmit={disableTotp}>
              <input
                bind:value={totpInput}
                inputmode="numeric"
                autocomplete="one-time-code"
                maxlength="12"
                aria-label="Code"
                required
              />
              <button type="submit" class="quiet" disabled={totpBusy}>{totpBusy ? 'Checking' : 'Turn off'}</button>
              <button type="button" class="quiet" onclick={() => { disabling = false; totpError = ''; }}>Keep it on</button>
            </form>
          {:else}
            <p class="hint">On. Signing in asks for a code from your authenticator after the password.</p>
            <button type="button" class="quiet" onclick={() => { disabling = true; totpInput = ''; }}>Turn off</button>
          {/if}
        {:else}
          <p class="hint">Off. With it on, signing in takes your password and a six digit code from an authenticator app.</p>
          <button type="button" class="uploadbtn" onclick={() => void beginTotp()} disabled={totpBusy}>
            {totpBusy ? 'Starting' : 'Turn on two-factor'}
          </button>
        {/if}
      </div>
    </div>
  {/if}
</main>

<style>
  .page { min-height: calc(100vh - var(--topbar-h, 0px)); padding: 48px clamp(24px, 5vw, 96px); background: var(--ink-000); color: var(--ink-text); font-size: var(--text-13); }
  .crumbs { margin: 0 0 8px; }
  .crumbs a { color: var(--ink-text-dim); font-size: var(--text-13); text-decoration: none; }
  .crumbs a:hover { color: var(--ink-text); }
  .headrow { display: flex; align-items: baseline; gap: 16px; }
  h1 { margin: 0 0 20px; font-family: var(--font-display); font-size: clamp(28px, 4vw, 44px); font-weight: 700; letter-spacing: -0.02em; }
  .saved { color: var(--ok); }

  .card { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 28px; align-items: start; max-width: 720px; padding: var(--pad-3); border-radius: var(--radius-lg); background: var(--ink-100); }
  @media (max-width: 640px) { .card { grid-template-columns: 1fr; } }
  .facecol { display: grid; gap: 12px; justify-items: start; }
  .faceactions { display: flex; gap: 8px; flex-wrap: wrap; }
  .uploadlabel { display: inline-flex; align-items: center; border-radius: var(--radius); background: var(--accent); color: #0b1214; padding: 8px 14px; font-size: var(--text-13); font-weight: 600; cursor: pointer; }
  .uploadlabel:hover { background: var(--accent-bright); }
  .uploadlabel.disabled { opacity: 0.5; cursor: default; }
  .uploadlabel input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
  .uploadlabel:focus-within { outline: 1px solid var(--accent-bright); outline-offset: 2px; }

  .idcol { display: grid; gap: 6px; justify-items: start; }
  .nametext { border: 0; background: none; color: var(--ink-text); font-family: var(--font-display); font-size: clamp(22px, 3vw, 30px); font-weight: 700; letter-spacing: -0.02em; padding: 2px 8px; margin: -2px -8px; border-radius: var(--radius); cursor: text; text-align: left; }
  .nametext:hover { background: var(--ink-200); }
  .nameedit { width: 100%; max-width: 420px; border: 0; border-radius: var(--radius); background: var(--ink-300); color: var(--ink-text); padding: 2px 8px; margin: -2px -8px; font-family: var(--font-display); font-size: clamp(22px, 3vw, 30px); font-weight: 700; letter-spacing: -0.02em; }
  .email { margin: 0; color: var(--ink-text-dim); }
  .hint { margin: 6px 0 0; color: var(--ink-text-dim); max-width: 40ch; }
  .hint a { color: var(--ink-text); }

  button.quiet { border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 8px 14px; font-size: var(--text-13); font-weight: 500; }
  button.quiet:hover { background: var(--ink-300); }

  .card.totp { margin-top: 16px; grid-template-columns: 1fr; }
  .card.totp h2 { margin: 0; font-size: var(--text-16); font-weight: 600; }
  .tc { font-variant-numeric: tabular-nums; }
  .secret { margin: 0; padding: 8px 12px; border-radius: var(--radius); background: var(--ink-200); font-size: var(--text-14); letter-spacing: 0.12em; overflow-wrap: anywhere; }
  .totpform { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .totpform input { width: 130px; border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 8px 11px; font-size: var(--text-14); letter-spacing: 0.1em; }
  .uploadbtn { border: 0; border-radius: var(--radius); background: var(--accent); color: #0b1214; padding: 8px 14px; font-size: var(--text-13); font-weight: 600; }
  .uploadbtn:hover { background: var(--accent-bright); }
  .uploadbtn:disabled { opacity: 0.5; }
  .codes { list-style: none; display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 6px; margin: 0; padding: 0; max-width: 540px; }
  .codes li { background: var(--ink-200); border-radius: var(--radius); padding: 6px 10px; letter-spacing: 0.1em; }
  .error { margin: 0 0 12px; color: var(--warn); }
  a:focus-visible, button:focus-visible, input:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: 2px; }
</style>
