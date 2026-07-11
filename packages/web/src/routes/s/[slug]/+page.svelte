<script lang="ts">
  import Player from '@onelight/player/Player.svelte';
  import type { AnnotationStroke, FrameAnnotation } from '@onelight/player';
  import { page } from '$app/state';
  import { api, apiPost, ApiError, messageFrom } from '$lib/api.js';

  type Share = { title: string; kind: 'review' | 'presentation'; layout: 'grid' | 'list' | 'reel'; allow_comments: boolean; expires_at: number | null };
  type Asset = { id: string; name: string; kind: string; status: string; current_version_id: string | null; sort_order: number };
  type Comment = { id: string; author_name: string | null; body_text: string; frame_in: number | null; annotation: unknown };
  type AssetDetail = {
    asset: { id: string; name: string; kind: string; status: string };
    versions: Array<{
      id: string;
      media_info: Record<string, unknown>;
      renditions: Array<{ kind: string; meta: Record<string, unknown> }>;
    }>;
  };

  let share = $state<Share | null>(null);
  let assets = $state<Asset[]>([]);
  let selected = $state<Asset | null>(null);
  let previewUrl = $state('');
  let previewRate = $state<{ num: number; den: number } | null>(null);
  let previewDropFrame = $state(false);
  let comments = $state<Comment[]>([]);
  let passphrase = $state('');
  let viewerName = $state('');
  let viewerEmail = $state('');
  let bodyText = $state('');
  let locked = $state(false);
  let error = $state('');
  let currentFrame = $state(0);
  let player = $state<Player | null>(null);

  const slug = $derived(page.params.slug);

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

  const loadAssets = async (currentSlug: string): Promise<void> => {
    try {
      assets = (await api<{ items: Asset[] }>(`/api/v1/s/${currentSlug}/assets`)).items;
    } catch {
      /* Bootstrap assets remain. */
    }
  };

  const load = async (currentSlug: string): Promise<void> => {
    share = null; assets = []; selected = null; previewUrl = ''; comments = []; locked = false; error = '';
    try {
      const payload = await api<{ share: Share; viewer: unknown; assets: Asset[] }>(`/s/${currentSlug}`);
      if (currentSlug !== slug) return;
      share = payload.share;
      assets = payload.assets;
      if (payload.viewer) await loadAssets(currentSlug);
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
      const payload = await apiPost<{ share?: Share }>(`/api/v1/s/${slug}/access`, {
        passphrase: passphrase || undefined,
        name: viewerName || undefined,
        email: viewerEmail || undefined
      });
      share = payload.share ?? share;
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

  const openAsset = async (asset: Asset): Promise<void> => {
    selected = asset;
    previewUrl = '';
    previewRate = null;
    previewDropFrame = false;
    comments = [];
    currentFrame = 0;
    try {
      const detail = await api<AssetDetail>(`/api/v1/s/${slug}/assets/${asset.id}`);
      previewRate = rateFrom(detail);
      const info = detail.versions[0]?.media_info ?? {};
      previewDropFrame = Boolean(info['drop_frame'] ?? info['dropFrame']);
    } catch {
      /* Rate stays at the player default until known. */
    }
    try {
      previewUrl = (await api<{ url: string }>(`/api/v1/s/${slug}/assets/${asset.id}/media`)).url;
    } catch {
      /* No media yet: the preview shows the empty state. */
    }
    try {
      comments = (await api<{ items: Comment[] }>(`/api/v1/s/${slug}/assets/${asset.id}/comments`)).items;
    } catch {
      /* Comments stay empty. */
    }
  };

  const closePreview = (): void => {
    selected = null;
    previewUrl = '';
    previewRate = null;
    comments = [];
  };

  const playerActive = $derived(Boolean(selected && previewUrl && selected.kind === 'video'));

  const addComment = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    if (!selected || !bodyText.trim()) return;
    try {
      const created = await apiPost<Comment>(`/api/v1/s/${slug}/assets/${selected.id}/comments`, {
        body_text: bodyText,
        ...(playerActive ? { frame_in: currentFrame } : {})
      });
      comments = [...comments, created];
      bodyText = '';
      error = '';
    } catch (caught) {
      error = messageFrom(caught, 'The comment could not be added.');
    }
  };

  const seekToComment = (comment: Comment): void => {
    if (comment.frame_in !== null) player?.seekToFrame(comment.frame_in);
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
        <button type="button" class="close" onclick={closePreview}>Close preview</button>
      </div>
      {#if playerActive}
        <Player bind:this={player} src={previewUrl} rate={previewRate ?? { num: 24, den: 1 }} dropFrame={previewDropFrame} {annotations} onframechange={(frame) => { currentFrame = frame; }} />
      {:else if previewUrl}
        <p class="open-media"><a href={previewUrl}>Open media</a></p>
      {:else}
        <p class="empty">A review rendition is not ready.</p>
      {/if}
      <section class="comments" aria-label="Comments">
        <h3>Comments</h3>
        {#if comments.length === 0}<p class="empty">No comments yet.</p>{/if}
        {#each comments as comment (comment.id)}
          <article>
            <span class="c-head">
              <strong>{comment.author_name ?? 'Viewer'}</strong>
              {#if comment.frame_in !== null}
                <button type="button" class="chip tc" onclick={() => seekToComment(comment)} aria-label={`Go to frame ${comment.frame_in}`}>Frame {comment.frame_in}</button>
              {/if}
            </span>
            <p>{comment.body_text}</p>
          </article>
        {/each}
        {#if share.allow_comments}
          <form onsubmit={addComment}>
            <label>Add a note {#if playerActive}<span class="tc anchor">at frame {currentFrame}</span>{/if}
              <textarea bind:value={bodyText} maxlength="10000" required></textarea>
            </label>
            <button type="submit" class="post">Comment</button>
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
  .comments article p { margin: 6px 0 0; line-height: 1.45; }
  .c-head { display: flex; align-items: center; gap: 10px; }
  .c-head strong { color: var(--n-900); font-size: var(--text-12); font-weight: 600; }
  .chip { border: 0; border-radius: 2px; background: var(--n-700); color: var(--n-050); font-size: var(--text-11); font-weight: 600; padding: 1px 6px; cursor: pointer; }
  .chip:hover { background: var(--n-800); }
  .comments form { display: grid; gap: 12px; margin-top: var(--pad-3); padding: var(--pad-2); background: var(--n-100); border-radius: var(--radius); }
  .comments form label { display: grid; gap: 8px; color: var(--n-600); font-size: var(--text-12); }
  .comments textarea { border: 0; border-radius: var(--radius); background: var(--n-150); color: var(--n-900); padding: 8px 10px; min-height: 72px; }
  .anchor { color: var(--n-600); }
  .post { justify-self: start; background: var(--n-800); color: var(--n-050); }
  .preview .post:hover { background: var(--n-900); }
  .error { color: var(--warn); }
  button:focus-visible, a:focus-visible, input:focus-visible, textarea:focus-visible { outline: 1px solid var(--n-800); outline-offset: 2px; }
  .shell button:focus-visible, .shell input:focus-visible { outline: 2px solid var(--accent-bright); outline-offset: 3px; }
  @media (max-width: 760px) { .assets { grid-template-columns: 1fr; } }
</style>
