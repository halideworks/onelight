<script lang="ts">
  import { onMount } from 'svelte';
  import { api, apiPatch, messageFrom } from '$lib/api.js';

  type Preferences = { mode: 'instant' | 'hourly' | 'daily'; muted_projects: string[] };
  type Project = { id: string; name: string };

  let prefs = $state<Preferences | null>(null);
  let projects = $state<Project[]>([]);
  let prefsError = $state('');
  let prefsSaved = $state(false);
  let busy = $state(false);

  onMount(() => {
    void (async () => {
      try {
        const [loadedPrefs, loadedProjects] = await Promise.all([
          api<Preferences>('/api/v1/notifications/preferences'),
          api<{ items: Project[] }>('/api/v1/projects')
        ]);
        prefs = loadedPrefs;
        projects = loadedProjects.items;
      } catch (caught) {
        prefsError = messageFrom(caught, 'Preferences could not be loaded.');
      }
    })();
  });

  const toggleMuted = (projectId: string): void => {
    if (!prefs) return;
    prefs = {
      ...prefs,
      muted_projects: prefs.muted_projects.includes(projectId)
        ? prefs.muted_projects.filter((id) => id !== projectId)
        : [...prefs.muted_projects, projectId]
    };
    prefsSaved = false;
  };

  const savePrefs = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    if (!prefs || busy) return;
    busy = true;
    prefsError = '';
    try {
      prefs = await apiPatch<Preferences>('/api/v1/notifications/preferences', prefs);
      prefsSaved = true;
    } catch (caught) {
      prefsError = messageFrom(caught, 'Preferences could not be saved.');
    } finally {
      busy = false;
    }
  };
</script>

<svelte:head><title>Notifications | Onelight</title></svelte:head>

<main class="page">
  <h1>Notifications</h1>
  <p class="lede">The list itself lives in the panel behind the bell, on every page.</p>

  <section aria-label="Notification preferences" class="prefs">
    {#if prefsError}<p class="error" role="alert">{prefsError}</p>{/if}
    {#if prefs}
      <form onsubmit={savePrefs}>
        <fieldset>
          <legend>Email delivery</legend>
          <label><input type="radio" name="mode" value="instant" bind:group={prefs.mode} onchange={() => (prefsSaved = false)} /> Instant</label>
          <label><input type="radio" name="mode" value="hourly" bind:group={prefs.mode} onchange={() => (prefsSaved = false)} /> Hourly digest</label>
          <label><input type="radio" name="mode" value="daily" bind:group={prefs.mode} onchange={() => (prefsSaved = false)} /> Daily digest</label>
        </fieldset>
        <fieldset>
          <legend>Muted projects</legend>
          {#if projects.length === 0}
            <p class="empty">No projects to mute.</p>
          {/if}
          {#each projects as project (project.id)}
            <label>
              <input
                type="checkbox"
                checked={prefs.muted_projects.includes(project.id)}
                onchange={() => toggleMuted(project.id)}
              />
              {project.name}
            </label>
          {/each}
        </fieldset>
        <div class="actions">
          <button type="submit" disabled={busy}>{busy ? 'Saving' : 'Save preferences'}</button>
          {#if prefsSaved}<span class="saved" aria-live="polite">Saved.</span>{/if}
        </div>
      </form>
    {/if}
  </section>
</main>

<style>
  .page { padding: 44px 0 72px; }
  h1 { margin: 0 0 12px; font-family: var(--font-display); font-size: clamp(26px, 3vw, 36px); font-weight: 700; letter-spacing: -0.02em; }
  .lede { margin: 0 0 32px; color: var(--ink-text-dim); font-size: var(--text-13); }
  .prefs { max-width: 560px; }
  fieldset { border: 0; margin: 0 0 24px; padding: 0; display: grid; gap: 10px; }
  legend { padding: 0; margin-bottom: 10px; color: var(--ink-text-dim); font-size: var(--text-13); font-weight: 600; }
  label { display: flex; align-items: center; gap: 10px; font-size: var(--text-13); }
  input[type='radio'], input[type='checkbox'] { accent-color: var(--accent); margin: 0; }
  .actions { display: flex; align-items: center; gap: 14px; }
  button { border: 0; border-radius: var(--radius); background: var(--accent); color: #0b1214; padding: 9px 16px; font-size: var(--text-13); font-weight: 600; }
  button:hover { background: var(--accent-bright); }
  button:disabled { opacity: 0.5; cursor: default; }
  .saved { color: var(--ok); font-size: var(--text-13); }
  .empty { color: var(--ink-text-dim); }
  .error { color: var(--warn); }
  button:focus-visible, input:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: 2px; }
</style>
