<script lang="ts">
  import { onMount } from 'svelte';
  import { PALETTES } from '@onelight/core';
  import { page } from '$app/state';
  import { api, apiDelete, apiPatch, apiPut, messageFrom } from '$lib/api.js';
  import { washFor } from '$lib/washes.js';
  import { auth } from '$lib/auth.svelte.js';

  type Project = {
    id: string;
    name: string;
    palette: string;
    status: string;
    restricted: boolean;
    my_role?: string;
  };
  type Member = { user: { id: string; name: string; email: string }; role: string };

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
  let error = $state('');
  let saved = $state('');
  let loaded = $state(false);

  let name = $state('');
  let renaming = $state(false);

  const isManager = $derived(project?.my_role === 'manager' || auth.user?.role === 'admin');

  onMount(() => {
    void (async () => {
      try {
        const [loadedProject, loadedMembers] = await Promise.all([
          api<Project>(`/api/v1/projects/${projectId}`),
          api<{ items: Member[] }>(`/api/v1/projects/${projectId}/members`)
        ]);
        project = loadedProject;
        name = loadedProject.name;
        members = loadedMembers.items;
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

  const rename = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const next = name.trim();
    if (!next || next === project?.name) {
      renaming = false;
      return;
    }
    await patch({ name: next }, 'Name saved');
    renaming = false;
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

  const removeMember = async (member: Member): Promise<void> => {
    try {
      await apiDelete(`/api/v1/projects/${projectId}/members/${member.user.id}`);
      members = members.filter((entry) => entry.user.id !== member.user.id);
      error = '';
      saved = `${member.user.name} removed`;
    } catch (caught) {
      error = messageFrom(caught, 'That member could not be removed.');
    }
  };

  const wash = $derived(washFor(project?.palette));
</script>

<svelte:head><title>{project?.name ?? 'Project'} settings | Onelight</title></svelte:head>

<main class="room" style={`background-image: ${wash};`}>
  <header class="wash">
    <div class="washrow">
      <a href={`/projects/${projectId}`}>Back to project</a>
      <span class="grow"></span>
      {#if saved}<span class="saved" aria-live="polite">{saved}</span>{/if}
    </div>
    <p class="eyebrow">{project?.palette ?? ''}</p>
    <h1>Settings</h1>
  </header>

  {#if error}<p class="error" role="alert">{error}</p>{/if}

  {#if project}
    {#if !isManager}
      <p class="hint">Only a project manager can change these.</p>
    {/if}

    <section class="panel" aria-label="Name">
      <h2>Name</h2>
      {#if renaming}
        <form class="renameform" onsubmit={rename}>
          <input bind:value={name} aria-label="Project name" maxlength="200" />
          <button type="submit">Save</button>
          <button type="button" class="quiet" onclick={() => { name = project?.name ?? ''; renaming = false; }}>Cancel</button>
        </form>
      {:else}
        <div class="row">
          <span class="value">{project.name}</span>
          <button type="button" class="quiet" disabled={!isManager} onclick={() => { renaming = true; }}>Rename</button>
        </div>
      {/if}
    </section>

    <section class="panel" aria-label="Colour">
      <h2>Colour</h2>
      <p class="sub">The project's wash, and its thumbnail on the projects page.</p>
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
                onchange={(event) => void setRole(member, event.currentTarget.value)}
              >
                {#each ROLES as role (role)}<option value={role}>{role}</option>{/each}
              </select>
              <small class="rolenote">{ROLE_NOTES[member.role]}</small>
            </span>
            <button type="button" class="quiet" disabled={!isManager} onclick={() => void removeMember(member)}>Remove</button>
          </li>
        {/each}
      </ul>
    </section>
  {:else if loaded}
    <p class="empty">This project could not be loaded.</p>
  {/if}
</main>

<style>
  .room { position: relative; min-height: calc(100vh - var(--topbar-h, 0px)); background-color: var(--ink-000); background-size: 100% 100%; background-attachment: fixed; color: var(--ink-text); font-size: var(--text-13); padding-bottom: var(--pad-4); }
  .room::before { content: ''; position: fixed; inset: 0; pointer-events: none; background: linear-gradient(180deg, rgba(13, 17, 23, 0.05) 0%, rgba(13, 17, 23, 0.45) 26%, rgba(13, 17, 23, 0.88) 58%, rgba(13, 17, 23, 0.95) 100%); }
  .room > :global(*) { position: relative; }
  .wash { padding: var(--pad-3) var(--pad-4) var(--pad-4); }
  .washrow { display: flex; gap: 16px; align-items: center; }
  .washrow a { color: rgba(250, 248, 244, 0.72); font-size: var(--text-13); text-decoration: none; }
  .washrow a:hover { color: rgba(250, 248, 244, 0.96); }
  .grow { flex: 1; }
  .saved { color: var(--ok); font-size: var(--text-13); }
  .eyebrow { margin: 24px 0 4px; color: var(--ink-text-dim); font-size: var(--text-13); }
  h1 { margin: 0; font-family: var(--font-display); font-size: clamp(24px, 3vw, 34px); font-weight: 700; letter-spacing: -0.02em; }

  .panel { max-width: 720px; margin: 0 var(--pad-4) 2px; padding: var(--pad-2); background: var(--ink-100); border-radius: var(--radius); }
  .panel:first-of-type { border-radius: var(--radius-lg) var(--radius-lg) var(--radius) var(--radius); }
  h2 { margin: 0 0 4px; font-size: var(--text-13); font-weight: 600; color: var(--ink-text); }
  .sub { margin: 0 0 12px; color: var(--ink-text-dim); }
  .sub a { color: var(--ink-text); }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .value { color: var(--ink-text); font-size: var(--text-16); }
  .renameform { display: flex; gap: 6px; }
  .renameform input { flex: 1; min-width: 0; }
  input, select { border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 8px 10px; font: inherit; }

  /* Ten swatches painted in the actual wash: the colour is the label. */
  .swatches { display: flex; flex-wrap: wrap; gap: 8px; }
  .swatch { width: 56px; height: 36px; padding: 0; border: 0; border-radius: var(--radius); background-size: 100% 100%; }
  .swatch.active { box-shadow: 0 0 0 2px var(--ink-100), 0 0 0 4px var(--accent-bright); }
  .swatch:disabled { opacity: 0.5; cursor: default; }

  .check { display: flex; align-items: flex-start; gap: 10px; padding: 8px 0; }
  .check input { margin: 2px 0 0; accent-color: var(--accent); }
  .check span { display: grid; gap: 2px; }
  .check small { color: var(--ink-text-dim); }

  .members { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
  .members li { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 12px; padding: 8px; margin: 0 -8px; border-radius: var(--radius); }
  .members li:hover { background: var(--ink-200); }
  .who { display: grid; gap: 2px; min-width: 0; }
  .who small { color: var(--ink-text-dim); }
  .rolecell { display: grid; gap: 2px; justify-items: end; }
  .rolenote { color: var(--ink-text-dim); font-size: var(--text-11); }

  button { border: 0; border-radius: var(--radius); background: var(--accent); color: #0b1214; padding: 8px 14px; font-size: var(--text-13); font-weight: 600; }
  button:hover { background: var(--accent-bright); }
  button.quiet { background: var(--ink-200); color: var(--ink-text); font-weight: 500; }
  button.quiet:hover { background: var(--ink-300); }
  button:disabled { opacity: 0.5; cursor: default; }
  .hint, .empty { margin: 0 var(--pad-4) 12px; color: var(--ink-text-dim); }
  .error { margin: 0 var(--pad-4) 12px; color: var(--warn); }
  button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: 2px; }
</style>
