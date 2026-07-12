<script lang="ts">
  import { api } from '$lib/api.js';
  import { auth } from '$lib/auth.svelte.js';

  type Project = { id: string; name: string; status: string; palette: string; my_role?: string };
  let projects = $state<Project[]>([]);
  /* The layout owns session hydration (one GET /auth/session). Load projects
     once it reports a signed-in session, exactly once. */
  let projectsLoaded = false;

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
</script>

<svelte:head><title>Onelight</title></svelte:head>

<main class="shell">
  <p class="eyebrow">One-light dailies</p>
  <h1>{auth.signedIn ? 'Choose a project.' : 'Review work with the frame still in view.'}</h1>
  <p class="lede">A self-hosted review room for post-production teams.</p>
  {#if auth.signedIn}
    <section class="projects" aria-label="Projects">
      {#if projects.length === 0}<p class="empty">No projects yet.</p>{/if}
      {#each projects as project (project.id)}<a class="project" href={`/projects/${project.id}`}><span>{project.name}</span><small>{project.my_role ?? 'viewer'}</small></a>{/each}
    </section>
  {:else if auth.ready}
    <nav aria-label="Primary"><a href="/login">Sign in</a><a href="/setup">First run setup</a></nav>
  {/if}
</main>

<style>
  .shell { min-height: 100vh; padding: 12vh 9vw; background: linear-gradient(180deg, var(--sumimai-a) 0%, var(--sumimai-m) 55%, var(--sumimai-b) 105%); }
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
</style>
