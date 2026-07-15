<script lang="ts">
  import { goto } from '$app/navigation';
  import { api, createProject, messageFrom } from '$lib/api.js';
  import { auth } from '$lib/auth.svelte.js';

  type Project = { id: string; name: string; status: string; palette: string; my_role?: string };
  let projects = $state<Project[]>([]);
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
      await goto(`/projects/${project.id}`);
    } catch (caught) {
      createError = messageFrom(caught, 'The project could not be created.');
      creating = false;
    }
  };
</script>

<svelte:head><title>Onelight</title></svelte:head>

<main class="shell">
  <p class="eyebrow">One-light dailies</p>
  <h1>{auth.signedIn ? 'Choose a project.' : 'Review work with the frame still in view.'}</h1>
  <p class="lede">A self-hosted review room for post-production teams.</p>
  {#if auth.signedIn}
    <section class="projects" aria-label="Projects">
      {#if projects.length === 0}<p class="empty">No projects yet. Name one to start.</p>{/if}
      {#each projects as project (project.id)}<a class="project" href={`/projects/${project.id}`}><span>{project.name}</span><small>{project.my_role ?? 'viewer'}</small></a>{/each}
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
    </section>
  {:else if auth.ready}
    <nav aria-label="Primary"><a href="/login">Sign in</a><a href="/setup">First run setup</a></nav>
  {/if}
</main>

<style>
  .shell { min-height: calc(100vh - var(--topbar-h, 0px)); padding: 12vh 9vw; background: linear-gradient(180deg, var(--sumimai-a) 0%, var(--sumimai-m) 55%, var(--sumimai-b) 105%); }
  .eyebrow { margin: 0 0 24px; color: rgba(255, 255, 255, 0.65); font-size: var(--text-13); }
  h1 { max-width: 760px; margin: 0; font-family: var(--font-display); font-size: clamp(42px, 8vw, 92px); line-height: 0.98; }
  .lede { max-width: 460px; margin: 32px 0 48px; font-size: 19px; }
  nav { display: flex; gap: 24px; }
  a { color: inherit; text-decoration: none; }
  nav a { border-bottom: 1px solid rgba(255, 255, 255, 0.7); padding-bottom: 5px; }
  a:focus-visible { outline: 2px solid var(--accent-bright); outline-offset: 4px; }
  .projects { display: grid; gap: 2px; max-width: 640px; }
  .project { display: flex; justify-content: space-between; gap: 24px; padding: 16px 14px; margin: 0 -14px; border-radius: var(--radius); background: rgba(13, 17, 23, 0.35); }
  .project:hover { background: rgba(13, 17, 23, 0.55); }
  .project small { color: rgba(255, 255, 255, 0.65); }
  .empty { color: rgba(255, 255, 255, 0.65); }
  .newproject { display: flex; gap: 6px; margin-top: 14px; }
  .newproject input { flex: 1; min-width: 0; border: 0; border-radius: var(--radius); background: rgba(13, 17, 23, 0.35); color: var(--ink-text); padding: 9px 12px; font-size: var(--text-13); }
  .newproject input::placeholder { color: rgba(255, 255, 255, 0.65); }
  .newproject button { border: 0; border-radius: var(--radius); background: var(--accent); color: #0b1214; padding: 9px 16px; font-size: var(--text-13); font-weight: 600; }
  .newproject button:hover { background: var(--accent-bright); }
  .newproject button:disabled { opacity: 0.5; cursor: default; }
  .error { margin: 12px 0 0; color: var(--warn); font-size: var(--text-13); }
</style>
