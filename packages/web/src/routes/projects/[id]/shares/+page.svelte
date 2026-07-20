<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { api, createShare, listShares, listShareViewers, messageFrom } from '$lib/api.js';
  import type { Share, ShareViewer, WatermarkSpec } from '$lib/api.js';
  import { copyText } from '$lib/clipboard.js';
  import { createMediaCache } from '$lib/asset-media.svelte.js';
  import { whenAbsolute, whenRelative } from '$lib/format.js';
  import { canonicalizePath } from '$lib/canonical.js';
  import { idFrom, pretty } from '$lib/ids.js';
  import { pageWashFor } from '$lib/washes.js';

  /* The index of a project's shares. Each share has its own page now -- the
     link, the settings, the contents, the viewers -- so a card here is a door,
     not a control panel. The one thing worth doing without leaving the list is
     copying the link, so that stays on the card. This page used to hold every
     setting of every share behind one Edit dialog, which meant changing one
     thing about one share required finding it in a list and holding a
     twenty-field form; that dialog now only creates. */

  type Project = { id: string; public_id: string; name: string; palette: string };
  type Asset = { id: string; name: string; kind: string; current_version_id?: string | null };

  const routeId = $derived(idFrom(page.params.id));
  /* Canonical ULID once the project loads; the route may carry the short
     public id, which only the project fetch understands. */
  let projectId = $state<string | null>(null);

  let project = $state<Project | null>(null);
  const projectPath = $derived(
    project ? pretty(project.public_id, project.name) : routeId
  );
  let shares = $state<Share[]>([]);
  let assets = $state<Asset[]>([]);
  let pageError = $state('');
  let listError = $state('');
  let copiedId = $state<string | null>(null);

  /* Viewer counts, keyed by share id: one number per card, the roster itself
     lives on the share's page. */
  let viewerCounts = $state<Record<string, number>>({});

  const media = createMediaCache();
  const observeMedia = media.observe;
  const wash = $derived(pageWashFor(project?.palette));

  const load = async (routeRef: string): Promise<void> => {
    project = null; shares = []; assets = []; pageError = ''; listError = '';
    viewerCounts = {}; projectId = null;
    let id = routeRef;
    try {
      const loaded = await api<Project>(`/api/v1/projects/${routeRef}`);
      if (routeRef !== routeId) return;
      project = loaded;
      projectId = loaded.id;
      id = loaded.id;
      canonicalizePath(`/projects/${pretty(loaded.public_id, loaded.name)}/shares`);
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
    for (const share of shares)
      void listShareViewers(share.id)
        .then((roster: { items: ShareViewer[] }) => {
          viewerCounts[share.id] = roster.items.length;
        })
        .catch(() => {
          /* No count on this card. */
        });
  };

  $effect(() => {
    const id = routeId;
    if (id) void load(id);
  });

  /* ---- card helpers ---- */

  const now = Date.now();
  const shareUrl = (share: Share): string =>
    `${typeof location === 'undefined' ? '' : location.origin}/s/${share.slug}`;
  const isExpired = (share: Share): boolean =>
    share.expires_at !== null && share.expires_at <= now;
  const downloadLabel = (share: Share): string =>
    share.allow_download === 'none' ? 'No downloads' : share.allow_download === 'proxy' ? 'Proxy downloads' : 'Original downloads';

  const copyUrl = async (share: Share): Promise<void> => {
    if (await copyText(shareUrl(share))) {
      listError = '';
      copiedId = share.id;
      setTimeout(() => {
        if (copiedId === share.id) copiedId = null;
      }, 2000);
    } else {
      listError = 'The link could not be copied. Copy it from the address shown.';
    }
  };

  /* ---- create dialog ---- */

  type Form = {
    title: string;
    kind: 'review' | 'presentation';
    layout: 'grid' | 'list' | 'reel';
    passphrase: string;
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
    expires: '',
    allow_download: 'none',
    allow_comments: true,
    show_all_versions: false,
    watermarkOn: false,
    wmText: '{share} {date}',
    wmPosition: 'br',
    wmOpacity: 0.4,
    wmSize: 0.03,
    wmBox: false
  });

  let dialog = $state<HTMLDialogElement | null>(null);
  let form = $state<Form>(blankForm());
  let picked = $state<string[]>([]);
  let pickFilter = $state('');
  let formError = $state('');
  let saving = $state(false);

  /* A click on the ::backdrop is dispatched with the dialog itself as target;
     anything inside the form stops at the form. Escape already closed this --
     clicking away is the same intention with a mouse. */
  const onDialogClick = (event: MouseEvent): void => {
    if (event.target === dialog) dialog?.close();
  };

  const openCreate = (): void => {
    form = blankForm();
    picked = [];
    pickFilter = '';
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
          text: form.wmText.trim() || '{share} {date}',
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
    if (picked.length === 0) {
      formError = 'Pick at least one asset to share.';
      return;
    }
    saving = true;
    formError = '';
    try {
      const created = await createShare({
        project_id: id,
        kind: form.kind,
        title: form.title.trim(),
        layout: form.layout,
        ...(form.passphrase ? { passphrase: form.passphrase } : {}),
        expires_at: form.expires ? new Date(form.expires).getTime() : null,
        allow_download: form.allow_download,
        allow_comments: form.allow_comments,
        show_all_versions: form.show_all_versions,
        watermark_spec: watermarkSpec(),
        asset_ids: picked
      });
      dialog?.close();
      /* Straight to the new share's page, where its link is the headline. */
      await goto(`/projects/${projectPath}/shares/${pretty(created.share.public_id, created.share.title)}`);
    } catch (caught) {
      formError = messageFrom(caught, 'The share could not be saved.');
    } finally {
      saving = false;
    }
  };
</script>

<svelte:head><title>Shares | {project?.name ?? 'Project'} | Onelight</title></svelte:head>

<main class="room" style={`background-image: ${wash};`}>
  <header class="wash">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="/">Projects</a>
      <span aria-hidden="true">/</span>
      <a href={`/projects/${projectPath}`}>{project?.name ?? 'Project'}</a>
    </nav>
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
          {@const dead = share.revoked_at !== null || isExpired(share)}
          <article class="share" class:dead>
            <div class="head">
              <h2>
                <!-- The stretched link: the whole card opens the share's page,
                     and the two buttons sit above it. -->
                <a class="cardlink" href={`/projects/${projectPath}/shares/${pretty(share.public_id, share.title)}`}>{share.title}</a>
              </h2>
              <span class="chip">{share.kind}</span>
              <span class="chip dim">{share.layout}</span>
              {#if share.revoked_at !== null}
                <span class="chip warn">Revoked</span>
              {:else if isExpired(share)}
                <span class="chip warn">Expired</span>
              {/if}
              <span class="grow"></span>
              {#if viewerCounts[share.id] !== undefined}
                <span class="viewercount">{viewerCounts[share.id]} {viewerCounts[share.id] === 1 ? 'viewer' : 'viewers'}</span>
              {/if}
            </div>
            <p class="meta">
              {downloadLabel(share)}
              <span class="sep" aria-hidden="true"></span>
              {share.allow_comments ? 'Comments on' : 'Comments off'}
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
              <button type="button" class="quiet raised" onclick={() => void copyUrl(share)}>
                {copiedId === share.id ? 'Copied' : 'Copy link'}
              </button>
            </div>
          </article>
        {/each}
      </section>
    </div>
  {/if}
</main>

<dialog bind:this={dialog} aria-label="New share" onclick={onDialogClick}>
  <form method="dialog" class="share-form" onsubmit={submitForm}>
    <h2>New share</h2>

    <label class="field">Title
      <input bind:value={form.title} required maxlength="200" />
    </label>

    <div class="pair">
      <label class="field">Kind
        <select bind:value={form.kind}>
          <option value="review">Review: viewers can comment</option>
          <option value="presentation">Presentation: playback only</option>
        </select>
      </label>
      <label class="field">Layout
        <select bind:value={form.layout}>
          <option value="grid">Grid</option>
          <option value="list">List</option>
          <option value="reel">Reel</option>
        </select>
      </label>
    </div>

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

    <div class="pair">
      <label class="field">Passphrase
        <input type="text" bind:value={form.passphrase} placeholder="None" autocomplete="off" />
      </label>
      <label class="field">Expires
        <input type="datetime-local" bind:value={form.expires} />
      </label>
    </div>

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
        <!-- A watermark is burned into the pixels, so every clip in the share
             has to be encoded again. Saying so here costs a sentence; finding
             out by watching a share sit on "processing" costs the meeting. -->
        <p class="wmnote">
          Every clip in this share is re-encoded with the watermark burned in. That takes a
          few minutes per clip, and the share shows each one as it finishes.
        </p>
        <label class="field">Text template
          <input bind:value={form.wmText} />
        </label>
        <p class="hint">
          Tokens: {'{share}'} and {'{date}'}. The burned text is the same for everyone,
          because it is rendered once for the whole share.
        </p>
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
      <button type="submit" disabled={saving}>{saving ? 'Creating' : 'Create share'}</button>
    </div>
  </form>
</dialog>

<style>
  /* The same page as the project and its settings: ink base, the project's
     wash resolving into it at the same height. */
  .room { min-height: calc(100vh - var(--topbar-h, 0px)); background-color: var(--ink-000); background-repeat: repeat, no-repeat; color: var(--ink-text); font-size: var(--text-13); padding-bottom: var(--pad-4); }
  .wash { padding: var(--pad-3) var(--pad-4) var(--pad-4); }
  .crumbs { display: flex; gap: 8px; color: rgba(250, 248, 244, 0.72); }
  .crumbs a { color: inherit; font-size: var(--text-13); text-decoration: none; }
  .crumbs a:hover { color: rgba(250, 248, 244, 0.96); }
  h1 { margin: var(--pad-3) 0 0; font-family: var(--font-display); font-size: clamp(2rem, 5vw, var(--text-56)); font-weight: 700; letter-spacing: -0.02em; color: rgba(250, 248, 244, 0.96); }
  .body { padding: var(--pad-3) var(--pad-4) var(--pad-4); max-width: 1100px; }
  .actions-row { display: flex; align-items: center; gap: 16px; margin-bottom: var(--pad-3); }

  .shares { display: grid; gap: var(--pad); }
  /* A card that is a door: the whole surface opens the share's page via the
     stretched title link, and lifts a little to say so. */
  .share { position: relative; padding: 16px 18px; border-radius: var(--radius-lg); background: var(--ink-100); display: grid; gap: 10px; transition: background 100ms ease; }
  .share:hover { background: var(--ink-200); }
  .share.dead { opacity: 0.6; }
  .head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  h2 { margin: 0; font-size: var(--text-16); font-weight: 600; }
  .cardlink { color: inherit; text-decoration: none; }
  .cardlink::after { content: ''; position: absolute; inset: 0; border-radius: var(--radius-lg); }
  /* The controls that are not the door sit above it. */
  .raised { position: relative; z-index: 1; }
  .grow { flex: 1; }
  .chip { padding: 2px 8px; border-radius: 9px; background: var(--ink-300); font-size: var(--text-12); font-weight: 500; }
  .chip.dim { background: var(--ink-200); color: var(--ink-text-dim); }
  .chip.warn { background: var(--ink-200); color: var(--warn); }
  .viewercount { color: var(--ink-text-dim); }
  .meta { margin: 0; color: var(--ink-text-dim); display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  /* Phone: tighter gutters, and every card wears the same face — the title
     owns its line, the chips and viewer count share the next. A short title
     used to pull its chips up beside it and no two cards matched. */
  @media (max-width: 720px) {
    .wash { padding: var(--pad-2) var(--pad-2) var(--pad-3); }
    .body { padding: var(--pad-2) var(--pad-2) var(--pad-3); }
    .actions-row { margin-bottom: var(--pad-2); }
    .head h2 { flex-basis: 100%; }
  }
  .sep { width: 3px; height: 3px; border-radius: 50%; background: var(--ink-300); }
  .linkrow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .url { color: var(--ink-text-dim); font-size: var(--text-13); overflow-wrap: anywhere; }
  .meta .tc { font-variant-numeric: tabular-nums; }

  /* ---- create dialog ---- */
  dialog { border: 0; border-radius: var(--radius-lg); background: var(--ink-100); color: var(--ink-text); padding: 0; width: min(760px, calc(100vw - 48px)); box-shadow: 0 32px 80px rgba(0, 0, 0, 0.6); }
  dialog::backdrop { background: rgba(5, 8, 12, 0.72); }
  /* The form scrolls, so it says so. A hidden scrollbar on a panel that is
     taller than it looks is how half a form goes unread. */
  .share-form { padding: var(--pad-3); display: grid; gap: 16px; font-size: var(--text-13); max-height: min(84vh, 820px); overflow-y: scroll; scrollbar-width: thin; scrollbar-color: var(--ink-300) transparent; }
  .share-form::-webkit-scrollbar { width: 10px; }
  .share-form::-webkit-scrollbar-track { background: transparent; }
  .share-form::-webkit-scrollbar-thumb { background: var(--ink-300); border-radius: 5px; border: 2px solid var(--ink-100); }
  .share-form::-webkit-scrollbar-thumb:hover { background: var(--ink-400, #33415a); }
  .share-form h2 { font-size: var(--text-20); font-family: var(--font-display); margin: 0 0 2px; }
  .wmnote { margin: -4px 0 0; padding: 9px 11px; border-radius: var(--radius); background: color-mix(in oklab, var(--note) 14%, var(--ink-200)); color: var(--ink-text); font-size: var(--text-12); line-height: 1.5; box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--note) 30%, transparent); }
  .field { display: grid; gap: 6px; color: var(--ink-text-dim); font-weight: 500; }
  .field input, .field select { border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 8px 10px; font-size: var(--text-13); }
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
  .empty { margin: 0; color: var(--ink-text-dim); }
  .error { margin: 0; color: var(--warn); }
  .page-error { padding: var(--pad-3) var(--pad-4); }
  button:focus-visible, a:focus-visible, input:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: 2px; }
  /* A dropdown never wears an outline ring; focus is the value step. */
  select:focus-visible { outline: none; background: var(--ink-300); }
</style>
