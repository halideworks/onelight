<script lang="ts">
  import { tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { api, messageFrom, type SearchPage } from '$lib/api.js';
  import { pretty } from '$lib/ids.js';
  import { auth } from '$lib/auth.svelte.js';
  import { commandState, closeCommands, openCommands, type WorkbenchCommand } from '$lib/workbench/commands.svelte.js';
  import { undo } from '$lib/workbench/undo.svelte.js';

  let { neutral = false }: { neutral?: boolean } = $props();
  let dialog = $state<HTMLDialogElement | null>(null);
  let input = $state<HTMLInputElement | null>(null);
  let query = $state('');
  let selected = $state(0);
  let hits = $state<WorkbenchCommand[]>([]);
  let busy = $state(false);
  let error = $state('');
  let request = 0;

  const navigation: WorkbenchCommand[] = [
    { id: 'nav-projects', label: 'Projects', detail: 'Go to your projects', keywords: 'home library', run: () => goto('/') },
    { id: 'nav-search', label: 'Search workspace', detail: 'Assets, comments, projects and people', run: () => goto('/search') },
    { id: 'nav-settings', label: 'Settings', detail: 'Your profile and workspace', run: () => goto('/settings') }
  ];

  const results = $derived.by(() => {
    const term = query.trim().toLocaleLowerCase();
    const contextual = [
      ...commandState.contextual,
      ...(undo.canUndo ? [{ id: 'action-undo', label: `Undo ${undo.label}`, detail: 'Recent action', run: () => undo.run() }] : []),
      ...navigation
    ].filter((command) => !term || `${command.label} ${command.detail ?? ''} ${command.keywords ?? ''}`.toLocaleLowerCase().includes(term));
    const all = [...contextual.slice(0, 12), ...hits];
    if (term.length >= 2) all.push({ id: 'nav-full-search', label: `Search workspace for "${query.trim()}"`, detail: 'See all results', run: () => goto(`/search?q=${encodeURIComponent(query.trim())}`) });
    return all;
  });

  $effect(() => {
    if (commandState.open && dialog && !dialog.open) {
      query = '';
      error = '';
      selected = 0;
      dialog.showModal();
      input?.focus();
    } else if (!commandState.open && dialog?.open) dialog.close();
  });

  $effect(() => {
    const term = query.trim();
    const open = commandState.open;
    const seq = ++request;
    hits = [];
    error = '';
    selected = 0;
    const shouldSearch = open && term.length >= 2;
    busy = shouldSearch;
    if (!shouldSearch) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const search = async (): Promise<void> => {
        try {
          const pages = await Promise.all(['projects', 'assets'].map((scope) => {
            const params = new URLSearchParams({ q: term, scope, limit: '6' });
            return api<SearchPage>(`/api/v1/search?${params}`, { signal: controller.signal });
          }));
          if (seq !== request || controller.signal.aborted) return;
          hits = pages.flatMap((result) => result.items.flatMap((hit): WorkbenchCommand[] => {
            if (hit.type === 'project') return [{ id: `project-${hit.id}`, label: hit.name, detail: 'Project', run: () => goto(`/projects/${pretty(hit.public_id, hit.name)}`) }];
            if (hit.type === 'asset') return [{ id: `asset-${hit.id}`, label: hit.name, detail: 'Asset', run: () => goto(`/projects/${hit.project_id}/assets/${pretty(hit.public_id, hit.name)}`) }];
            return [];
          }));
        } catch (caught) {
          if (seq === request && !controller.signal.aborted) error = messageFrom(caught, 'Search is unavailable. Try again.');
        } finally {
          if (seq === request && !controller.signal.aborted) busy = false;
        }
      };
      void search();
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  });

  $effect(() => {
    if (selected >= results.length) selected = Math.max(0, results.length - 1);
  });

  const execute = async (command: WorkbenchCommand): Promise<void> => {
    const owner = auth.user?.id;
    closeCommands();
    await tick();
    if (!owner || auth.user?.id !== owner) return;
    try {
      await command.run();
    } catch (caught) {
      if (auth.user?.id !== owner) return;
      openCommands();
      await tick();
      error = messageFrom(caught, 'The action could not be completed.');
    }
  };

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      selected = results.length ? (selected + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length : 0;
      document.getElementById(`command-${selected}`)?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter' && event.target === input) {
      event.preventDefault();
      event.stopPropagation();
      const command = results[selected];
      if (command) void execute(command);
    }
  };
</script>

<dialog
  bind:this={dialog}
  class:neutral
  aria-labelledby="command-title"
  onkeydown={onKeydown}
  oncancel={(event) => { event.preventDefault(); closeCommands(); }}
  onclose={() => { if (!dialog?.open) closeCommands(); }}
  onclick={(event) => { if (event.target === dialog) closeCommands(); }}
>
  <div class="palette">
    <header>
      <h2 id="command-title">Go anywhere. Keep your place.</h2>
      <button type="button" class="close" aria-label="Close command palette" onclick={closeCommands}>Esc</button>
    </header>
    <div class="query">
      <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg>
      <input
        bind:this={input}
        bind:value={query}
        role="combobox"
        aria-label="Search commands, projects and assets"
        aria-autocomplete="list"
        aria-expanded="true"
        aria-controls="command-results"
        aria-activedescendant={results[selected] ? `command-${selected}` : undefined}
        placeholder="Search commands, projects and assets"
        maxlength="200"
        autocomplete="off"
        spellcheck="false"
      />
    </div>
    <div class="results" id="command-results" role="listbox" aria-label="Commands and search results" aria-busy={busy}>
      {#each results as command, index (command.id)}
        <button
          id={`command-${index}`}
          type="button"
          role="option"
          aria-selected={selected === index}
          tabindex="-1"
          onpointermove={() => { selected = index; }}
          onclick={() => void execute(command)}
        >
          <span class="result-text"><span class="label">{command.label}</span>{#if command.detail}<span class="detail">{command.detail}</span>{/if}</span>
          {#if selected === index}<span class="enter" aria-hidden="true">Enter</span>{/if}
        </button>
      {/each}
      {#if results.length === 0 && !busy}<p class="empty">No matching commands. Type at least two characters to search the workspace.</p>{/if}
    </div>
    <footer>
      <span role="status">{error || (busy ? 'Searching workspace...' : query.trim().length >= 2 ? 'Showing matching commands and up to 12 workspace results' : 'Use arrow keys to choose, Enter to open')}</span>
    </footer>
  </div>
</dialog>

<style>
  dialog { --surface: var(--ink-100); --surface-raised: var(--ink-200); --surface-active: var(--ink-300); --text: var(--ink-text); --muted: var(--ink-text-dim); --focus: var(--accent-bright); --available-height: calc(100dvh - min(16vh, 120px) - 24px); width: min(600px, calc(100vw - 32px)); max-height: var(--available-height); margin: min(16vh, 120px) auto auto; padding: 0; border: 0; border-radius: var(--radius-lg); background: var(--surface); color: var(--text); overflow: hidden; }
  dialog.neutral { --surface: var(--n-100); --surface-raised: var(--n-200); --surface-active: var(--n-300); --text: var(--n-900); --muted: var(--n-700); --focus: var(--n-800); }
  dialog::backdrop { background: rgb(0 0 0 / 0.7); }
  .palette { display: flex; flex-direction: column; max-height: var(--available-height); }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 18px 20px 10px; }
  h2 { margin: 0; font: 500 var(--text-14) var(--font-ui); }
  .close { padding: 5px 8px; background: var(--surface-raised); color: var(--muted); border-radius: var(--radius); }
  .query { display: flex; flex: none; align-items: center; gap: 12px; margin: 4px 16px 12px; padding: 12px; background: var(--surface-raised); border-radius: var(--radius); }
  .query svg { flex: none; color: var(--muted); }
  input { flex: 1; width: 100%; min-width: 0; border: 0; padding: 0; outline: 0; background: transparent; color: var(--text); font-size: var(--text-16); }
  input::placeholder { color: var(--muted); }
  .query:focus-within { outline: 1px solid var(--focus); outline-offset: 1px; }
  .results { overflow: auto; min-height: 0; padding: 0 8px 8px; }
  button { font: inherit; font-size: var(--text-13); border: 0; cursor: pointer; }
  .results button { display: flex; align-items: center; justify-content: space-between; gap: 16px; width: 100%; padding: 11px 12px; text-align: left; background: transparent; color: var(--text); border-radius: var(--radius); }
  .results button[aria-selected='true'] { background: var(--surface-active); }
  .result-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
  .detail, .enter { color: var(--muted); }
  .detail { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .enter { flex: none; }
  footer { flex: none; padding: 12px 20px; background: var(--surface-raised); color: var(--muted); font-size: var(--text-13); line-height: 1.5; }
  .empty { padding: 12px; color: var(--muted); font-size: var(--text-13); line-height: 1.5; }
  button:focus-visible { outline: 1px solid var(--focus); outline-offset: -2px; }
  @media (max-width: 600px) { dialog { margin-top: 16px; --available-height: calc(100dvh - 32px); } header { padding-inline: 16px; } .enter { display: none; } }
  @media (pointer: coarse) { .close { min-height: 44px; min-width: 44px; } .results button { min-height: 56px; } }
</style>
