<script lang="ts">
  import { page } from '$app/state';
  import { api, apiPost, messageFrom } from '$lib/api.js';
  import { copyText } from '$lib/clipboard.js';
  import { formatBytes } from '$lib/upload.js';
  import { whenAbsolute, whenRelative } from '$lib/format.js';
  import { canonicalizePath } from '$lib/canonical.js';
  import { idFrom, pretty } from '$lib/ids.js';
  import { pageWashFor } from '$lib/washes.js';

  /* One transfer, opened.
   *
   * A link used to be a card that could only be revoked or deleted: everything
   * chosen when it was made -- what it says, what it costs to open, when it
   * stops working, which files it carries -- was final, and the only way to
   * change your mind was to make a second link and chase down whoever had the
   * first. Everything here is editable, because a deliverable changes.
   *
   * The other half is the record. A package handed to a client is exactly the
   * thing an owner needs an audit trail for, and there was none: who opened it,
   * when, and what they took were all questions the system could not answer an
   * hour after the fact. */

  type Project = { id: string; public_id: string; name: string; palette: string };
  type Asset = { id: string; name: string; kind: string };
  type Folder = { id: string; name: string };
  type Transfer = {
    id: string;
    project_id: string;
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
  type Item = {
    asset_id: string;
    name: string;
    kind: string;
    size: number | null;
    sort_order: number;
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
  type Visit = {
    id: string;
    name: string;
    first_seen_at: number;
    last_seen_at: number;
    user_agent: string | null;
    ip: string | null;
    download_count: number;
  };
  type Download = {
    id: string;
    visit_id: string | null;
    name: string;
    asset_id: string | null;
    filename: string;
    kind: 'file' | 'zip';
    bytes: number;
    user_agent: string | null;
    ip: string | null;
    created_at: number;
  };

  const routeProject = $derived(idFrom(page.params.id));
  const transferId = $derived(idFrom(page.params.transferId));

  let project = $state<Project | null>(null);
  let transfer = $state<Transfer | null>(null);
  let items = $state<Item[]>([]);
  let receipts = $state<Receipt[]>([]);
  let visits = $state<Visit[]>([]);
  let downloads = $state<Download[]>([]);
  let assets = $state<Asset[]>([]);
  let folders = $state<Folder[]>([]);
  let pageError = $state('');
  let notice = $state('');
  let copied = $state(false);

  const projectPath = $derived(
    project ? pretty(project.public_id, project.name) : routeProject
  );
  const wash = $derived(pageWashFor(project?.palette));
  const url = $derived(
    transfer
      ? `${typeof location === 'undefined' ? '' : location.origin}/t/${transfer.slug}`
      : ''
  );
  const expired = $derived(
    transfer?.expires_at !== null &&
      transfer?.expires_at !== undefined &&
      transfer.expires_at <= Date.now()
  );
  const dead = $derived(Boolean(transfer && (transfer.revoked_at !== null || expired)));

  /* ---- the edit form ----
     Held apart from the loaded transfer so a half-typed expiry is not the
     truth until Save says so, and so Save can send only what moved. */
  type Draft = {
    title: string;
    message: string;
    expires: string;
    capGb: string;
    folderId: string;
  };
  let draft = $state<Draft>({ title: '', message: '', expires: '', capGb: '', folderId: '' });
  let passphrase = $state('');
  let saving = $state(false);
  let formError = $state('');

  /* A datetime-local field wants the LOCAL wall clock, and toISOString gives
     UTC: converting one to the other is what makes an expiry shift by the
     timezone offset every time the page is opened. */
  const toLocalInput = (at: number | null): string => {
    if (at === null) return '';
    const when = new Date(at);
    const pad = (value: number): string => String(value).padStart(2, '0');
    return `${String(when.getFullYear())}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:${pad(when.getMinutes())}`;
  };

  const resetDraft = (from: Transfer): void => {
    draft = {
      title: from.title,
      message: from.message,
      expires: toLocalInput(from.expires_at),
      capGb: from.byte_cap === null ? '' : String(from.byte_cap / 1_000_000_000),
      folderId: from.folder_id ?? ''
    };
    passphrase = '';
  };

  const loadRecord = async (id: string): Promise<void> => {
    try {
      const [visitPage, downloadPage] = await Promise.all([
        api<{ items: Visit[] }>(`/api/v1/transfers/${id}/visits`),
        api<{ items: Download[] }>(`/api/v1/transfers/${id}/downloads`)
      ]);
      visits = visitPage.items;
      downloads = downloadPage.items;
    } catch {
      /* Only a manager sees the record; the panel says so rather than
         turning the whole page into an error. */
      visits = [];
      downloads = [];
    }
  };

  const load = async (id: string): Promise<void> => {
    project = null;
    transfer = null;
    items = [];
    receipts = [];
    visits = [];
    downloads = [];
    pageError = '';
    notice = '';
    try {
      const detail = await api<Transfer & { items: Item[]; receipts: Receipt[] }>(
        `/api/v1/transfers/${id}`
      );
      if (id !== transferId) return;
      transfer = detail;
      items = detail.items;
      receipts = detail.receipts;
      resetDraft(detail);
      project = await api<Project>(`/api/v1/projects/${detail.project_id}`);
      canonicalizePath(
        `/projects/${pretty(project.public_id, project.name)}/transfers/${detail.id}`
      );
    } catch (caught) {
      pageError = messageFrom(caught, 'This transfer is not available.');
      return;
    }
    await loadRecord(id);
    const owner = project?.id;
    if (!owner) return;
    try {
      const collected: Asset[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 10; guard += 1) {
        const suffix: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
        const batch = await api<{ items: Asset[]; next_cursor: string | null }>(
          `/api/v1/projects/${owner}/assets?limit=200${suffix}`
        );
        collected.push(...batch.items);
        cursor = batch.next_cursor;
        if (!cursor) break;
      }
      assets = collected;
    } catch {
      /* The add-files picker reports its own empty state. */
    }
    try {
      folders = (
        await api<{ items: Folder[] }>(`/api/v1/projects/${owner}/folders?kind=assets`)
      ).items;
    } catch {
      /* The root is always available. */
    }
  };

  $effect(() => {
    const id = transferId;
    if (id) void load(id);
  });

  const patch = async (body: Record<string, unknown>): Promise<void> => {
    const current = transfer;
    if (!current) return;
    saving = true;
    formError = '';
    try {
      transfer = await api<Transfer>(`/api/v1/transfers/${current.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body)
      });
      notice = 'Saved.';
      setTimeout(() => {
        if (notice === 'Saved.') notice = '';
      }, 2400);
    } catch (caught) {
      formError = messageFrom(caught, 'The change could not be saved.');
    } finally {
      saving = false;
    }
  };

  const save = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const current = transfer;
    if (!current || saving) return;
    const body: Record<string, unknown> = {};
    if (draft.title.trim() !== current.title) body.title = draft.title.trim();
    if (draft.message.trim() !== current.message) body.message = draft.message.trim();
    const expiresAt = draft.expires ? new Date(draft.expires).getTime() : null;
    if (expiresAt !== current.expires_at) body.expires_at = expiresAt;
    if (current.kind === 'request') {
      const cap = draft.capGb.trim() ? Math.round(Number(draft.capGb) * 1_000_000_000) : null;
      if (cap !== current.byte_cap) body.byte_cap = cap;
      const folder = draft.folderId || null;
      if (folder !== current.folder_id) body.folder_id = folder;
    }
    /* An empty box is not "clear the passphrase": it is "leave it alone". The
       passphrase is cleared by the button that says so. */
    if (passphrase.trim()) body.passphrase = passphrase.trim();
    if (Object.keys(body).length === 0) {
      notice = 'Nothing changed.';
      return;
    }
    await patch(body);
    if (transfer) resetDraft(transfer);
  };

  const clearPassphrase = async (): Promise<void> => {
    await patch({ passphrase: null });
    passphrase = '';
  };

  const removeItem = async (assetId: string): Promise<void> => {
    const current = transfer;
    if (!current) return;
    try {
      await api(`/api/v1/transfers/${current.id}/items/${assetId}`, { method: 'DELETE' });
      items = items.filter((item) => item.asset_id !== assetId);
    } catch (caught) {
      formError = messageFrom(caught, 'That file could not be removed.');
    }
  };

  let adding = $state(false);
  let addFilter = $state('');
  let addPicked = $state<string[]>([]);
  const alreadyIn = $derived(new Set(items.map((item) => item.asset_id)));
  const addable = $derived.by(() => {
    const needle = addFilter.trim().toLowerCase();
    return assets
      .filter((asset) => !alreadyIn.has(asset.id))
      .filter((asset) => (needle ? asset.name.toLowerCase().includes(needle) : true));
  });

  const addFiles = async (): Promise<void> => {
    const current = transfer;
    if (!current || addPicked.length === 0) return;
    try {
      await apiPost(`/api/v1/transfers/${current.id}/items`, { asset_ids: addPicked });
      const detail = await api<Transfer & { items: Item[] }>(
        `/api/v1/transfers/${current.id}`
      );
      transfer = detail;
      items = detail.items;
      addPicked = [];
      adding = false;
    } catch (caught) {
      formError = messageFrom(caught, 'Those files could not be added.');
    }
  };

  const copyUrl = async (): Promise<void> => {
    if (await copyText(url)) {
      copied = true;
      setTimeout(() => {
        copied = false;
      }, 2000);
    } else {
      formError = 'The link could not be copied. Copy it from the address shown.';
    }
  };

  /* A user agent string is not something anyone reads; the shape of the thing
     at the other end is. The full string stays as the row's title. */
  const agentShape = (agent: string | null): string => {
    if (!agent) return 'Unknown';
    const os = /Windows/i.test(agent)
      ? 'Windows'
      : /iPhone|iPad|iOS/i.test(agent)
        ? 'iOS'
        : /Macintosh|Mac OS/i.test(agent)
          ? 'macOS'
          : /Android/i.test(agent)
            ? 'Android'
            : /Linux/i.test(agent)
              ? 'Linux'
              : '';
    const browser = /Edg\//i.test(agent)
      ? 'Edge'
      : /OPR\//i.test(agent)
        ? 'Opera'
        : /Firefox\//i.test(agent)
          ? 'Firefox'
          : /Chrome\//i.test(agent)
            ? 'Chrome'
            : /Safari\//i.test(agent)
              ? 'Safari'
              : 'Browser';
    return os ? `${browser} on ${os}` : browser;
  };

  const takenBytes = $derived(downloads.reduce((total, row) => total + row.bytes, 0));
</script>

<svelte:head><title>{transfer?.title ?? 'Transfer'} | Onelight</title></svelte:head>

<main class="room" style={`background-image: ${wash};`}>
  <header class="wash">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="/">Projects</a>
      <span aria-hidden="true">/</span>
      <a href={`/projects/${projectPath}`}>{project?.name ?? 'Project'}</a>
      <span aria-hidden="true">/</span>
      <a href={`/projects/${projectPath}/transfers`}>Transfers</a>
    </nav>
    <h1>{transfer?.title ?? 'Transfer'}</h1>
  </header>

  {#if pageError}
    <p class="error page-error" role="alert">{pageError}</p>
  {:else if transfer}
    <div class="body">
      <div class="topline">
        <span class="chip">{transfer.kind === 'package' ? 'Send' : 'Request'}</span>
        {#if transfer.has_passphrase}<span class="chip dim">Passphrase</span>{/if}
        {#if transfer.revoked_at !== null}
          <span class="chip warn">Revoked</span>
        {:else if expired}
          <span class="chip warn">Expired</span>
        {/if}
        <span class="grow"></span>
        <button
          type="button"
          class="quiet small"
          onclick={() => void patch({ revoked: transfer?.revoked_at === null })}
        >{transfer.revoked_at === null ? 'Revoke' : 'Reopen'}</button>
      </div>
      <div class="linkrow" class:dead>
        <span class="url tc">{url}</span>
        <button type="button" class="quiet small" onclick={() => void copyUrl()}>
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>

      <div class="cols">
        <section class="panel" aria-label="Settings">
          <h2>Settings</h2>
          <form onsubmit={save}>
            <label class="field">Title
              <input bind:value={draft.title} maxlength="200" required />
            </label>
            <label class="field">Message
              <textarea bind:value={draft.message} rows="3" maxlength="2000"></textarea>
            </label>
            <div class="pair">
              <label class="field">Expires
                <input type="datetime-local" bind:value={draft.expires} />
              </label>
              <label class="field">
                {transfer.has_passphrase ? 'Change passphrase' : 'Add a passphrase'}
                <input type="password" bind:value={passphrase} autocomplete="new-password" placeholder={transfer.has_passphrase ? 'Leave blank to keep it' : ''} />
              </label>
            </div>
            {#if transfer.has_passphrase}
              <p class="hint">
                <button type="button" class="linklike" onclick={() => void clearPassphrase()}>Remove the passphrase</button>
                and anyone with the link gets in.
              </p>
            {/if}
            {#if transfer.kind === 'request'}
              <div class="pair">
                <label class="field">Size limit, GB
                  <input type="number" min="0" step="0.1" bind:value={draft.capGb} placeholder="No limit" />
                </label>
                <label class="field">Files land in
                  <select bind:value={draft.folderId}>
                    <option value="">All assets</option>
                    {#each folders as folder (folder.id)}
                      <option value={folder.id}>{folder.name}</option>
                    {/each}
                  </select>
                </label>
              </div>
            {/if}
            {#if formError}<p class="error" role="alert">{formError}</p>{/if}
            <div class="rowend">
              {#if notice}<span class="hint" role="status">{notice}</span>{/if}
              <button type="submit" disabled={saving}>{saving ? 'Saving' : 'Save changes'}</button>
            </div>
          </form>
        </section>

        <section class="panel" aria-label={transfer.kind === 'package' ? 'Files' : 'Received files'}>
          {#if transfer.kind === 'package'}
            <h2>Files <span class="count">{items.length}</span></h2>
            <ul class="rows">
              {#each items as item (item.asset_id)}
                <li>
                  <span class="what" title={item.name}>{item.name}</span>
                  <span class="dimtext tc">{item.size === null ? '' : formatBytes(item.size)}</span>
                  <button type="button" class="linklike" onclick={() => void removeItem(item.asset_id)}>Remove</button>
                </li>
              {/each}
              {#if items.length === 0}
                <li class="empty">This package has no files. Add some, or it delivers nothing.</li>
              {/if}
            </ul>
            {#if adding}
              <div class="picker">
                <input type="search" bind:value={addFilter} placeholder="Filter files" aria-label="Filter files" />
                <div class="picklist">
                  {#each addable as asset (asset.id)}
                    <label class="pick">
                      <input
                        type="checkbox"
                        checked={addPicked.includes(asset.id)}
                        onchange={() => {
                          addPicked = addPicked.includes(asset.id)
                            ? addPicked.filter((id) => id !== asset.id)
                            : [...addPicked, asset.id];
                        }}
                      />
                      <span class="pick-name">{asset.name}</span>
                    </label>
                  {/each}
                  {#if addable.length === 0}
                    <p class="empty">Nothing left to add.</p>
                  {/if}
                </div>
                <div class="rowend">
                  <button type="button" class="quiet small" onclick={() => { adding = false; addPicked = []; }}>Cancel</button>
                  <button type="button" class="small" disabled={addPicked.length === 0} onclick={() => void addFiles()}>
                    Add {addPicked.length || ''}
                  </button>
                </div>
              </div>
            {:else}
              <button type="button" class="quiet small" onclick={() => { adding = true; addFilter = ''; }}>Add files</button>
            {/if}
          {:else}
            <h2>Received <span class="count">{receipts.length}</span></h2>
            <ul class="rows">
              {#each receipts as receipt (receipt.id)}
                <li>
                  <span class="who">{receipt.sender_name}</span>
                  <span class="what" title={receipt.filename}>{receipt.filename}</span>
                  <span class="dimtext tc">{formatBytes(receipt.size)}</span>
                  <span class="dimtext">{receipt.status === 'completed' ? 'Received' : receipt.status === 'quarantined' ? 'Failed verification' : receipt.status}</span>
                </li>
              {/each}
              {#if receipts.length === 0}
                <li class="empty">Nothing received yet.</li>
              {/if}
            </ul>
          {/if}
        </section>
      </div>

      <section class="panel wide" aria-label="Who opened this">
        <h2>Opened by <span class="count">{visits.length}</span></h2>
        {#if visits.length === 0}
          <p class="empty">Nobody has opened this link yet. Anyone who does is recorded here.</p>
        {:else}
          <div class="scroll-x">
            <table>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">First opened</th>
                  <th scope="col">Last seen</th>
                  <th scope="col">Downloads</th>
                  <th scope="col">Device</th>
                  {#if visits.some((visit) => visit.ip)}<th scope="col">Address</th>{/if}
                </tr>
              </thead>
              <tbody>
                {#each visits as visit (visit.id)}
                  <tr>
                    <td>{visit.name}</td>
                    <td class="tc" title={whenRelative(visit.first_seen_at)}>{whenAbsolute(visit.first_seen_at)}</td>
                    <td class="tc" title={whenRelative(visit.last_seen_at)}>{whenAbsolute(visit.last_seen_at)}</td>
                    <td class="tc">{visit.download_count}</td>
                    <td title={visit.user_agent ?? ''}>{agentShape(visit.user_agent)}</td>
                    {#if visits.some((row) => row.ip)}<td class="tc">{visit.ip ?? 'not recorded'}</td>{/if}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
        {#if project && !visits.some((visit) => visit.ip)}
          <p class="hint">
            Addresses are not recorded for this project. Turn that on in
            <a href={`/projects/${projectPath}/settings`}>project settings</a> if you need them.
          </p>
        {/if}
      </section>

      {#if transfer.kind === 'package'}
        <section class="panel wide" aria-label="What has been downloaded">
          <h2>
            Downloads <span class="count">{downloads.length}</span>
            {#if downloads.length}<span class="dimtext tc">{formatBytes(takenBytes)} taken</span>{/if}
          </h2>
          {#if downloads.length === 0}
            <p class="empty">Nothing has been downloaded yet.</p>
          {:else}
            <div class="scroll-x">
              <table>
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Who</th>
                    <th scope="col">What</th>
                    <th scope="col">Size</th>
                    {#if downloads.some((row) => row.ip)}<th scope="col">Address</th>{/if}
                  </tr>
                </thead>
                <tbody>
                  {#each downloads as row (row.id)}
                    <tr>
                      <td class="tc" title={whenRelative(row.created_at)}>{whenAbsolute(row.created_at)}</td>
                      <td>{row.name}</td>
                      <td title={row.filename}>
                        {row.filename || (row.kind === 'zip' ? 'Everything, as a zip' : 'A file')}
                        {#if row.kind === 'zip'}<span class="chip dim">zip</span>{/if}
                      </td>
                      <td class="tc">{formatBytes(row.bytes)}</td>
                      {#if downloads.some((other) => other.ip)}<td class="tc">{row.ip ?? 'not recorded'}</td>{/if}
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        </section>
      {/if}
    </div>
  {/if}
</main>

<style>
  .room { min-height: calc(100vh - var(--topbar-h, 0px)); background-color: var(--ink-000); background-repeat: repeat, no-repeat; color: var(--ink-text); font-size: var(--text-13); padding-bottom: var(--pad-4); }
  .wash { padding: var(--pad-3) var(--pad-4) var(--pad-4); }
  .crumbs { display: flex; gap: 8px; color: rgba(250, 248, 244, 0.72); flex-wrap: wrap; }
  .crumbs a { color: inherit; font-size: var(--text-13); text-decoration: none; }
  .crumbs a:hover { color: rgba(250, 248, 244, 0.96); }
  h1 { margin: var(--pad-3) 0 0; font-family: var(--font-display); font-size: clamp(1.6rem, 4vw, var(--text-40)); font-weight: 700; letter-spacing: -0.02em; color: rgba(250, 248, 244, 0.96); overflow-wrap: anywhere; }
  .body { padding: var(--pad-3) var(--pad-4) var(--pad-4); max-width: 1100px; display: grid; gap: var(--pad-2); }
  .topline { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .grow { flex: 1; }
  .chip { padding: 2px 8px; border-radius: 9px; background: var(--ink-300); font-size: var(--text-12); font-weight: 500; }
  .chip.dim { background: var(--ink-200); color: var(--ink-text-dim); }
  .chip.warn { background: var(--ink-200); color: var(--warn); }
  .linkrow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .linkrow.dead .url { text-decoration: line-through; }
  .url { color: var(--ink-text-dim); overflow-wrap: anywhere; }
  .tc { font-variant-numeric: tabular-nums; }

  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: var(--pad-2); align-items: start; }
  .panel { padding: 16px 18px; border-radius: var(--radius-lg); background: var(--ink-100); display: grid; gap: 12px; align-content: start; }
  h2 { margin: 0; font-size: var(--text-16); font-weight: 600; display: flex; align-items: baseline; gap: 8px; }
  .count { color: var(--ink-text-dim); font-weight: 500; font-variant-numeric: tabular-nums; }
  form { display: grid; gap: 12px; }
  .field { display: grid; gap: 6px; color: var(--ink-text-dim); font-weight: 500; }
  .field input, .field select, .field textarea { border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 8px 10px; font-size: var(--text-13); font-family: inherit; resize: vertical; }
  .field input[type='number'] { appearance: textfield; -moz-appearance: textfield; }
  .field input[type='number']::-webkit-outer-spin-button,
  .field input[type='number']::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: end; }
  .rowend { display: flex; align-items: center; justify-content: end; gap: 10px; }

  .rows { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  .rows li { display: flex; align-items: baseline; gap: 12px; }
  .rows .who { font-weight: 500; flex: none; }
  .rows .what { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dimtext { color: var(--ink-text-dim); }

  .picker { display: grid; gap: 8px; padding: 10px; border-radius: var(--radius); background: var(--ink-000); }
  .picker input[type='search'] { border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 8px 10px; font-size: var(--text-13); }
  .picklist { max-height: 220px; overflow: auto; display: grid; gap: 1px; scrollbar-width: thin; }
  .pick { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: var(--radius); }
  .pick:hover { background: var(--ink-200); }
  .pick input { accent-color: var(--accent); margin: 0; flex: none; }
  .pick-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* The record reads as a record: rows separated by value, no rules. */
  table { width: 100%; border-collapse: collapse; font-size: var(--text-13); }
  th { text-align: left; font-weight: 500; color: var(--ink-text-dim); padding: 0 14px 8px 0; white-space: nowrap; }
  td { padding: 6px 14px 6px 0; vertical-align: baseline; }
  tbody tr:nth-child(odd) td { background: var(--ink-000); }
  td:first-child, th:first-child { padding-left: 8px; }
  tbody tr td:first-child { border-radius: var(--radius) 0 0 var(--radius); }
  tbody tr td:last-child { border-radius: 0 var(--radius) var(--radius) 0; }

  .hint { margin: 0; color: var(--ink-text-dim); }
  .hint a { color: var(--accent-bright); }
  .linklike { border: 0; background: none; padding: 0; color: var(--ink-text-dim); text-decoration: underline; cursor: pointer; font-size: var(--text-13); font-weight: 400; }
  .linklike:hover { color: var(--ink-text); }
  .empty { margin: 0; color: var(--ink-text-dim); }
  .error { margin: 0; color: var(--warn); }
  .page-error { padding: var(--pad-3) var(--pad-4); }

  button { border: 0; border-radius: var(--radius); background: var(--accent); color: #0b1214; padding: 9px 16px; font-size: var(--text-13); font-weight: 600; }
  button:hover { background: var(--accent-bright); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.quiet { background: var(--ink-200); color: var(--ink-text); font-weight: 500; }
  button.quiet:hover { background: var(--ink-300); }
  button.small { padding: 6px 12px; }
  button:focus-visible, a:focus-visible, input:focus-visible, textarea:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: 2px; }
  select:focus-visible { outline: none; background: var(--ink-300); }

  @media (max-width: 1080px) {
    .cols { grid-template-columns: 1fr; }
  }
  @media (max-width: 720px) {
    .wash, .body { padding-left: var(--pad-2); padding-right: var(--pad-2); }
    .pair { grid-template-columns: 1fr; }
  }
</style>
