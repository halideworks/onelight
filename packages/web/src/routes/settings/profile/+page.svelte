<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { apiDelete, apiPatch, apiPost, messageFrom } from '$lib/api.js';
  import { auth } from '$lib/auth.svelte.js';
  import Avatar from '$lib/Avatar.svelte';

  /* The identity page: everything about who you are lives here. Name and
     picture, the address and password that sign you in, the second factor,
     and the way out. One room, no hunting. */

  let error = $state('');
  let saved = $state('');

  const note = (text: string): void => {
    saved = text;
    setTimeout(() => {
      if (saved === text) saved = '';
    }, 2200);
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

  let uploading = $state(false);

  /* Whatever the camera made, the avatar that leaves the browser is a 512 px
     square JPEG: cover-cropped to the short side, orientation baked in, and
     always comfortably under the server's byte cap. Nobody should have to
     resize a photo by hand to get a face on a comment. */
  const AVATAR_SIDE = 512;
  const normalizeAvatar = async (file: File): Promise<Blob> => {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const side = Math.min(bitmap.width, bitmap.height);
      const canvas = document.createElement('canvas');
      canvas.width = AVATAR_SIDE;
      canvas.height = AVATAR_SIDE;
      const ctx = canvas.getContext('2d');
      if (!ctx) return file;
      ctx.fillStyle = '#1a2330';
      ctx.fillRect(0, 0, AVATAR_SIDE, AVATAR_SIDE);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(
        bitmap,
        (bitmap.width - side) / 2,
        (bitmap.height - side) / 2,
        side,
        side,
        0,
        0,
        AVATAR_SIDE,
        AVATAR_SIDE
      );
      bitmap.close();
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
      return blob ?? file;
    } catch {
      /* Unreadable as an image here; let the server say what it thinks. */
      return file;
    }
  };

  const upload = async (event: Event): Promise<void> => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    uploading = true;
    error = '';
    try {
      const picture = await normalizeAvatar(file);
      const response = await fetch('/api/v1/users/me/avatar', {
        method: 'PUT',
        headers: { 'Content-Type': picture.type || file.type },
        body: picture
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

  const removePicture = async (): Promise<void> => {
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

  /* ---- the sign-in address ---- */

  let emailOpen = $state(false);
  let emailValue = $state('');
  let emailPassword = $state('');
  let emailBusy = $state(false);
  let emailError = $state('');

  const changeEmail = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    if (emailBusy) return;
    emailBusy = true;
    emailError = '';
    try {
      await apiPatch(
        '/api/v1/users/me',
        { email: { value: emailValue.trim(), password: emailPassword } },
        /* A wrong password answers 401; that is feedback for this form, not
           a reason to bounce to the sign-in page. */
        { redirectOn401: false }
      );
      emailOpen = false;
      emailValue = '';
      emailPassword = '';
      await auth.hydrate();
      note('Email changed');
    } catch (caught) {
      emailError = messageFrom(caught, 'The address could not be changed.');
    } finally {
      emailBusy = false;
    }
  };

  /* ---- the password ---- */

  let passwordCurrent = $state('');
  let passwordNew = $state('');
  let passwordConfirm = $state('');
  let passwordBusy = $state(false);
  let passwordError = $state('');

  const changePassword = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    if (passwordBusy) return;
    if (passwordNew !== passwordConfirm) {
      passwordError = 'The two copies of the new password do not match.';
      return;
    }
    passwordBusy = true;
    passwordError = '';
    try {
      await apiPatch(
        '/api/v1/users/me',
        { password: { current: passwordCurrent, new: passwordNew } },
        { redirectOn401: false }
      );
      passwordCurrent = '';
      passwordNew = '';
      passwordConfirm = '';
      note('Password changed; other sessions signed out');
    } catch (caught) {
      passwordError = messageFrom(caught, 'The password could not be changed.');
    } finally {
      passwordBusy = false;
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

  /* ---- the way out ---- */

  let deactivateOpen = $state(false);
  let deactivatePassword = $state('');
  let deactivateCode = $state('');
  let deactivateBusy = $state(false);
  let deactivateError = $state('');

  const deactivate = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    if (deactivateBusy) return;
    deactivateBusy = true;
    deactivateError = '';
    try {
      await apiDelete('/api/v1/users/me', {
        redirectOn401: false,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          password: deactivatePassword,
          ...(deactivateCode.trim() ? { code: deactivateCode.trim() } : {})
        })
      });
      await goto('/login');
    } catch (caught) {
      deactivateError = messageFrom(caught, 'The account could not be deactivated.');
      deactivateBusy = false;
    }
  };
</script>

<svelte:head><title>Profile | Onelight</title></svelte:head>

<main class="page">
  <div class="headrow">
    <h1>Profile</h1>
    {#if saved}<span class="saved" aria-live="polite">{saved}</span>{/if}
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}

  {#if auth.user}
    <section class="card identity" aria-label="Identity">
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

        {#if emailOpen}
          <form class="stack" onsubmit={changeEmail}>
            <label>New address
              <input type="email" bind:value={emailValue} autocomplete="email" required />
            </label>
            <label>Current password
              <input type="password" bind:value={emailPassword} autocomplete="current-password" required />
            </label>
            {#if emailError}<p class="error" role="alert">{emailError}</p>{/if}
            <div class="row">
              <button type="submit" class="primary" disabled={emailBusy}>{emailBusy ? 'Saving' : 'Change address'}</button>
              <button type="button" class="quiet" onclick={() => { emailOpen = false; emailError = ''; }}>Cancel</button>
            </div>
          </form>
        {:else}
          <p class="email">
            {auth.user.email}
            <button type="button" class="textbtn" onclick={() => { emailOpen = true; emailValue = ''; emailPassword = ''; }}>Change</button>
          </p>
        {/if}
        <p class="hint">Your name signs every note you leave. The address is what signs you in, so changing it takes the password.</p>
      </div>

      <!-- The picture holds the card's right edge. -->
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
            <button type="button" class="quiet" onclick={() => void removePicture()}>Remove picture</button>
          {/if}
        </div>
        <p class="hint facehint">Any picture works; it becomes a 512 px square here before upload. Without one, your initial sits on a wash that is yours alone.</p>
      </div>
    </section>

    <section class="card" aria-label="Password">
      <h2>Password</h2>
      <form class="stack narrow" onsubmit={changePassword}>
        <label>Current password
          <input type="password" bind:value={passwordCurrent} autocomplete="current-password" required />
        </label>
        <label>New password
          <input type="password" bind:value={passwordNew} autocomplete="new-password" required />
        </label>
        <label>New password, again
          <input type="password" bind:value={passwordConfirm} autocomplete="new-password" required />
        </label>
        {#if passwordError}<p class="error" role="alert">{passwordError}</p>{/if}
        <div class="row">
          <button type="submit" class="primary" disabled={passwordBusy}>{passwordBusy ? 'Saving' : 'Change password'}</button>
        </div>
        <p class="hint">Changing it signs out every other session; this one stays.</p>
      </form>
    </section>

    <section class="card" aria-label="Two-factor sign-in">
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
          <button type="submit" class="primary" disabled={totpBusy}>{totpBusy ? 'Checking' : 'Turn on'}</button>
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
        <button type="button" class="primary" onclick={() => void beginTotp()} disabled={totpBusy}>
          {totpBusy ? 'Starting' : 'Turn on two-factor'}
        </button>
      {/if}
    </section>

    <section class="card danger" aria-label="Deactivate account">
      <h2>Deactivate account</h2>
      {#if deactivateOpen}
        <p class="hint">
          Signing in stops everywhere and your API tokens die. Notes you left keep your name,
          and an admin can re-enable the account later. The last active admin cannot leave.
        </p>
        <form class="stack narrow" onsubmit={deactivate}>
          <label>Password
            <input type="password" bind:value={deactivatePassword} autocomplete="current-password" required />
          </label>
          {#if auth.user.totp_enabled}
            <label>Two-factor code
              <input bind:value={deactivateCode} inputmode="numeric" autocomplete="one-time-code" maxlength="12" required />
            </label>
          {/if}
          {#if deactivateError}<p class="error" role="alert">{deactivateError}</p>{/if}
          <div class="row">
            <button type="submit" class="dangerbtn" disabled={deactivateBusy}>{deactivateBusy ? 'Deactivating' : 'Deactivate my account'}</button>
            <button type="button" class="quiet" onclick={() => { deactivateOpen = false; deactivateError = ''; }}>Never mind</button>
          </div>
        </form>
      {:else}
        <p class="hint">Leave the workspace: sign-in stops, tokens die, your notes keep your name.</p>
        <button type="button" class="quiet" onclick={() => { deactivateOpen = true; deactivatePassword = ''; deactivateCode = ''; }}>Deactivate</button>
      {/if}
    </section>
  {/if}
</main>

<style>
  .page { padding: 44px 0 72px; color: var(--ink-text); font-size: var(--text-13); }
  .headrow { display: flex; align-items: baseline; gap: 16px; }
  h1 { margin: 0 0 20px; font-family: var(--font-display); font-size: clamp(26px, 3vw, 36px); font-weight: 700; letter-spacing: -0.02em; }
  .saved { color: var(--ok); }

  .card { max-width: 720px; margin: 0 0 16px; padding: var(--pad-3); border-radius: var(--radius-lg); background: var(--ink-100); }
  h2 { margin: 0 0 12px; font-size: var(--text-16); font-weight: 600; }

  .identity { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 28px; align-items: start; }
  @media (max-width: 640px) { .identity { grid-template-columns: 1fr; } }

  .facecol { display: grid; gap: 12px; justify-items: end; text-align: right; }
  .faceactions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
  .facehint { max-width: 26ch; }
  .uploadlabel { position: relative; display: inline-flex; align-items: center; border-radius: var(--radius); background: var(--accent); color: #0b1214; padding: 8px 14px; font-size: var(--text-13); font-weight: 600; cursor: pointer; }
  .uploadlabel:hover { background: var(--accent-bright); }
  .uploadlabel.disabled { opacity: 0.5; cursor: default; }
  .uploadlabel input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
  .uploadlabel:focus-within { outline: 1px solid var(--accent-bright); outline-offset: 2px; }

  .idcol { display: grid; gap: 6px; justify-items: start; }
  .nametext { border: 0; background: none; color: var(--ink-text); font-family: var(--font-display); font-size: clamp(22px, 3vw, 30px); font-weight: 700; letter-spacing: -0.02em; padding: 2px 8px; margin: -2px -8px; border-radius: var(--radius); cursor: text; text-align: left; }
  .nametext:hover { background: var(--ink-200); }
  .nameedit { width: 100%; max-width: 420px; border: 0; border-radius: var(--radius); background: var(--ink-300); color: var(--ink-text); padding: 2px 8px; margin: -2px -8px; font-family: var(--font-display); font-size: clamp(22px, 3vw, 30px); font-weight: 700; letter-spacing: -0.02em; }
  .email { display: flex; align-items: baseline; gap: 10px; margin: 0; color: var(--ink-text-dim); }
  .hint { margin: 6px 0 0; color: var(--ink-text-dim); max-width: 46ch; }
  .hint a { color: var(--ink-text); }

  .stack { display: grid; gap: 12px; margin-top: 6px; }
  .stack.narrow { max-width: 340px; }
  .stack label { display: grid; gap: 6px; color: var(--ink-text-dim); font-weight: 500; }
  .stack input { border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 9px 11px; font-size: var(--text-13); }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }

  .primary { border: 0; border-radius: var(--radius); background: var(--accent); color: #0b1214; padding: 8px 14px; font-size: var(--text-13); font-weight: 600; }
  .primary:hover { background: var(--accent-bright); }
  .primary:disabled { opacity: 0.5; }
  button.quiet { border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 8px 14px; font-size: var(--text-13); font-weight: 500; }
  button.quiet:hover { background: var(--ink-300); }
  .textbtn { border: 0; background: none; padding: 0; color: var(--ink-text); font-size: var(--text-13); font-weight: 500; cursor: pointer; }
  .textbtn:hover { color: var(--accent-bright); }

  .tc { font-variant-numeric: tabular-nums; }
  .secret { margin: 0; padding: 8px 12px; border-radius: var(--radius); background: var(--ink-200); font-size: var(--text-14); letter-spacing: 0.12em; overflow-wrap: anywhere; }
  .totpform { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 10px; }
  .totpform input { width: 130px; border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 8px 11px; font-size: var(--text-14); letter-spacing: 0.1em; }
  .codes { list-style: none; display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 6px; margin: 12px 0; padding: 0; max-width: 540px; }
  .codes li { background: var(--ink-200); border-radius: var(--radius); padding: 6px 10px; letter-spacing: 0.1em; }

  .danger { border: 1px solid rgba(165, 96, 90, 0.35); }
  .dangerbtn { border: 0; border-radius: var(--radius); background: var(--warn); color: #14100a; padding: 8px 14px; font-size: var(--text-13); font-weight: 600; }
  .dangerbtn:hover { filter: brightness(1.1); }
  .dangerbtn:disabled { opacity: 0.5; }

  .error { margin: 0 0 12px; color: var(--warn); }
  .stack .error { margin: 0; }
  a:focus-visible, button:focus-visible, input:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: 2px; }
</style>
