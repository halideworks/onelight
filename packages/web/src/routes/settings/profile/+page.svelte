<script lang="ts">
  import { onMount } from 'svelte';
  import { apiPatch, messageFrom } from '$lib/api.js';
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
  .error { margin: 0 0 12px; color: var(--warn); }
  a:focus-visible, button:focus-visible, input:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: 2px; }
</style>
