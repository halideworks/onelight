<script lang="ts">
  import Player from '@onelight/player/Player.svelte';
  import type {
    AnnotationStroke,
    FrameAnnotation,
    PendingDrawing,
    PlayerRendition,
    TimelineMarker,
    WatermarkOverlay
  } from '@onelight/player';
  import { page } from '$app/state';
  import { api, apiPost, ApiError, messageFrom } from '$lib/api.js';

  type Share = {
    title: string;
    kind: 'review' | 'presentation';
    layout: 'grid' | 'list' | 'reel';
    allow_comments: boolean;
    allow_download: 'none' | 'proxy' | 'original';
    expires_at: number | null;
    watermark_spec: Record<string, unknown> | null;
  };
  type Asset = { id: string; name: string; kind: string; status: string; sort_order: number };
  type Comment = {
    id: string;
    author_name: string | null;
    body_text: string;
    frame_in: number | null;
    frame_out: number | null;
    completed_at: number | null;
    annotation: unknown;
  };
  type AssetDetail = {
    asset: { id: string; name: string; kind: string; status: string };
    versions: Array<{
      id: string;
      media_info: Record<string, unknown>;
      renditions: Array<{ kind: string; meta: Record<string, unknown> }>;
      sources: Array<{ kind: string; url: string }>;
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
  /* Bumped whenever the preview changes; in-flight media polls compare it
     and stand down. */
  let mediaPollToken = 0;

  const slug = $derived(page.params.slug);

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
    const expires = record['expires_at'] ?? record['expiresAt'];
    const download = record['allow_download'] ?? record['allowDownload'];
    return {
      title: typeof record['title'] === 'string' ? record['title'] : 'Shared review',
      kind: record['kind'] === 'presentation' ? 'presentation' : 'review',
      layout: record['layout'] === 'list' ? 'list' : record['layout'] === 'reel' ? 'reel' : 'grid',
      allow_comments: Boolean(record['allow_comments'] ?? record['allowComments']),
      allow_download: download === 'proxy' || download === 'original' ? download : 'none',
      expires_at: typeof expires === 'number' ? expires : null,
      watermark_spec: parseSpec()
    };
  };

  const strokesFrom = (annotation: unknown): AnnotationStroke[] => {
    const candidates = Array.isArray(annotation)
      ? annotation
      : annotation && typeof annotation === 'object' && Array.isArray((annotation as { strokes?: unknown }).strokes)
        ? (annotation as { strokes: unknown[] }).strokes
        : [];
    return candidates.filter(
      (stroke): stroke is AnnotationStroke =>
        typeof stroke === 'object' && stroke !== null && Array.isArray((stroke as { points?: unknown }).points)
    );
  };

  const annotations = $derived<FrameAnnotation[]>(
    comments
      .filter((comment) => comment.frame_in !== null && comment.annotation)
      .map((comment) => ({ frame: comment.frame_in, strokes: strokesFrom(comment.annotation) }))
      .filter((annotation) => annotation.strokes.length > 0)
  );

  const markers = $derived<TimelineMarker[]>(
    comments
      .filter((comment) => comment.frame_in !== null)
      .map((comment) => ({
        id: comment.id,
        frameIn: comment.frame_in as number,
        frameOut: comment.frame_out,
        author: comment.author_name,
        text: comment.body_text,
        completed: comment.completed_at !== null
      }))
  );

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
      }
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) locked = true;
      else error = messageFrom(caught, 'This share is not available.');
    }
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

  const openAsset = async (asset: Asset): Promise<void> => {
    selected = asset;
    previewUrl = '';
    previewRate = null;
    previewDropFrame = false;
    previewDurationFrames = null;
    previewRenditions = [];
    watermarkPending = false;
    downloadNote = '';
    comments = [];
    currentFrame = 0;
    highlightedId = null;
    pendingDrawing = null;
    mediaPollToken += 1;
    const token = mediaPollToken;
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
    } catch {
      /* Rate stays at the player default until known. */
    }
    await fetchMedia(asset, token);
    try {
      comments = (await api<{ items: Comment[] }>(`/api/v1/s/${slug}/assets/${asset.id}/comments`)).items;
    } catch {
      /* Comments stay empty. */
    }
  };

  const closePreview = (): void => {
    mediaPollToken += 1;
    selected = null;
    previewUrl = '';
    previewRate = null;
    previewDurationFrames = null;
    previewRenditions = [];
    watermarkPending = false;
    downloadNote = '';
    comments = [];
    pendingDrawing = null;
    highlightedId = null;
  };

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
      comments = [...comments, created];
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
  <main class="shell"><p role="alert">{error}</p></main>
{:else if locked}
  <main class="shell access">
    <p class="eyebrow">Shared review</p>
    <h1>Enter the review room.</h1>
    <form onsubmit={access}>
      <label>Passphrase <input type="password" bind:value={passphrase} /></label>
      <label>Your name <input bind:value={viewerName} required /></label>
      <label>Email <input type="email" bind:value={viewerEmail} /></label>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <button type="submit">Continue</button>
    </form>
  </main>
{:else if share}
  <main class="shell">
    <header>
      <p class="eyebrow">{share.kind === 'presentation' ? 'Presentation' : 'Review room'}</p>
      <h1>{share.title}</h1>
    </header>
    <section class={`assets ${share.layout}`} aria-label="Shared assets">
      {#each assets as asset (asset.id)}
        <button class="asset" type="button" onclick={() => openAsset(asset)}>
          <span>{asset.name}</span>
          <small>{asset.kind} / {asset.status}</small>
        </button>
      {/each}
    </section>
  </main>
  {#if selected}
    <!-- Media is open: a full-bleed opaque neutral layer. No gradient is
         visible anywhere behind footage. -->
    <section class="preview" aria-label="Asset preview">
      <div class="preview-bar">
        <h2>{selected.name}</h2>
        {#if share.allow_download !== 'none'}
          <button type="button" class="download" onclick={() => void download()}>Download</button>
        {/if}
        <button type="button" class="close" onclick={closePreview}>Close preview</button>
      </div>
      {#if downloadNote}<p class="empty" role="status">{downloadNote}</p>{/if}
      {#if playerActive}
        <Player
          bind:this={player}
          src={previewUrl}
          rate={previewRate ?? { num: 24, den: 1 }}
          dropFrame={previewDropFrame}
          {annotations}
          durationFrames={previewDurationFrames}
          {markers}
          renditions={previewRenditions}
          allowDrawing={share.allow_comments}
          {watermark}
          onframechange={(frame) => { currentFrame = frame; }}
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
      <section class="comments" aria-label="Comments">
        <h3>Comments</h3>
        {#if comments.length === 0}<p class="empty">No comments yet.</p>{/if}
        {#each comments as comment (comment.id)}
          <article id={`share-note-${comment.id}`} class:highlighted={highlightedId === comment.id}>
            <span class="c-head">
              <strong>{comment.author_name ?? 'Viewer'}</strong>
              {#if comment.frame_in !== null}
                <button type="button" class="chip tc" onclick={() => seekToComment(comment)} aria-label={`Go to frame ${comment.frame_in}`}>Frame {comment.frame_in}</button>
              {/if}
              {#if comment.annotation}<span class="drawn">Drawing</span>{/if}
            </span>
            <p>{comment.body_text}</p>
          </article>
        {/each}
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
    </section>
  {/if}
{/if}

<style>
  /* Share landing: client world, gradient wash allowed. */
  .shell { min-height: 100vh; padding: 48px clamp(24px, 8vw, 120px); color: var(--ink-text); background: linear-gradient(180deg, var(--sumimai-a) 0%, var(--sumimai-m) 58%, var(--sumimai-b) 108%); background-attachment: fixed; }
  .access { display: grid; align-content: center; }
  .eyebrow { color: rgba(255, 255, 255, 0.68); font-size: var(--text-13); }
  h1 { max-width: 760px; margin: 24px 0 48px; font-family: var(--font-display); font-size: clamp(44px, 8vw, 92px); line-height: 0.98; }
  .shell form { display: grid; gap: 16px; max-width: 420px; }
  .shell label { display: grid; gap: 8px; }
  .shell input { border: 0; border-radius: var(--radius); background: rgba(13, 17, 23, 0.62); color: inherit; padding: 11px 12px; }
  .shell button { border: 0; border-radius: var(--radius); background: #e7dfc8; color: #202832; padding: 12px 16px; text-align: left; font-weight: 500; }
  .assets { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; max-width: 1080px; }
  .assets.list, .assets.reel { grid-template-columns: 1fr; max-width: 760px; }
  .asset { min-height: 160px; display: grid; align-content: end; gap: 8px; padding: var(--pad-2); border-radius: var(--radius-lg); background: rgba(13, 17, 23, 0.54); color: inherit; }
  .asset small { color: rgba(255, 255, 255, 0.64); }

  /* Preview: review-room world. Full bleed, opaque, strictly neutral. */
  .preview { position: fixed; inset: 0; z-index: 10; overflow: auto; padding: 0 0 var(--pad-4); background: var(--n-050); color: var(--n-800); font-size: var(--text-13); }
  .preview-bar { display: flex; align-items: center; gap: var(--pad-2); padding: 10px var(--pad-2); background: var(--n-100); }
  .preview h2 { flex: 1; margin: 0; font-family: var(--font-ui); font-size: var(--text-16); font-weight: 500; color: var(--n-900); }
  .preview button { border: 0; border-radius: var(--radius); background: var(--n-200); color: var(--n-800); padding: 8px 12px; font-size: var(--text-12); font-weight: 500; }
  .preview button:hover { background: var(--n-300); color: var(--n-900); }
  .open-media { padding: var(--pad-3) var(--pad-2); }
  .open-media a { color: var(--n-900); }
  .empty { color: var(--n-600); padding: var(--pad-2); }
  .comments { max-width: 760px; margin: var(--pad-3) auto 0; padding: 0 var(--pad-2); }
  .comments h3 { margin: 0 0 10px; font-size: var(--text-13); font-weight: 600; color: var(--n-900); }
  .comments article { padding: 12px; margin: 0 -12px 2px; border-radius: var(--radius); }
  .comments article:hover { background: var(--n-150); }
  .comments article.highlighted { background: var(--n-200); }
  .comments article p { margin: 6px 0 0; line-height: 1.45; }
  .c-head { display: flex; align-items: center; gap: 10px; }
  .c-head strong { color: var(--n-900); font-size: var(--text-12); font-weight: 600; }
  .chip { border: 0; border-radius: 2px; background: var(--n-700); color: var(--n-050); font-size: var(--text-11); font-weight: 600; padding: 1px 6px; cursor: pointer; }
  .chip:hover { background: var(--n-800); }
  .drawn { color: var(--warn); font-size: var(--text-11); }
  .comments form { display: grid; gap: 12px; margin-top: var(--pad-3); padding: var(--pad-2); background: var(--n-100); border-radius: var(--radius); }
  .comments form label { display: grid; gap: 8px; color: var(--n-600); font-size: var(--text-12); }
  .comments textarea { border: 0; border-radius: var(--radius); background: var(--n-150); color: var(--n-900); padding: 8px 10px; min-height: 72px; }
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
