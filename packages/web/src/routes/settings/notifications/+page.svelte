<script lang="ts">
  import { onMount } from 'svelte';
  import { api, apiPatch, messageFrom } from '$lib/api.js';

  type Mode = 'off' | 'instant' | 'hourly' | 'daily';
  type Preferences = {
    mode: Mode;
    kind_modes: Record<string, Mode>;
    digest_hour: number;
    utc_offset_minutes: number;
    muted_projects: string[];
  };
  type Project = { id: string; name: string };

  /* The kinds worth routing on their own, in the order they matter. A mention
     is addressed to you; a version arriving is the quietest thing here. */
  const KINDS: Array<{ kind: string; label: string; hint: string }> = [
    { kind: 'comment.mention', label: 'Mentions', hint: 'Somebody typed your name' },
    { kind: 'comment.reply', label: 'Replies', hint: 'An answer in a thread you are in' },
    { kind: 'comment.created', label: 'Comments', hint: 'Notes on work you uploaded or manage' },
    { kind: 'approval.updated', label: 'Approvals', hint: 'Approved, or sent back for changes' },
    { kind: 'transcode.failed', label: 'Failed uploads', hint: 'A file Onelight could not read' },
    { kind: 'version.created', label: 'New versions', hint: 'Somebody uploaded a new cut' }
  ];
  const MODES: Array<{ value: Mode; label: string }> = [
    { value: 'instant', label: 'As it happens' },
    { value: 'hourly', label: 'Hourly' },
    { value: 'daily', label: 'Daily' },
    { value: 'off', label: 'No email' }
  ];

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
        /* Offer this browser's own offset if the account has never said one:
           the default of UTC would put a "morning" summary in the middle of
           somebody's night. */
        if (prefs.utc_offset_minutes === 0)
          prefs = { ...prefs, utc_offset_minutes: localOffsetMinutes() };
      } catch (caught) {
        prefsError = messageFrom(caught, 'Preferences could not be loaded.');
      }
    })();
  });

  /* What this kind does today: its own rule, or "same as the default". */
  const kindMode = (kind: string): Mode | '' => prefs?.kind_modes[kind] ?? '';
  const setKindMode = (kind: string, value: string): void => {
    if (!prefs) return;
    const next = { ...prefs.kind_modes };
    /* Empty means "no rule of its own", which is a deletion rather than a
       value: a stored copy of the default would silently stop following it. */
    if (value === '') delete next[kind];
    else next[kind] = value as Mode;
    prefs = { ...prefs, kind_modes: next };
    prefsSaved = false;
  };

  /* The browser knows the reader's offset; the server cannot guess it. Stored
     in minutes east of UTC so "eight in the morning" is their morning. */
  const localOffsetMinutes = (): number => -new Date().getTimezoneOffset();
  const offsetLabel = $derived.by(() => {
    const minutes = prefs?.utc_offset_minutes ?? 0;
    const sign = minutes < 0 ? '-' : '+';
    const abs = Math.abs(minutes);
    return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  });
  const hourLabel = (hour: number): string => {
    const suffix = hour < 12 ? 'am' : 'pm';
    const twelve = hour % 12 === 0 ? 12 : hour % 12;
    return `${String(twelve)}${suffix}`;
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
  <h1>Notifications</h1>
  <p class="lede">The list itself lives in the panel behind the bell, on every page.</p>

  <section aria-label="Notification preferences" class="prefs">
    {#if prefsError}<p class="error" role="alert">{prefsError}</p>{/if}
    {#if prefs}
      <form onsubmit={savePrefs}>
        <fieldset>
          <legend>Email, by default</legend>
          {#each MODES as option (option.value)}
            <label>
              <input type="radio" name="mode" value={option.value} bind:group={prefs.mode} onchange={() => (prefsSaved = false)} />
              {option.label}
            </label>
          {/each}
          <p class="note">Everything still arrives in the app behind the bell. This is only about email.</p>
        </fieldset>

        <!-- Per kind, because a mention and a new version arriving are not the
             same news, and one dial for both is why people turn it off. -->
        <fieldset class="kinds">
          <legend>Except for these</legend>
          {#each KINDS as entry (entry.kind)}
            <label class="kindrow">
              <span class="kindname">
                {entry.label}
                <small>{entry.hint}</small>
              </span>
              <select
                value={kindMode(entry.kind)}
                onchange={(event) => setKindMode(entry.kind, event.currentTarget.value)}
              >
                <option value="">Same as default</option>
                {#each MODES as option (option.value)}
                  <option value={option.value}>{option.label}</option>
                {/each}
              </select>
            </label>
          {/each}
        </fieldset>

        <fieldset>
          <legend>When the daily summary arrives</legend>
          <label class="kindrow">
            <span class="kindname">
              Send it at
              <small>In your own day: {offsetLabel}</small>
            </span>
            <select bind:value={prefs.digest_hour} onchange={() => (prefsSaved = false)}>
              {#each { length: 24 } as _, hour (hour)}
                <option value={hour}>{hourLabel(hour)}</option>
              {/each}
            </select>
          </label>
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
  .note { margin: 2px 0 0; color: var(--ink-text-dim); font-size: var(--text-12); }
  .kinds { gap: 6px; }
  .kindrow { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .kindname { display: grid; gap: 1px; }
  .kindname small { color: var(--ink-text-dim); font-size: var(--text-12); }
  select {
    border: 1px solid var(--ink-300);
    border-radius: var(--radius);
    background: var(--ink-200);
    color: var(--ink-text);
    padding: 6px 8px;
    font-size: var(--text-13);
    min-width: 148px;
  }
  .error { color: var(--warn); }
  button:focus-visible, input:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: 2px; }
</style>
