<script lang="ts">
  import { goto } from '$app/navigation';
  import { api, createProject, getBootstrap, messageFrom } from '$lib/api.js';
  import { auth } from '$lib/auth.svelte.js';
  import ProjectCover from '$lib/ProjectCover.svelte';
  import { pretty } from '$lib/ids.js';
  import { pageWashFor } from '$lib/washes.js';
  import { grainLayer } from '$lib/grain.js';

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

  /* The setup door exists only while the workspace has no users: once set
     up, a signed-out landing offers Sign in and nothing else. */
  let setupRequired = $state(false);
  $effect(() => {
    if (auth.ready && !auth.signedIn)
      void getBootstrap().then(
        (bootstrap) => (setupRequired = bootstrap.setup_required),
        () => {},
      );
  });

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

  /* The signed-out landing carries the full wash, dark into the light
     terminal at the very bottom edge, with the cover grammar's placed
     light; content stays on the dark two thirds. */
  const heroWash = [
    grainLayer,
    'radial-gradient(90% 62% at 70% 12%, rgba(255, 255, 255, 0.09), rgba(255, 255, 255, 0) 60%)',
    'linear-gradient(180deg in oklab, #0d1117 0%, var(--sumimai-a) 18%, var(--sumimai-m) 66%, var(--sumimai-b) 112%)'
  ].join(', ');
</script>

<svelte:head><title>Onelight</title></svelte:head>

<main
  class="shell"
  class:signed-in={auth.signedIn}
  style={`background-image: ${auth.signedIn ? pageWashFor(null) : heroWash}`}
>
  {#if auth.signedIn}
    <p class="eyebrow">One-light dailies</p>
    <h1>Choose a project.</h1>
    <section class="projects" aria-label="Projects">
      <!-- Creating a project leads: it is the one thing a new workspace must
           do, and it used to be stranded under the list. -->
      {#if auth.user?.role !== 'guest'}
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
      {/if}
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
    <div class="hero">
      <span class="lockup">
        <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true">
          <rect x="0.5" y="0.5" width="31" height="31" rx="8.5" fill="#10151d" />
          <rect x="5" y="8" width="5" height="16" rx="1.2" fill="#2c3f56" />
          <rect x="11" y="8" width="5" height="16" rx="1.2" fill="#934337" />
          <rect x="17" y="8" width="5" height="16" rx="1.2" fill="#cf8a56" />
          <rect x="23" y="8" width="4" height="16" rx="1.2" fill="#F7E1A0" />
        </svg>
        Onelight
      </span>
      <div class="pitch">
        <p class="eyebrow">One-light dailies</p>
        <h1>Review work with the frame still in view.</h1>
        <p class="lede">A self-hosted review room for post-production teams.</p>
        <div class="doors">
          <a class="signin" href="/login">Sign in</a>
          {#if setupRequired}<a class="setup" href="/setup">First run setup</a>{/if}
        </div>
      </div>
      <p class="facts">Self-hosted. AGPL-3.0.</p>
    </div>
  {/if}
</main>

<style>
  /* Signed out, the landing is the one page allowed the FULL wash: it ends
     on the light terminal like a horizon, and the content keeps to the dark
     two thirds so nothing ever sits on cream. Signed in, it takes the same
     page wash as every working page. */
  .shell { min-height: calc(100vh - var(--topbar-h, 0px)); padding: 12vh 9vw; background-color: var(--ink-000); background-repeat: repeat, no-repeat, no-repeat; }
  /* Signed in this is a working page, not a landing page: less air, no hero. */
  .shell.signed-in { padding: 6vh 9vw; background-repeat: repeat, no-repeat; }

  .hero { position: relative; display: grid; grid-template-rows: auto 1fr auto; min-height: calc(100vh - 24vh); }
  .lockup { display: inline-flex; align-items: center; gap: 9px; font-family: var(--font-display); font-size: var(--text-16); font-weight: 700; color: var(--ink-text); }
  .lockup svg { flex: none; }
  .pitch { align-self: center; max-width: 720px; padding: 8vh 0; }
  .pitch .lede { color: rgba(255, 255, 255, 0.74); }
  .doors { display: flex; align-items: center; gap: 22px; margin-top: 44px; }
  .signin { display: inline-block; border-radius: var(--radius); background: var(--accent); color: #0b1214; padding: 11px 26px; font-size: var(--text-14); font-weight: 600; }
  .signin:hover { background: var(--accent-bright); }
  .setup { color: var(--ink-text-dim); border-bottom: 1px solid rgba(255, 255, 255, 0.35); padding-bottom: 3px; }
  .setup:hover { color: var(--ink-text); }
  .facts { margin: 0; color: rgba(255, 255, 255, 0.55); font-size: var(--text-13); }
  .eyebrow { margin: 0 0 24px; color: var(--ink-text-dim); font-size: var(--text-13); }
  h1 { max-width: 760px; margin: 0; font-family: var(--font-display); font-size: clamp(42px, 8vw, 92px); line-height: 0.98; }
  /* The heading over a list you came here to use does not need to be 92px. */
  .signed-in h1 { font-size: clamp(24px, 3vw, 34px); line-height: 1.1; margin: 0 0 24px; }
  .lede { max-width: 460px; margin: 32px 0 48px; font-size: 19px; color: var(--ink-text-dim); }
  a { color: inherit; text-decoration: none; }
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
