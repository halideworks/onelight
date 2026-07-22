<script lang="ts">
  import { PALETTES } from '@onelight/core';
  import { page } from '$app/state';
  import { api, apiDelete, apiPatch, listShareViewers, messageFrom, revokeShare, updateShare } from '$lib/api.js';
  import type { Share, SharePatchBody, ShareViewer, WatermarkSpec } from '$lib/api.js';
  import { askConfirm } from '$lib/confirm.svelte.js';
  import { copyText } from '$lib/clipboard.js';
  import { createMediaCache } from '$lib/asset-media.svelte.js';
  import { whenAbsolute, whenRelative } from '$lib/format.js';
  import { canonicalizePath } from '$lib/canonical.js';
  import { idFrom, pretty } from '$lib/ids.js';
  import { pageWashFor, pageWashFromStops, washFor } from '$lib/washes.js';
  import Slider from '@onelight/player/Slider.svelte';

  /* One share, one page. The old flow was a list of every share with a dialog
     of twenty settings behind an Edit button: to change one thing about one
     share you had to find it, open the dialog, and hold the whole form in your
     head. Here the share's link leads -- copying it is the page's number one
     job -- and each setting sits in its own panel and saves as it changes. */

  type Project = { id: string; public_id: string; name: string; palette: string };
  type Asset = { id: string; public_id: string; name: string; kind: string; current_version_id?: string | null };

  const routeProjectId = $derived(idFrom(page.params.id));
  const routeShareId = $derived(idFrom(page.params.shareId));
  /* Canonical ULIDs once the share loads; the route may carry short public
     ids, which only the two bootstrap fetches understand. */
  let projectId = $state<string | null>(null);
  let shareId = $state<string | null>(null);

  let project = $state<Project | null>(null);
  const projectPath = $derived(
    project ? pretty(project.public_id, project.name) : routeProjectId
  );
  let share = $state<Share | null>(null);
  let assets = $state<Asset[]>([]);
  let viewers = $state<ShareViewer[] | null>(null);
  let pageError = $state('');
  let error = $state('');
  let saved = $state('');
  let copied = $state(false);

  const media = createMediaCache();
  const observeMedia = media.observe;
  const wash = $derived(pageWashFor(project?.palette));

  const shareUrl = $derived(
    share ? `${typeof location === 'undefined' ? '' : location.origin}/s/${share.slug}` : ''
  );
  const expired = $derived(Boolean(share?.expires_at && share.expires_at <= Date.now()));
  const dead = $derived(Boolean(share?.revoked_at) || expired);

  const load = async (routeRef: string): Promise<void> => {
    project = null; share = null; assets = []; viewers = null;
    pageError = ''; error = ''; saved = '';
    projectId = null; shareId = null;
    try {
      const [loadedShare, loadedProject] = await Promise.all([
        api<Share>(`/api/v1/shares/${routeRef}`),
        api<Project>(`/api/v1/projects/${routeProjectId}`)
      ]);
      if (routeRef !== routeShareId) return;
      share = loadedShare;
      project = loadedProject;
      shareId = loadedShare.id;
      projectId = loadedProject.id;
      canonicalizePath(
        `/projects/${pretty(loadedProject.public_id, loadedProject.name)}/shares/${pretty(loadedShare.public_id, loadedShare.title)}`
      );
    } catch (caught) {
      pageError = messageFrom(caught, 'This share is not available.');
      return;
    }
    const canonicalShare = shareId;
    const canonicalProject = projectId;
    if (!canonicalShare || !canonicalProject) return;
    try {
      const loaded = await api<{ items: Asset[] }>(
        `/api/v1/projects/${canonicalProject}/assets?share_id=${encodeURIComponent(canonicalShare)}&limit=200`
      );
      if (routeRef === routeShareId) assets = loaded.items;
    } catch {
      /* The contents panel reports the empty list itself. */
    }
    try {
      const roster = await listShareViewers(canonicalShare);
      if (routeRef === routeShareId) viewers = roster.items;
    } catch {
      viewers = null;
    }
  };

  $effect(() => {
    const id = routeShareId;
    if (id) void load(id);
  });

  /* Every setting saves as it changes, the way project settings do: there is
     no draft state worth defending, and a Save button under one select is
     furniture. The watermark is the one exception below. */
  const patch = async (body: SharePatchBody, note: string): Promise<void> => {
    if (!share) return;
    try {
      share = await updateShare(share.id, body);
      error = '';
      saved = note;
      setTimeout(() => {
        if (saved === note) saved = '';
      }, 1600);
    } catch (caught) {
      error = messageFrom(caught, 'That change could not be saved.');
    }
  };

  const copyUrl = async (): Promise<void> => {
    if (!(await copyText(shareUrl))) {
      error = 'The link could not be copied. Copy it from the address shown.';
      return;
    }
    error = '';
    copied = true;
    setTimeout(() => {
      copied = false;
    }, 2000);
  };

  /* ---- title, renamed in place ---- */

  let renaming = $state(false);
  let renameValue = $state('');

  const focusInput = (element: HTMLInputElement): void => {
    element.focus();
    element.select();
  };

  const commitRename = async (): Promise<void> => {
    const next = renameValue.trim();
    renaming = false;
    if (!share || !next || next === share.title) return;
    await patch({ title: next }, 'Name saved');
  };

  /* ---- expiry and passphrase ---- */

  const pad = (value: number): string => String(value).padStart(2, '0');
  const toLocalInput = (ms: number): string => {
    const date = new Date(ms);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };

  const onExpiryChange = (value: string): void => {
    const ms = value ? new Date(value).getTime() : null;
    void patch({ expires_at: ms }, ms ? 'Expiry saved' : 'Expiry removed');
  };

  let passphrase = $state('');

  const setPassphrase = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const next = passphrase.trim();
    if (!next) return;
    await patch({ passphrase: next }, 'Passphrase set');
    passphrase = '';
  };

  const clearPassphrase = async (): Promise<void> => {
    await patch({ passphrase: null }, 'Passphrase removed');
  };

  /* ---- appearance: the room the viewer walks into ---- */

  /* The brand crosses the wire as a loose record; this is the shape the
     share room reads (washes + player). */
  type Brand = {
    palette?: string;
    colors?: [string, string];
    player?: 'full' | 'simple';
  };

  const brandOf = (current: Share | null): Brand => {
    const raw = current?.brand;
    if (!raw || typeof raw !== 'object') return {};
    return raw as Brand;
  };

  /* Replace the whole brand: it is one small object, and field-wise merging
     on the server would turn "pick a palette" into "keep the stale custom
     colours too". An empty result clears the row. */
  const patchBrand = async (next: Brand, note: string): Promise<void> => {
    const cleaned: Brand = {
      ...(next.palette ? { palette: next.palette } : {}),
      ...(next.colors ? { colors: next.colors } : {}),
      ...(next.player === 'simple' ? { player: 'simple' } : {})
    };
    await patch(
      { brand: Object.keys(cleaned).length ? cleaned : null } as SharePatchBody,
      note
    );
  };

  let customA = $state('#16283a');
  let customB = $state('#e7dfc8');
  /* Seed the pickers from the share whenever it (re)loads. */
  $effect(() => {
    const brand = brandOf(share);
    if (brand.colors) {
      customA = brand.colors[0];
      customB = brand.colors[1];
    }
  });

  const washPreview = $derived.by(() => {
    const brand = brandOf(share);
    if (brand.colors) return pageWashFromStops(brand.colors[0], brand.colors[1]);
    return pageWashFor(brand.palette ?? null);
  });

  /* ---- curation: order and membership of the reel ---- */

  let draggingAsset = $state<string | null>(null);
  let dropBefore = $state<string | null>(null);

  const persistOrder = async (ordered: Asset[]): Promise<void> => {
    if (!share) return;
    try {
      await apiPatch(`/api/v1/shares/${share.id}/assets`, {
        asset_ids: ordered.map((asset) => asset.id)
      });
      assets = ordered;
      error = '';
      saved = 'Order saved';
      setTimeout(() => {
        if (saved === 'Order saved') saved = '';
      }, 1600);
    } catch (caught) {
      error = messageFrom(caught, 'The order could not be saved.');
    }
  };

  /* Touch has no HTML5 drag: the arrows do the same move one step at a
     time, and they are the only reorder surface a phone gets. */
  const moveAsset = (asset: Asset, delta: number): void => {
    const at = assets.findIndex((entry) => entry.id === asset.id);
    const to = at + delta;
    if (at < 0 || to < 0 || to >= assets.length) return;
    const ordered = [...assets];
    ordered.splice(at, 1);
    ordered.splice(to, 0, asset);
    void persistOrder(ordered);
  };

  const dropOn = (targetId: string | null): void => {
    const dragged = draggingAsset;
    draggingAsset = null;
    dropBefore = null;
    if (!dragged || dragged === targetId) return;
    const without = assets.filter((asset) => asset.id !== dragged);
    const moved = assets.find((asset) => asset.id === dragged);
    if (!moved) return;
    const at = targetId ? without.findIndex((asset) => asset.id === targetId) : without.length;
    const ordered = [...without.slice(0, at < 0 ? without.length : at), moved, ...without.slice(at < 0 ? without.length : at)];
    void persistOrder(ordered);
  };

  const removeAsset = async (asset: Asset): Promise<void> => {
    if (!share) return;
    if (
      !(await askConfirm({
        title: `Take "${asset.name}" out of this share?`,
        body: 'The asset itself is untouched; it just stops being in this reel.',
        confirmLabel: 'Remove',
        danger: true
      }))
    )
      return;
    try {
      await apiDelete(`/api/v1/shares/${share.id}/assets/${asset.id}`);
      assets = assets.filter((entry) => entry.id !== asset.id);
      error = '';
    } catch (caught) {
      error = messageFrom(caught, 'It could not be removed.');
    }
  };

  /* ---- the logo (brand, design doc section 11) ---- */

  let logoUploading = $state(false);

  const uploadLogo = async (event: Event): Promise<void> => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !share) return;
    logoUploading = true;
    try {
      const response = await fetch(`/api/v1/shares/${share.id}/logo`, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? 'The logo could not be uploaded.');
      }
      share = await api<Share>(`/api/v1/shares/${share.id}`);
      error = '';
      saved = 'Logo saved';
      setTimeout(() => {
        if (saved === 'Logo saved') saved = '';
      }, 1600);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'The logo could not be uploaded.';
    } finally {
      logoUploading = false;
    }
  };

  const removeLogo = async (): Promise<void> => {
    if (!share) return;
    try {
      const response = await fetch(`/api/v1/shares/${share.id}/logo`, { method: 'DELETE' });
      if (!response.ok) throw new Error('The logo could not be removed.');
      share = await api<Share>(`/api/v1/shares/${share.id}`);
      error = '';
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'The logo could not be removed.';
    }
  };

  /* ---- watermark ---- */

  /* The one setting with an Apply button: changing the spec re-renders every
     clip in the share, so it must not fire per slider tick. */
  const specOf = (current: Share | null): WatermarkSpec | null =>
    current?.watermark_spec ? (current.watermark_spec as WatermarkSpec) : null;

  let wmOpen = $state(false);
  let wmText = $state('{share} {date}');
  let wmPosition = $state<'tl' | 'tr' | 'bl' | 'br' | 'center' | 'tile'>('br');
  let wmOpacity = $state(0.4);
  let wmSize = $state(0.03);
  let wmBox = $state(false);

  /* Seed the controls from the share whenever it (re)loads. */
  $effect(() => {
    const spec = specOf(share);
    wmOpen = spec !== null;
    if (spec) {
      wmText = typeof spec.text === 'string' ? spec.text : '{share} {date}';
      wmPosition = spec.position ?? 'br';
      wmOpacity = typeof spec.opacity === 'number' ? spec.opacity : 0.4;
      wmSize = typeof spec.size === 'number' ? spec.size : 0.03;
      wmBox = spec.box === true;
    }
  });

  const wmDirty = $derived.by(() => {
    const spec = specOf(share);
    if (!wmOpen) return spec !== null;
    if (!spec) return true;
    return (
      (typeof spec.text === 'string' ? spec.text : '{share} {date}') !== wmText.trim() ||
      (spec.position ?? 'br') !== wmPosition ||
      (typeof spec.opacity === 'number' ? spec.opacity : 0.4) !== wmOpacity ||
      (typeof spec.size === 'number' ? spec.size : 0.03) !== wmSize ||
      (spec.box === true) !== wmBox
    );
  });

  const applyWatermark = async (): Promise<void> => {
    await patch(
      {
        watermark_spec: wmOpen
          ? {
              text: wmText.trim() || '{share} {date}',
              position: wmPosition,
              opacity: wmOpacity,
              size: wmSize,
              box: wmBox
            }
          : null
      },
      wmOpen ? 'Watermark applied' : 'Watermark removed'
    );
  };

  /* ---- revoke ---- */

  const revoke = async (): Promise<void> => {
    if (!share) return;
    if (
      !(await askConfirm({
        title: `Revoke "${share.title}"?`,
        body: 'The link stops working immediately and cannot be reopened.',
        confirmLabel: 'Revoke',
        danger: true
      }))
    )
      return;
    try {
      await revokeShare(share.id);
      share = { ...share, revoked_at: Date.now() };
      error = '';
    } catch (caught) {
      error = messageFrom(caught, 'The share could not be revoked.');
    }
  };
</script>

<svelte:head><title>{share?.title ?? 'Share'} | {project?.name ?? 'Project'} | Onelight</title></svelte:head>

<main class="room" style={`background-image: ${wash};`}>
  <header class="wash">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="/">Projects</a>
      <span aria-hidden="true">/</span>
      <a href={`/projects/${projectPath}`}>{project?.name ?? 'Project'}</a>
      <span aria-hidden="true">/</span>
      <a href={`/projects/${projectPath}/shares`}>Shares</a>
    </nav>
    {#if share}
      <div class="titlerow">
        {#if renaming}
          <input
            class="titleedit"
            bind:value={renameValue}
            use:focusInput
            aria-label={`Rename ${share.title}`}
            maxlength="200"
            onkeydown={(event) => {
              if (event.key === 'Enter') void commitRename();
              else if (event.key === 'Escape') renaming = false;
            }}
            onblur={() => void commitRename()}
          />
        {:else}
          <h1>
            <button
              type="button"
              class="titletext"
              title="Click to rename"
              onclick={() => {
                renameValue = share?.title ?? '';
                renaming = true;
              }}
            >{share.title}</button>
          </h1>
        {/if}
      </div>
      <p class="chips">
        <span class="chip">{share.kind}</span>
        <span class="chip dim">{share.layout}</span>
        {#if share.revoked_at !== null}
          <span class="chip warn">Revoked</span>
        {:else if expired}
          <span class="chip warn">Expired</span>
        {/if}
        {#if viewers}
          <span class="chip dim">{viewers.length} {viewers.length === 1 ? 'viewer' : 'viewers'}</span>
        {/if}
        {#if saved}<span class="saved" aria-live="polite">{saved}</span>{/if}
      </p>
    {/if}
  </header>

  {#if pageError}
    <p class="error page-error" role="alert">{pageError}</p>
  {:else if share}
    <div class="body">
      {#if error}<p class="error" role="alert">{error}</p>{/if}

      <!-- The link is what a share is. It leads, at full width, with the one
           accent button on the page beside it. -->
      <section class="linkcard" class:dead aria-label="Share link">
        <span class="url tc">{shareUrl}</span>
        <span class="linkacts">
          <button type="button" class="copy" onclick={() => void copyUrl()}>
            {copied ? 'Copied' : 'Copy link'}
          </button>
          <a class="openlink" href={shareUrl} target="_blank" rel="noopener">Open</a>
        </span>
        {#if dead}
          <p class="deadnote" role="status">
            {share.revoked_at !== null
              ? 'This share is revoked: the link no longer opens.'
              : 'This share has expired: the link no longer opens.'}
          </p>
        {/if}
      </section>

      <div class="panels">
        <div class="duo">
        <!-- One panel for what a viewer can do, one for how the room looks:
             Viewing and Access as two thin panels beside the tall Appearance
             left a field of dead air under them, and dead air is the one
             thing empty space here is not allowed to be. -->
        <section class="panel" aria-label="Access and viewing">
          <h2>Access and viewing</h2>
          <div class="pair">
            <label class="field">Layout
              <select
                value={share.layout}
                onchange={(event) => void patch({ layout: event.currentTarget.value as Share['layout'] }, 'Layout saved')}
              >
                <option value="grid">Grid</option>
                <option value="list">List</option>
                <option value="reel">Reel</option>
              </select>
            </label>
            <label class="field">Downloads
              <select
                value={share.allow_download}
                onchange={(event) => void patch({ allow_download: event.currentTarget.value as Share['allow_download'] }, 'Downloads saved')}
              >
                <option value="none">Not allowed</option>
                <option value="proxy">Proxy only</option>
                <option value="original">Original files</option>
              </select>
            </label>
          </div>
          <label class="check">
            <input
              type="checkbox"
              checked={share.allow_comments}
              onchange={(event) => void patch({ allow_comments: event.currentTarget.checked }, 'Comments saved')}
            />
            Allow comments
          </label>
          <label class="check">
            <input
              type="checkbox"
              checked={share.allow_approvals}
              onchange={(event) => void patch({ allow_approvals: event.currentTarget.checked }, 'Approvals saved')}
            />
            Approve / request changes
          </label>
          <label class="check">
            <input
              type="checkbox"
              checked={share.show_all_versions}
              onchange={(event) => void patch({ show_all_versions: event.currentTarget.checked }, 'Versions saved')}
            />
            Show all versions, not just the current one
          </label>
          <label class="field">Expires
            <input
              type="datetime-local"
              value={share.expires_at === null ? '' : toLocalInput(share.expires_at)}
              onchange={(event) => onExpiryChange(event.currentTarget.value)}
            />
          </label>
          <form class="field" onsubmit={setPassphrase}>
            <span class="fieldname">Passphrase</span>
            <span class="passrow">
              <input
                type="text"
                bind:value={passphrase}
                placeholder="Set a new passphrase"
                autocomplete="off"
                aria-label="New passphrase"
              />
              <button type="submit" class="quiet" disabled={!passphrase.trim()}>Set</button>
            </span>
            <!-- The wire never says whether one is set: the hash stays on the
                 server. So the controls speak in verbs, not state. -->
            <button type="button" class="quiet clearpass" onclick={() => void clearPassphrase()}>
              Remove any passphrase
            </button>
          </form>
        </section>

        <section class="panel" aria-label="Appearance">
          <h2>Appearance</h2>
          <p class="sub">The room this link opens: its colours, and which player the viewer gets.</p>
          <!-- The wash preview is the setting's own receipt: what the client's
               page draws, drawn here. -->
          <span class="washpreview" style={`background-image: ${washPreview};`} aria-hidden="true"></span>
          <div class="swatches" role="group" aria-label="Share colours">
            {#each PALETTES as palette (palette)}
              <button
                type="button"
                class="swatch"
                class:active={brandOf(share).palette === palette && !brandOf(share).colors}
                aria-pressed={brandOf(share).palette === palette && !brandOf(share).colors}
                aria-label={palette}
                title={palette}
                style={`background-image: ${washFor(palette)};`}
                onclick={() => void patchBrand({ ...brandOf(share), palette, colors: undefined }, 'Colours saved')}
              ></button>
            {/each}
          </div>
          <div class="customwash">
            <label class="colorpick">
              <input type="color" bind:value={customA} aria-label="Custom wash, top colour" />
              <span class="tc">{customA}</span>
            </label>
            <label class="colorpick">
              <input type="color" bind:value={customB} aria-label="Custom wash, second colour" />
              <span class="tc">{customB}</span>
            </label>
            <button
              type="button"
              class="quiet"
              class:activechoice={Boolean(brandOf(share).colors)}
              onclick={() => void patchBrand({ ...brandOf(share), colors: [customA, customB], palette: undefined }, 'Colours saved')}
            >Use these colours</button>
            {#if brandOf(share).palette || brandOf(share).colors}
              <button type="button" class="quiet" onclick={() => void patchBrand({ ...brandOf(share), palette: undefined, colors: undefined }, 'Colours reset')}>
                Default
              </button>
            {/if}
          </div>
          <div class="logorow">
            <span class="fieldname">Logo</span>
            {#if share.logo_url}
              <img class="logopreview" src={share.logo_url} alt="" />
            {/if}
            <label class="quiet uploadish" class:disabled={logoUploading}>
              <input type="file" class="attach-hidden" accept="image/png,image/jpeg,image/webp,image/svg+xml" disabled={logoUploading} onchange={(event) => void uploadLogo(event)} />
              {logoUploading ? 'Uploading' : share.logo_url ? 'Change' : 'Upload'}
            </label>
            {#if share.logo_url}
              <button type="button" class="quiet" onclick={() => void removeLogo()}>Remove</button>
            {/if}
          </div>
          {#if share.kind === 'review'}
            <div class="playerpick" role="group" aria-label="Player">
              <span class="fieldname">Player</span>
              <label class="check">
                <input
                  type="radio"
                  name="playerchrome"
                  checked={brandOf(share).player !== 'simple'}
                  onchange={() => void patchBrand({ ...brandOf(share), player: undefined }, 'Player saved')}
                />
                <span>
                  <strong>Review</strong>
                  <small>The full instrument: marks, loops, lanes, quality.</small>
                </span>
              </label>
              <label class="check">
                <input
                  type="radio"
                  name="playerchrome"
                  checked={brandOf(share).player === 'simple'}
                  onchange={() => void patchBrand({ ...brandOf(share), player: 'simple' }, 'Player saved')}
                />
                <span>
                  <strong>Presentation</strong>
                  <small>Just the work: transport, timecode, volume, full screen. Notes still work.</small>
                </span>
              </label>
            </div>
          {:else}
            <p class="hint">Presentation shares always use the presentation player.</p>
          {/if}
        </section>

        </div>

        <section class="panel wide" aria-label="Watermark">
          <h2>Watermark</h2>
          <label class="check">
            <input type="checkbox" bind:checked={wmOpen} />
            Burn a watermark into playback
          </label>
          {#if wmOpen}
            <p class="wmnote">
              Every clip in this share is re-encoded with the watermark burned in. That takes a
              few minutes per clip, and the share shows each one as it finishes. Applying a new
              text or position re-renders them all again.
            </p>
            <div class="pair">
              <label class="field">Text template
                <input bind:value={wmText} />
              </label>
              <label class="field">Position
                <select bind:value={wmPosition}>
                  <option value="tl">Top left</option>
                  <option value="tr">Top right</option>
                  <option value="bl">Bottom left</option>
                  <option value="br">Bottom right</option>
                  <option value="center">Center</option>
                  <option value="tile">Tiled</option>
                </select>
              </label>
            </div>
            <p class="hint">
              Tokens: {'{share}'} and {'{date}'}. The burned text is the same for everyone;
              each viewer's name and email are drawn live on top of it.
            </p>
            <div class="pair">
              <span class="field">Opacity
                <span class="rangewrap">
                  <Slider
                    label="Watermark opacity"
                    min={0.05}
                    max={1}
                    step={0.05}
                    value={wmOpacity}
                    valueText={`${String(Math.round(wmOpacity * 100))} percent`}
                    oninput={(next) => { wmOpacity = next; }}
                  />
                  <span class="tc rangeval">{Math.round(wmOpacity * 100)}%</span>
                </span>
              </span>
              <span class="field">Size, fraction of frame height
                <span class="rangewrap">
                  <Slider
                    label="Watermark size"
                    min={0.01}
                    max={0.2}
                    step={0.01}
                    value={wmSize}
                    valueText={`${String(Math.round(wmSize * 100))} percent of frame height`}
                    oninput={(next) => { wmSize = next; }}
                  />
                  <span class="tc rangeval">{Math.round(wmSize * 100)}%</span>
                </span>
              </span>
            </div>
            <label class="check">
              <input type="checkbox" bind:checked={wmBox} />
              Backing box
            </label>
          {/if}
          {#if wmDirty}
            <div class="wmapply">
              <button type="button" onclick={() => void applyWatermark()}>
                {wmOpen ? 'Apply watermark' : 'Remove watermark'}
              </button>
              <span class="hint">Re-renders every clip in the share.</span>
            </div>
          {/if}
        </section>

        <section class="panel wide" aria-label="In this share">
          <h2>In this share</h2>
          {#if assets.length === 0}
            <p class="empty">Nothing is in this share yet. Add assets from the project page: select them and right-click, or drag them onto the share in the rail.</p>
          {:else}
            <p class="sub">Set the order the share plays in: drag the tiles, or use a tile's arrows.</p>
            <div class="contents">
              {#each assets as asset, index (asset.id)}
                {@const entry = media.entries[asset.id]}
                <div
                  class="contentwrap"
                  class:dropbefore={dropBefore === asset.id}
                  class:dragging={draggingAsset === asset.id}
                  role="listitem"
                  draggable="true"
                  ondragstart={(event) => {
                    draggingAsset = asset.id;
                    if (event.dataTransfer) {
                      /* Firefox refuses to start a drag whose dataTransfer
                         holds nothing. */
                      event.dataTransfer.setData('text/plain', asset.id);
                      event.dataTransfer.effectAllowed = 'move';
                    }
                  }}
                  ondragend={() => { draggingAsset = null; dropBefore = null; }}
                  ondragover={(event) => {
                    if (!draggingAsset || draggingAsset === asset.id) return;
                    event.preventDefault();
                    dropBefore = asset.id;
                  }}
                  ondragleave={() => { if (dropBefore === asset.id) dropBefore = null; }}
                  ondrop={(event) => { event.preventDefault(); dropOn(asset.id); }}
                >
                  <!-- draggable=false on the link and the poster: both are
                       natively draggable, and whichever one the pointer lands
                       on would hijack the tile's own drag with a link-drag. -->
                  <a
                    class="content"
                    href={`/projects/${projectPath}/assets/${pretty(asset.public_id, asset.name)}`}
                    title={asset.name}
                    draggable="false"
                    use:observeMedia={asset}
                  >
                    {#if entry?.media?.posterUrl}
                      <img src={entry.media.posterUrl} alt="" loading="lazy" draggable="false" />
                    {:else}
                      <span class="contentblank" aria-hidden="true"></span>
                    {/if}
                    <span class="contentname">{asset.name}</span>
                  </a>
                  <button
                    type="button"
                    class="contentdrop"
                    aria-label={`Remove ${asset.name} from this share`}
                    title="Remove from this share"
                    onclick={() => void removeAsset(asset)}
                  >×</button>
                  <span class="movers">
                    <button
                      type="button"
                      class="mover"
                      aria-label={`Move ${asset.name} earlier`}
                      disabled={index === 0}
                      onclick={() => moveAsset(asset, -1)}
                    ><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.5L5.5 8l4.5 4.5" /></svg></button>
                    <button
                      type="button"
                      class="mover"
                      aria-label={`Move ${asset.name} later`}
                      disabled={index === assets.length - 1}
                      onclick={() => moveAsset(asset, 1)}
                    ><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5L10.5 8L6 12.5" /></svg></button>
                  </span>
                </div>
              {/each}
              {#if draggingAsset}
                <div
                  class="dropend"
                  class:armed={dropBefore === null}
                  role="presentation"
                  ondragover={(event) => { event.preventDefault(); dropBefore = null; }}
                  ondrop={(event) => { event.preventDefault(); dropOn(null); }}
                >to the end</div>
              {/if}
            </div>
          {/if}
        </section>

        <section class="panel wide" aria-label="Viewers">
          <h2>Viewers</h2>
          {#if viewers === null}
            <p class="empty">The viewer roster is not available.</p>
          {:else if viewers.length === 0}
            <p class="empty">Nobody has opened this share yet.</p>
          {:else}
            <table>
              <thead>
                <tr><th>Name</th><th>Email</th><th>First seen</th><th>Last seen</th></tr>
              </thead>
              <tbody>
                {#each viewers as viewer (viewer.id)}
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
        </section>

        {#if share.revoked_at === null}
          <section class="panel wide dangerzone" aria-label="Revoke">
            <div class="dangerrow">
              <span>
                <strong>Revoke this share</strong>
                <small>The link stops working immediately and cannot be reopened.</small>
              </span>
              <button type="button" class="danger" onclick={() => void revoke()}>Revoke</button>
            </div>
          </section>
        {/if}
      </div>
    </div>
  {/if}
</main>

<style>
  /* The same room as the project and its settings: ink base, the project's
     wash resolving into it at the same height. */
  .room { position: relative; min-height: calc(100vh - var(--topbar-h, 0px)); background-color: var(--ink-000); background-repeat: repeat, no-repeat; color: var(--ink-text); font-size: var(--text-13); padding-bottom: var(--pad-4); }
  .room::before { content: ''; position: fixed; inset: 0; pointer-events: none; background: linear-gradient(180deg, rgba(13, 17, 23, 0.05) 0%, rgba(13, 17, 23, 0.45) 26%, rgba(13, 17, 23, 0.88) 58%, rgba(13, 17, 23, 0.95) 100%); }
  .room > :global(*) { position: relative; }
  .wash { padding: var(--pad-3) var(--pad-4) var(--pad-3); }
  .crumbs { display: flex; gap: 8px; color: rgba(250, 248, 244, 0.72); }
  .crumbs a { color: inherit; font-size: var(--text-13); text-decoration: none; }
  .crumbs a:hover { color: rgba(250, 248, 244, 0.96); }
  .titlerow { margin-top: var(--pad-3); }
  h1 { margin: 0; font-family: var(--font-display); font-size: clamp(2rem, 5vw, var(--text-56)); font-weight: 700; letter-spacing: -0.02em; color: rgba(250, 248, 244, 0.96); }
  /* The name is editable where it is shown; a rename behind a dialog was the
     old page's mistake. */
  .titletext { border: 0; background: none; color: inherit; font: inherit; letter-spacing: inherit; padding: 0 10px; margin: 0 -10px; border-radius: var(--radius); cursor: text; text-align: left; }
  .titletext:hover { background: rgba(13, 17, 23, 0.35); }
  .titletext:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: 2px; }
  .titleedit { width: min(720px, 90%); border: 0; border-radius: var(--radius); background: rgba(13, 17, 23, 0.55); color: rgba(250, 248, 244, 0.96); padding: 0 10px; margin: 0 -10px; font-family: var(--font-display); font-size: clamp(2rem, 5vw, var(--text-56)); font-weight: 700; letter-spacing: -0.02em; }
  .titleedit:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: 2px; }
  .chips { display: flex; align-items: center; gap: 8px; margin: 12px 0 0; }
  .chip { padding: 2px 8px; border-radius: 9px; background: rgba(13, 17, 23, 0.5); color: rgba(250, 248, 244, 0.9); font-size: var(--text-12); font-weight: 500; }
  .chip.dim { color: rgba(250, 248, 244, 0.62); }
  .chip.warn { color: var(--warn); }
  .saved { color: var(--ok); font-size: var(--text-13); }

  /* The page uses the window: panels flow into as many columns as fit, capped
     where lines would get too long to read rather than at a fixed strip. */
  .body { padding: 0 var(--pad-4); max-width: 1720px; display: grid; gap: 10px; }

  /* ---- the link card ---- */
  .linkcard { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 18px 20px; border-radius: var(--radius-lg); background: var(--ink-100); }
  .linkcard .url { flex: 1 1 320px; min-width: 0; color: var(--ink-text); font-size: var(--text-14); overflow-wrap: anywhere; }
  .linkcard.dead .url { color: var(--ink-text-dim); text-decoration: line-through; }
  .linkacts { display: flex; align-items: center; gap: 8px; }
  .copy { border: 0; border-radius: var(--radius); background: var(--accent); color: #0b1214; padding: 10px 18px; font-size: var(--text-13); font-weight: 600; }
  .copy:hover { background: var(--accent-bright); }
  .openlink { border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 10px 14px; font-size: var(--text-13); font-weight: 500; text-decoration: none; }
  .openlink:hover { background: var(--ink-300); }
  .deadnote { flex-basis: 100%; margin: 0; color: var(--warn); }

  /* ---- panels ---- */
  /* Stretch, not start: panels in one row share an edge, and a shorter panel
     is a surface with room in it rather than a hole in the page. */
  /* The two side-by-side panels get their own grid: auto-fit cannot collapse
     spare tracks while a full-width sibling spans them, which left real empty
     cells beside Appearance. Stretch inside the duo: panels in one row share
     an edge, and a shorter panel is a surface with room in it rather than a
     hole in the page. */
  /* minmax(0, 1fr), not the implicit auto track: auto's min-content floor let
     the widest panel row (a .pair of intrinsically-sized fields) set the whole
     page's width on a phone, and the page rendered desktop-wide and panned. */
  .panels { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; }
  .duo { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 10px; align-items: stretch; }
  /* Flat surfaces, one value step off the page: no gradient fills, no
     highlights, no drop shadows. */
  .panel { padding: var(--pad-2); border-radius: var(--radius-lg); background: var(--ink-100); display: grid; gap: 10px; align-content: start; }
  /* Panel names, plain case: the anti-slop list bans uppercase-tracked
     microcopy, and a heading does not need to shout to be a heading. */
  .panel h2 { margin: 0; color: var(--ink-text); font-size: var(--text-13); font-weight: 600; }

  .field { display: grid; gap: 6px; color: var(--ink-text-dim); font-weight: 500; }
  .fieldname { color: var(--ink-text-dim); font-weight: 500; }
  .sub { margin: 0; color: var(--ink-text-dim); }

  /* ---- appearance ---- */
  .washpreview { display: block; height: 72px; border-radius: var(--radius); background-color: var(--ink-000); background-size: 100% 640px; }
  .swatches { display: flex; flex-wrap: wrap; gap: 6px; }
  .swatch { width: 44px; height: 28px; padding: 0; border: 0; border-radius: var(--radius); background-size: 100% 100%; }
  .swatch.active { box-shadow: 0 0 0 2px var(--ink-100), 0 0 0 4px var(--accent-bright); }
  .customwash { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .colorpick { display: inline-flex; align-items: center; gap: 6px; color: var(--ink-text-dim); font-size: var(--text-12); }
  .colorpick input[type='color'] { width: 36px; height: 28px; padding: 2px; border: 0; border-radius: var(--radius); background: var(--ink-200); }
  .activechoice { box-shadow: 0 0 0 1px var(--accent-bright); }
  .playerpick { display: grid; gap: 6px; }
  .playerpick .check { align-items: flex-start; }
  .playerpick .check input { margin-top: 3px; }
  .playerpick .check span { display: grid; gap: 1px; }
  .playerpick .check small { color: var(--ink-text-dim); }
  .field input, .field select { border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 8px 10px; font: inherit; font-size: var(--text-13); }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; align-items: end; }
  .check { display: flex; align-items: center; gap: 10px; color: var(--ink-text); }
  .check input { accent-color: var(--accent); margin: 0; }
  .passrow { display: flex; gap: 6px; }
  .passrow input { flex: 1; min-width: 0; }
  .clearpass { justify-self: start; }
  .rangewrap { display: flex; align-items: center; gap: 12px; }
  .rangewrap > :global(.slider) { flex: 1; }
  .rangeval { min-width: 44px; color: var(--ink-text); font-variant-numeric: tabular-nums; }
  .wmnote { margin: 0; padding: 9px 11px; border-radius: var(--radius); background: color-mix(in oklab, var(--note) 14%, var(--ink-200)); color: var(--ink-text); font-size: var(--text-12); line-height: 1.5; box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--note) 30%, transparent); }
  .wmapply { display: flex; align-items: center; gap: 12px; }
  .hint { margin: 0; color: var(--ink-text-dim); font-size: var(--text-12); }

  /* ---- contents ---- */
  .contents { display: grid; grid-template-columns: repeat(auto-fill, minmax(148px, 1fr)); gap: 8px; }
  .contentwrap { position: relative; }
  .contentwrap.dragging { opacity: 0.4; }
  .contentwrap.dropbefore { outline: 2px solid var(--accent-bright); outline-offset: 2px; border-radius: var(--radius); }
  .contentdrop { position: absolute; top: 4px; right: 4px; display: none; place-items: center; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 50%; background: rgba(6, 9, 14, 0.85); color: #fff; font-size: 13px; line-height: 1; cursor: pointer; }
  .contentwrap:hover .contentdrop, .contentdrop:focus-visible { display: grid; }
  .contentdrop:hover { background: var(--warn); color: #12080a; }
  /* Reordering without a drag: fine pointers never see these — the drag is
     richer — but touch has no HTML5 drag at all, so the arrows are the only
     way a phone curates the reel. */
  .movers { display: none; position: absolute; top: 4px; left: 4px; gap: 4px; }
  .mover { display: grid; place-items: center; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 50%; background: rgba(6, 9, 14, 0.85); color: #fff; cursor: pointer; }
  .mover:disabled { opacity: 0.35; cursor: default; }
  @media (pointer: coarse) {
    .movers { display: inline-flex; }
    .contentdrop { display: grid; }
  }
  .dropend { display: grid; place-items: center; min-height: 84px; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text-dim); font-size: var(--text-12); }
  .dropend.armed { outline: 2px solid var(--accent-bright); outline-offset: -2px; }
  .logorow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .logopreview { max-height: 36px; max-width: 140px; object-fit: contain; border-radius: 2px; }
  .uploadish { display: inline-flex; align-items: center; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 8px 14px; font-size: var(--text-13); font-weight: 500; cursor: pointer; }
  .uploadish:hover { background: var(--ink-300); }
  .uploadish.disabled { opacity: 0.5; cursor: default; }
  .attach-hidden { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
  .content { display: grid; gap: 5px; color: var(--ink-text-dim); text-decoration: none; }
  .content img, .contentblank { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; display: block; border-radius: var(--radius); background: var(--ink-200); }
  .content:hover { color: var(--ink-text); }
  .contentname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-12); }

  table { width: 100%; border-collapse: collapse; font-size: var(--text-13); }
  th { text-align: left; padding: 6px 10px 6px 0; color: var(--ink-text-dim); font-weight: 500; }
  td { padding: 6px 10px 6px 0; }
  td.tc { font-variant-numeric: tabular-nums; }

  .dangerzone { background: color-mix(in oklab, var(--warn) 6%, var(--ink-100)); }
  .dangerrow { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .dangerrow span { display: grid; gap: 2px; }
  .dangerrow small { color: var(--ink-text-dim); }

  button { border: 0; border-radius: var(--radius); background: var(--accent); color: #0b1214; padding: 8px 14px; font-size: var(--text-13); font-weight: 600; }
  button:hover { background: var(--accent-bright); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.quiet { background: var(--ink-200); color: var(--ink-text); font-weight: 500; }
  button.quiet:hover { background: var(--ink-300); }
  button.danger { background: var(--warn); color: #12080a; }
  button.danger:hover { filter: brightness(1.12); }
  .empty { margin: 0; color: var(--ink-text-dim); }
  .error { margin: 0; color: var(--warn); }
  .page-error { padding: 0 var(--pad-4); }
  button:focus-visible, a:focus-visible, input:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: 2px; }
  select:focus-visible { outline: none; background: var(--ink-300); }

  /* Phone: the paired panels' 360px track minimum was the page's horizontal
     overflow — panels stack; the viewer roster becomes two-line entries
     (who, then when) instead of a four-column table sliced off-screen. */
  @media (max-width: 720px) {
    .wash { padding: var(--pad-2) var(--pad-2) var(--pad-2); }
    .body { padding: 0 var(--pad-2); }
    .page-error { padding: 0 var(--pad-2); }
    .duo { grid-template-columns: minmax(0, 1fr); }
    /* Paired fields stack: two intrinsic-width fields side by side are what
       overflowed the panel in the first place. */
    .pair { grid-template-columns: minmax(0, 1fr); }
    .field input, .field select { max-width: 100%; }
    table, tbody { display: block; }
    thead { display: none; }
    tr {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 2px 12px;
      padding: 8px 0;
      border-bottom: 1px solid var(--ink-200);
    }
    td { display: block; padding: 0; }
    td:nth-child(1) { grid-row: 1; grid-column: 1; font-weight: 500; }
    td:nth-child(2) { grid-row: 2; grid-column: 1; color: var(--ink-text-dim); overflow-wrap: anywhere; }
    td:nth-child(3) { display: none; }
    td:nth-child(4) { grid-row: 1; grid-column: 2; color: var(--ink-text-dim); }
  }
</style>
