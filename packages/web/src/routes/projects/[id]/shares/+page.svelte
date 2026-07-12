<script lang="ts">
  import { page } from '$app/state';
  import {
    api,
    createShare,
    listShares,
    listShareViewers,
    messageFrom,
    revokeShare,
    updateShare
  } from '$lib/api.js';
  import type { Share, ShareViewer, SharePatchBody, WatermarkSpec } from '$lib/api.js';
  import { createMediaCache } from '$lib/asset-media.svelte.js';
  import { whenAbsolute, whenRelative } from '$lib/format.js';
  import { washFor } from '$lib/washes.js';

  type Project = { id: string; name: string; palette: string };
  type Asset = { id: string; name: string; kind: string; current_version_id?: string | null };

  const projectId = $derived(page.params.id);

  let project = $state<Project | null>(null);
  let shares = $state<Share[]>([]);
  let assets = $state<Asset[]>([]);
  let pageError = $state('');
  let listError = $state('');
  let copiedId = $state<string | null>(null);

  /* Viewer rosters, keyed by share id. Loaded lazily after the share list so
     counts appear without blocking first paint. */
  type ViewersEntry = { status: 'loading' | 'ready' | 'failed'; items: ShareViewer[] };
  let viewers = $state<Record<string, ViewersEntry>>({});
  let viewersOpen = $state<Record<string, boolean>>({});

  const media = createMediaCache();
  const observeMedia = media.observe;
  const wash = $derived(washFor(project?.palette));

  const loadViewers = async (shareId: string): Promise<void> => {
    viewers[shareId] = { status: 'loading', items: [] };
    try {
      const roster = await listShareViewers(shareId);
      viewers[shareId] = { status: 'ready', items: roster.items };
    } catch {
      viewers[shareId] = { status: 'failed', items: [] };
    }
  };

  const load = async (id: string): Promise<void> => {
    project = null; shares = []; assets = []; pageError = ''; listError = '';
    viewers = {}; viewersOpen = {};
    try {
      project = await api<Project>(`/api/v1/projects/${id}`);
    } catch (caught) {
      pageError = messageFrom(caught, 'This project is not available.');
      return;
    }
    try {
      shares = (await listShares(id)).items;
    } catch (caught) {
      listError = messageFrom(caught, 'Shares could not be loaded.');
    }
    /* Every deliverable in the project, for the create dialog's picker. */
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
    for (const share of shares) void loadViewers(share.id);
  };

  $effect(() => {
    const id = projectId;
    if (id) void load(id);
  });

  /* ---- share row helpers ---- */

  const now = Date.now();
  const shareUrl = (share: Share): string =>
    `${typeof location === 'undefined' ? '' : location.origin}/s/${share.slug}`;
  const isExpired = (share: Share): boolean =>
    share.expires_at !== null && share.expires_at <= now;
  const downloadLabel = (share: Share): string =>
    share.allow_download === 'none' ? 'No downloads' : share.allow_download === 'proxy' ? 'Proxy downloads' : 'Original downloads';

  const copyUrl = async (share: Share): Promise<void> => {
    try {
      await navigator.clipboard.writeText(shareUrl(share));
      copiedId = share.id;
      setTimeout(() => {
        if (copiedId === share.id) copiedId = null;
      }, 2000);
    } catch {
      listError = 'The link could not be copied. Copy it from the address shown.';
    }
  };

  /* ---- create and edit dialog ---- */

  type Form = {
    title: string;
    kind: 'review' | 'presentation';
    layout: 'grid' | 'list' | 'reel';
    passphrase: string;
    clearPassphrase: boolean;
    expires: string;
    allow_download: 'none' | 'proxy' | 'original';
    allow_comments: boolean;
    show_all_versions: boolean;
    watermarkOn: boolean;
    wmText: string;
    wmPosition: 'tl' | 'tr' | 'bl' | 'br' | 'center' | 'tile';
    wmOpacity: number;
    wmSize: number;
    wmBox: boolean;
  };

  const blankForm = (): Form => ({
    title: '',
    kind: 'review',
    layout: 'grid',
    passphrase: '',
    clearPassphrase: false,
    expires: '',
    allow_download: 'none',
    allow_comments: true,
    show_all_versions: false,
    watermarkOn: false,
    wmText: '{email} {date}',
    wmPosition: 'br',
    wmOpacity: 0.4,
    wmSize: 0.03,
    wmBox: false
  });

  let dialog = $state<HTMLDialogElement | null>(null);
  let editing = $state<Share | null>(null);
  let form = $state<Form>(blankForm());
  let picked = $state<string[]>([]);
  let pickFilter = $state('');
  let formError = $state('');
  let saving = $state(false);

  const pad = (value: number): string => String(value).padStart(2, '0');
  const toLocalInput = (ms: number): string => {
    const date = new Date(ms);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };

  const specOf = (share: Share): WatermarkSpec | null =>
    share.watermark_spec ? (share.watermark_spec as WatermarkSpec) : null;

  const openCreate = (): void => {
    editing = null;
    form = blankForm();
    picked = [];
    pickFilter = '';
    formError = '';
    dialog?.showModal();
  };

  const openEdit = (share: Share): void => {
    editing = share;
    const spec = specOf(share);
    form = {
      ...blankForm(),
      title: share.title,
      kind: share.kind,
      layout: share.layout,
      expires: share.expires_at === null ? '' : toLocalInput(share.expires_at),
      allow_download: share.allow_download,
      allow_comments: share.allow_comments,
      show_all_versions: share.show_all_versions,
      watermarkOn: spec !== null,
      wmText: typeof spec?.text === 'string' ? spec.text : '{email} {date}',
      wmPosition: spec?.position ?? 'br',
      wmOpacity: typeof spec?.opacity === 'number' ? spec.opacity : 0.4,
      wmSize: typeof spec?.size === 'number' ? spec.size : 0.03,
      wmBox: spec?.box === true
    };
    formError = '';
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

  const watermarkSpec = (): WatermarkSpec | null =>
    form.watermarkOn
      ? {
          text: form.wmText.trim() || '{email} {date}',
          position: form.wmPosition,
          opacity: form.wmOpacity,
          size: form.wmSize,
          box: form.wmBox
        }
      : null;

  const submitForm = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    if (saving) return;
    const id = projectId;
    if (!id) return;
    const expiresAt = form.expires ? new Date(form.expires).getTime() : null;
    saving = true;
    formError = '';
    try {
      if (editing) {
        const body: SharePatchBody = {
          title: form.title.trim(),
          layout: form.layout,
          expires_at: expiresAt,
          allow_download: form.allow_download,
          allow_comments: form.allow_comments,
          show_all_versions: form.show_all_versions,
          watermark_spec: watermarkSpec(),
          ...(form.clearPassphrase
            ? { passphrase: null }
            : form.passphrase
              ? { passphrase: form.passphrase }
              : {})
        };
        const updated = await updateShare(editing.id, body);
        shares = shares.map((share) => (share.id === updated.id ? updated : share));
      } else {
        if (picked.length === 0) {
          formError = 'Pick at least one asset to share.';
          return;
        }
        const created = await createShare({
          project_id: id,
          kind: form.kind,
          title: form.title.trim(),
          layout: form.layout,
          ...(form.passphrase ? { passphrase: form.passphrase } : {}),
          expires_at: expiresAt,
          allow_download: form.allow_download,
          allow_comments: form.allow_comments,
          show_all_versions: form.show_all_versions,
          watermark_spec: watermarkSpec(),
          asset_ids: picked
        });
        shares = [created.share, ...shares];
        void loadViewers(created.share.id);
      }
      dialog?.close();
    } catch (caught) {
      formError = messageFrom(caught, 'The share could not be saved.');
    } finally {
      saving = false;
    }
  };

  const revoke = async (share: Share): Promise<void> => {
    if (!confirm(`Revoke "${share.title}"? The link stops working immediately and cannot be reopened.`)) return;
    listError = '';
    try {
      await revokeShare(share.id);
      shares = shares.map((item) =>
        item.id === share.id ? { ...item, revoked_at: Date.now() } : item
      );
    } catch (caught) {
      listError = messageFrom(caught, 'The share could not be revoked.');
    }
  };
</script>

<svelte:head><title>Shares | {project?.name ?? 'Project'} | Onelight</title></svelte:head>

<main class="room">
  <header class="wash" style={`background-image: ${wash};`}>
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="/">Projects</a>
      <span aria-hidden="true">/</span>
      <a href={`/projects/${projectId}`}>{project?.name ?? 'Project'}</a>
    </nav>
    <p class="eyebrow">{project?.palette ?? ''}</p>
    <h1>Shares</h1>
  </header>

  {#if pageError}
    <p class="error page-error" role="alert">{pageError}</p>
  {:else}
    <div class="body">
      <div class="actions-row">
        <button type="button" onclick={openCreate}>New share</button>
        {#if listError}<p class="error" role="alert">{listError}</p>{/if}
      </div>

      {#if shares.length === 0}
        <p class="empty">No shares yet. A share is a client-facing link to a set of assets: review kind collects comments, presentation kind just plays.</p>
      {/if}

      <section class="shares" aria-label="Shares">
        {#each shares as share (share.id)}
          {@const roster = viewers[share.id]}
          {@const dead = share.revoked_at !== null || isExpired(share)}
          <article class="share" class:dead>
            <div class="head">
              <h2>{share.title}</h2>
              <span class="chip">{share.kind}</span>
              <span class="chip dim">{share.layout}</span>
              {#if share.revoked_at !== null}
                <span class="chip warn">Revoked</span>
              {:else if isExpired(share)}
                <span class="chip warn">Expired</span>
              {/if}
              <span class="grow"></span>
              {#if share.revoked_at === null}
                <button type="button" class="quiet" onclick={() => openEdit(share)}>Edit</button>
                <button type="button" class="quiet danger" onclick={() => revoke(share)}>Revoke</button>
              {/if}
            </div>
            <p class="meta">
              {downloadLabel(share)}
              <span class="sep" aria-hidden="true"></span>
              {share.allow_comments ? 'Comments on' : 'Comments off'}
              <span class="sep" aria-hidden="true"></span>
              {share.show_all_versions ? 'All versions' : 'Current version only'}
              <span class="sep" aria-hidden="true"></span>
              {share.watermark_spec ? 'Watermarked' : 'No watermark'}
              <span class="sep" aria-hidden="true"></span>
              {#if share.expires_at !== null}
                <span class="tc" title={whenRelative(share.expires_at)}>Expires {whenAbsolute(share.expires_at)}</span>
              {:else}
                No expiry
              {/if}
            </p>
            <div class="linkrow">
              <span class="url tc">{shareUrl(share)}</span>
              <button type="button" class="quiet" onclick={() => copyUrl(share)}>
                {copiedId === share.id ? 'Copied' : 'Copy link'}
              </button>
              <button
                type="button"
                class="quiet"
                aria-expanded={viewersOpen[share.id] === true}
                onclick={() => (viewersOpen[share.id] = viewersOpen[share.id] !== true)}
              >
                {roster?.status === 'ready'
                  ? `Viewers (${roster.items.length})`
                  : 'Viewers'}
              </button>
            </div>
            {#if viewersOpen[share.id]}
              <div class="viewers">
                {#if !roster || roster.status === 'loading'}
                  <p class="empty">Loading viewers.</p>
                {:else if roster.status === 'failed'}
                  <p class="empty">The viewer roster is not available.</p>
                {:else if roster.items.length === 0}
                  <p class="empty">Nobody has opened this share yet.</p>
                {:else}
                  <table>
                    <thead>
                      <tr><th>Name</th><th>Email</th><th>First seen</th><th>Last seen</th></tr>
                    </thead>
                    <tbody>
                      {#each roster.items as viewer (viewer.id)}
                        <tr title={viewer.user_agent ?? ''}>
                          <td>{viewer.name ?? 'Unnamed'}</td>
                          <td>{viewer.email ?? ''}</td>
                          <td class="tc" title={whenAbsolute(viewer.first_seen_at)}>{whenRelative(viewer.first_seen_at)}</td>
                          <td class="tc" title={whenAbsolute(viewer.last_seen_at)}>{whenRelative(viewer.last_seen_at)}</td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                {/if}
              </div>
            {/if}
          </article>
        {/each}
      </section>
    </div>
  {/if}
</main>

<dialog
  bind:this={dialog}
  aria-label={editing ? 'Edit share' : 'New share'}
  onclose={() => (editing = null)}
>
  <form method="dialog" class="share-form" onsubmit={submitForm}>
    <h2>{editing ? 'Edit share' : 'New share'}</h2>

    <label class="field">Title
      <input bind:value={form.title} required maxlength="200" />
    </label>

    <div class="pair">
      <label class="field">Kind
        {#if editing}
          <span class="fixed">{form.kind} (fixed after creation)</span>
        {:else}
          <select bind:value={form.kind}>
            <option value="review">Review: viewers can comment</option>
            <option value="presentation">Presentation: playback only</option>
          </select>
        {/if}
      </label>
      <label class="field">Layout
        <select bind:value={form.layout}>
          <option value="grid">Grid</option>
          <option value="list">List</option>
          <option value="reel">Reel</option>
        </select>
      </label>
    </div>

    {#if !editing}
      <fieldset class="pickerbox">
        <legend>Assets</legend>
        <input
          type="search"
          placeholder="Filter by name"
          aria-label="Filter assets"
          bind:value={pickFilter}
        />
        <div class="picklist" role="group" aria-label="Assets to share">
          {#if pickerAssets.length === 0}
            <p class="empty">{assets.length === 0 ? 'This project has no assets yet.' : 'Nothing matches that filter.'}</p>
          {/if}
          {#each pickerAssets as asset (asset.id)}
            {@const entry = media.entries[asset.id]}
            <label class="pick" use:observeMedia={asset}>
              <input
                type="checkbox"
                checked={picked.includes(asset.id)}
                onchange={() => togglePicked(asset.id)}
              />
              {#if entry?.media?.posterUrl}
                <img class="mini" src={entry.media.posterUrl} alt="" loading="lazy" />
              {:else}
                <span class="mini blank" aria-hidden="true"></span>
              {/if}
              <span class="pick-name">{asset.name}</span>
            </label>
          {/each}
        </div>
        <p class="hint">{picked.length} selected</p>
      </fieldset>
    {/if}

    <div class="pair">
      <label class="field">Passphrase
        <input
          type="text"
          bind:value={form.passphrase}
          placeholder={editing ? 'Unchanged' : 'None'}
          autocomplete="off"
          disabled={form.clearPassphrase}
        />
      </label>
      <label class="field">Expires
        <input type="datetime-local" bind:value={form.expires} />
      </label>
    </div>
    {#if editing}
      <label class="check">
        <input type="checkbox" bind:checked={form.clearPassphrase} />
        Remove the passphrase
      </label>
    {/if}

    <label class="field">Downloads
      <select bind:value={form.allow_download}>
        <option value="none">Not allowed</option>
        <option value="proxy">Proxy only</option>
        <option value="original">Original files</option>
      </select>
    </label>

    <label class="check">
      <input type="checkbox" bind:checked={form.allow_comments} />
      Allow comments
    </label>
    <label class="check">
      <input type="checkbox" bind:checked={form.show_all_versions} />
      Show all versions, not just the current one
    </label>

    <fieldset class="wm">
      <legend>Watermark</legend>
      <label class="check">
        <input type="checkbox" bind:checked={form.watermarkOn} />
        Burn a watermark into playback
      </label>
      {#if form.watermarkOn}
        <label class="field">Text template
          <input bind:value={form.wmText} />
        </label>
        <p class="hint">Tokens: {'{email}'} {'{name}'} {'{share}'} {'{date}'} fill in per viewer.</p>
        <div class="pair">
          <label class="field">Position
            <select bind:value={form.wmPosition}>
              <option value="tl">Top left</option>
              <option value="tr">Top right</option>
              <option value="bl">Bottom left</option>
              <option value="br">Bottom right</option>
              <option value="center">Center</option>
              <option value="tile">Tiled</option>
            </select>
          </label>
          <label class="check boxed">
            <input type="checkbox" bind:checked={form.wmBox} />
            Backing box
          </label>
        </div>
        <label class="field">Opacity
          <span class="rangewrap">
            <input type="range" min="0.05" max="1" step="0.05" bind:value={form.wmOpacity} />
            <span class="tc rangeval">{Math.round(form.wmOpacity * 100)}%</span>
          </span>
        </label>
        <label class="field">Size, fraction of frame height
          <span class="rangewrap">
            <input type="range" min="0.01" max="0.2" step="0.01" bind:value={form.wmSize} />
            <span class="tc rangeval">{Math.round(form.wmSize * 100)}%</span>
          </span>
        </label>
      {/if}
    </fieldset>

    {#if formError}<p class="error" role="alert">{formError}</p>{/if}
    <div class="dialog-actions">
      <button type="button" class="quiet" onclick={() => dialog?.close()}>Cancel</button>
      <button type="submit" disabled={saving}>{saving ? 'Saving' : editing ? 'Save changes' : 'Create share'}</button>
    </div>
  </form>
</dialog>

<style>
  .room { min-height: 100vh; background: var(--ink-000); color: var(--ink-text); font-size: var(--text-13); }
  .wash { padding: var(--pad-3) var(--pad-4) var(--pad-4); background-size: 100% 300%; background-position: 50% 0%; }
  .crumbs { display: flex; gap: 8px; color: rgba(250, 248, 244, 0.72); }
  .crumbs a { color: inherit; font-size: var(--text-13); text-decoration: none; }
  .crumbs a:hover { color: rgba(250, 248, 244, 0.96); }
  .eyebrow { margin: var(--pad-3) 0 0; color: rgba(250, 248, 244, 0.62); font-size: var(--text-13); font-weight: 500; }
  h1 { margin: 4px 0 0; font-family: var(--font-display); font-size: clamp(2rem, 5vw, var(--text-56)); font-weight: 700; letter-spacing: -0.02em; color: rgba(250, 248, 244, 0.96); }
  .body { padding: var(--pad-3) var(--pad-4) var(--pad-4); max-width: 900px; }
  .actions-row { display: flex; align-items: center; gap: 16px; margin-bottom: var(--pad-3); }

  .shares { display: grid; gap: var(--pad); }
  .share { padding: 16px 18px; border-radius: var(--radius-lg); background: var(--ink-100); display: grid; gap: 10px; }
  .share.dead { opacity: 0.65; }
  .head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  h2 { margin: 0; font-size: var(--text-16); font-weight: 600; }
  .grow { flex: 1; }
  .chip { padding: 2px 8px; border-radius: 9px; background: var(--ink-300); font-size: var(--text-12); font-weight: 500; }
  .chip.dim { background: var(--ink-200); color: var(--ink-text-dim); }
  .chip.warn { background: var(--ink-200); color: var(--warn); }
  .meta { margin: 0; color: var(--ink-text-dim); display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .sep { width: 3px; height: 3px; border-radius: 50%; background: var(--ink-300); }
  .linkrow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .url { color: var(--ink-text-dim); font-size: var(--text-13); overflow-wrap: anywhere; }
  .viewers { background: var(--ink-200); border-radius: var(--radius); padding: 10px 12px; }
  table { width: 100%; border-collapse: collapse; font-size: var(--text-13); }
  th { text-align: left; padding: 6px 10px 6px 0; color: var(--ink-text-dim); font-weight: 500; }
  td { padding: 6px 10px 6px 0; }
  td.tc, .meta .tc { font-variant-numeric: tabular-nums; }

  /* ---- dialog ---- */
  dialog { border: 0; border-radius: var(--radius-lg); background: var(--ink-100); color: var(--ink-text); padding: 0; width: min(560px, calc(100vw - 48px)); }
  dialog::backdrop { background: rgba(5, 8, 12, 0.7); }
  .share-form { padding: var(--pad-3); display: grid; gap: 14px; font-size: var(--text-13); max-height: min(80vh, 720px); overflow: auto; }
  .share-form h2 { font-size: var(--text-20); font-family: var(--font-display); }
  .field { display: grid; gap: 6px; color: var(--ink-text-dim); font-weight: 500; }
  .field input, .field select { border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 8px 10px; font-size: var(--text-13); }
  .field input:disabled { opacity: 0.5; }
  .fixed { color: var(--ink-text); font-weight: 400; padding: 8px 0; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; align-items: end; }
  .check { display: flex; align-items: center; gap: 10px; color: var(--ink-text); }
  .check.boxed { padding-bottom: 9px; }
  .check input { accent-color: var(--accent); margin: 0; }
  fieldset { border: 0; margin: 0; padding: 12px; border-radius: var(--radius); background: var(--ink-000); display: grid; gap: 10px; }
  legend { padding: 0 4px; color: var(--ink-text-dim); font-size: var(--text-13); font-weight: 600; }
  .pickerbox input[type='search'] { border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 8px 10px; font-size: var(--text-13); }
  .picklist { max-height: 220px; overflow: auto; display: grid; gap: 1px; }
  .pick { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: var(--radius); }
  .pick:hover { background: var(--ink-200); }
  .pick input { accent-color: var(--accent); margin: 0; flex: none; }
  .mini { width: 48px; height: 27px; object-fit: cover; border-radius: 2px; flex: none; }
  .mini.blank { display: block; background: var(--ink-300); }
  .pick-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rangewrap { display: flex; align-items: center; gap: 12px; }
  .rangewrap input[type='range'] { flex: 1; accent-color: var(--accent); padding: 0; background: none; }
  .rangeval { min-width: 44px; color: var(--ink-text); font-variant-numeric: tabular-nums; }
  .hint { margin: 0; color: var(--ink-text-dim); font-size: var(--text-13); }
  .dialog-actions { display: flex; justify-content: end; gap: 10px; }

  button { border: 0; border-radius: var(--radius); background: var(--accent); color: #0b1214; padding: 9px 16px; font-size: var(--text-13); font-weight: 600; }
  button:hover { background: var(--accent-bright); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.quiet { background: var(--ink-200); color: var(--ink-text); font-weight: 500; }
  button.quiet:hover { background: var(--ink-300); }
  button.danger { color: var(--warn); }
  .empty { margin: 0; color: var(--ink-text-dim); }
  .error { margin: 0; color: var(--warn); }
  .page-error { padding: var(--pad-3) var(--pad-4); }
  button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: 2px; }
</style>
