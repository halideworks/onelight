<script lang="ts">
  /* Searchable single select over a small option list (used for the
     upload-time "New version of" picker). Keyboard: type to filter, arrows
     move, Enter picks, Escape closes, clear button resets. */

  interface Option {
    id: string;
    name: string;
  }

  interface Props {
    options: Option[];
    value: string | null;
    label: string;
    placeholder?: string;
    disabled?: boolean;
  }

  let {
    options,
    value = $bindable(),
    label,
    placeholder = 'Search assets',
    disabled = false
  }: Props = $props();

  const LIMIT = 40;

  let query = $state('');
  let open = $state(false);
  let active = $state(0);

  const selected = $derived(options.find((option) => option.id === value) ?? null);
  const matches = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    const hits = needle
      ? options.filter((option) => option.name.toLowerCase().includes(needle))
      : options;
    return hits.slice(0, LIMIT);
  });

  const openList = (): void => {
    if (disabled) return;
    open = true;
    active = 0;
  };

  const close = (): void => {
    open = false;
    query = '';
  };

  const pick = (option: Option): void => {
    value = option.id;
    close();
  };

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) openList();
      else active = Math.min(matches.length - 1, active + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      active = Math.max(0, active - 1);
    } else if (event.key === 'Enter') {
      if (!open) return;
      event.preventDefault();
      const option = matches[active];
      if (option) pick(option);
    } else if (event.key === 'Escape') {
      if (!open) return;
      event.stopPropagation();
      close();
    }
  };
</script>

<div class="picker">
  <input
    type="text"
    role="combobox"
    aria-label={label}
    aria-expanded={open}
    aria-autocomplete="list"
    aria-controls="asset-select-list"
    placeholder={selected ? selected.name : placeholder}
    class:filled={selected !== null && !open}
    value={open ? query : (selected?.name ?? '')}
    {disabled}
    oninput={(event) => {
      query = (event.currentTarget as HTMLInputElement).value;
      openList();
      active = 0;
    }}
    onfocus={openList}
    onblur={close}
    onkeydown={onKeydown}
  />
  {#if selected && !disabled}
    <button
      type="button"
      class="clear"
      aria-label={`Clear, currently ${selected.name}`}
      onclick={() => {
        value = null;
        close();
      }}
    >Clear</button>
  {/if}
  {#if open}
    <div class="list" id="asset-select-list" role="listbox" aria-label={label}>
      {#if matches.length === 0}
        <p class="none">No matching assets.</p>
      {/if}
      {#each matches as option, index (option.id)}
        <button
          type="button"
          role="option"
          aria-selected={option.id === value}
          class="option"
          class:active={index === active}
          tabindex="-1"
          onpointerdown={(event) => {
            /* Before blur closes the list. */
            event.preventDefault();
            pick(option);
          }}
        >{option.name}</button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .picker { position: relative; min-width: 0; }
  input {
    width: 100%;
    border: 0;
    border-radius: var(--radius);
    background: var(--ink-200);
    color: var(--ink-text);
    padding: 7px 60px 7px 10px;
    font-size: var(--text-13);
  }
  input::placeholder { color: var(--ink-text-dim); }
  input.filled::placeholder { color: var(--ink-text); }
  input:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
  .clear {
    position: absolute;
    right: 4px;
    top: 50%;
    transform: translateY(-50%);
    border: 0;
    border-radius: 2px;
    background: none;
    color: var(--ink-text-dim);
    padding: 3px 7px;
    font-size: var(--text-13);
  }
  .clear:hover { background: var(--ink-300); color: var(--ink-text); }
  .list {
    position: absolute;
    z-index: 20;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    max-height: 240px;
    overflow: auto;
    border-radius: var(--radius);
    background: var(--ink-300);
    padding: 4px;
    display: grid;
    gap: 1px;
  }
  .option {
    border: 0;
    border-radius: 2px;
    background: none;
    color: var(--ink-text);
    padding: 7px 9px;
    font-size: var(--text-13);
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .option:hover,
  .option.active { background: var(--ink-200); }
  .option[aria-selected='true'] { color: var(--accent-bright); }
  .none { margin: 0; padding: 7px 9px; color: var(--ink-text-dim); font-size: var(--text-13); }
  button:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: -1px; }
</style>
