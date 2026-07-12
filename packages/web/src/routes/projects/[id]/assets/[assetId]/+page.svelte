<script lang="ts">
  import { tick } from 'svelte';
  import Player from '@onelight/player/Player.svelte';
  import { parseSpriteVtt } from '@onelight/player';
  import type {
    FrameAnnotation,
    PendingDrawing,
    PlayerRendition,
    SpriteCue,
    TimelineMarker
  } from '@onelight/player';
  import { page } from '$app/state';
  import { replaceState } from '$app/navigation';
  import { api, apiPatch, apiPost, messageFrom } from '$lib/api.js';
  import { projectEvents } from '$lib/sse.svelte.js';
  import { whenAbsolute, whenRelative } from '$lib/format.js';
  import { annotationsFrom, markersFrom, type ReviewComment } from '$lib/comments.js';
  import { hashtagsIn, segmentCommentBody } from './comment-text.js';

  type Asset = { id: string; name: string; kind: string; status: string; current_version_id: string | null };
  type Version = {
    id: string;
    asset_id: string;
    version_no: number;
    original_filename: string | null;
    uploaded_by: string | null;
    frame_rate_num: number | null;
    frame_rate_den: number | null;
    drop_frame: boolean;
    duration_frames: number | null;
    transcode_status: string;
    created_at: number;
  };
  type Rendition = {
    kind: string;
    blob_key?: string;
    blobKey?: string;
    url?: string | null;
    vtt_url?: string | null;
    meta?: Record<string, unknown>;
  };
  type Comment = ReviewComment & {
    version_id?: string;
    parent_id?: string | null;
    author_user_id?: string | null;
    carried_from_comment_id?: string | null;
  };
  type Member = { user: { id: string; name: string; email: string }; role: string };
  type NoteFilter = 'all' | 'open' | 'completed';
  type UploadState = { status: 'idle' | 'uploading' | 'registering' | 'failed'; progress: number; error: string };

  let asset = $state<Asset | null>(null);
  let versions = $state<Version[]>([]);
  let selectedVersionId = $state<string | null>(null);
  let source = $state('');
  let renditionOptions = $state<PlayerRendition[]>([]);
  let filmstrip = $state<{ url: string; cues: SpriteCue[] } | null>(null);
  let waveformUrl = $state<string | null>(null);
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
  let activeTag = $state<string | null>(null);
  let highlightedId = $state<string | null>(null);
  let pendingDrawing = $state<PendingDrawing | null>(null);
  let members = $state<Member[]>([]);
  let membersFor: string | null = null;
  let versionsOpen = $state(true);
  let railError = $state('');
  let copyNotice = $state('');
  let uploadState = $state<UploadState>({ status: 'idle', progress: 0, error: '' });
  let carryForwardOnUpload = $state(true);
  let prevVersion = $state<Version | null>(null);
  let prevOpenCount = $state(0);
  let carrying = $state(false);
  /* Comment id to version number, filled from every comment fetch, so
     carried badges can say which version a note came from. Reactive: the
     source version's comments often load after the visible ones render. */
  let versionNoByComment = $state<Record<string, number>>({});
  /* Bumped on every asset or version switch; stale async loads stand down. */
  let versionToken = 0;

  const projectId = $derived(page.params.id);
  const assetId = $derived(page.params.assetId);
  const selectedVersion = $derived(versions.find((version) => version.id === selectedVersionId) ?? null);
  const newestVersion = $derived(versions[0] ?? null);
  const isNewestSelected = $derived(Boolean(selectedVersion && newestVersion && selectedVersion.id === newestVersion.id));
  const carryAvailable = $derived(isNewestSelected && prevVersion !== null && prevOpenCount > 0);
  const memberNames = $derived(members.map((member) => member.user.name));

  const memberName = (userId: string | null | undefined): string =>
    (userId && members.find((member) => member.user.id === userId)?.user.name) || 'Unknown';

  const TRANSCODE_LABELS: Record<string, string> = {
    pending: 'Queued',
    processing: 'Transcoding',
    failed: 'Transcode failed',
    skipped: 'No proxy'
  };

  const annotations = $derived<FrameAnnotation[]>(annotationsFrom(comments));

  const markers = $derived<TimelineMarker[]>(markersFrom(comments));

  const tagsOf = (comment: Comment): string[] =>
    Array.isArray(comment.tags) ? comment.tags : hashtagsIn(comment.body_text);

  const visibleComments = $derived(
    comments.filter((comment) => {
      const stateMatch =
        noteFilter === 'all' ? true : noteFilter === 'open' ? !comment.completed_at : Boolean(comment.completed_at);
      if (!stateMatch) return false;
      return activeTag === null || tagsOf(comment).includes(activeTag);
    })
  );

  /* Server list order: (frame_in, else -1) ascending, then id descending. */
  const commentOrder = (a: Comment, b: Comment): number => {
    const frameA = a.frame_in ?? -1;
    const frameB = b.frame_in ?? -1;
    if (frameA !== frameB) return frameA - frameB;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  };

  const mediaPath = (key: string): string =>
    `/api/v1/media/${key.split('/').map(encodeURIComponent).join('/')}`;

  const urlForRendition = (rendition: Rendition): string | null => {
    if (rendition.url) return rendition.url;
    const key = rendition.blob_key ?? rendition.blobKey;
    return key ? mediaPath(key) : null;
  };

  const rememberVersionNos = (items: Comment[], versionNo: number): void => {
    for (const comment of items) versionNoByComment[comment.id] = versionNo;
  };

  const carriedLabel = (comment: Comment): string | null => {
    if (!comment.carried_from_comment_id) return null;
    const versionNo = versionNoByComment[comment.carried_from_comment_id];
    return versionNo ? `Carried from v${versionNo}` : 'Carried forward';
  };

  const loadMembers = async (id: string): Promise<void> => {
    if (membersFor === id) return;
    membersFor = id;
    try {
      members = (await api<{ items: Member[] }>(`/api/v1/projects/${id}/members`)).items;
    } catch {
      membersFor = null;
      /* Names fall back to "Unknown"; mention autocomplete stays empty. */
    }
  };

  const loadRenditions = async (versionId: string, token: number): Promise<void> => {
    try {
      const items = (await api<{ items: Rendition[] }>(`/api/v1/versions/${versionId}/renditions`)).items;
      if (token !== versionToken) return;
      renditionOptions = items
        .filter((candidate) => ['proxy_540', 'proxy_1080', 'proxy_2160'].includes(candidate.kind))
        .flatMap((candidate) => {
          const url = urlForRendition(candidate);
          return url ? [{ kind: candidate.kind, url }] : [];
        });
      const rendition =
        items.find((candidate) => candidate.kind === 'proxy_1080') ??
        items.find((candidate) => candidate.kind.startsWith('proxy_'));
      source = (rendition && urlForRendition(rendition)) || '';
      const peaks = items.find((candidate) => candidate.kind === 'audio_peaks');
      waveformUrl = peaks ? urlForRendition(peaks) : null;
      const sprite = items.find((candidate) => candidate.kind === 'sprite');
      const spriteUrl = sprite ? urlForRendition(sprite) : null;
      const vttUrl = sprite?.vtt_url ?? null;
      if (sprite && spriteUrl && vttUrl) {
        try {
          const response = await fetch(vttUrl);
          if (response.ok) {
            const cues = parseSpriteVtt(await response.text());
            if (token === versionToken && cues.length) filmstrip = { url: spriteUrl, cues };
          }
        } catch {
          /* No filmstrip lane; the timeline stands alone. */
        }
      }
    } catch {
      /* No renditions yet: the empty state below covers it. */
    }
  };

  const refreshComments = async (versionId: string, token: number): Promise<void> => {
    try {
      const items = (await api<{ items: Comment[] }>(`/api/v1/versions/${versionId}/comments`)).items;
      if (token !== versionToken) return;
      comments = items;
      const versionNo = versions.find((version) => version.id === versionId)?.version_no;
      if (versionNo) rememberVersionNos(items, versionNo);
    } catch {
      /* Notes stay as they are; posting still works once the version is ready. */
    }
  };

  /* Carry-forward offers notes from the immediately previous version when
     the newest is on screen and that previous version still has open notes. */
  const checkCarrySource = async (token: number): Promise<void> => {
    prevVersion = null;
    prevOpenCount = 0;
    if (!isNewestSelected || versions.length < 2) return;
    const previous = versions[1];
    if (!previous) return;
    try {
      const items = (await api<{ items: Comment[] }>(`/api/v1/versions/${previous.id}/comments`)).items;
      if (token !== versionToken) return;
      rememberVersionNos(items, previous.version_no);
      prevVersion = previous;
      prevOpenCount = items.filter((comment) => !comment.completed_at && !comment.parent_id).length;
    } catch {
      /* Carry-forward simply is not offered. */
    }
  };

  const applyVersionMeta = (version: Version | null): void => {
    rate =
      version && typeof version.frame_rate_num === 'number' && typeof version.frame_rate_den === 'number' &&
      version.frame_rate_num > 0 && version.frame_rate_den > 0
        ? { num: version.frame_rate_num, den: version.frame_rate_den }
        : null;
    dropFrame = Boolean(version?.drop_frame);
    durationFrames =
      version && typeof version.duration_frames === 'number' && version.duration_frames > 0
        ? version.duration_frames
        : null;
  };

  const selectVersion = async (versionId: string, options?: { fromUser?: boolean }): Promise<void> => {
    versionToken += 1;
    const token = versionToken;
    selectedVersionId = versionId;
    source = '';
    renditionOptions = [];
    filmstrip = null;
    waveformUrl = null;
    comments = [];
    commentError = '';
    highlightedId = null;
    pendingDrawing = null;
    activeTag = null;
    railError = '';
    applyVersionMeta(versions.find((version) => version.id === versionId) ?? null);
    if (options?.fromUser) writeVersionParam(versionId);
    await loadRenditions(versionId, token);
    if (token !== versionToken) return;
    await refreshComments(versionId, token);
    if (token !== versionToken) return;
    await checkCarrySource(token);
  };

  const load = async (id: string): Promise<void> => {
    versionToken += 1;
    asset = null; versions = []; selectedVersionId = null; source = ''; renditionOptions = [];
    filmstrip = null; waveformUrl = null; rate = null; dropFrame = false; durationFrames = null;
    error = ''; comments = []; commentError = ''; highlightedId = null; pendingDrawing = null;
    noteFilter = 'all'; activeTag = null; railError = ''; prevVersion = null; prevOpenCount = 0;
    versionNoByComment = {};
    try {
      const loaded = await api<Asset>(`/api/v1/assets/${id}`);
      if (id !== assetId) return;
      asset = loaded;
    } catch (caught) {
      error = messageFrom(caught, 'This asset is not available.');
      return;
    }
    const pid = projectId;
    if (pid) void loadMembers(pid);
    try {
      versions = (await api<{ items: Version[] }>(`/api/v1/assets/${id}/versions`)).items;
    } catch {
      versions = [];
    }
    if (id !== assetId) return;
    /* Deep links may pin a specific version (?v=); location.search is read
       directly so this load never re-runs on ?f= rewrites. */
    const pinned = new URLSearchParams(location.search).get('v');
    const initial =
      (pinned && versions.find((version) => version.id === pinned)?.id) ||
      asset.current_version_id ||
      versions[0]?.id ||
      null;
    if (initial) await selectVersion(initial);
  };

  $effect(() => {
    const id = assetId;
    if (id) void load(id);
  });

  /* ---- version rail actions ---- */

  const refreshVersions = async (): Promise<void> => {
    const id = assetId;
    if (!id) return;
    try {
      versions = (await api<{ items: Version[] }>(`/api/v1/assets/${id}/versions`)).items;
      applyVersionMeta(versions.find((version) => version.id === selectedVersionId) ?? null);
    } catch {
      /* The rail keeps its last state. */
    }
  };

  /* PATCH /versions/:id/stack sets which version of the stack is current
     (body {version_no}); that is all it does, so that is all we expose. */
  const setCurrent = async (version: Version): Promise<void> => {
    railError = '';
    try {
      const result = await apiPatch<{ items: Version[]; current_version_id: string }>(
        `/api/v1/versions/${version.id}/stack`,
        { version_no: version.version_no }
      );
      versions = result.items;
      if (asset) asset = { ...asset, current_version_id: result.current_version_id };
    } catch (caught) {
      railError = messageFrom(caught, 'The current version could not be changed.');
    }
  };

  const carryForward = async (): Promise<void> => {
    const target = selectedVersionId;
    const from = prevVersion;
    if (!target || !from || carrying) return;
    carrying = true;
    railError = '';
    try {
      await apiPost(`/api/v1/versions/${target}/carry-forward`, { from_version_id: from.id });
      const token = versionToken;
      await refreshComments(target, token);
      await checkCarrySource(token);
    } catch (caught) {
      railError = messageFrom(caught, 'Notes could not be carried forward.');
    } finally {
      carrying = false;
    }
  };

  /* ---- upload a new version (lean lane; the project page owns the heavy
          uploader). Same session flow: create, multipart, parts, complete,
          then POST /assets/:id/versions registers the version. ---- */

  const uploadVersion = async (event: Event): Promise<void> => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    const target = asset;
    const pid = projectId;
    if (!file || !target || !pid || uploadState.status === 'uploading' || uploadState.status === 'registering') return;
    uploadState = { status: 'uploading', progress: 0, error: '' };
    try {
      const created = await apiPost<{ upload: { id: string } }>('/api/v1/uploads', {
        project_id: pid,
        filename: file.name,
        relative_path: '',
        size: file.size
      });
      const sessionId = created.upload.id;
      const multipart = await apiPost<{ upload: { status: string }; part_size?: number }>(
        `/api/v1/uploads/${sessionId}/multipart`
      );
      if (multipart.upload.status !== 'completed') {
        const partSize = multipart.part_size;
        if (!partSize) throw new Error('The upload session did not return a part size.');
        const parts: Array<{ part_no: number; etag: string }> = [];
        const count = Math.max(1, Math.ceil(file.size / partSize));
        for (let partNo = 1; partNo <= count; partNo += 1) {
          const start = (partNo - 1) * partSize;
          const response = await fetch(`/api/v1/uploads/${sessionId}/parts/${partNo}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/octet-stream' },
            body: file.slice(start, Math.min(file.size, start + partSize))
          });
          if (!response.ok) throw new Error(`Part ${partNo} could not be uploaded.`);
          parts.push({ part_no: partNo, etag: response.headers.get('etag') ?? '' });
          uploadState = { status: 'uploading', progress: Math.round((partNo / count) * 90), error: '' };
        }
        await apiPost(`/api/v1/uploads/${sessionId}/complete`, { parts });
      }
      uploadState = { status: 'registering', progress: 95, error: '' };
      const result = await apiPost<{ asset?: Asset; version?: Version; job_id?: string }>(
        `/api/v1/assets/${target.id}/versions`,
        { upload_id: sessionId, carry_forward: carryForwardOnUpload }
      );
      if (result.asset) asset = result.asset;
      await refreshVersions();
      const landed = result.version?.id ?? versions[0]?.id;
      if (landed) await selectVersion(landed);
      uploadState = { status: 'idle', progress: 100, error: '' };
    } catch (caught) {
      uploadState = { status: 'failed', progress: 0, error: messageFrom(caught, 'The version upload failed.') };
    }
  };

  /* ---- live updates over the project SSE stream. Comment payloads carry
          ids only (never bodies), so matching events refetch the list; the
          keyed refetch also absorbs the echo of our own posts. ---- */

  const handleProjectEvent = (event: { type: string; payload: Record<string, unknown> }): void => {
    const payload = event.payload;
    const versionId = typeof payload['version_id'] === 'string' ? payload['version_id'] : null;
    const eventAssetId = typeof payload['asset_id'] === 'string' ? payload['asset_id'] : null;
    if (event.type === 'comment.created' || event.type === 'comment.updated') {
      if (versionId && versionId === selectedVersionId) void refreshComments(versionId, versionToken);
      return;
    }
    if (event.type === 'comment.deleted') {
      const commentId = typeof payload['comment_id'] === 'string' ? payload['comment_id'] : null;
      if (versionId === selectedVersionId && commentId)
        comments = comments.filter((comment) => comment.id !== commentId);
      return;
    }
    if (event.type === 'version.transcode') {
      if (eventAssetId !== assetId || !versionId) return;
      const status = typeof payload['status'] === 'string' ? payload['status'] : null;
      if (status)
        versions = versions.map((version) =>
          version.id === versionId ? { ...version, transcode_status: status } : version
        );
      if (versionId === selectedVersionId && status === 'ready') void loadRenditions(versionId, versionToken);
      return;
    }
    if (event.type === 'version.probed') {
      if (eventAssetId === assetId) void refreshVersions();
      return;
    }
    if (event.type === 'asset.version_created') {
      if (eventAssetId !== assetId) return;
      if (versionId && versions.some((version) => version.id === versionId)) return;
      void refreshVersions();
    }
  };

  $effect(() => {
    const pid = projectId;
    if (!pid) return;
    return projectEvents(
      pid,
      [
        'comment.created',
        'comment.updated',
        'comment.deleted',
        'version.transcode',
        'version.probed',
        'asset.version_created'
      ],
      handleProjectEvent
    );
  });

  /* ---- frame deep links (?f=, optional ?v=). The URL mirrors the paused
          playhead so copying the address shares the moment; it is never
          rewritten during playback. ---- */

  let paused = true;
  let lastWrittenF: number | null = null;
  let appliedF: number | null = null;
  let urlTimer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    const raw = page.url.searchParams.get('f');
    const current = player;
    if (!current || !source) return;
    if (raw === null || !/^\d+$/.test(raw)) return;
    const frame = Number(raw);
    if (frame === lastWrittenF || frame === appliedF) return;
    appliedF = frame;
    current.seekToFrame(frame);
  });

  const writeFrameParam = (): void => {
    const frame = currentFrame;
    if (frame === lastWrittenF) return;
    const url = new URL(page.url.href);
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

  const writeVersionParam = (versionId: string): void => {
    const url = new URL(page.url.href);
    if (asset && versionId !== asset.current_version_id) url.searchParams.set('v', versionId);
    else url.searchParams.delete('v');
    url.searchParams.delete('f');
    lastWrittenF = null;
    appliedF = null;
    replaceState(url, {});
  };

  $effect(() => {
    return () => {
      if (urlTimer !== null) clearTimeout(urlTimer);
    };
  });

  const copyFrameLink = async (): Promise<void> => {
    const url = new URL(page.url.href);
    url.searchParams.set('f', String(currentFrame));
    if (asset && selectedVersionId && selectedVersionId !== asset.current_version_id)
      url.searchParams.set('v', selectedVersionId);
    else url.searchParams.delete('v');
    try {
      await navigator.clipboard.writeText(url.toString());
      copyNotice = 'Link copied';
    } catch {
      copyNotice = 'Copy failed';
    }
    setTimeout(() => {
      copyNotice = '';
    }, 2000);
  };

  /* ---- composer: mentions and hashtags ---- */

  let composerEl = $state<HTMLTextAreaElement | null>(null);
  let mentionQuery = $state<string | null>(null);
  let mentionIndex = $state(0);
  let mentionStart = 0;
  let picked: Array<{ id: string; name: string }> = [];

  const mentionMatches = $derived(
    mentionQuery === null
      ? []
      : members
          .filter((member) => {
            const query = (mentionQuery ?? '').toLowerCase();
            return (
              member.user.name.toLowerCase().includes(query) || member.user.email.toLowerCase().includes(query)
            );
          })
          .slice(0, 6)
  );

  const updateMention = (): void => {
    const element = composerEl;
    if (!element) {
      mentionQuery = null;
      return;
    }
    const caret = element.selectionStart ?? 0;
    const upto = bodyText.slice(0, caret);
    const at = upto.lastIndexOf('@');
    if (at < 0 || (at > 0 && !/[\s([{]/.test(upto[at - 1] ?? ''))) {
      mentionQuery = null;
      return;
    }
    const token = upto.slice(at + 1);
    if (/[\n@#]/.test(token) || token.length > 40) {
      mentionQuery = null;
      return;
    }
    mentionStart = at;
    if (mentionQuery !== token) mentionIndex = 0;
    mentionQuery = token;
  };

  const pickMention = (member: Member): void => {
    const element = composerEl;
    if (!element || mentionQuery === null) return;
    const caret = element.selectionStart ?? bodyText.length;
    const insert = `@${member.user.name} `;
    bodyText = bodyText.slice(0, mentionStart) + insert + bodyText.slice(caret);
    picked = [...picked.filter((entry) => entry.id !== member.user.id), { id: member.user.id, name: member.user.name }];
    mentionQuery = null;
    const position = mentionStart + insert.length;
    void tick().then(() => {
      element.focus();
      element.setSelectionRange(position, position);
    });
  };

  const composerKeydown = (event: KeyboardEvent): void => {
    if (mentionQuery === null || mentionMatches.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      mentionIndex = (mentionIndex + 1) % mentionMatches.length;
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      mentionIndex = (mentionIndex - 1 + mentionMatches.length) % mentionMatches.length;
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      const choice = mentionMatches[Math.min(mentionIndex, mentionMatches.length - 1)];
      if (choice) {
        event.preventDefault();
        pickMention(choice);
      }
    } else if (event.key === 'Escape') {
      event.stopPropagation();
      mentionQuery = null;
    }
  };

  const addComment = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const versionId = selectedVersionId;
    if (!versionId || !bodyText.trim()) return;
    const drawing = pendingDrawing;
    const anchorFrame = drawing
      ? drawing.frame
      : typeof frameIn === 'number' && Number.isInteger(frameIn) && frameIn >= 0
        ? frameIn
        : null;
    const mentionIds = [...new Set(picked.filter((entry) => bodyText.includes(`@${entry.name}`)).map((entry) => entry.id))];
    try {
      const created = await apiPost<Comment>(`/api/v1/versions/${versionId}/comments`, {
        body_text: bodyText,
        ...(anchorFrame !== null ? { frame_in: anchorFrame } : {}),
        ...(drawing ? { annotation: { strokes: drawing.strokes } } : {}),
        ...(mentionIds.length ? { mentions: mentionIds } : {})
      });
      /* An SSE echo of this comment may already have refetched the list. */
      if (!comments.some((comment) => comment.id === created.id))
        comments = [...comments, created].sort(commentOrder);
      const versionNo = versions.find((version) => version.id === versionId)?.version_no;
      if (versionNo) versionNoByComment[created.id] = versionNo;
      bodyText = '';
      frameIn = null;
      commentError = '';
      picked = [];
      mentionQuery = null;
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
      {#if selectedVersion}<span class="vbadge tc">v{selectedVersion.version_no}</span>{/if}
      <span class="grow"></span>
      <span class="upload-new">
        <label class="filebtn">
          New version
          <input
            type="file"
            onchange={uploadVersion}
            disabled={uploadState.status === 'uploading' || uploadState.status === 'registering'}
          />
        </label>
        <label class="carry-opt">
          <input type="checkbox" bind:checked={carryForwardOnUpload} />
          Carry open notes
        </label>
      </span>
      <button type="button" aria-pressed={versionsOpen} onclick={() => { versionsOpen = !versionsOpen; }}>
        Versions
      </button>
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
  {#if uploadState.status !== 'idle'}
    <p class="upload-status" role="status">
      {#if uploadState.status === 'uploading'}
        Uploading new version, <span class="tc">{uploadState.progress}%</span>
      {:else if uploadState.status === 'registering'}
        Registering the new version.
      {:else}
        <span class="error-text">{uploadState.error}</span>
      {/if}
    </p>
  {/if}
  {#if error}
    <p class="error" role="alert">{error}</p>
  {:else if asset}
    <div class="content" class:with-rail={versionsOpen}>
      <div class="maincol">
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
            {filmstrip}
            {waveformUrl}
            allowDrawing
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
          <div class="framebar">
            <span class="tc frame-readout">Frame {currentFrame}</span>
            <button type="button" class="quiet" onclick={() => void copyFrameLink()}>Copy link at this frame</button>
            {#if copyNotice}<span class="copy-note" role="status">{copyNotice}</span>{/if}
          </div>
        {:else if selectedVersion && (selectedVersion.transcode_status === 'pending' || selectedVersion.transcode_status === 'processing')}
          <p class="empty stage-empty">Transcoding this version. The proxy appears when it is ready.</p>
        {:else}
          <p class="empty stage-empty">A review proxy is not ready yet.</p>
        {/if}
        <section class="notes" aria-label="Review notes">
          <div class="notes-head">
            <h2>Notes</h2>
            {#if activeTag}
              <button type="button" class="tagfilter" onclick={() => { activeTag = null; }} aria-label={`Stop filtering by #${activeTag}`}>
                #{activeTag} <span aria-hidden="true">clear</span>
              </button>
            {/if}
            <div class="filters" role="group" aria-label="Filter notes">
              <button type="button" aria-pressed={noteFilter === 'all'} onclick={() => { noteFilter = 'all'; }}>All</button>
              <button type="button" aria-pressed={noteFilter === 'open'} onclick={() => { noteFilter = 'open'; }}>Open</button>
              <button type="button" aria-pressed={noteFilter === 'completed'} onclick={() => { noteFilter = 'completed'; }}>Completed</button>
            </div>
          </div>
          {#if carryAvailable && prevVersion}
            <div class="carry-row">
              <span>
                {prevOpenCount} open {prevOpenCount === 1 ? 'note' : 'notes'} on
                <span class="tc">v{prevVersion.version_no}</span> have not been carried to this version.
              </span>
              <button type="button" onclick={() => void carryForward()} disabled={carrying}>
                {carrying ? 'Carrying' : `Carry forward from v${prevVersion.version_no}`}
              </button>
            </div>
          {/if}
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
                  {#if carriedLabel(comment)}<span class="carried">{carriedLabel(comment)}</span>{/if}
                </span>
                <p>
                  {#each segmentCommentBody(comment.body_text, memberNames) as segment, index (index)}
                    {#if segment.kind === 'mention'}
                      <span class="mention">{segment.text}</span>
                    {:else if segment.kind === 'tag' && segment.tag}
                      <button type="button" class="tag" onclick={() => { activeTag = segment.tag ?? null; }} aria-label={`Filter notes by ${segment.text}`}>{segment.text}</button>
                    {:else}
                      {segment.text}
                    {/if}
                  {/each}
                </p>
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
                <button type="button" class="quiet tc" onclick={() => { frameIn = currentFrame; }}>At playhead ({currentFrame})</button>
              {/if}
              {#if pendingDrawing}
                <span class="drawing-chip">Drawing attached at frame <span class="tc">{pendingDrawing.frame}</span></span>
                <button type="button" class="quiet" onclick={discardDrawing}>Discard drawing</button>
              {/if}
            </div>
            <label>
              Note
              <span class="composer">
                <textarea
                  bind:this={composerEl}
                  bind:value={bodyText}
                  maxlength="10000"
                  required
                  oninput={updateMention}
                  onclick={updateMention}
                  onkeydown={composerKeydown}
                  onkeyup={(event) => {
                    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) updateMention();
                  }}
                ></textarea>
                {#if mentionQuery !== null && mentionMatches.length > 0}
                  <span class="mention-menu" role="listbox" aria-label="Mention a project member">
                    {#each mentionMatches as member, index (member.user.id)}
                      <button
                        type="button"
                        role="option"
                        aria-selected={index === mentionIndex}
                        class:active={index === mentionIndex}
                        onclick={() => pickMention(member)}
                      >
                        <strong>{member.user.name}</strong>
                        <span>{member.user.email}</span>
                      </button>
                    {/each}
                  </span>
                {/if}
              </span>
            </label>
            <button type="submit" class="primary">Add note</button>
          </form>
          {#if commentError}<p class="error" role="alert">{commentError}</p>{/if}
        </section>
      </div>
      {#if versionsOpen}
        <aside class="rail" aria-label="Versions">
          <h2>Versions</h2>
          {#if versions.length === 0}
            <p class="empty">No versions.</p>
          {/if}
          {#each versions as version (version.id)}
            <div class="vrow" class:active={version.id === selectedVersionId}>
              <button
                type="button"
                class="vpick"
                aria-current={version.id === selectedVersionId ? 'true' : undefined}
                onclick={() => void selectVersion(version.id, { fromUser: true })}
              >
                <span class="vline">
                  <span class="vno tc">v{version.version_no}</span>
                  {#if asset && version.id === asset.current_version_id}<span class="vcurrent">Current</span>{/if}
                  {#if TRANSCODE_LABELS[version.transcode_status]}
                    <span class="vstate" class:failed={version.transcode_status === 'failed'}>
                      {TRANSCODE_LABELS[version.transcode_status]}
                    </span>
                  {/if}
                </span>
                <span class="vmeta">{memberName(version.uploaded_by)}</span>
                <span class="vmeta" title={whenAbsolute(version.created_at)}>{whenRelative(version.created_at)}</span>
              </button>
              {#if asset && version.id !== asset.current_version_id}
                <button type="button" class="quiet setcur" onclick={() => void setCurrent(version)}>Set current</button>
              {/if}
            </div>
          {/each}
          {#if railError}<p class="error-text" role="alert">{railError}</p>{/if}
        </aside>
      {/if}
    </div>
  {:else}
    <p class="empty loading">Loading asset.</p>
  {/if}
</main>

<style>
  /* Review room world: strictly neutral, R=G=B, no gradients, no tinted
     chrome. Separation by value step, not borders. */
  .review { min-height: 100vh; background: var(--n-050); color: var(--n-800); font-size: var(--text-13); }
  .topbar { display: flex; align-items: center; gap: var(--pad-2); padding: 10px var(--pad-2); background: var(--n-100); flex-wrap: wrap; }
  .topbar a { color: var(--n-600); font-size: var(--text-13); text-decoration: none; }
  .topbar a:hover { color: var(--n-800); }
  h1 { margin: 0; font-family: var(--font-ui); font-size: var(--text-16); font-weight: 500; color: var(--n-900); }
  .vbadge { color: var(--n-600); font-size: var(--text-13); font-weight: 600; }
  .grow { flex: 1; }
  .approval { display: flex; align-items: center; gap: 8px; color: var(--n-600); font-size: var(--text-13); }
  select, input, textarea { border: 0; border-radius: var(--radius); background: var(--n-200); color: var(--n-900); padding: 8px 10px; }

  /* Upload-new-version: a file input styled as the button it acts as. */
  .upload-new { display: flex; align-items: center; gap: 10px; }
  .filebtn { position: relative; display: inline-block; border-radius: var(--radius); background: var(--n-200); color: var(--n-800); padding: 8px 12px; font-size: var(--text-13); font-weight: 500; cursor: pointer; }
  .filebtn:hover { background: var(--n-300); color: var(--n-900); }
  .filebtn input { position: absolute; inset: 0; width: 100%; opacity: 0; cursor: pointer; }
  .filebtn:focus-within { outline: 1px solid var(--n-800); outline-offset: 2px; }
  .carry-opt { display: flex; align-items: center; gap: 6px; color: var(--n-600); font-size: var(--text-13); }
  .carry-opt input { width: auto; padding: 0; accent-color: var(--n-700); }
  .upload-status { margin: 0; padding: 8px var(--pad-2); background: var(--n-150); color: var(--n-800); font-size: var(--text-13); }

  .content { display: grid; grid-template-columns: minmax(0, 1fr); align-items: start; }
  .content.with-rail { grid-template-columns: minmax(0, 1fr) 232px; }
  .maincol { min-width: 0; }
  .stage-empty { padding: 18vh 0; text-align: center; background: var(--n-000); margin: 0; }
  .empty { color: var(--n-600); }
  .loading { padding: 32px var(--pad-3); }
  .error { padding: 12px var(--pad-2); margin: 0; color: var(--warn); }
  .error-text { color: var(--warn); font-size: var(--text-13); }

  .framebar { display: flex; align-items: center; gap: 12px; padding: 0 16px 8px; }
  .frame-readout { color: var(--n-600); font-size: var(--text-13); }
  .copy-note { color: var(--n-600); font-size: var(--text-13); }

  /* ---- version rail ---- */
  .rail { padding: var(--pad-2); background: var(--n-100); min-height: 100%; }
  .rail h2 { margin: 0 0 10px; font-size: var(--text-13); font-weight: 600; color: var(--n-900); }
  .vrow { display: grid; gap: 2px; margin-bottom: 2px; border-radius: var(--radius); }
  .vrow.active { background: var(--n-200); }
  .vpick { display: grid; gap: 3px; text-align: left; background: none; padding: 10px; border-radius: var(--radius); }
  .vrow:not(.active) .vpick:hover { background: var(--n-150); }
  .vline { display: flex; align-items: baseline; gap: 8px; }
  .vno { color: var(--n-900); font-weight: 600; }
  .vcurrent { color: var(--n-050); background: var(--n-700); border-radius: 2px; padding: 1px 6px; font-size: var(--text-11); font-weight: 600; }
  .vstate { color: var(--n-600); font-size: var(--text-13); }
  .vstate.failed { color: var(--warn); }
  .vmeta { color: var(--n-600); font-size: var(--text-13); }
  .setcur { justify-self: start; margin: 0 0 8px 10px; padding: 3px 8px; font-size: var(--text-13); }

  /* ---- notes ---- */
  .notes { max-width: 820px; margin: 0 auto; padding: var(--pad-3) var(--pad-2) var(--pad-4); }
  .notes-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0 0 12px; }
  .notes h2 { margin: 0; font-size: var(--text-13); font-weight: 600; color: var(--n-900); }
  .filters { display: flex; gap: 2px; background: var(--n-150); border-radius: var(--radius); padding: 2px; }
  .filters button { background: none; padding: 5px 10px; }
  .filters button[aria-pressed='true'] { background: var(--n-400); color: var(--n-900); }
  .tagfilter { margin-left: auto; background: var(--n-300); color: var(--n-900); font-weight: 600; padding: 4px 10px; }
  .tagfilter span { color: var(--n-600); font-weight: 400; margin-left: 6px; }
  .carry-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 10px 12px; margin: 0 0 12px; background: var(--n-150); border-radius: var(--radius); color: var(--n-800); }
  .notes article { display: flex; justify-content: space-between; gap: 20px; padding: 12px; margin: 0 -12px 2px; border-radius: var(--radius); }
  .notes article:hover { background: var(--n-150); }
  .notes article.highlighted { background: var(--n-200); }
  .notes article div { flex: 1; }
  .notes article p { margin: 6px 0 0; color: var(--n-800); line-height: 1.45; white-space: pre-wrap; }
  .notes article.completed p { color: var(--n-500); }
  .head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .head strong { color: var(--n-900); font-size: var(--text-13); font-weight: 600; }
  .chip { border: 0; border-radius: 2px; background: var(--n-700); color: var(--n-050); font-size: var(--text-11); font-weight: 600; padding: 1px 6px; cursor: pointer; }
  .chip:hover { background: var(--n-800); }
  .drawn { color: var(--warn); font-size: var(--text-13); }
  .carried { color: var(--n-600); background: var(--n-150); border-radius: 2px; padding: 1px 6px; font-size: var(--text-11); }
  .resolved { color: var(--ok); font-size: var(--text-13); align-self: center; }

  /* Mentions and hashtags carry weight and value, never hue: the review
     room stays strictly neutral. */
  .mention { color: var(--n-900); font-weight: 600; }
  .tag { display: inline; border: 0; border-radius: 2px; background: var(--n-150); color: var(--n-900); font-weight: 600; font-size: inherit; padding: 0 3px; cursor: pointer; }
  .tag:hover { background: var(--n-300); }

  .notes form { display: grid; gap: 12px; margin-top: var(--pad-3); padding: var(--pad-2); background: var(--n-100); border-radius: var(--radius); }
  .notes form label { display: grid; gap: 8px; color: var(--n-600); font-size: var(--text-13); }
  .anchor-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .anchor-row label { align-self: end; }
  .drawing-chip { color: var(--n-800); font-size: var(--text-13); }
  .drawing-chip .tc { font-variant-numeric: tabular-nums; }
  .composer { position: relative; display: grid; }
  .notes textarea { min-height: 96px; background: var(--n-150); }
  .mention-menu { position: absolute; left: 0; right: auto; top: 100%; z-index: 4; display: grid; min-width: 260px; background: var(--n-200); border-radius: var(--radius); padding: 2px; }
  .mention-menu button { display: flex; align-items: baseline; gap: 10px; background: none; text-align: left; padding: 7px 10px; border-radius: 2px; }
  .mention-menu button.active, .mention-menu button:hover { background: var(--n-400); }
  .mention-menu strong { color: var(--n-900); font-weight: 600; font-size: var(--text-13); }
  .mention-menu span { color: var(--n-600); font-size: var(--text-13); }
  .notes form input { background: var(--n-150); width: 120px; }
  .notes form input:disabled { color: var(--n-500); }

  button { border: 0; border-radius: var(--radius); background: var(--n-200); color: var(--n-800); padding: 8px 12px; font-size: var(--text-13); font-weight: 500; }
  button:hover { background: var(--n-300); color: var(--n-900); }
  button:disabled { color: var(--n-500); background: var(--n-150); }
  button.primary { background: var(--n-800); color: var(--n-050); justify-self: start; }
  button.primary:hover { background: var(--n-900); }
  button.quiet { background: none; color: var(--n-600); }
  button.quiet:hover { color: var(--n-900); background: var(--n-200); }
  button[aria-pressed='true'] { background: var(--n-400); color: var(--n-900); }
  .tc { font-variant-numeric: tabular-nums; }
  button:focus-visible, a:focus-visible, select:focus-visible, input:focus-visible, textarea:focus-visible { outline: 1px solid var(--n-800); outline-offset: 2px; }
  @media (max-width: 900px) { .content.with-rail { grid-template-columns: 1fr; } .rail { min-height: 0; } }
</style>
