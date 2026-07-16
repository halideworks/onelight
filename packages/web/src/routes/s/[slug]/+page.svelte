<script lang="ts">
  import { tick } from 'svelte';
  import Player from '@onelight/player/Player.svelte';
  import { parseSpriteVtt } from '@onelight/player';
  import type {
    FrameAnnotation,
    PendingDrawing,
    PlayerRendition,
    SpriteCue,
    TimelineMarker,
    WatermarkOverlay
  } from '@onelight/player';
  import { page } from '$app/state';
  import { copyText } from '$lib/clipboard.js';
  import { replaceState } from '$app/navigation';
  import ProjectCover from '$lib/ProjectCover.svelte';
  import { pageWashFor, pageWashFromStops } from '$lib/washes.js';
  import { api, apiPost, ApiError, messageFrom } from '$lib/api.js';
  import { annotationsFrom, markersFrom, type ReviewComment } from '$lib/comments.js';
  import { hashtagsIn, segmentCommentBody } from '../../projects/[id]/assets/[assetId]/comment-text.js';

  type Brand = {
    palette?: string;
    colors?: [string, string];
    player?: 'full' | 'simple';
  };
  type Share = {
    title: string;
    kind: 'review' | 'presentation';
    layout: 'grid' | 'list' | 'reel';
    allow_comments: boolean;
    allow_download: 'none' | 'proxy' | 'original';
    expires_at: number | null;
    watermark_spec: Record<string, unknown> | null;
    brand: Brand | null;
  };
  type Asset = {
    id: string;
    name: string;
    kind: string;
    status: string;
    sort_order: number;
    poster_url: string | null;
    duration_seconds: number | null;
  };
  type Comment = ReviewComment;
  type AssetDetail = {
    asset: { id: string; name: string; kind: string; status: string };
    versions: Array<{
      id: string;
      media_info: Record<string, unknown>;
      renditions: Array<{ kind: string; meta: Record<string, unknown> }>;
      sources: Array<{ kind: string; url: string }>;
      sidecars?: {
        sprite?: { url: string; vtt_url: string | null } | null;
        peaks?: { url: string } | null;
      } | null;
      watermark: 'ready' | 'processing' | null;
    }>;
  };

  let share = $state<Share | null>(null);
  let assets = $state<Asset[]>([]);
  let selected = $state<Asset | null>(null);
  let previewUrl = $state('');
  let previewRate = $state<{ num: number; den: number } | null>(null);
  let previewDropFrame = $state(false);
  let previewDurationFrames = $state<number | null>(null);
  let previewRenditions = $state<PlayerRendition[]>([]);
  let previewFilmstrip = $state<{ url: string; cues: SpriteCue[] } | null>(null);
  let previewWaveformUrl = $state<string | null>(null);
  let watermarkPending = $state(false);
  let downloadNote = $state('');
  let comments = $state<Comment[]>([]);
  let passphrase = $state('');
  let viewerName = $state('');
  let viewerEmail = $state('');
  let viewerIdentity = $state<{ name: string | null; email: string | null } | null>(null);
  let bodyText = $state('');
  let locked = $state(false);
  let error = $state('');
  let currentFrame = $state(0);
  let player = $state<Player | null>(null);
  let highlightedId = $state<string | null>(null);
  let pendingDrawing = $state<PendingDrawing | null>(null);
  let activeTag = $state<string | null>(null);
  let copyNotice = $state('');
  /* Bumped whenever the preview changes; in-flight media polls compare it
     and stand down. */
  let mediaPollToken = 0;

  /* The preview is a modal dialog: it covers the share landing beneath. Track
     the element that opened it so focus can return there on close, and the
     dialog element so focus can move into it on open. */
  let previewEl = $state<HTMLElement | null>(null);
  let restoreFocusTo: HTMLElement | null = null;

  const slug = $derived(page.params.slug);

  /* The design doc's second share kind (section 11): review is comment-first,
     presentation is branded and curated. A presentation drops the tools a
     reviewer works the frame with -- the frame readout, the frame link,
     drawing -- because its viewer is a client, not a reviewer. */
  const presenting = $derived(share?.kind === 'presentation');

  /* The notes rail exists only where the share allows comments: with them
     off there is nothing to read and nothing to write, and an empty panel
     titled Comments was furniture. The picture takes the whole room. */
  const railOpen = $derived(Boolean(share?.allow_comments));

  /* Running time as a clock: 1:23, or 1:02:03 past the hour. */
  const clock = (seconds: number): string => {
    const total = Math.round(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
  };

  /* An approval state is agency language, so it stays out of a presentation.
     "none" has no chip in the app and has none here. */
  const STATUS_LABEL: Record<string, string> = {
    in_review: 'In review',
    approved: 'Approved',
    changes_requested: 'Changes requested'
  };

  /* The tile picture: the asset's poster where the pipeline has made one, and
     the app's own generated cover where it has not, so a share that is still
     transcoding shows composed tiles rather than holes. Sumimai is this page's
     wash, so those tiles belong to the page they sit on. */
  const coverFor = (asset: Asset) => ({
    id: asset.id,
    name: asset.name,
    palette: 'sumimai',
    cover_url: asset.poster_url
  });

  /* Showtime opens straight into the work: the client clicked a link to
     watch something, not to choose from a menu first. Deep links (?a=)
     still win; this only fills the silence when none is given. */
  const autoOpen = (): void => {
    if (playerChrome !== 'simple' || selected) return;
    if (new URLSearchParams(location.search).get('a')) return;
    const first = assets[0];
    if (first) void openAsset(first);
  };

  /* The page wash the rest of the app outside the review room uses, rather
     than the full-length wash this page used to draw itself with. A wash run
     the whole height of a share ends on its light stop, so the tiles and their
     names sat on dirty cream and the page looked cheap exactly where a client
     first sees it (washes.ts documents the effect). This one peaks behind the
     title and resolves into ink before the work starts.

     The share's brand decides the colours: a library palette, or two custom
     hexes run through the same grammar so a client-designed room still reads
     as this app. No brand takes the default. */
  const wash = $derived(
    share?.brand?.colors
      ? pageWashFromStops(share.brand.colors[0], share.brand.colors[1])
      : pageWashFor(share?.brand?.palette ?? null)
  );

  /* Which instrument the viewer gets. A presentation is always the simple
     player; a review share can choose it too (brand.player). */
  const playerChrome = $derived<'full' | 'simple'>(
    presenting || share?.brand?.player === 'simple' ? 'simple' : 'full'
  );

  /* Showtime is the whole beautiful room, and it follows the PLAYER choice,
     not the share kind: picking the Presentation player means the client
     experience -- wash walls, floating picture, cream controls, the carousel
     -- on any share. The two-worlds rule protects the review player, and
     only the review player; David has been explicit that presentation is the
     other world. Notes still work in showtime when the share allows them. */
  const showtime = $derived(playerChrome === 'simple');

  const tagsOf = (comment: Comment): string[] =>
    Array.isArray(comment.tags) ? comment.tags : hashtagsIn(comment.body_text);

  const visibleComments = $derived(
    activeTag === null ? comments : comments.filter((comment) => tagsOf(comment).includes(activeTag ?? ''))
  );

  /* The share bootstrap (GET /s/:slug) serializes the raw row (camelCase,
     watermark spec still as JSON text) while POST /s/:slug/access returns
     the snake_case wire shape. Normalize both into one Share. */
  const normalizeShare = (raw: unknown): Share => {
    const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const parseSpec = (): Record<string, unknown> | null => {
      const wire = record['watermark_spec'];
      if (wire && typeof wire === 'object' && !Array.isArray(wire)) return wire as Record<string, unknown>;
      const rawJson = record['watermarkSpecJson'];
      if (typeof rawJson === 'string' && rawJson) {
        try {
          const parsed: unknown = JSON.parse(rawJson);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
        } catch {
          /* Unparseable spec: no session overlay. */
        }
      }
      return null;
    };
    const parseBrand = (): Brand | null => {
      const wire = record['brand'];
      if (!wire || typeof wire !== 'object' || Array.isArray(wire)) return null;
      const raw_ = wire as Record<string, unknown>;
      const colors =
        Array.isArray(raw_['colors']) &&
        raw_['colors'].length === 2 &&
        raw_['colors'].every((color) => typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color))
          ? ([raw_['colors'][0], raw_['colors'][1]] as [string, string])
          : undefined;
      return {
        ...(typeof raw_['palette'] === 'string' ? { palette: raw_['palette'] } : {}),
        ...(colors ? { colors } : {}),
        ...(raw_['player'] === 'simple' || raw_['player'] === 'full' ? { player: raw_['player'] } : {})
      };
    };
    const expires = record['expires_at'] ?? record['expiresAt'];
    const download = record['allow_download'] ?? record['allowDownload'];
    return {
      title: typeof record['title'] === 'string' ? record['title'] : 'Shared review',
      kind: record['kind'] === 'presentation' ? 'presentation' : 'review',
      layout: record['layout'] === 'list' ? 'list' : record['layout'] === 'reel' ? 'reel' : 'grid',
      allow_comments: Boolean(record['allow_comments'] ?? record['allowComments']),
      allow_download: download === 'proxy' || download === 'original' ? download : 'none',
      expires_at: typeof expires === 'number' ? expires : null,
      watermark_spec: parseSpec(),
      brand: parseBrand()
    };
  };

  const annotations = $derived<FrameAnnotation[]>(annotationsFrom(comments));

  const markers = $derived<TimelineMarker[]>(markersFrom(comments));

  /* Session watermark: deterrent-grade only (a DOM overlay the design doc
     documents as DevTools-removable; the tamper-resistant path is the
     burned per-link rendition). Identity comes from the named-viewer access
     flow; spec fields text, position, and opacity are honored when present. */
  const watermark = $derived<WatermarkOverlay | null>(
    (() => {
      const spec = share?.watermark_spec;
      if (!spec) return null;
      const lines: string[] = [];
      if (typeof spec['text'] === 'string' && spec['text'].trim()) lines.push(spec['text'].trim());
      const identity = [viewerIdentity?.name, viewerIdentity?.email]
        .filter((part): part is string => Boolean(part && part.trim()))
        .join('  ');
      lines.push(identity || 'Review viewer');
      const position = spec['position'];
      const corner =
        position === 'top_left' || position === 'top_right' || position === 'bottom_left' ||
        position === 'bottom_right' || position === 'center'
          ? position
          : null;
      return {
        lines,
        mode: corner ? 'corner' : 'tile',
        ...(corner ? { position: corner } : {}),
        ...(typeof spec['opacity'] === 'number' ? { opacity: spec['opacity'] } : {})
      };
    })()
  );

  const loadAssets = async (currentSlug: string): Promise<void> => {
    try {
      assets = (await api<{ items: Asset[] }>(`/api/v1/s/${currentSlug}/assets`)).items;
    } catch {
      /* Bootstrap assets remain. */
    }
  };

  const load = async (currentSlug: string): Promise<void> => {
    share = null; assets = []; selected = null; previewUrl = ''; comments = []; locked = false; error = '';
    viewerIdentity = null;
    try {
      const payload = await api<{ share: unknown; viewer: unknown; assets: Asset[] }>(`/s/${currentSlug}`);
      if (currentSlug !== slug) return;
      share = normalizeShare(payload.share);
      assets = payload.assets;
      if (payload.viewer) {
        const viewer = payload.viewer as Record<string, unknown>;
        viewerIdentity = {
          name: typeof viewer['name'] === 'string' ? viewer['name'] : null,
          email: typeof viewer['email'] === 'string' ? viewer['email'] : null
        };
        await loadAssets(currentSlug);
        openFromUrl();
        autoOpen();
      }
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) locked = true;
      else error = messageFrom(caught, 'This share is not available.');
    }
  };

  /* Deep links: ?a= names the asset to open (share pages host several),
     ?f= the frame. location.search is read directly so the slug-keyed load
     effect never re-runs on our own ?f= rewrites. */
  const openFromUrl = (): void => {
    const requested = new URLSearchParams(location.search).get('a');
    if (!requested) return;
    const match = assets.find((candidate) => candidate.id === requested);
    if (match && selected?.id !== match.id) void openAsset(match, { fromUrl: true });
  };

  $effect(() => {
    const currentSlug = slug;
    if (currentSlug) void load(currentSlug);
  });

  const access = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    try {
      const payload = await apiPost<{ share?: unknown }>(`/api/v1/s/${slug}/access`, {
        passphrase: passphrase || undefined,
        name: viewerName || undefined,
        email: viewerEmail || undefined
      });
      share = payload.share ? normalizeShare(payload.share) : share;
      viewerIdentity = { name: viewerName.trim() || null, email: viewerEmail.trim() || null };
      locked = false;
      error = '';
      await loadAssets(slug ?? '');
      openFromUrl();
      autoOpen();
    } catch (caught) {
      error = messageFrom(caught, 'Access could not be granted.');
    }
  };

  const rateFrom = (detail: AssetDetail): { num: number; den: number } | null => {
    const version = detail.versions[0];
    if (!version) return null;
    const sources: Array<Record<string, unknown>> = [
      ...version.renditions.map((rendition) => rendition.meta),
      version.media_info
    ];
    for (const meta of sources) {
      const num = meta['frame_rate_num'] ?? meta['frameRateNum'];
      const den = meta['frame_rate_den'] ?? meta['frameRateDen'];
      if (typeof num === 'number' && typeof den === 'number' && num > 0 && den > 0) return { num, den };
    }
    return null;
  };

  /* GET .../media answers 200 {url} or, for watermarked shares whose burned
     rendition is still rendering, 202 {status: "processing"}. Poll quietly
     on 202; the clean proxy is never served for those shares. */
  const fetchMedia = async (asset: Asset, token: number): Promise<void> => {
    try {
      const payload = await api<{ url?: string; status?: string }>(
        `/api/v1/s/${slug}/assets/${asset.id}/media`
      );
      if (token !== mediaPollToken) return;
      if (payload.url) {
        previewUrl = payload.url;
        watermarkPending = false;
        return;
      }
      if (payload.status === 'processing') {
        watermarkPending = true;
        setTimeout(() => {
          if (token === mediaPollToken) void fetchMedia(asset, token);
        }, 4000);
      }
    } catch {
      /* No media yet: the preview shows the empty state. */
      if (token === mediaPollToken) watermarkPending = false;
    }
  };

  const openAsset = async (asset: Asset, options?: { fromUrl?: boolean }): Promise<void> => {
    /* Remember the trigger so focus returns to it when the dialog closes. */
    if (!selected && document.activeElement instanceof HTMLElement) restoreFocusTo = document.activeElement;
    selected = asset;
    previewUrl = '';
    previewRate = null;
    previewDropFrame = false;
    previewDurationFrames = null;
    previewRenditions = [];
    previewFilmstrip = null;
    previewWaveformUrl = null;
    watermarkPending = false;
    downloadNote = '';
    comments = [];
    currentFrame = 0;
    highlightedId = null;
    pendingDrawing = null;
    activeTag = null;
    mediaPollToken += 1;
    const token = mediaPollToken;
    if (!options?.fromUrl) writeAssetParam(asset.id);
    try {
      const detail = await api<AssetDetail>(`/api/v1/s/${slug}/assets/${asset.id}`);
      previewRate = rateFrom(detail);
      const version = detail.versions[0];
      const info = version?.media_info ?? {};
      previewDropFrame = Boolean(info['drop_frame'] ?? info['dropFrame']);
      const frames = info['duration_frames'] ?? info['durationFrames'];
      if (typeof frames === 'number' && frames > 0) previewDurationFrames = frames;
      /* The detail carries the playable ladder (watermark-aware) directly. */
      previewRenditions = (version?.sources ?? []).map((source) => ({
        kind: source.kind,
        url: source.url
      }));
      if (version?.watermark === 'processing') watermarkPending = true;
      /* Sidecar lanes: peaks stretch as an image, the sprite VTT carries the
         filmstrip tile geometry. Absent sidecars mean absent lanes. */
      const sidecars = version?.sidecars;
      if (token === mediaPollToken && sidecars?.peaks?.url) previewWaveformUrl = sidecars.peaks.url;
      if (sidecars?.sprite?.url && sidecars.sprite.vtt_url) {
        const spriteUrl = sidecars.sprite.url;
        try {
          const response = await fetch(sidecars.sprite.vtt_url);
          if (response.ok) {
            const cues = parseSpriteVtt(await response.text());
            if (token === mediaPollToken && cues.length) previewFilmstrip = { url: spriteUrl, cues };
          }
        } catch {
          /* No filmstrip lane on this share. */
        }
      }
    } catch {
      /* Rate stays at the player default until known. */
    }
    await fetchMedia(asset, token);
    /* With comments off there is nothing to draw: no rail, and no markers or
       annotations on the timeline either. They all derive from this list. */
    if (share?.allow_comments) {
      try {
        comments = (await api<{ items: Comment[] }>(`/api/v1/s/${slug}/assets/${asset.id}/comments`)).items;
      } catch {
        /* Comments stay empty. */
      }
    }
  };

  /* Move focus into the dialog when it opens. */
  $effect(() => {
    const el = previewEl;
    if (selected && el) el.focus();
  });

  /* Escape closes the dialog. A pending drawing owns Escape (the player exits
     draw mode), and typing in the composer must not close the room. */
  const onPreviewKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || pendingDrawing) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.isContentEditable)
    )
      return;
    event.stopPropagation();
    closePreview();
  };

  const closePreview = (): void => {
    /* Return focus to whatever opened the dialog before it unmounts. */
    const toRestore = restoreFocusTo;
    restoreFocusTo = null;
    void tick().then(() => toRestore?.focus());
    mediaPollToken += 1;
    selected = null;
    previewUrl = '';
    previewRate = null;
    previewDurationFrames = null;
    previewRenditions = [];
    previewFilmstrip = null;
    previewWaveformUrl = null;
    watermarkPending = false;
    downloadNote = '';
    comments = [];
    pendingDrawing = null;
    highlightedId = null;
    activeTag = null;
    writeAssetParam(null);
  };

  /* ---- frame deep links. The share SSE story: GET /projects/:id/events
     requires an authenticated project member, so share viewers cannot
     subscribe; comments refresh by polling instead (below). ---- */

  let paused = true;
  let lastWrittenF: number | null = null;
  let appliedF: number | null = null;
  let urlTimer: ReturnType<typeof setTimeout> | null = null;

  const writeAssetParam = (assetId: string | null): void => {
    const url = new URL(page.url.href);
    if (assetId) url.searchParams.set('a', assetId);
    else url.searchParams.delete('a');
    url.searchParams.delete('f');
    lastWrittenF = null;
    appliedF = null;
    replaceState(url, {});
  };

  $effect(() => {
    const raw = page.url.searchParams.get('f');
    const current = player;
    if (!current || !previewUrl) return;
    if (raw === null || !/^\d+$/.test(raw)) return;
    const frame = Number(raw);
    if (frame === lastWrittenF || frame === appliedF) return;
    appliedF = frame;
    current.seekToFrame(frame);
  });

  const writeFrameParam = (): void => {
    const frame = currentFrame;
    if (frame === lastWrittenF || !selected) return;
    const url = new URL(page.url.href);
    url.searchParams.set('a', selected.id);
    url.searchParams.set('f', String(frame));
    lastWrittenF = frame;
    replaceState(url, {});
  };

  /* Write only once the playhead is stable: a paused scrub drag or the
     reverse shuttle (which steps a paused element) never spams the URL. */
  const scheduleFrameParam = (): void => {
    if (urlTimer !== null) return;
    const anchor = currentFrame;
    urlTimer = setTimeout(() => {
      urlTimer = null;
      if (!paused) return;
      if (currentFrame === anchor) writeFrameParam();
      else scheduleFrameParam();
    }, 350);
  };

  $effect(() => {
    return () => {
      if (urlTimer !== null) clearTimeout(urlTimer);
    };
  });

  const copyFrameLink = async (): Promise<void> => {
    if (!selected) return;
    const url = new URL(page.url.href);
    url.searchParams.set('a', selected.id);
    url.searchParams.set('f', String(currentFrame));
    copyNotice = (await copyText(url.toString())) ? 'Link copied' : 'Copy failed';
    setTimeout(() => {
      copyNotice = '';
    }, 2000);
  };

  /* Live-ish comments: a 15 second poll while a preview is open and the tab
     is visible. Wholesale replacement is safe; the server list is the truth
     and rows are keyed by id. */
  $effect(() => {
    const current = selected;
    const currentSlug = slug;
    if (!current || !currentSlug || !share?.allow_comments) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void (async () => {
        try {
          const items = (
            await api<{ items: Comment[] }>(`/api/v1/s/${currentSlug}/assets/${current.id}/comments`)
          ).items;
          if (selected?.id === current.id) comments = items;
        } catch {
          /* The next tick retries. */
        }
      })();
    }, 15_000);
    return () => clearInterval(timer);
  });

  /* Download affordance, gated on the share's allow_download. A 202 means
     the watermarked file is still rendering. */
  const download = async (): Promise<void> => {
    if (!selected) return;
    downloadNote = '';
    try {
      const payload = await api<{ url?: string; status?: string }>(
        `/api/v1/s/${slug}/assets/${selected.id}/download`
      );
      if (payload.url) window.location.assign(payload.url);
      else if (payload.status === 'processing')
        downloadNote = 'Preparing watermarked media. Try again shortly.';
    } catch (caught) {
      downloadNote = messageFrom(caught, 'The download is not available.');
    }
  };

  const playerActive = $derived(Boolean(selected && previewUrl && selected.kind === 'video'));

  const addComment = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    if (!selected || !bodyText.trim()) return;
    const drawing = pendingDrawing;
    const anchorFrame = drawing ? drawing.frame : playerActive ? currentFrame : null;
    try {
      const created = await apiPost<Comment>(`/api/v1/s/${slug}/assets/${selected.id}/comments`, {
        body_text: bodyText,
        ...(anchorFrame !== null ? { frame_in: anchorFrame } : {}),
        ...(drawing ? { annotation: { strokes: drawing.strokes } } : {})
      });
      /* A poll may already have delivered this comment. */
      if (!comments.some((existing) => existing.id === created.id)) comments = [...comments, created];
      bodyText = '';
      error = '';
      if (drawing) {
        player?.clearDrawing();
        pendingDrawing = null;
      }
    } catch (caught) {
      error = messageFrom(caught, 'The comment could not be added.');
    }
  };

  const seekToComment = (comment: Comment): void => {
    if (comment.frame_in !== null) player?.seekToFrame(comment.frame_in);
  };

  const highlightComment = (id: string): void => {
    highlightedId = id;
    document.getElementById(`share-note-${id}`)?.scrollIntoView({ block: 'nearest' });
  };

  const discardDrawing = (): void => {
    player?.clearDrawing();
    pendingDrawing = null;
  };
</script>

<svelte:head>
  <title>{share?.title ?? 'Shared review'} | Onelight</title>
  <meta property="og:title" content={share?.title ?? 'Shared review'} />
  <meta property="og:type" content="website" />
</svelte:head>

{#if error && !share && !locked}
  <main class="shell" style={`background-image: ${wash};`}><p role="alert">{error}</p></main>
{:else if locked || (share && !viewerIdentity)}
  <!-- Two ways to arrive here. A 401 means a passphrase is required and the
       form asks for it. A passphrase-less share loads fine but issues no
       viewer, and every asset read needs one -- so it prompts for the name
       alone. It used to show the tiles instead, and each one failed to open. -->
  <main class="shell access" style={`background-image: ${wash};`}>
    <div class="inner">
      <h1>{share ? share.title : 'Enter the review room.'}</h1>
      <form onsubmit={access}>
        {#if locked}
          <label>Passphrase <input type="password" bind:value={passphrase} /></label>
        {/if}
        <label>Your name <input bind:value={viewerName} required /></label>
        <label>Email <input type="email" bind:value={viewerEmail} /></label>
        {#if error}<p class="error" role="alert">{error}</p>{/if}
        <button type="submit">Continue</button>
      </form>
    </div>
  </main>
{:else if share}
  <main class="shell" inert={selected !== null} style={`background-image: ${wash};`}>
    <div class="inner">
    <!-- The title carries the page; naming the mechanism ("Review room") over
         it was chrome the client does not need. -->
    <header>
      <h1>{share.title}</h1>
    </header>
    <section class={`assets ${share.layout}`} aria-label="Shared assets">
      {#each assets as asset (asset.id)}
        <button class="asset" type="button" onclick={() => openAsset(asset)}>
          <!-- The picture leads. A list row is 56px of frame, too small for a
               monogram to read as anything but a cropped letter, so it takes
               the wash and the light alone. -->
          <span class="frame">
            <ProjectCover project={coverFor(asset)} monogram={share.layout !== 'list'} />
          </span>
          <span class="caption">
            <span class="name">{asset.name}</span>
            <small class="status">
              {#if asset.duration_seconds !== null}<span class="tc">{clock(asset.duration_seconds)}</span>{/if}
              {#if !showtime && STATUS_LABEL[asset.status]}{asset.duration_seconds !== null ? ' ' : ''}{STATUS_LABEL[asset.status]}{/if}
            </small>
          </span>
        </button>
      {/each}
    </section>
    </div>
  </main>
  {#if selected}
    <!-- Media is open. For a review this is a full-bleed opaque NEUTRAL
         layer: no gradient near footage under review, per the two-worlds
         rule. A presentation belongs to the other world -- the design doc
         lists presentation pages with the washed surfaces -- so it wears the
         share's brand and is built to be walked into. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role a11y_no_noninteractive_tabindex -->
    <section
      class="preview"
      class:showtime
      role="dialog"
      aria-modal="true"
      aria-label={`Preview: ${selected.name}`}
      tabindex="-1"
      bind:this={previewEl}
      onkeydown={onPreviewKeydown}
      style={showtime ? `background-image: ${wash}; background-size: 100% 100vh; background-attachment: fixed;` : ''}
    >
      <div class="preview-bar">
        <h2>{selected.name}</h2>
        {#if playerActive && !showtime}
          <span class="tc frame-readout">Frame {currentFrame}</span>
          <button type="button" class="copylink" onclick={() => void copyFrameLink()}>Copy link at this frame</button>
          {#if copyNotice}<span class="copy-note" role="status">{copyNotice}</span>{/if}
        {/if}
        {#if share.allow_download !== 'none'}
          <button type="button" class="download" onclick={() => void download()}>Download</button>
        {/if}
        <button type="button" class="close" onclick={closePreview}>Close preview</button>
      </div>
      {#if downloadNote}<p class="empty" role="status">{downloadNote}</p>{/if}
      <!-- The picture and the notes, side by side, the way the review page
           does it: notes below the fold made a viewer scroll away from the
           footage to read what was said about it. A presentation with comments
           off has no notes, so its picture takes the whole room.

           The player's chrome follows playerChrome: a presentation is always
           the simple instrument, and a review share can choose it in its
           brand, for clients who should read and leave notes without the
           colorist's deck in their hands. The player hides its own lanes in
           simple chrome, so the props pass unconditionally. -->
      <div class="room" class:solo={!railOpen}>
      <div class="maincol">
      {#if playerActive}
        <Player
          bind:this={player}
          oncopytimecode={copyText}
          src={previewUrl}
          rate={previewRate ?? { num: 24, den: 1 }}
          dropFrame={previewDropFrame}
          {annotations}
          durationFrames={previewDurationFrames}
          {markers}
          renditions={previewRenditions}
          filmstrip={previewFilmstrip}
          waveformUrl={previewWaveformUrl}
          allowDrawing={share.allow_comments && !showtime}
          chrome={playerChrome}
          {watermark}
          onframechange={(frame) => {
            currentFrame = frame;
            if (paused) scheduleFrameParam();
          }}
          onplaystate={(playing) => {
            paused = !playing;
            if (paused) scheduleFrameParam();
          }}
          onmarkerselect={(id) => highlightComment(id)}
          ondrawingchange={(drawing) => { pendingDrawing = drawing; }}
        />
      {:else if previewUrl}
        <p class="open-media"><a href={previewUrl}>Open media</a></p>
      {:else if watermarkPending}
        <p class="empty" role="status">Preparing watermarked media.</p>
      {:else}
        <p class="empty">A review rendition is not ready.</p>
      {/if}
      {#if showtime && assets.length > 1}
        <!-- The whole share, current one marked: the client skips through the
             work from here, never back out to a menu. -->
        <nav class="carousel" aria-label="In this share">
          {#each assets as asset (asset.id)}
            <button
              class="reeltile"
              class:current={selected?.id === asset.id}
              type="button"
              aria-current={selected?.id === asset.id}
              onclick={() => { if (selected?.id !== asset.id) void openAsset(asset); }}
            >
              <span class="reelframe">
                <ProjectCover project={coverFor(asset)} monogram={false} />
              </span>
              <span class="reelname">{asset.name}</span>
            </button>
          {/each}
        </nav>
      {/if}
      </div>
      {#if railOpen}
      <aside class="rail">
      <section class="comments" aria-label="Comments">
        <div class="c-bar">
          <h3>Comments</h3>
          {#if activeTag}
            <button type="button" class="tagfilter" onclick={() => { activeTag = null; }} aria-label={`Stop filtering by #${activeTag}`}>
              #{activeTag} <span aria-hidden="true">clear</span>
            </button>
          {/if}
        </div>
        <div class="notelist">
        {#if visibleComments.length === 0}
          <p class="empty">{comments.length === 0 ? 'No comments yet.' : 'No comments match this tag.'}</p>
        {/if}
        {#each visibleComments as comment (comment.id)}
          <article id={`share-note-${comment.id}`} class:highlighted={highlightedId === comment.id}>
            <span class="c-head">
              <strong>{comment.author_name ?? 'Viewer'}</strong>
              {#if comment.frame_in !== null}
                <button type="button" class="chip tc" onclick={() => seekToComment(comment)} aria-label={`Go to frame ${comment.frame_in}`}>Frame {comment.frame_in}</button>
              {/if}
              {#if comment.annotation}<span class="drawn">Drawing</span>{/if}
            </span>
            <p>
              {#each segmentCommentBody(comment.body_text) as segment, index (index)}
                {#if segment.kind === 'mention'}
                  <span class="mention">{segment.text}</span>
                {:else if segment.kind === 'tag' && segment.tag}
                  <button type="button" class="tag" onclick={() => { activeTag = segment.tag ?? null; }} aria-label={`Filter comments by ${segment.text}`}>{segment.text}</button>
                {:else}
                  {segment.text}
                {/if}
              {/each}
            </p>
          </article>
        {/each}
        </div>
        {#if share.allow_comments}
          <form onsubmit={addComment}>
            <label>
              Add a note
              {#if pendingDrawing}
                <span class="tc anchor">with drawing at frame {pendingDrawing.frame}</span>
              {:else if playerActive}
                <span class="tc anchor">at frame {currentFrame}</span>
              {/if}
              <textarea bind:value={bodyText} maxlength="10000" required></textarea>
            </label>
            <div class="post-row">
              <button type="submit" class="post">Comment</button>
              {#if pendingDrawing}
                <button type="button" class="quiet" onclick={discardDrawing}>Discard drawing</button>
              {/if}
            </div>
          </form>
          {#if error}<p class="error" role="alert">{error}</p>{/if}
        {/if}
      </section>
      </aside>
      {/if}
      </div>
    </section>
  {/if}
{/if}

<style>
  /* Share landing: client world, gradient wash allowed. */
  .shell { min-height: 100vh; padding: 48px clamp(24px, 5vw, 96px); color: var(--ink-text); background-color: var(--ink-000); background-repeat: no-repeat; }
  /* The content column sits centered in the window rather than hugging the
     left edge of a wide screen; text stays left-aligned inside it. */
  .inner { width: min(1120px, 100%); margin: 0 auto; }
  .access { display: grid; align-content: center; }
  .eyebrow { color: rgba(255, 255, 255, 0.68); font-size: var(--text-13); }
  h1 { max-width: 760px; margin: 0 0 48px; font-family: var(--font-display); font-size: clamp(44px, 8vw, 92px); line-height: 0.98; }
  .shell form { display: grid; gap: 16px; max-width: 420px; }
  .shell label { display: grid; gap: 8px; }
  .shell input { border: 0; border-radius: var(--radius); background: rgba(13, 17, 23, 0.62); color: inherit; padding: 11px 12px; }
  /* The access form's button, and only it. Unscoped, this cream also painted
     every asset tile (a tile is a button in this shell too), which put a
     cream card and dark text around each poster. */
  .shell form button { border: 0; border-radius: var(--radius); background: #e7dfc8; color: #202832; padding: 12px 16px; text-align: left; font-weight: 500; }
  /* Three layouts, one tile. They differ in how much room the picture gets,
     which is the whole of what grid, list and reel mean here, so the markup
     stays one thing and the columns and the frame do the talking. */
  .assets { display: grid; gap: 20px 16px; max-width: 1120px; }
  .assets.grid { grid-template-columns: repeat(auto-fill, minmax(232px, 1fr)); }
  .assets.list { grid-template-columns: 1fr; gap: 10px; max-width: 880px; margin-inline: auto; }
  /* Reel: one frame per row, as large as the page allows. This is the layout
     for showing the work, so the work is what fills the screen. */
  .assets.reel { grid-template-columns: 1fr; gap: 56px; max-width: 1000px; margin-inline: auto; }

  .asset { display: grid; gap: 10px; padding: 0; border: 0; border-radius: 0; background: none; color: inherit; text-align: left; }
  .frame { display: block; overflow: hidden; border-radius: var(--radius-lg); background: rgba(13, 17, 23, 0.54); aspect-ratio: 16 / 9; }
  .frame :global(.cover) { width: 100%; height: 100%; }
  .caption { display: grid; gap: 3px; }
  .name { font-size: var(--text-14); font-weight: 500; }
  .status { color: rgba(255, 255, 255, 0.64); font-size: var(--text-13); }

  /* A list row is still led by its picture, at a size where the frame reads
     as a frame rather than an icon. Each row is a quiet surface -- a bare
     filename floating beside a thumbnail read as unfinished. */
  .assets.list .asset { grid-template-columns: 176px minmax(0, 1fr); align-items: center; gap: 18px; padding: 10px; border-radius: var(--radius-lg); background: rgba(13, 17, 23, 0.4); }
  .assets.list .asset:hover { background: rgba(13, 17, 23, 0.62); }
  .assets.list .asset:hover .frame { transform: none; }
  .assets.list .name { font-size: var(--text-16); font-weight: 500; }
  .assets.list .caption { gap: 4px; }
  .assets.reel .name { font-family: var(--font-display); font-size: clamp(20px, 2.4vw, 28px); font-weight: 500; }
  .assets.reel .caption { gap: 5px; }

  /* The picture lifts toward the viewer on hover. No border, no glow: the
     frame is already the brightest thing in the row. */
  .asset .frame { transition: transform 160ms ease; }
  .asset:hover .frame { transform: translateY(-2px); }
  @media (prefers-reduced-motion: reduce) {
    .asset .frame { transition: none; }
    .asset:hover .frame { transform: none; }
  }

  /* Preview: review-room world. Full bleed, opaque, strictly neutral. */
  .preview { position: fixed; inset: 0; z-index: 10; display: flex; flex-direction: column; background: var(--n-050); color: var(--n-800); font-size: var(--text-13); }
  .preview-bar { flex: none; display: flex; align-items: center; gap: var(--pad-2); padding: 10px var(--pad-2); background: var(--n-100); }

  /* The picture and the rail divide what is left of the window, the way the
     review page divides it. Not ".stage": the player owns that name for its
     own picture area, and two different things under one class in a parent and
     its child is a trap for anything selecting either. */
  .room { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) clamp(320px, 26vw, 420px); align-items: stretch; }
  .room.solo { grid-template-columns: minmax(0, 1fr); }
  /* A column too, so the player has a definite height to divide. overflow
     hidden rather than auto: the picture shrinks to fit instead of the room
     growing a scrollbar and hiding the transport below the fold. */
  .maincol { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
  .maincol > :global(.player) { flex: 1; min-height: 0; }
  .rail { display: flex; flex-direction: column; min-height: 0; background: var(--n-100); }
  @media (max-width: 900px) {
    .preview { overflow: auto; }
    .room { grid-template-columns: minmax(0, 1fr); }
    .maincol { overflow: visible; }
    .maincol > :global(.player) { flex: none; }
  }

  /* Presentation carousel: the whole share at the foot of the picture,
     thumbnails only, because the point is to move, not to browse. */
  .carousel { flex: none; display: flex; justify-content: center; gap: 12px; overflow-x: auto; padding: 14px var(--pad-2) 18px; }
  .reeltile { flex: none; width: 148px; display: grid; gap: 6px; padding: 0; background: none; text-align: left; }
  .preview .reeltile:hover { background: none; }
  .reelframe { display: block; overflow: hidden; border-radius: var(--radius); background: var(--n-200); aspect-ratio: 16 / 9; opacity: 0.66; transition: opacity 140ms ease; }
  .reelframe :global(.cover) { width: 100%; height: 100%; }
  .reeltile:hover .reelframe, .reeltile.current .reelframe { opacity: 1; }
  .reeltile.current .reelframe { box-shadow: 0 0 0 2px rgba(250, 248, 244, 0.85); }
  .reelname { color: var(--n-700); font-size: var(--text-13); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .preview .reeltile:hover .reelname, .reeltile.current .reelname { color: var(--n-900); }

  /* ---- the presentation room ---- */
  /* The client's world, not the colorist's: the share's wash as the walls,
     the title in display type, the work centered with air around it, and the
     rest of the reel within reach. The review preview above stays strictly
     neutral; none of this applies there. */
  .preview.showtime { background-color: var(--ink-000); color: var(--ink-text); }
  .showtime .preview-bar { background: transparent; padding: 18px var(--pad-3) 8px; }
  .showtime .preview-bar h2 { font-family: var(--font-display); font-size: clamp(20px, 2.2vw, 30px); font-weight: 700; letter-spacing: -0.02em; color: var(--ink-text); }
  .showtime .preview-bar button { background: rgba(13, 17, 23, 0.55); color: var(--ink-text); }
  .showtime .preview-bar button:hover { background: rgba(13, 17, 23, 0.8); color: #fff; }
  /* The picture gets a proscenium: inset from the walls, never wall to wall. */
  .showtime .maincol { padding: 0 clamp(16px, 5vw, 96px); }
  .showtime .maincol > :global(.player) { border-radius: var(--radius-lg); overflow: hidden; }
  /* The instrument sheds the NLE grey. The player paints itself entirely in
     the neutral scale, so re-mapping that scale inside this container turns
     its slabs transparent (the wash shows through, the picture floats on the
     gradient) and its controls to cream on translucent ink. Only the full
     review player keeps the neutral world. */
  .showtime .maincol {
    --n-000: transparent;
    --n-050: transparent;
    --n-100: transparent;
    /* The scrub track reads in cream: translucent ink vanished into the
       wash, and an invisible seek bar is a control that does not exist. */
    --n-150: rgba(250, 248, 244, 0.14);
    --n-200: rgba(13, 17, 23, 0.5);
    --n-300: rgba(13, 17, 23, 0.66);
    --n-400: rgba(13, 17, 23, 0.85);
    --n-500: rgba(250, 248, 244, 0.42);
    --n-600: rgba(250, 248, 244, 0.6);
    --n-700: rgba(250, 248, 244, 0.75);
    --n-800: rgba(250, 248, 244, 0.9);
    --n-900: #faf8f4;
  }
  .showtime .empty, .showtime .open-media { color: var(--ink-text-dim); text-align: center; padding: var(--pad-4); }
  .showtime .reelname { color: var(--ink-text-dim); }
  .showtime .reeltile:hover .reelname, .showtime .reeltile.current .reelname { color: var(--ink-text); }
  .showtime .reelframe { background: rgba(13, 17, 23, 0.5); }
  /* Notes, when the share allows them, sit on ink rather than the review
     room's neutral grey. */
  .showtime .rail { background: rgba(13, 17, 23, 0.45); }
  .showtime .comments h3, .showtime .c-head strong, .showtime .comments article p { color: var(--ink-text); }
  .showtime .comments .empty { color: var(--ink-text-dim); text-align: left; padding: 0; }
  .showtime .comments article:hover { background: rgba(13, 17, 23, 0.5); }
  .showtime .comments article.highlighted { background: rgba(13, 17, 23, 0.65); }
  .showtime .comments form { background: rgba(13, 17, 23, 0.5); box-shadow: none; }
  .showtime .comments textarea { color: var(--ink-text); }
  .showtime .comments form label { color: var(--ink-text-dim); }
  .showtime .anchor { color: var(--ink-text-dim); }
  .preview h2 { flex: 1; margin: 0; font-family: var(--font-ui); font-size: var(--text-16); font-weight: 500; color: var(--n-900); }
  .preview { outline: none; }
  .preview button { border: 0; border-radius: var(--radius); background: var(--n-200); color: var(--n-800); padding: 8px 12px; font-size: var(--text-13); font-weight: 500; }
  .preview button:hover { background: var(--n-300); color: var(--n-900); }
  .open-media { padding: var(--pad-3) var(--pad-2); }
  .open-media a { color: var(--n-900); }
  .empty { color: var(--n-600); padding: var(--pad-2); }
  .frame-readout { color: var(--n-600); font-size: var(--text-13); }
  .copy-note { color: var(--n-600); font-size: var(--text-13); }
  /* The rail is a fixed head, a list that scrolls, and a composer docked at
     the bottom: reading the notes never scrolls the composer away, and a long
     thread never pushes it off the screen. */
  .comments { display: flex; flex-direction: column; min-height: 0; flex: 1; padding: var(--pad-2); }
  .notelist { flex: 1; min-height: 0; overflow-y: auto; }
  .c-bar { flex: none; display: flex; align-items: center; gap: 12px; margin: 0 0 10px; }
  .comments h3 { margin: 0; font-size: var(--text-13); font-weight: 600; color: var(--n-900); }
  .tagfilter { background: var(--n-300); color: var(--n-900); font-weight: 600; padding: 4px 10px; }
  .tagfilter span { color: var(--n-600); font-weight: 400; margin-left: 6px; }
  /* Mentions and hashtags carry weight and value only; the preview stays
     strictly neutral. */
  .mention { color: var(--n-900); font-weight: 600; }
  .tag { display: inline; border: 0; border-radius: 2px; background: var(--n-150); color: var(--n-900); font-weight: 600; font-size: inherit; padding: 0 3px; cursor: pointer; }
  .tag:hover { background: var(--n-300); }
  .comments article { padding: 12px; margin: 0 -12px 2px; border-radius: var(--radius); }
  .comments article:hover { background: var(--n-150); }
  .comments article.highlighted { background: var(--n-200); }
  .comments article p { margin: 6px 0 0; line-height: 1.45; white-space: pre-wrap; }
  .c-head { display: flex; align-items: center; gap: 10px; }
  .c-head strong { color: var(--n-900); font-size: var(--text-13); font-weight: 600; }
  .chip { border: 0; border-radius: 2px; background: var(--n-700); color: var(--n-050); font-size: var(--text-11); font-weight: 600; padding: 1px 6px; cursor: pointer; }
  .chip:hover { background: var(--n-800); }
  .drawn { color: var(--warn); font-size: var(--text-13); }
  /* The composer box is the form, not a field inside it: same shape the review
     page's composer has. */
  .comments form { flex: none; display: grid; gap: 8px; margin-top: 10px; padding: 10px; background: var(--n-150); border-radius: var(--radius-lg); box-shadow: inset 0 0 0 1px var(--n-200); }
  .comments form:focus-within { box-shadow: inset 0 0 0 1px var(--n-400); }
  .comments form label { display: grid; gap: 6px; color: var(--n-600); font-size: var(--text-13); }
  .comments textarea { border: 0; background: none; color: var(--n-900); padding: 0; min-height: 64px; resize: vertical; }
  .comments textarea:focus-visible { outline: none; }
  .anchor { color: var(--n-600); }
  .post-row { display: flex; align-items: center; gap: 12px; }
  .post { background: var(--n-800); color: var(--n-050); }
  .preview .post:hover { background: var(--n-900); }
  .preview button.quiet { background: none; color: var(--n-600); }
  .preview button.quiet:hover { color: var(--n-900); background: var(--n-200); }
  .error { color: var(--warn); }
  button:focus-visible, a:focus-visible, input:focus-visible, textarea:focus-visible { outline: 1px solid var(--n-800); outline-offset: 2px; }
  .shell button:focus-visible, .shell input:focus-visible { outline: 2px solid var(--accent-bright); outline-offset: 3px; }
  @media (max-width: 760px) { .assets { grid-template-columns: 1fr; } }
</style>
