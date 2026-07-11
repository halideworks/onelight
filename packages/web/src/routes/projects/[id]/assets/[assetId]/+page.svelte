<script lang="ts">
  import Player from '@onelight/player/Player.svelte';
  import type {
    AnnotationStroke,
    FrameAnnotation,
    PendingDrawing,
    PlayerRendition,
    TimelineMarker
  } from '@onelight/player';
  import { page } from '$app/state';
  import { api, apiPatch, apiPost, messageFrom } from '$lib/api.js';

  type Asset = { id: string; name: string; kind: string; status: string; current_version_id: string | null };
  type Version = {
    frame_rate_num?: number | null; frame_rate_den?: number | null; drop_frame?: boolean | null;
    duration_frames?: number | null;
    frameRateNum?: number | null; frameRateDen?: number | null; dropFrame?: boolean | null;
    durationFrames?: number | null;
  };
  type Rendition = { kind: string; blob_key?: string; blobKey?: string; url?: string | null };
  type Comment = {
    id: string;
    author_name: string | null;
    body_text: string;
    frame_in: number | null;
    frame_out: number | null;
    completed_at: number | null;
    annotation: unknown;
  };
  type NoteFilter = 'all' | 'open' | 'completed';

  let asset = $state<Asset | null>(null);
  let source = $state('');
  let renditionOptions = $state<PlayerRendition[]>([]);
  let rate = $state<{ num: number; den: number } | null>(null);
  let dropFrame = $state(false);
  let durationFrames = $state<number | null>(null);
  let error = $state('');
  let comments = $state<Comment[]>([]);
  let bodyText = $state('');
  let frameIn = $state<number | null>(null);
  let commentError = $state('');
  let currentFrame = $state(0);
  let player = $state<Player | null>(null);
  let noteFilter = $state<NoteFilter>('all');
  let highlightedId = $state<string | null>(null);
  let pendingDrawing = $state<PendingDrawing | null>(null);

  const projectId = $derived(page.params.id);
  const assetId = $derived(page.params.assetId);

  /* Annotation payloads come from clients we do not control: accept either a
     bare stroke array or { strokes: [...] } and drop anything malformed. */
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

  const visibleComments = $derived(
    comments.filter((comment) =>
      noteFilter === 'all' ? true : noteFilter === 'open' ? !comment.completed_at : Boolean(comment.completed_at)
    )
  );

  const mediaPath = (key: string): string =>
    `/api/v1/media/${key.split('/').map(encodeURIComponent).join('/')}`;

  const load = async (id: string): Promise<void> => {
    asset = null; source = ''; renditionOptions = []; rate = null; dropFrame = false;
    durationFrames = null; error = ''; comments = []; commentError = '';
    highlightedId = null; pendingDrawing = null; noteFilter = 'all';
    try {
      const loaded = await api<Asset>(`/api/v1/assets/${id}`);
      if (id !== assetId) return;
      asset = loaded;
    } catch (caught) {
      error = messageFrom(caught, 'This asset is not available.');
      return;
    }
    if (!asset.current_version_id) return;
    const versionId = asset.current_version_id;
    try {
      const version = await api<Version>(`/api/v1/versions/${versionId}`);
      const num = version.frame_rate_num ?? version.frameRateNum;
      const den = version.frame_rate_den ?? version.frameRateDen;
      if (typeof num === 'number' && typeof den === 'number' && num > 0 && den > 0) rate = { num, den };
      dropFrame = Boolean(version.drop_frame ?? version.dropFrame);
      const frames = version.duration_frames ?? version.durationFrames;
      if (typeof frames === 'number' && frames > 0) durationFrames = frames;
    } catch {
      /* The player falls back to 24/1 until the probe lands. */
    }
    try {
      const renditions = (await api<{ items: Rendition[] }>(`/api/v1/versions/${versionId}/renditions`)).items;
      const urlFor = (rendition: Rendition): string | null => {
        if (rendition.url) return rendition.url;
        const key = rendition.blob_key ?? rendition.blobKey;
        return key ? mediaPath(key) : null;
      };
      renditionOptions = renditions
        .filter((candidate) => ['proxy_540', 'proxy_1080', 'proxy_2160'].includes(candidate.kind))
        .flatMap((candidate) => {
          const url = urlFor(candidate);
          return url ? [{ kind: candidate.kind, url }] : [];
        });
      const rendition = renditions.find((candidate) => candidate.kind === 'proxy_1080') ?? renditions.find((candidate) => candidate.kind.startsWith('proxy_'));
      if (rendition) source = urlFor(rendition) ?? '';
    } catch {
      /* No renditions yet: the empty state below covers it. */
    }
    try {
      comments = (await api<{ items: Comment[] }>(`/api/v1/versions/${versionId}/comments`)).items;
    } catch {
      /* Notes stay empty; posting still works once the version is ready. */
    }
  };

  $effect(() => {
    const id = assetId;
    if (id) void load(id);
  });

  const addComment = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    if (!asset?.current_version_id || !bodyText.trim()) return;
    const drawing = pendingDrawing;
    const anchorFrame = drawing
      ? drawing.frame
      : typeof frameIn === 'number' && Number.isInteger(frameIn) && frameIn >= 0
        ? frameIn
        : null;
    try {
      const created = await apiPost<Comment>(`/api/v1/versions/${asset.current_version_id}/comments`, {
        body_text: bodyText,
        ...(anchorFrame !== null ? { frame_in: anchorFrame } : {}),
        ...(drawing ? { annotation: { strokes: drawing.strokes } } : {})
      });
      comments = [...comments, created];
      bodyText = '';
      frameIn = null;
      commentError = '';
      if (drawing) {
        player?.clearDrawing();
        pendingDrawing = null;
      }
    } catch (caught) {
      commentError = messageFrom(caught, 'The comment could not be added.');
    }
  };

  const completeComment = async (id: string): Promise<void> => {
    try {
      const completed = await apiPost<Comment>(`/api/v1/comments/${id}/complete`);
      comments = comments.map((comment) => (comment.id === id ? { ...comment, ...completed } : comment));
      commentError = '';
    } catch (caught) {
      commentError = messageFrom(caught, 'The note could not be completed.');
    }
  };

  const updateApproval = async (status: string): Promise<void> => {
    if (!asset) return;
    try {
      asset = await apiPatch<Asset>(`/api/v1/assets/${asset.id}/approval`, { status });
      error = '';
    } catch (caught) {
      error = messageFrom(caught, 'Approval state could not be updated.');
    }
  };

  const seekToComment = (comment: Comment): void => {
    if (comment.frame_in !== null) player?.seekToFrame(comment.frame_in);
  };

  /* A timeline marker click seeks in the player and highlights the note. */
  const highlightComment = (id: string): void => {
    highlightedId = id;
    document.getElementById(`note-${id}`)?.scrollIntoView({ block: 'nearest' });
  };

  const discardDrawing = (): void => {
    player?.clearDrawing();
    pendingDrawing = null;
  };
</script>

<svelte:head><title>{asset?.name ?? 'Review room'} | Onelight</title></svelte:head>

<main class="review">
  <header class="topbar">
    <a href={`/projects/${projectId}`}>Back to project</a>
    {#if asset}
      <h1>{asset.name}</h1>
      <span class="grow"></span>
      <label class="approval">Approval
        <select value={asset.status} onchange={(event) => updateApproval((event.currentTarget as HTMLSelectElement).value)}>
          <option value="none">No decision</option>
          <option value="in_review">In review</option>
          <option value="approved">Approved</option>
          <option value="changes_requested">Changes requested</option>
        </select>
      </label>
    {/if}
  </header>
  {#if error}
    <p class="error" role="alert">{error}</p>
  {:else if asset}
    {#if source}
      <Player
        bind:this={player}
        src={source}
        rate={rate ?? { num: 24, den: 1 }}
        {dropFrame}
        {annotations}
        {durationFrames}
        {markers}
        renditions={renditionOptions}
        allowDrawing
        onframechange={(frame) => { currentFrame = frame; }}
        onmarkerselect={(id) => highlightComment(id)}
        ondrawingchange={(drawing) => { pendingDrawing = drawing; }}
      />
    {:else}
      <p class="empty stage-empty">A review proxy is not ready yet.</p>
    {/if}
    <section class="notes" aria-label="Review notes">
      <div class="notes-head">
        <h2>Notes</h2>
        <div class="filters" role="group" aria-label="Filter notes">
          <button type="button" aria-pressed={noteFilter === 'all'} onclick={() => { noteFilter = 'all'; }}>All</button>
          <button type="button" aria-pressed={noteFilter === 'open'} onclick={() => { noteFilter = 'open'; }}>Open</button>
          <button type="button" aria-pressed={noteFilter === 'completed'} onclick={() => { noteFilter = 'completed'; }}>Completed</button>
        </div>
      </div>
      {#if visibleComments.length === 0}
        <p class="empty">{comments.length === 0 ? 'No notes yet.' : 'No notes match this filter.'}</p>
      {/if}
      {#each visibleComments as comment (comment.id)}
        <article id={`note-${comment.id}`} class:completed={comment.completed_at} class:highlighted={highlightedId === comment.id}>
          <div>
            <span class="head">
              <strong>{comment.author_name ?? 'Reviewer'}</strong>
              {#if comment.frame_in !== null}
                <button type="button" class="chip tc" onclick={() => seekToComment(comment)} aria-label={`Go to frame ${comment.frame_in}`}>
                  Frame {comment.frame_in}{comment.frame_out !== null && comment.frame_out > comment.frame_in ? ` to ${comment.frame_out}` : ''}
                </button>
              {/if}
              {#if comment.annotation}<span class="drawn">Drawing</span>{/if}
            </span>
            <p>{comment.body_text}</p>
          </div>
          {#if !comment.completed_at}
            <button type="button" onclick={() => completeComment(comment.id)}>Resolve</button>
          {:else}
            <span class="resolved">Resolved</span>
          {/if}
        </article>
      {/each}
      <form onsubmit={addComment}>
        <div class="anchor-row">
          <label>Frame <input type="number" min="0" step="1" bind:value={frameIn} disabled={pendingDrawing !== null} /></label>
          {#if source && !pendingDrawing}
            <button type="button" class="quiet" onclick={() => { frameIn = currentFrame; }}>At playhead ({currentFrame})</button>
          {/if}
          {#if pendingDrawing}
            <span class="drawing-chip">Drawing attached at frame <span class="tc">{pendingDrawing.frame}</span></span>
            <button type="button" class="quiet" onclick={discardDrawing}>Discard drawing</button>
          {/if}
        </div>
        <label>Note <textarea bind:value={bodyText} maxlength="10000" required></textarea></label>
        <button type="submit" class="primary">Add note</button>
      </form>
      {#if commentError}<p class="error" role="alert">{commentError}</p>{/if}
    </section>
  {:else}
    <p class="empty loading">Loading asset.</p>
  {/if}
</main>

<style>
  /* Review room world: strictly neutral, R=G=B, no gradients, no tinted
     chrome. Separation by value step, not borders. */
  .review { min-height: 100vh; background: var(--n-050); color: var(--n-800); font-size: var(--text-13); }
  .topbar { display: flex; align-items: center; gap: var(--pad-2); padding: 10px var(--pad-2); background: var(--n-100); }
  .topbar a { color: var(--n-600); font-size: var(--text-12); text-decoration: none; }
  .topbar a:hover { color: var(--n-800); }
  h1 { margin: 0; font-family: var(--font-ui); font-size: var(--text-16); font-weight: 500; color: var(--n-900); }
  .grow { flex: 1; }
  .approval { display: flex; align-items: center; gap: 8px; color: var(--n-600); font-size: var(--text-12); }
  select, input, textarea { border: 0; border-radius: var(--radius); background: var(--n-200); color: var(--n-900); padding: 8px 10px; }
  .stage-empty { padding: 18vh 0; text-align: center; background: var(--n-000); margin: 0; }
  .empty { color: var(--n-600); }
  .loading { padding: 32px var(--pad-3); }
  .error { padding: 12px var(--pad-2); margin: 0; color: var(--warn); }
  .notes { max-width: 820px; margin: 0 auto; padding: var(--pad-3) var(--pad-2) var(--pad-4); }
  .notes-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0 0 12px; }
  .notes h2 { margin: 0; font-size: var(--text-13); font-weight: 600; color: var(--n-900); }
  .filters { display: flex; gap: 2px; background: var(--n-150); border-radius: var(--radius); padding: 2px; }
  .filters button { background: none; padding: 5px 10px; }
  .filters button[aria-pressed='true'] { background: var(--n-400); color: var(--n-900); }
  .notes article { display: flex; justify-content: space-between; gap: 20px; padding: 12px; margin: 0 -12px 2px; border-radius: var(--radius); }
  .notes article:hover { background: var(--n-150); }
  .notes article.highlighted { background: var(--n-200); }
  .notes article div { flex: 1; }
  .notes article p { margin: 6px 0 0; color: var(--n-800); line-height: 1.45; }
  .notes article.completed p { color: var(--n-500); }
  .head { display: flex; align-items: center; gap: 10px; }
  .head strong { color: var(--n-900); font-size: var(--text-12); font-weight: 600; }
  .chip { border: 0; border-radius: 2px; background: var(--n-700); color: var(--n-050); font-size: var(--text-11); font-weight: 600; padding: 1px 6px; cursor: pointer; }
  .chip:hover { background: var(--n-800); }
  .drawn { color: var(--warn); font-size: var(--text-11); }
  .resolved { color: var(--ok); font-size: var(--text-12); align-self: center; }
  .notes form { display: grid; gap: 12px; margin-top: var(--pad-3); padding: var(--pad-2); background: var(--n-100); border-radius: var(--radius); }
  .notes form label { display: grid; gap: 8px; color: var(--n-600); font-size: var(--text-12); }
  .anchor-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .anchor-row label { align-self: end; }
  .drawing-chip { color: var(--n-800); font-size: var(--text-13); }
  .drawing-chip .tc { font-variant-numeric: tabular-nums; }
  .notes textarea { min-height: 96px; background: var(--n-150); }
  .notes form input { background: var(--n-150); width: 120px; }
  .notes form input:disabled { color: var(--n-500); }
  button { border: 0; border-radius: var(--radius); background: var(--n-200); color: var(--n-800); padding: 8px 12px; font-size: var(--text-12); font-weight: 500; }
  button:hover { background: var(--n-300); color: var(--n-900); }
  button.primary { background: var(--n-800); color: var(--n-050); justify-self: start; }
  button.primary:hover { background: var(--n-900); }
  button.quiet { background: none; color: var(--n-600); }
  button.quiet:hover { color: var(--n-900); background: var(--n-200); }
  button:focus-visible, a:focus-visible, select:focus-visible, input:focus-visible, textarea:focus-visible { outline: 1px solid var(--n-800); outline-offset: 2px; }
  @media (max-width: 700px) { .topbar { flex-wrap: wrap; } }
</style>
