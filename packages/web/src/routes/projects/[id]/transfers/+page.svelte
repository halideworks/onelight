<script lang="ts">
  import { page } from '$app/state';
  import { api, apiPost, messageFrom } from '$lib/api.js';
  import { copyText } from '$lib/clipboard.js';
  import { formatBytes } from '$lib/upload.js';
  import { whenAbsolute, whenRelative } from '$lib/format.js';
  import { canonicalizePath } from '$lib/canonical.js';
  import { idFrom, pretty } from '$lib/ids.js';
  import { pageWashFor } from '$lib/washes.js';

  /* The index of a project's transfer links. A package sends files out; a
     request brings files in. Cards carry their own controls: the link is the
     product, so copying it stays one click. */

  type Project = { id: string; public_id: string; name: string; palette: string };
  type Asset = { id: string; name: string; kind: string };
  type Folder = { id: string; name: string };
  type Transfer = {
    id: string;
    kind: 'package' | 'request';
    slug: string;
    title: string;
    message: string;
    has_passphrase: boolean;
    expires_at: number | null;
    byte_cap: number | null;
    folder_id: string | null;
    revoked_at: number | null;
    created_at: number;
    item_count: number;
    received_count: number;
    received_bytes: number;
  };
  type Receipt = {
    id: string;
    sender_name: string;
    filename: string;
    size: number;
    status: string;
    asset_id: string | null;
    created_at: number;
  };

  const routeId = $derived(idFrom(page.params.id));
  /* Canonical ULID once the project loads; the route may carry the short
     public id, which only the project fetch understands. */
  let projectId = $state<string | null>(null);

  let project = $state<Project | null>(null);
  const projectPath = $derived(
    project ? pretty(project.public_id, project.name) : routeId
  );
  let transfers = $state<Transfer[]>([]);
  let assets = $state<Asset[]>([]);
  let folders = $state<Folder[]>([]);
  let pageError = $state('');
  let listError = $state('');
  let copiedId = $state<string | null>(null);
  let receiptsFor = $state<Record<string, Receipt[]>>({});

  const wash = $derived(pageWashFor(project?.palette));

  const load = async (routeRef: string): Promise<void> => {
    project = null; transfers = []; assets = []; folders = [];
    pageError = ''; listError = ''; receiptsFor = {};
    projectId = null;
    let id = routeRef;
    try {
      const loaded = await api<Project>(`/api/v1/projects/${routeRef}`);
      if (routeRef !== routeId) return;
      project = loaded;
      projectId = loaded.id;
      id = loaded.id;
      canonicalizePath(`/projects/${pretty(loaded.public_id, loaded.name)}/transfers`);
    } catch (caught) {
      pageError = messageFrom(caught, 'This project is not available.');
      return;
    }
    try {
      transfers = (
        await api<{ items: Transfer[] }>(`/api/v1/transfers?project_id=${id}`)
      ).items;
    } catch (caught) {
      listError = messageFrom(caught, 'Transfers could not be loaded.');
    }
    try {
      const collected: Asset[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 10; guard += 1) {
        const suffix: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
        const batch = await api<{ items: Asset[]; next_cursor: string | null }>(
          `/api/v1/projects/${id}/assets?limit=200${suffix}`
        );
        collected.push(...batch.items);
        cursor = batch.next_cursor;
        if (!cursor) break;
      }
      if (id !== projectId) return;
      assets = collected;
    } catch {
      /* The dialog reports the empty picker itself. */
    }
    try {
      folders = (
        await api<{ items: Folder[] }>(`/api/v1/projects/${id}/folders?kind=assets`)
      ).items;
    } catch {
      /* The root is always available. */
    }
  };

  $effect(() => {
    const id = routeId;
    if (id) void load(id);
  });

  const transferUrl = (transfer: Transfer): string =>
    `${typeof location === 'undefined' ? '' : location.origin}/t/${transfer.slug}`;
  const now = Date.now();
  const isExpired = (transfer: Transfer): boolean =>
    transfer.expires_at !== null && transfer.expires_at <= now;

  const copyUrl = async (transfer: Transfer): Promise<void> => {
    if (await copyText(transferUrl(transfer))) {
      listError = '';
      copiedId = transfer.id;
      setTimeout(() => {
        if (copiedId === transfer.id) copiedId = null;
      }, 2000);
    } else {
      listError = 'The link could not be copied. Copy it from the address shown.';
    }
  };

  const patch = async (transfer: Transfer, body: Record<string, unknown>): Promise<void> => {
    try {
      const updated = await api<Transfer>(`/api/v1/transfers/${transfer.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body)
      });
      transfers = transfers.map((entry) => (entry.id === transfer.id ? updated : entry));
    } catch (caught) {
      listError = messageFrom(caught, 'The change could not be saved.');
    }
  };

  const remove = async (transfer: Transfer): Promise<void> => {
    try {
      await api(`/api/v1/transfers/${transfer.id}`, { method: 'DELETE' });
      transfers = transfers.filter((entry) => entry.id !== transfer.id);
    } catch (caught) {
      listError = messageFrom(caught, 'The transfer could not be deleted.');
    }
  };

  const toggleReceipts = async (transfer: Transfer): Promise<void> => {
    if (receiptsFor[transfer.id]) {
      const next = { ...receiptsFor };
      delete next[transfer.id];
      receiptsFor = next;
      return;
    }
    try {
      const detail = await api<{ receipts: Receipt[] }>(`/api/v1/transfers/${transfer.id}`);
      receiptsFor = { ...receiptsFor, [transfer.id]: detail.receipts };
    } catch (caught) {
      listError = messageFrom(caught, 'The received files could not be loaded.');
    }
  };

  /* ---- create dialog ---- */

  type Form = {
    kind: 'package' | 'request';
    title: string;
    message: string;
    passphrase: string;
    expires: string;
    capGb: string;
    folderId: string;
  };
  const blankForm = (kind: 'package' | 'request'): Form => ({
    kind,
    title: '',
    message: '',
    passphrase: '',
    expires: '',
    capGb: '',
    folderId: ''
  });

  let dialog = $state<HTMLDialogElement | null>(null);
  let form = $state<Form>(blankForm('package'));
  let picked = $state<string[]>([]);
  let pickFilter = $state('');
  let formError = $state('');
  let saving = $state(false);
  let createdUrl = $state('');

  const onDialogClick = (event: MouseEvent): void => {
    if (event.target === dialog) dialog?.close();
  };

  const openCreate = (kind: 'package' | 'request'): void => {
    form = blankForm(kind);
    picked = [];
    pickFilter = '';
    formError = '';
    createdUrl = '';
    dialog?.showModal();
  };

  const togglePicked = (assetId: string): void => {
    picked = picked.includes(assetId)
      ? picked.filter((id) => id !== assetId)
      : [...picked, assetId];
  };

  const pickerAssets = $derived.by(() => {
    const needle = pickFilter.trim().toLowerCase();
    return needle ? assets.filter((asset) => asset.name.toLowerCase().includes(needle)) : assets;
  });

  const submitForm = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    if (saving) return;
    const id = projectId;
    if (!id) return;
    if (form.kind === 'package' && picked.length === 0) {
      formError = 'Pick at least one file to send.';
      return;
    }
    saving = true;
    formError = '';
    try {
      const created = await apiPost<{ transfer: Transfer; url: string }>('/api/v1/transfers', {
        project_id: id,
        kind: form.kind,
        title: form.title.trim(),
        message: form.message.trim(),
        ...(form.passphrase ? { passphrase: form.passphrase } : {}),
        expires_at: form.expires ? new Date(form.expires).getTime() : null,
        ...(form.kind === 'request' && form.capGb
          ? { byte_cap: Math.round(Number(form.capGb) * 1_000_000_000) }
          : {}),
        ...(form.kind === 'request' && form.folderId ? { folder_id: form.folderId } : {}),
        ...(form.kind === 'package' ? { asset_ids: picked } : {})
      });
      transfers = [created.transfer, ...transfers];
      createdUrl = `${typeof location === 'undefined' ? '' : location.origin}/t/${created.transfer.slug}`;
      await copyText(createdUrl);
    } catch (caught) {
      formError = messageFrom(caught, 'The transfer could not be created.');
    } finally {
      saving = false;
    }
  };
</script>

<svelte:head><title>Transfers | {project?.name ?? 'Project'} | Onelight</title></svelte:head>

<main class="room" style={`background-image: ${wash};`}>
  <header class="wash">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="/">Projects</a>
      <span aria-hidden="true">/</span>
      <a href={`/projects/${projectPath}`}>{project?.name ?? 'Project'}</a>
    </nav>
    <h1>Transfers</h1>
  </header>

  {#if pageError}
    <p class="error page-error" role="alert">{pageError}</p>
  {:else}
    <div class="body">
      <div class="actions-row">
        <button type="button" onclick={() => openCreate('package')}>Send files</button>
        <button type="button" class="quiet" onclick={() => openCreate('request')}>Request files</button>
        {#if listError}<p class="error" role="alert">{listError}</p>{/if}
      </div>

      {#if transfers.length === 0}
        <p class="empty">No transfer links yet. Send files hands a set of originals to anyone with the link; Request files gives them a place to drop files into this project.</p>
      {/if}

      <section class="cards" aria-label="Transfers">
        {#each transfers as transfer (transfer.id)}
          {@const dead = transfer.revoked_at !== null || isExpired(transfer)}
          <article class="card" class:dead>
            <div class="head">
              <h2>{transfer.title}</h2>
              <span class="chip">{transfer.kind === 'package' ? 'Send' : 'Request'}</span>
              {#if transfer.has_passphrase}<span class="chip dim">Passphrase</span>{/if}
              {#if transfer.revoked_at !== null}
                <span class="chip warn">Revoked</span>
              {:else if isExpired(transfer)}
                <span class="chip warn">Expired</span>
              {/if}
              <span class="grow"></span>
              <button type="button" class="quiet small" onclick={() => void patch(transfer, { revoked: transfer.revoked_at === null })}>
                {transfer.revoked_at === null ? 'Revoke' : 'Reopen'}
              </button>
              <button type="button" class="quiet small" onclick={() => void remove(transfer)}>Delete</button>
            </div>
            <p class="meta">
              {#if transfer.kind === 'package'}
                {transfer.item_count} {transfer.item_count === 1 ? 'file' : 'files'}
              {:else}
                {transfer.received_count} received / {formatBytes(transfer.received_bytes)}{transfer.byte_cap !== null ? ` of ${formatBytes(transfer.byte_cap)}` : ''}
              {/if}
              <span class="sep" aria-hidden="true"></span>
              {#if transfer.expires_at !== null}
                <span class="tc" title={whenRelative(transfer.expires_at)}>Expires {whenAbsolute(transfer.expires_at)}</span>
              {:else}
                No expiry
              {/if}
              {#if transfer.kind === 'request'}
                <span class="sep" aria-hidden="true"></span>
                <button type="button" class="linklike" onclick={() => void toggleReceipts(transfer)}>
                  {receiptsFor[transfer.id] ? 'Hide received files' : 'Show received files'}
                </button>
              {/if}
            </p>
            {#if receiptsFor[transfer.id]}
              <ul class="receipts">
                {#if receiptsFor[transfer.id]?.length === 0}
                  <li class="empty">Nothing received yet.</li>
                {/if}
                {#each receiptsFor[transfer.id] ?? [] as receipt (receipt.id)}
                  <li>
                    <span class="who">{receipt.sender_name}</span>
                    <span class="what">{receipt.filename}</span>
                    <span class="size tc">{formatBytes(receipt.size)}</span>
                    <span class="state">{receipt.status === 'completed' ? 'Received' : receipt.status === 'quarantined' ? 'Failed verification' : receipt.status}</span>
                  </li>
                {/each}
              </ul>
            {/if}
            <div class="linkrow">
              <span class="url tc">{transferUrl(transfer)}</span>
              <button type="button" class="quiet small" onclick={() => void copyUrl(transfer)}>
                {copiedId === transfer.id ? 'Copied' : 'Copy link'}
              </button>
            </div>
          </article>
        {/each}
      </section>
    </div>
  {/if}
</main>

<dialog bind:this={dialog} aria-label="New transfer" onclick={onDialogClick}>
  <form method="dialog" class="create-form" onsubmit={submitForm}>
    {#if createdUrl}
      <h2>{form.kind === 'package' ? 'Package ready' : 'Request ready'}</h2>
      <p class="hint">The link is on your clipboard.</p>
      <p class="url tc">{createdUrl}</p>
      <div class="dialog-actions">
        <button type="button" onclick={() => dialog?.close()}>Done</button>
      </div>
    {:else}
      <h2>{form.kind === 'package' ? 'Send files' : 'Request files'}</h2>

      <label class="field">Title
        <input bind:value={form.title} required maxlength="200" placeholder={form.kind === 'package' ? 'Final deliverables' : 'Camera originals, day 3'} />
      </label>
      <label class="field">Message
        <textarea bind:value={form.message} rows="2" maxlength="2000" placeholder="Optional note shown on the page"></textarea>
      </label>

      {#if form.kind === 'package'}
        <fieldset class="pickerbox">
          <legend>Files to send</legend>
          <input
            type="search"
            placeholder="Filter by name"
            aria-label="Filter assets"
            bind:value={pickFilter}
          />
          <div class="picklist" role="group" aria-label="Files to send">
            {#if pickerAssets.length === 0}
              <p class="empty">{assets.length === 0 ? 'This project has no files yet.' : 'Nothing matches that filter.'}</p>
            {/if}
            {#each pickerAssets as asset (asset.id)}
              <label class="pick">
                <input
                  type="checkbox"
                  checked={picked.includes(asset.id)}
                  onchange={() => togglePicked(asset.id)}
                />
                <span class="pick-name">{asset.name}</span>
              </label>
            {/each}
          </div>
          <p class="hint">{picked.length} selected. Recipients get the originals.</p>
        </fieldset>
      {:else}
        <div class="pair">
          <label class="field">Files land in
            <select bind:value={form.folderId}>
              <option value="">Project root</option>
              {#each folders as folder (folder.id)}
                <option value={folder.id}>{folder.name}</option>
              {/each}
            </select>
          </label>
          <label class="field">Size limit, GB
            <input type="number" min="1" step="1" bind:value={form.capGb} placeholder="None" />
          </label>
        </div>
      {/if}

      <div class="pair">
        <label class="field">Passphrase
          <input type="text" bind:value={form.passphrase} placeholder="None" autocomplete="off" />
        </label>
        <label class="field">Expires
          <input type="datetime-local" bind:value={form.expires} />
        </label>
      </div>

      {#if formError}<p class="error" role="alert">{formError}</p>{/if}
      <div class="dialog-actions">
        <button type="button" class="quiet" onclick={() => dialog?.close()}>Cancel</button>
        <button type="submit" disabled={saving}>{saving ? 'Creating' : 'Create link'}</button>
      </div>
    {/if}
  </form>
</dialog>

<style>
  .room { min-height: calc(100vh - var(--topbar-h, 0px)); background-color: var(--ink-000); background-repeat: repeat, no-repeat; color: var(--ink-text); font-size: var(--text-13); padding-bottom: var(--pad-4); }
  .wash { padding: var(--pad-3) var(--pad-4) var(--pad-4); }
  .crumbs { display: flex; gap: 8px; color: rgba(250, 248, 244, 0.72); }
  .crumbs a { color: inherit; font-size: var(--text-13); text-decoration: none; }
  .crumbs a:hover { color: rgba(250, 248, 244, 0.96); }
  h1 { margin: var(--pad-3) 0 0; font-family: var(--font-display); font-size: clamp(2rem, 5vw, var(--text-56)); font-weight: 700; letter-spacing: -0.02em; color: rgba(250, 248, 244, 0.96); }
  .body { padding: var(--pad-3) var(--pad-4) var(--pad-4); max-width: 1100px; }
  .actions-row { display: flex; align-items: center; gap: 12px; margin-bottom: var(--pad-3); }

  .cards { display: grid; gap: var(--pad); }
  .card { padding: 16px 18px; border-radius: var(--radius-lg); background: var(--ink-100); display: grid; gap: 10px; }
  .card.dead { opacity: 0.6; }
  .head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  h2 { margin: 0; font-size: var(--text-16); font-weight: 600; }
  .grow { flex: 1; }
  .chip { padding: 2px 8px; border-radius: 9px; background: var(--ink-300); font-size: var(--text-12); font-weight: 500; }
  .chip.dim { background: var(--ink-200); color: var(--ink-text-dim); }
  .chip.warn { background: var(--ink-200); color: var(--warn); }
  .meta { margin: 0; color: var(--ink-text-dim); display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .sep { width: 3px; height: 3px; border-radius: 50%; background: var(--ink-300); }
  .tc { font-variant-numeric: tabular-nums; }
  .linkrow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .url { color: var(--ink-text-dim); font-size: var(--text-13); overflow-wrap: anywhere; }
  .linklike { border: 0; background: none; padding: 0; color: var(--ink-text-dim); text-decoration: underline; cursor: pointer; font-size: var(--text-13); }
  .linklike:hover { color: var(--ink-text); }

  .receipts { list-style: none; margin: 0; padding: 10px 12px; border-radius: var(--radius); background: var(--ink-000); display: grid; gap: 6px; }
  .receipts li { display: grid; grid-template-columns: minmax(90px, auto) 1fr auto auto; gap: 12px; align-items: baseline; }
  .receipts .who { font-weight: 500; }
  .receipts .what { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-text-dim); }
  .receipts .size, .receipts .state { color: var(--ink-text-dim); }

  dialog { border: 0; border-radius: var(--radius-lg); background: var(--ink-100); color: var(--ink-text); padding: 0; width: min(640px, calc(100vw - 48px)); box-shadow: 0 32px 80px rgba(0, 0, 0, 0.6); }
  dialog::backdrop { background: rgba(5, 8, 12, 0.72); }
  .create-form { padding: var(--pad-3); display: grid; gap: 16px; font-size: var(--text-13); max-height: min(84vh, 820px); overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--ink-300) transparent; }
  .create-form h2 { font-size: var(--text-20); font-family: var(--font-display); margin: 0 0 2px; }
  .field { display: grid; gap: 6px; color: var(--ink-text-dim); font-weight: 500; }
  .field input, .field select, .field textarea { border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 8px 10px; font-size: var(--text-13); font-family: inherit; resize: vertical; }
  /* Native number spinners do not dress for this room; the field reads as
     a plain field and takes typed digits. */
  .field input[type='number'] { appearance: textfield; -moz-appearance: textfield; }
  .field input[type='number']::-webkit-outer-spin-button,
  .field input[type='number']::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; align-items: end; }
  fieldset { border: 0; margin: 0; padding: 12px; border-radius: var(--radius); background: var(--ink-000); display: grid; gap: 10px; }
  legend { padding: 0 4px; color: var(--ink-text-dim); font-size: var(--text-13); font-weight: 600; }
  .pickerbox input[type='search'] { border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 8px 10px; font-size: var(--text-13); }
  .picklist { max-height: 220px; overflow: auto; display: grid; gap: 1px; }
  .pick { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: var(--radius); }
  .pick:hover { background: var(--ink-200); }
  .pick input { accent-color: var(--accent); margin: 0; flex: none; }
  .pick-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hint { margin: 0; color: var(--ink-text-dim); font-size: var(--text-13); }
  .dialog-actions { display: flex; justify-content: end; gap: 10px; }

  button { border: 0; border-radius: var(--radius); background: var(--accent); color: #0b1214; padding: 9px 16px; font-size: var(--text-13); font-weight: 600; }
  button:hover { background: var(--accent-bright); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.quiet { background: var(--ink-200); color: var(--ink-text); font-weight: 500; }
  button.quiet:hover { background: var(--ink-300); }
  button.small { padding: 6px 12px; }
  .empty { margin: 0; color: var(--ink-text-dim); }
  .error { margin: 0; color: var(--warn); }
  .page-error { padding: var(--pad-3) var(--pad-4); }
  button:focus-visible, a:focus-visible, input:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: 2px; }
  select:focus-visible { outline: none; background: var(--ink-300); }
</style>
