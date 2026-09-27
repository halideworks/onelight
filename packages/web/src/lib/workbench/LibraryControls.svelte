<script lang="ts">
  import { columns, type LibraryView, type SavedView } from './library.js';
  let { value, saved, selectedId, onchange, onsave, ondelete, onrename, onapply, railWidth, onrailwidth }:
    { value: LibraryView; saved: SavedView[]; selectedId: string | null; onchange: (patch: Partial<LibraryView>) => void;
      onsave: () => void; ondelete: (id: string) => void; onrename: (id: string) => void;
      onapply: (view: LibraryView, id: string) => void; railWidth: number; onrailwidth: (width: number) => void } = $props();
  const chosen = $derived(saved.find(entry => entry.id === selectedId && JSON.stringify(entry.view) === JSON.stringify(value))?.id ?? '');
  const labels: Record<string, string> = { status: 'Status', kind: 'Kind', runtime: 'Runtime', size: 'Size', format: 'Format', versions: 'Versions', created: 'Created', updated: 'Updated' };
</script>

<section class="controls" aria-label="Library preferences">
  <div class="line">
    <label>View
      <select aria-label="Saved view" value={chosen} onchange={(event) => { const found = saved.find(v => v.id === event.currentTarget.value); if (found) onapply(found.view, found.id); }}>
        <option value="">Custom view</option>
        {#each saved as entry (entry.id)}<option value={entry.id}>{entry.name}</option>{/each}
      </select>
    </label>
    <button type="button" onclick={onsave} disabled={saved.length >= 20}>Save view</button>
    {#if chosen && saved.some(v => v.id === chosen)}
      <button type="button" onclick={() => onrename(chosen)}>Rename view</button>
      <button type="button" onclick={() => ondelete(chosen)}>Delete view</button>
    {/if}
    <span class="space"></span>
    <details>
      <summary>Display options</summary>
      <div class="options">
        <label>Density<select aria-label="Information density" value={value.density} onchange={(e) => onchange({ density: e.currentTarget.value as LibraryView['density'] })}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label>
        <label>Folder panel width<input aria-label="Folder panel width" type="range" min="180" max="360" step="10" value={railWidth} oninput={(e) => onrailwidth(Number(e.currentTarget.value))} /></label>
        <fieldset><legend>List columns</legend>
          {#each columns as column}<label class="check"><input type="checkbox" checked={value.columns.includes(column)} onchange={(e) => onchange({ columns: e.currentTarget.checked ? [...value.columns, column] : value.columns.filter(c => c !== column) })} />{labels[column]}</label>{/each}
        </fieldset>
        <p>Saved on this browser, just for you.</p>
      </div>
    </details>
  </div>
  <div class="line">
    <label>Status<select aria-label="Filter by status" value={value.status} onchange={(e) => onchange({ status: e.currentTarget.value })}><option value="">Any status</option><option value="none">Unreviewed</option><option value="in_review">In review</option><option value="approved">Approved</option><option value="changes_requested">Changes requested</option></select></label>
    <label>Kind<select aria-label="Filter by kind" value={value.kind} onchange={(e) => onchange({ kind: e.currentTarget.value })}><option value="">All media</option><option value="video">Video</option><option value="audio">Audio</option><option value="image">Image</option><option value="pdf">PDF</option><option value="file">Other files</option></select></label>
    <label>Sort<select aria-label="Sort assets" value={value.sort} onchange={(e) => onchange({ sort: e.currentTarget.value as LibraryView['sort'] })}><option value="created_at">Created</option><option value="updated_at">Updated</option><option value="name">Name</option><option value="status">Status</option></select></label>
    <button type="button" aria-label="Reverse sort direction" onclick={() => onchange({ direction: value.direction === 'asc' ? 'desc' : 'asc' })}>{value.direction === 'asc' ? 'Ascending' : 'Descending'}</button>
    {#if value.status || value.kind}<button type="button" onclick={() => onchange({ status: '', kind: '' })}>Clear filters</button>{/if}
  </div>
</section>

<style>
  .controls { margin: 16px 0; display: grid; gap: 10px; font-size: 13px; }
  .line { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  label { display: flex; align-items: center; gap: 8px; color: var(--ink-text-dim); }
  select, button, summary { border: 0; border-radius: var(--radius); padding: 8px 10px; background: var(--ink-200); color: var(--ink-text); font: inherit; }
  button, summary { cursor: pointer; }
  select:focus-visible { outline: none; background: var(--ink-300); }
  button:hover, summary:hover { background: var(--ink-300); }
  button:disabled { opacity: .45; cursor: default; }
  .space { flex: 1; }
  details { position: relative; }
  .options { position: absolute; right: 0; top: calc(100% + 6px); z-index: 25; padding: 16px; width: 280px; max-width: calc(100vw - 48px); display: grid; gap: 16px; background: var(--ink-100); border-radius: var(--radius); }
  .options > label { justify-content: space-between; flex-wrap: wrap; }
  input[type=range] { width: 100%; accent-color: var(--accent); }
  input[type=checkbox] { accent-color: var(--accent); }
  fieldset { border: 0; padding: 0; margin: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  legend { margin-bottom: 10px; }
  p { margin: 0; color: var(--ink-text-dim); }
  @media(max-width: 600px) { .space { display: none; } .options { left: 0; right: auto; } label { gap: 5px; } }
</style>
