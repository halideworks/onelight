<script lang="ts">
  import { onMount } from 'svelte';
  import { PALETTES } from '@onelight/core';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { api, apiDelete, apiPatch, apiPost, apiPut, messageFrom } from '$lib/api.js';
  import { askConfirm } from '$lib/confirm.svelte.js';
  import { createMediaCache } from '$lib/asset-media.svelte.js';
  import { uploadFile } from '$lib/upload.js';
  import ProjectCover from '$lib/ProjectCover.svelte';
  import { pageWashFor, washFor } from '$lib/washes.js';
  import { auth } from '$lib/auth.svelte.js';

  type Project = {
    id: string;
    name: string;
    palette: string;
    status: string;
    restricted: boolean;
    cover_asset_id?: string | null;
    cover_kind?: 'upload' | 'asset' | 'generated';
    cover_url?: string | null;
    my_role?: string;
  };
  type Asset = { id: string; name: string; kind: string; current_version_id?: string | null };
  type CoverUpload = { id: string; filename: string; url: string; current: boolean };
  type Member = { user: { id: string; name: string; email: string }; role: string };
  type User = { id: string; name: string; email: string };

  const ROLES = ['manager', 'editor', 'commenter', 'viewer'] as const;
  /* What each role can actually do, in the words a person would use. A role
     picker with no explanation is a quiz. */
  const ROLE_NOTES: Record<string, string> = {
    manager: 'Everything, including settings, members and approval.',
    editor: 'Upload versions, organise folders, comment.',
    commenter: 'Watch and leave notes.',
    viewer: 'Watch only.'
  };

  const projectId = $derived(page.params.id);

  let project = $state<Project | null>(null);
  let members = $state<Member[]>([]);
  let workspaceUsers = $state<User[]>([]);
  let addUserId = $state('');
  let addRole = $state<string>('commenter');
  let error = $state('');
  let saved = $state('');
  let loaded = $state(false);

  let name = $state('');
  let renaming = $state(false);

  const focusInput = (element: HTMLInputElement): void => {
    element.focus();
    element.select();
  };

  /* Only pictures make sense as a cover, and only ones that have a frame to
     show: audio and PDFs are excluded, not filtered out of a list they were
     never in. */
  let coverAssets = $state<Asset[]>([]);
  /* Pictures uploaded here, kept as options once something else is chosen. */
  let coverUploads = $state<CoverUpload[]>([]);
  let coverUploading = $state(false);
  let coverProgress = $state(0);
  let coverPreview = $state<string | null>(null);
  let coverNote = $state('');
  const media = createMediaCache();

  const isManager = $derived(project?.my_role === 'manager' || auth.user?.role === 'admin');

  onMount(() => {
    void (async () => {
      try {
        const [loadedProject, loadedMembers, loadedUsers, loadedAssets, loadedCovers] =
          await Promise.all([
          api<Project>(`/api/v1/projects/${projectId}`),
          api<{ items: Member[] }>(`/api/v1/projects/${projectId}/members`),
          /* Everyone in the workspace, so someone can actually be added --
             including yourself, if you removed your own grant. */
          api<{ items: User[] }>('/api/v1/users').catch(() => ({ items: [] as User[] })),
          api<{ items: Asset[] }>(`/api/v1/projects/${projectId}/assets`).catch(() => ({
            items: [] as Asset[]
          })),
          api<{ items: CoverUpload[] }>(`/api/v1/projects/${projectId}/covers`).catch(() => ({
            items: [] as CoverUpload[]
          }))
        ]);
        project = loadedProject;
        name = loadedProject.name;
        members = loadedMembers.items;
        workspaceUsers = loadedUsers.items;
        coverAssets = loadedAssets.items.filter(
          (asset) => asset.kind === 'video' || asset.kind === 'image'
        );
        coverUploads = loadedCovers.items;
        loaded = true;
      } catch (caught) {
        error = messageFrom(caught, 'This project could not be loaded.');
      }
    })();
  });

  /* Every setting saves on change rather than behind a Save button: there is no
     draft state here worth defending, and a colour you have to commit to is a
     colour you cannot try. */
  const patch = async (body: Record<string, unknown>, note: string): Promise<void> => {
    if (!project) return;
    try {
      project = await apiPatch<Project>(`/api/v1/projects/${projectId}`, body);
      error = '';
      saved = note;
      setTimeout(() => {
        if (saved === note) saved = '';
      }, 1600);
    } catch (caught) {
      error = messageFrom(caught, 'That change could not be saved.');
    }
  };

  const commitRename = async (): Promise<void> => {
    const next = name.trim();
    renaming = false;
    if (!next || next === project?.name) {
      name = project?.name ?? '';
      return;
    }
    await patch({ name: next }, 'Name saved');
  };

  const setRole = async (member: Member, role: string): Promise<void> => {
    try {
      await apiPut(`/api/v1/projects/${projectId}/members/${member.user.id}`, { role });
      members = members.map((entry) =>
        entry.user.id === member.user.id ? { ...entry, role } : entry
      );
      error = '';
      saved = `${member.user.name} is now ${role}`;
    } catch (caught) {
      error = messageFrom(caught, 'That role could not be changed.');
    }
  };

  /* Everyone in the workspace who has no role here yet. */
  const addable = $derived(
    workspaceUsers
      .filter((user) => !members.some((member) => member.user.id === user.id))
      .sort((a, b) => a.name.localeCompare(b.name))
  );

  const addMember = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const user = addable.find((candidate) => candidate.id === addUserId);
    if (!user) return;
    try {
      await apiPut(`/api/v1/projects/${projectId}/members/${user.id}`, { role: addRole });
      members = [...members, { user, role: addRole }];
      addUserId = '';
      error = '';
      saved = `${user.name} added as ${addRole}`;
    } catch (caught) {
      error = messageFrom(caught, 'That person could not be added.');
    }
  };

  const removeMember = async (member: Member): Promise<void> => {
    /* Removing yourself is allowed -- a manager may genuinely be leaving -- but
       it is a door that locks behind you on a restricted project, so it says so
       rather than just doing it. */
    const isSelf = member.user.id === auth.user?.id;
    const locksOut = isSelf && project?.restricted === true && auth.user?.role !== 'admin';
    const confirmed = await askConfirm({
      title: isSelf ? 'Remove your own access?' : `Remove ${member.user.name}?`,
      body: isSelf
        ? locksOut
          ? 'This project is restricted, so you will lose access to it immediately and will not be able to add yourself back. A workspace admin, or another manager, would have to.'
          : 'You will lose your role here. The project is not restricted, so you can still open it as a workspace member.'
        : `${member.user.name} loses their role on this project. Their notes stay.`,
      confirmLabel: isSelf ? 'Remove my access' : 'Remove',
      danger: true
    });
    if (!confirmed) return;
    try {
      await apiDelete(`/api/v1/projects/${projectId}/members/${member.user.id}`);
      members = members.filter((entry) => entry.user.id !== member.user.id);
      error = '';
      saved = `${member.user.name} removed`;
      if (locksOut) await goto('/');
    } catch (caught) {
      error = messageFrom(caught, 'That member could not be removed.');
    }
  };

  /* A cover set from a just-uploaded file has no poster yet -- the transcode
     that makes one runs after the upload returns. Rather than show the
     generated cover and look like the choice was ignored, re-read the project
     until the poster lands, and say so while waiting. */
  const awaitPoster = async (): Promise<void> => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      try {
        const fresh = await api<Project>(`/api/v1/projects/${projectId}`);
        project = fresh;
        if (fresh.cover_url) {
          coverNote = '';
          return;
        }
      } catch {
        return;
      }
    }
    coverNote = 'Still processing. The cover appears when it finishes.';
  };

  const useUploadedCover = async (upload: CoverUpload): Promise<void> => {
    coverNote = '';
    await patch({ cover_upload_id: upload.id }, 'Cover saved');
  };

  const forgetUploadedCover = async (upload: CoverUpload): Promise<void> => {
    const confirmed = await askConfirm({
      title: `Remove ${upload.filename}?`,
      body: upload.current
        ? 'It is the current cover, so the project goes back to its generated one.'
        : 'It stops being offered here. Nothing else uses it.',
      confirmLabel: 'Remove',
      danger: true
    });
    if (!confirmed) return;
    try {
      await apiDelete(`/api/v1/projects/${projectId}/covers/${upload.id}`);
      coverUploads = coverUploads.filter((entry) => entry.id !== upload.id);
      if (upload.current) project = await api<Project>(`/api/v1/projects/${projectId}`);
      error = '';
    } catch (caught) {
      error = messageFrom(caught, 'That picture could not be removed.');
    }
  };

  const setCover = async (assetId: string | null): Promise<void> => {
    coverNote = '';
    await patch({ cover_asset_id: assetId }, assetId ? 'Cover saved' : 'Cover reset');
    /* Only a just-uploaded asset can lack a poster; anything already in the
       picker below has one, because that is why it is showing a frame. */
    if (assetId && !project?.cover_url) {
      coverNote = 'That clip is still processing. Its cover appears when it finishes.';
      void awaitPoster();
    }
  };

  const uploadCover = async (event: Event): Promise<void> => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !projectId) return;
    coverUploading = true;
    coverProgress = 0;
    coverNote = '';
    error = '';
    /* Show the file being picked before a byte has moved: the picture is on
       this machine already, so waiting for the server to hand one back is a
       delay with no reason to exist. */
    if (coverPreview) URL.revokeObjectURL(coverPreview);
    coverPreview = URL.createObjectURL(file);
    try {
      const uploadId = await uploadFile({
        projectId,
        file,
        relativePath: file.name,
        onProgress: ({ bytes }) => {
          coverProgress = file.size > 0 ? Math.min(1, bytes / file.size) : 0;
        }
      });
      /* A cover is not an asset: this endpoint stores the picture and nothing
         else, so it is done when the upload is, with no transcode to wait on. */
      project = await apiPost<Project>(`/api/v1/projects/${projectId}/cover`, {
        upload_id: uploadId
      });
      coverUploads = (
        await api<{ items: CoverUpload[] }>(`/api/v1/projects/${projectId}/covers`)
      ).items;
      saved = 'Cover saved';
      setTimeout(() => {
        if (saved === 'Cover saved') saved = '';
      }, 1600);
    } catch (caught) {
      error = messageFrom(caught, 'That picture could not be uploaded.');
    } finally {
      coverUploading = false;
      if (coverPreview) {
        URL.revokeObjectURL(coverPreview);
        coverPreview = null;
      }
    }
  };

  const wash = $derived(pageWashFor(project?.palette));
</script>

<svelte:head><title>{project?.name ?? 'Project'} settings | Onelight</title></svelte:head>

<main class="room" style={`background-image: ${wash};`}>
  <header class="wash">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="/">Projects</a>
      <span aria-hidden="true">/</span>
      <a href={`/projects/${projectId}`}>{project?.name ?? 'Project'}</a>
    </nav>
    <div class="washrow">
      <h1>Settings</h1>
      <span class="grow"></span>
      {#if saved}<span class="saved" aria-live="polite">{saved}</span>{/if}
    </div>
  </header>

  {#if error}<p class="error" role="alert">{error}</p>{/if}

  {#if project}
    {#if !isManager}
      <p class="hint">Only a project manager can change these.</p>
    {/if}

    <div class="panels">
    <!-- What the project looks like, composed as one thing: its picture, its
         name, its colour. These were three panels -- one of them a single line
         of text floating in a box -- when together they are one subject: the
         identity every other page draws from. -->
    <section class="panel wide identity" aria-label="Identity">
      <div class="idgrid">
        <span class="coverpreview">
          {#if coverPreview}
            <img src={coverPreview} alt="" />
            <span class="coverbusy" aria-hidden="true">
              <span class="bar" style={`transform: scaleX(${coverProgress});`}></span>
            </span>
          {:else}
            <ProjectCover {project} />
          {/if}
        </span>
        <div class="idmain">
          {#if renaming}
            <input
              class="nameedit"
              bind:value={name}
              use:focusInput
              aria-label="Project name"
              maxlength="200"
              onkeydown={(event) => {
                if (event.key === 'Enter') void commitRename();
                else if (event.key === 'Escape') { name = project?.name ?? ''; renaming = false; }
              }}
              onblur={() => void commitRename()}
            />
          {:else}
            <button
              type="button"
              class="nametext"
              title={isManager ? 'Click to rename' : undefined}
              disabled={!isManager}
              onclick={() => { name = project?.name ?? ''; renaming = true; }}
            >{project.name}</button>
          {/if}
          <div class="swatches" role="group" aria-label="Project colour">
            {#each PALETTES as palette (palette)}
              <button
                type="button"
                class="swatch"
                class:active={project.palette === palette}
                disabled={!isManager}
                aria-pressed={project.palette === palette}
                aria-label={palette}
                title={palette}
                style={`background-image: ${washFor(palette)};`}
                onclick={() => void patch({ palette }, 'Colour saved')}
              ></button>
            {/each}
          </div>
          <p class="sub">The colour is the project's wash on every page, and its generated cover. The picture, when one is set, fronts the projects page instead.</p>
          <div class="coveractions">
            <label class="uploadlabel" class:disabled={!isManager || coverUploading}>
              <!-- Only what a browser will actually draw: a TIFF or an EXR would
                   upload happily and then never appear. -->
              <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={!isManager || coverUploading} onchange={(event) => void uploadCover(event)} />
              <span>{coverUploading ? `Uploading ${Math.round(coverProgress * 100)}%` : 'Upload a picture'}</span>
            </label>
            {#if project.cover_kind !== 'generated'}
              <button type="button" class="quiet" disabled={!isManager} onclick={() => void setCover(null)}>Use the generated cover</button>
            {/if}
            {#if coverNote}<p class="covernote" aria-live="polite">{coverNote}</p>{/if}
          </div>
        </div>
      </div>
      {#if coverUploads.length > 0}
        <p class="sub pick">Pictures you have uploaded.</p>
        <div class="coverpick">
          {#each coverUploads as upload (upload.id)}
            <span class="pickwrap">
              <button
                type="button"
                class="pickone"
                class:active={upload.current}
                disabled={!isManager}
                aria-pressed={upload.current}
                title={upload.filename}
                onclick={() => void useUploadedCover(upload)}
              >
                <img src={upload.url} alt="" loading="lazy" />
              </button>
              {#if isManager}
                <button
                  type="button"
                  class="pickdrop"
                  aria-label={`Remove ${upload.filename}`}
                  title="Remove"
                  onclick={() => void forgetUploadedCover(upload)}
                >×</button>
              {/if}
            </span>
          {/each}
        </div>
      {/if}
      {#if coverAssets.length > 0}
        <p class="sub pick">Or pick something already here.</p>
        <div class="coverpick">
          {#each coverAssets as asset (asset.id)}
            {@const entry = media.entries[asset.id]}
            <button
              type="button"
              class="pickone"
              class:active={project.cover_asset_id === asset.id}
              disabled={!isManager}
              aria-pressed={project.cover_asset_id === asset.id}
              title={asset.name}
              use:media.observe={asset}
              onclick={() => void setCover(asset.id)}
            >
              {#if entry?.media?.posterUrl}
                <img src={entry.media.posterUrl} alt="" loading="lazy" />
              {:else}
                <span class="pickfallback">{asset.name}</span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    </section>

    <section class="panel" aria-label="Access">
      <h2>Access</h2>
      <label class="check">
        <input
          type="checkbox"
          checked={project.restricted}
          disabled={!isManager}
          onchange={(event) => void patch({ restricted: event.currentTarget.checked }, 'Access saved')}
        />
        <span>
          <strong>Restricted</strong>
          <small>Only people granted a role below can open this project. Otherwise everyone in the workspace can.</small>
        </span>
      </label>
      <label class="check">
        <input
          type="checkbox"
          checked={project.status === 'archived'}
          disabled={!isManager}
          onchange={(event) => void patch({ status: event.currentTarget.checked ? 'archived' : 'active' }, 'Status saved')}
        />
        <span>
          <strong>Archived</strong>
          <small>Read-only: no uploads, no new notes. Nothing is deleted.</small>
        </span>
      </label>
    </section>

    <section class="panel" aria-label="People">
      <h2>People</h2>
      <p class="sub">Workspace members are added from <a href="/settings/members">workspace settings</a>; roles here are per project.</p>
      {#if members.length === 0}
        <p class="empty">No one has a role on this project yet.</p>
      {/if}
      {#if isManager}
        <form class="addform" onsubmit={addMember}>
          <select bind:value={addUserId} aria-label="Person to add">
            <option value="" disabled>Add someone…</option>
            {#each addable as user (user.id)}
              <option value={user.id}>{user.name} — {user.email}</option>
            {/each}
          </select>
          <select bind:value={addRole} aria-label="Role for the new member">
            {#each ROLES as role (role)}<option value={role}>{role}</option>{/each}
          </select>
          <button type="submit" disabled={!addUserId}>Add</button>
        </form>
        {#if addable.length === 0}
          <p class="empty">Everyone in the workspace already has a role here.</p>
        {/if}
      {/if}
      <ul class="members">
        {#each members as member (member.user.id)}
          <li>
            <span class="who">
              <strong>{member.user.name}</strong>
              <small>{member.user.email}</small>
            </span>
            <span class="rolecell">
              <select
                value={member.role}
                disabled={!isManager}
                aria-label={`Role for ${member.user.name}`}
                title={ROLE_NOTES[member.role]}
                onchange={(event) => void setRole(member, event.currentTarget.value)}
              >
                {#each ROLES as role (role)}<option value={role}>{role}</option>{/each}
              </select>
            </span>
            <!-- Quiet until meant: a filled red button on every row made the
                 list read as a demolition plan. -->
            <button type="button" class="quiet remove" disabled={!isManager} onclick={() => void removeMember(member)}>Remove</button>
          </li>
        {/each}
      </ul>
      <p class="rolelegend">
        {#each ROLES as role, index (role)}
          <span><strong>{role}</strong> {ROLE_NOTES[role].toLowerCase()}</span>{#if index < ROLES.length - 1}<span class="sep" aria-hidden="true"></span>{/if}
        {/each}
      </p>
    </section>
    </div>
  {:else if loaded}
    <p class="empty">This project could not be loaded.</p>
  {/if}
</main>

<style>
  .room { position: relative; min-height: calc(100vh - var(--topbar-h, 0px)); background-color: var(--ink-000); background-repeat: no-repeat; color: var(--ink-text); font-size: var(--text-13); padding-bottom: var(--pad-4); }
  .room::before { content: ''; position: fixed; inset: 0; pointer-events: none; background: linear-gradient(180deg, rgba(13, 17, 23, 0.05) 0%, rgba(13, 17, 23, 0.45) 26%, rgba(13, 17, 23, 0.88) 58%, rgba(13, 17, 23, 0.95) 100%); }
  .room > :global(*) { position: relative; }
  .wash { padding: var(--pad-3) var(--pad-4) var(--pad-4); }
  .crumbs { display: flex; gap: 8px; color: rgba(250, 248, 244, 0.72); }
  .crumbs a { color: inherit; font-size: var(--text-13); text-decoration: none; }
  .crumbs a:hover { color: rgba(250, 248, 244, 0.96); }
  .washrow { display: flex; gap: 16px; align-items: baseline; }
  .grow { flex: 1; }
  .saved { color: var(--ok); font-size: var(--text-13); }
  h1 { margin: var(--pad-3) 0 0; font-family: var(--font-display); font-size: clamp(2rem, 5vw, var(--text-56)); font-weight: 700; letter-spacing: -0.02em; color: rgba(250, 248, 244, 0.96); }

  /* The identity panel leads at full width; Access and People divide the row
     under it, weighted toward the list that grows. */
  .panels { display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 10px; align-items: start; margin: 0 var(--pad-4); max-width: 1600px; }
  /* Panels as surfaces rather than holes. At one flat fill and a 2px gap they
     merged into a single dark mass -- five settings reading as one slab, which
     is the "heavy" part. A light from above (one highlight along the top edge,
     a fill that falls away below it) gives each panel a top and a bottom, so
     the eye separates them without a single border. */
  .panel {
    padding: var(--pad-2);
    border-radius: var(--radius-lg);
    background: linear-gradient(180deg, color-mix(in oklab, var(--ink-100) 88%, var(--ink-200)) 0%, var(--ink-100) 46%);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.045),
      0 1px 2px rgba(0, 0, 0, 0.28);
  }
  .panel.wide { grid-column: 1 / -1; }
  /* Panel names in plain case: the anti-slop list bans uppercase-tracked
     microcopy, and a heading does not need to shout to be a heading. */
  h2 { margin: 0 0 4px; font-size: var(--text-13); font-weight: 600; color: var(--ink-text); }
  .sub { margin: 0 0 12px; color: var(--ink-text-dim); }
  .sub a { color: var(--ink-text); }
  input, select { border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 8px 10px; font: inherit; }

  /* ---- identity ---- */
  .identity { padding: var(--pad-3); }
  .idgrid { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: var(--pad-3); align-items: start; }
  @media (max-width: 900px) { .idgrid { grid-template-columns: 1fr; } }
  .idmain { display: grid; gap: 14px; justify-items: start; }
  /* The name at display size, edited where it is shown. */
  .nametext { border: 0; background: none; color: var(--ink-text); font-family: var(--font-display); font-size: clamp(24px, 3vw, 34px); font-weight: 700; letter-spacing: -0.02em; padding: 2px 8px; margin: -2px -8px; border-radius: var(--radius); cursor: text; text-align: left; }
  .nametext:hover:not(:disabled) { background: var(--ink-200); }
  .nametext:disabled { cursor: default; }
  .nameedit { width: 100%; max-width: 560px; border: 0; border-radius: var(--radius); background: var(--ink-300); color: var(--ink-text); padding: 2px 8px; margin: -2px -8px; font-family: var(--font-display); font-size: clamp(24px, 3vw, 34px); font-weight: 700; letter-spacing: -0.02em; }

  /* Ten swatches painted in the actual wash: the colour is the label. */
  .swatches { display: flex; flex-wrap: wrap; gap: 8px; }
  .swatch { width: 64px; height: 40px; padding: 0; border: 0; border-radius: var(--radius); background-size: 100% 100%; }
  .swatch.active { box-shadow: 0 0 0 2px var(--ink-100), 0 0 0 4px var(--accent-bright); }
  .swatch:disabled { opacity: 0.5; cursor: default; }
  .idmain .sub { margin: 0; }

  .check { display: flex; align-items: flex-start; gap: 10px; padding: 8px 0; }
  .check input { margin: 2px 0 0; accent-color: var(--accent); }
  .check span { display: grid; gap: 2px; }
  .check small { color: var(--ink-text-dim); }

  .members { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
  .members li { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 12px; padding: 8px; margin: 0 -8px; border-radius: var(--radius); }
  .addform { display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; }
  .addform select { min-width: 0; }
  .addform select:first-child { flex: 1; max-width: 420px; }
  .members li:hover { background: var(--ink-200); }
  .who { display: grid; gap: 2px; min-width: 0; }
  .who small { color: var(--ink-text-dim); }
  .rolecell { display: grid; justify-items: end; }
  /* Removing someone is a real action, not the row's theme: quiet until
     pointed at, and only then does it say what it costs. */
  button.remove { color: var(--ink-text-dim); }
  button.remove:hover:not(:disabled) { background: var(--warn); color: #12080a; }
  /* One legend under the list instead of a note per row saying the same
     four sentences over and over. */
  .rolelegend { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 12px 0 0; color: var(--ink-text-dim); font-size: var(--text-12); }
  .rolelegend strong { color: var(--ink-text); font-weight: 600; }
  .rolelegend .sep { width: 3px; height: 3px; border-radius: 50%; background: var(--ink-300); }

  button { border: 0; border-radius: var(--radius); background: var(--accent); color: #0b1214; padding: 8px 14px; font-size: var(--text-13); font-weight: 600; }
  button:hover { background: var(--accent-bright); }
  button.quiet { background: var(--ink-200); color: var(--ink-text); font-weight: 500; }
  button.quiet:hover { background: var(--ink-300); }
  button:disabled { opacity: 0.5; cursor: default; }
  .hint, .empty { margin: 0 var(--pad-4) 12px; color: var(--ink-text-dim); }
  .error { margin: 0 var(--pad-4) 12px; color: var(--warn); }
  button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: 2px; }

  /* Cover */
  .coverpreview { position: relative; width: 100%; aspect-ratio: 16 / 9; border-radius: var(--radius); overflow: hidden; display: grid; }
  .coverpreview > img { width: 100%; height: 100%; object-fit: cover; }
  /* Progress over the picture being uploaded, not a spinner beside it: the
     thing that is happening is happening to this image. */
  .coverbusy { position: absolute; inset: auto 0 0 0; height: 3px; background: rgba(0, 0, 0, 0.45); }
  .coverbusy .bar { display: block; height: 100%; transform-origin: 0 50%; background: var(--accent-bright); transition: transform 120ms linear; }
  .coverpreview :global(.cover) { width: 100%; height: 100%; }
  .coveractions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  /* The file input itself is unstylable across browsers; the label is the
     button, and the input is the part that never shows. */
  .uploadlabel { display: inline-flex; align-items: center; border-radius: var(--radius); background: var(--ink-200); padding: 8px 14px; font-size: var(--text-13); font-weight: 600; cursor: pointer; }
  .uploadlabel:hover { background: var(--ink-300); }
  .uploadlabel.disabled { opacity: 0.5; cursor: default; }
  .uploadlabel input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
  .uploadlabel:focus-within { outline: 1px solid var(--accent-bright); outline-offset: 2px; }
  .covernote { margin: 0; color: var(--ink-text-dim); font-size: var(--text-12); }
  .sub.pick { margin-top: 14px; }
  .coverpick { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 6px; }
  .pickone { position: relative; aspect-ratio: 16 / 9; border: 0; border-radius: 2px; overflow: hidden; background: var(--ink-200); padding: 0; }
  .pickone img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .pickfallback { display: grid; place-items: center; width: 100%; height: 100%; padding: 4px; color: var(--ink-text-dim); font-size: var(--text-12); overflow: hidden; }
  .pickone.active { outline: 2px solid var(--accent-bright); outline-offset: -2px; }
  .pickwrap { position: relative; display: block; }
  /* Removing an option should be possible without being the first thing the
     pointer finds: it appears on hover, over the corner of its own picture. */
  .pickdrop { position: absolute; top: 3px; right: 3px; width: 18px; height: 18px; display: none; place-items: center; border: 0; border-radius: 50%; background: rgba(6, 9, 14, 0.82); color: #fff; font-size: 13px; line-height: 1; padding: 0; }
  .pickwrap:hover .pickdrop, .pickdrop:focus-visible { display: grid; }
  .pickdrop:hover { background: var(--warn); }
  .pickone:not(.active):hover { outline: 1px solid var(--ink-400, var(--ink-300)); outline-offset: -1px; }
</style>
