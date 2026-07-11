<script lang="ts">
  import { onMount } from 'svelte';
  import { api, apiPatch, messageFrom } from '$lib/api.js';
  import { whenAbsolute, whenRelative, excerpt } from '$lib/format.js';
  import { notifications, describeNotification, notificationLink } from '$lib/notifications.svelte.js';

  type Preferences = { mode: 'instant' | 'hourly' | 'daily'; muted_projects: string[] };
  type Project = { id: string; name: string };

  let prefs = $state<Preferences | null>(null);
  let projects = $state<Project[]>([]);
  let error = $state('');
  let prefsError = $state('');
  let prefsSaved = $state(false);
  let busy = $state(false);

  const unreadIds = $derived(notifications.items.filter((item) => item.read_at === null).map((item) => item.id));

  onMount(() => {
    void notifications.refresh();
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

  const markOne = async (id: string): Promise<void> => {
    try {
      await notifications.markRead([id]);
      error = '';
    } catch (caught) {
      error = messageFrom(caught, 'The notification could not be marked read.');
    }
  };

  const markAllVisible = async (): Promise<void> => {
    try {
      await notifications.markRead(unreadIds);
      error = '';
    } catch (caught) {
      error = messageFrom(caught, 'Notifications could not be marked read.');
    }
  };

  const loadMore = async (): Promise<void> => {
    try {
      await notifications.loadMore();
      error = '';
    } catch (caught) {
      error = messageFrom(caught, 'More notifications could not be loaded.');
    }
  };

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
  <div class="head">
    <h1>Notifications</h1>
    {#if unreadIds.length > 0}
      <button type="button" class="quiet" onclick={markAllVisible}>Mark all read</button>
    {/if}
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}

  <section aria-label="Notifications" class="list">
    {#if notifications.loaded && notifications.items.length === 0}
      <p class="empty">Nothing yet. Comments, approvals, and transcode results land here.</p>
    {/if}
    {#each notifications.items as item (item.id)}
      {@const described = describeNotification(item)}
      {@const link = notificationLink(item)}
      <article class:unread={item.read_at === null}>
        <span class="dot" aria-hidden="true"></span>
        <div class="body">
          {#if link}
            <a href={link} onclick={() => void markOne(item.id)}>{described.title}</a>
          {:else}
            <span class="title">{described.title}</span>
          {/if}
          {#if described.detail}<p class="detail">{excerpt(described.detail)}</p>{/if}
        </div>
        <span class="when" title={whenAbsolute(item.created_at)}>{whenRelative(item.created_at)}</span>
        {#if item.read_at === null}
          <button type="button" class="quiet" onclick={() => markOne(item.id)}>Mark read</button>
        {/if}
      </article>
    {/each}
    {#if notifications.nextCursor}
      <button type="button" class="quiet more" onclick={loadMore}>Load older</button>
    {/if}
  </section>

  <section aria-label="Notification preferences" class="prefs">
    <h2>Preferences</h2>
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
  /* App world, no borders: rows separate by value step and space. */
  .page { min-height: 100vh; padding: 48px clamp(24px, 8vw, 120px); background: var(--ink-000); }
  .head { display: flex; align-items: baseline; gap: 20px; }
  h1 { margin: 0 0 24px; font-family: var(--font-display); font-size: clamp(40px, 7vw, 72px); font-weight: 700; letter-spacing: -0.02em; }
  h2 { margin: 56px 0 16px; font-size: var(--text-16); }
  .list { max-width: 760px; display: grid; gap: 2px; }
  article { display: flex; align-items: baseline; gap: 12px; padding: 12px 14px; margin: 0 -14px; border-radius: var(--radius); background: var(--ink-100); font-size: var(--text-13); }
  .dot { width: 6px; height: 6px; border-radius: 50%; flex: none; align-self: center; background: transparent; }
  article.unread .dot { background: var(--accent); }
  article.unread { background: var(--ink-200); }
  .body { flex: 1; min-width: 0; display: grid; gap: 3px; }
  .body a, .title { color: var(--ink-text); font-weight: 500; text-decoration: none; }
  .body a:hover { color: var(--accent-bright); }
  .detail { margin: 0; color: var(--ink-text-dim); overflow-wrap: anywhere; }
  .when { color: var(--ink-text-dim); font-size: var(--text-12); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .prefs { max-width: 560px; }
  fieldset { border: 0; margin: 0 0 24px; padding: 0; display: grid; gap: 10px; }
  legend { padding: 0; margin-bottom: 10px; color: var(--ink-text-dim); font-size: var(--text-13); font-weight: 600; }
  label { display: flex; align-items: center; gap: 10px; font-size: var(--text-13); }
  input[type='radio'], input[type='checkbox'] { accent-color: var(--accent); margin: 0; }
  .actions { display: flex; align-items: center; gap: 14px; }
  button { border: 0; border-radius: var(--radius); background: var(--accent); color: #0b1214; padding: 9px 16px; font-size: var(--text-12); font-weight: 600; }
  button:hover { background: var(--accent-bright); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.quiet { background: var(--ink-200); color: var(--ink-text); font-weight: 500; }
  button.quiet:hover { background: var(--ink-300); }
  .more { justify-self: start; margin-top: 10px; }
  .saved { color: var(--ok); font-size: var(--text-13); }
  .empty { color: var(--ink-text-dim); }
  .error { color: var(--warn); }
  button:focus-visible, a:focus-visible, input:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: 2px; }
</style>
