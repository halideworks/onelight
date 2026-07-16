<script lang="ts">
  import { goto } from '$app/navigation';
  import { api, createProject, messageFrom } from '$lib/api.js';
  import { auth } from '$lib/auth.svelte.js';
  import ProjectCover from '$lib/ProjectCover.svelte';
  import { pretty } from '$lib/ids.js';

  type Project = {
    id: string;
    name: string;
    status: string;
    palette: string;
    cover_url?: string | null;
    my_role?: string;
  };
  let projects = $state<Project[]>([]);

  /* Grid or list, remembered per user: a wall of thumbnails is right for a few
     projects, a list is right for forty. */
  const VIEW_KEY = 'onelight.projects.view';
  let view = $state<'grid' | 'list'>('grid');
  $effect(() => {
    try {
      if (localStorage.getItem(VIEW_KEY) === 'list') view = 'list';
    } catch {
      /* Storage can be unavailable; the default view stands. */
    }
  });
  const setView = (next: 'grid' | 'list'): void => {
    view = next;
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* Non-persistent, still applied for the session. */
    }
  };
  /* The layout owns session hydration (one GET /auth/session). Load projects
     once it reports a signed-in session, exactly once. */
  let projectsLoaded = false;

  let newProjectName = $state('');
  let creating = $state(false);
  let createError = $state('');

  $effect(() => {
    if (!auth.ready || !auth.signedIn || projectsLoaded) return;
    projectsLoaded = true;
    void (async () => {
      try {
        projects = (await api<{ items: Project[] }>('/api/v1/projects')).items;
      } catch {
        /* The empty state stands in. */
      }
    })();
  });

  /* Name is the only required field: the server round-robins the palette and
     enrols the creator as manager. */
  const create = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const name = newProjectName.trim();
    if (!name || creating) return;
    creating = true;
    createError = '';
    try {
      const project = await createProject({ name });
      await goto(`/projects/${pretty(project.id, project.name)}`);
    } catch (caught) {
      createError = messageFrom(caught, 'The project could not be created.');
      creating = false;
    }
  };
</script>

<svelte:head><title>Onelight</title></svelte:head>

<main class="shell" class:signed-in={auth.signedIn}>
  <p class="eyebrow">One-light dailies</p>
  <!-- Signed out this is a hero and earns its size. Signed in it is a page
       heading over a list you came here to use, so it stops shouting. -->
  <h1>{auth.signedIn ? 'Choose a project.' : 'Review work with the frame still in view.'}</h1>
  {#if !auth.signedIn}
    <p class="lede">A self-hosted review room for post-production teams.</p>
  {/if}
  {#if auth.signedIn}
    <section class="projects" aria-label="Projects">
      <!-- Creating a project leads: it is the one thing a new workspace must
           do, and it used to be stranded under the list. -->
      <form class="newproject" onsubmit={create}>
        <input
          bind:value={newProjectName}
          placeholder="New project"
          aria-label="New project name"
          maxlength="200"
          disabled={creating}
        />
        <button type="submit" disabled={!newProjectName.trim() || creating}>
          {creating ? 'Creating…' : 'Create project'}
        </button>
      </form>
      {#if createError}<p class="error" role="alert">{createError}</p>{/if}

      <div class="listhead">
        <span class="count">{projects.length} {projects.length === 1 ? 'project' : 'projects'}</span>
        <div class="viewtoggle" role="group" aria-label="Project view">
          <button type="button" aria-pressed={view === 'grid'} onclick={() => setView('grid')}>Grid</button>
          <button type="button" aria-pressed={view === 'list'} onclick={() => setView('list')}>List</button>
        </div>
      </div>

      {#if projects.length === 0}<p class="empty">No projects yet. Name one to start.</p>{/if}

      <div class="projectlist" class:grid={view === 'grid'}>
        {#each projects as project (project.id)}
          <a class="project" href={`/projects/${pretty(project.id, project.name)}`}>
            <!-- Every project has a picture: the one it chose, or the one
                 generated from its palette and name. Neither costs a request
                 beyond this page's own. -->
            <span class="thumb"><ProjectCover {project} monogram={view === 'grid'} /></span>
            <span class="meta">
              <span class="name">{project.name}</span>
              <small>{project.my_role ?? 'viewer'}</small>
            </span>
          </a>
        {/each}
      </div>
    </section>
  {:else if auth.ready}
    <nav aria-label="Primary"><a href="/login">Sign in</a><a href="/setup">First run setup</a></nav>
  {/if}
</main>

<style>
  /* The landing wash, resolving into ink like every other page rather than
     ending the screen in pale tan with white text on it. */
  .shell { min-height: calc(100vh - var(--topbar-h, 0px)); padding: 12vh 9vw; background-color: var(--ink-000); background-repeat: no-repeat; background-image: linear-gradient(180deg, color-mix(in oklab, var(--sumimai-a) 88%, var(--ink-000)) 0px, color-mix(in oklab, var(--sumimai-m) 42%, var(--ink-000)) 190px, color-mix(in oklab, var(--sumimai-m) 12%, var(--ink-000)) 380px, var(--ink-000) 640px); }
  /* Signed in this is a working page, not a landing page: less air, no hero. */
  .shell.signed-in { padding: 6vh 9vw; }
  .eyebrow { margin: 0 0 24px; color: var(--ink-text-dim); font-size: var(--text-13); }
  h1 { max-width: 760px; margin: 0; font-family: var(--font-display); font-size: clamp(42px, 8vw, 92px); line-height: 0.98; }
  /* The heading over a list you came here to use does not need to be 92px. */
  .signed-in h1 { font-size: clamp(24px, 3vw, 34px); line-height: 1.1; margin: 0 0 24px; }
  .lede { max-width: 460px; margin: 32px 0 48px; font-size: 19px; color: var(--ink-text-dim); }
  nav { display: flex; gap: 24px; }
  a { color: inherit; text-decoration: none; }
  nav a { border-bottom: 1px solid rgba(255, 255, 255, 0.7); padding-bottom: 5px; }
  a:focus-visible { outline: 2px solid var(--accent-bright); outline-offset: 4px; }

  /* The list uses the window: the grid flows into as many columns as fit,
     and only the create form and the list rows keep a readable measure. A
     640px strip on a 2560px display was a column of air. */
  .projects { max-width: none; }
  .newproject { max-width: 640px; }
  .projectlist:not(.grid) { max-width: 900px; }
  .newproject { display: flex; gap: 6px; }
  .newproject input { flex: 1; min-width: 0; border: 0; border-radius: var(--radius); background: var(--ink-100); color: var(--ink-text); padding: 10px 14px; font-size: var(--text-13); }
  .newproject input::placeholder { color: var(--ink-text-dim); }
  .newproject button { border: 0; border-radius: var(--radius); background: var(--accent); color: #0b1214; padding: 10px 16px; font-size: var(--text-13); font-weight: 600; white-space: nowrap; }
  .newproject button:hover { background: var(--accent-bright); }
  .newproject button:disabled { opacity: 0.5; cursor: default; }

  .listhead { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 28px 0 10px; }
  .count { color: var(--ink-text-dim); font-size: var(--text-13); }
  .viewtoggle { display: flex; gap: 2px; padding: 2px; border-radius: var(--radius); background: var(--ink-100); }
  .viewtoggle button { border: 0; border-radius: 2px; background: none; color: var(--ink-text-dim); padding: 4px 10px; font-size: var(--text-12); font-weight: 500; }
  .viewtoggle button:hover { color: #fff; }
  .viewtoggle button[aria-pressed='true'] { background: var(--ink-300); color: #fff; }

  .projectlist { display: grid; gap: 2px; }
  .projectlist.grid { grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }

  /* List row: thumbnail as a small swatch. */
  .project { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-radius: var(--radius); background: var(--ink-100); transition: background 100ms ease; }
  .project:hover { background: var(--ink-200); }
  .meta { flex: 1; min-width: 0; display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .project small { color: var(--ink-text-dim); }
  .thumb { flex: none; width: 34px; height: 24px; border-radius: 2px; overflow: hidden; display: grid; }

  /* Grid card: the thumbnail leads and the name sits under it. */
  .grid .project { flex-direction: column; align-items: stretch; gap: 0; padding: 0; overflow: hidden; }
  /* The thumb scales with its column instead of clamping at one height that
     only suited 180px cards. */
  .grid .thumb { width: 100%; height: auto; aspect-ratio: 16 / 9; border-radius: 0; }
  /* The component's own <span> is the box; let it fill the wrapper. */
  .thumb :global(.cover) { width: 100%; height: 100%; }
  .grid .meta { padding: 10px 12px; }

  .empty { color: var(--ink-text-dim); }
  .error { margin: 12px 0 0; color: var(--warn); font-size: var(--text-13); }
</style>
