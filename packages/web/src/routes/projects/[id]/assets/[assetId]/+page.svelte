<script lang="ts">
  import { tick } from 'svelte';
  import Player from '@onelight/player/Player.svelte';
  import ImageViewer from '@onelight/player/ImageViewer.svelte';
  import { parseSpriteVtt } from '@onelight/player';
  import { annotationInkFor } from '@onelight/player';
  import { formatTimecode, timecodeFromFrames } from '@onelight/core';
  import type {
    FrameAnnotation,
    PendingDrawing,
    PlayerRendition,
    SpriteCue,
    TimelineMarker
  } from '@onelight/player';
  import { page } from '$app/state';
  import { copyText } from '$lib/clipboard.js';
  import { dismissable } from '$lib/dismiss.js';
  import { holdRepeat } from '$lib/hold-repeat.js';
  import { replaceState } from '$app/navigation';
  import { api, apiDelete, apiPatch, apiPost, apiPut, messageFrom } from '$lib/api.js';
  import { uploadFile } from '$lib/upload.js';
  import { projectEvents } from '$lib/sse.svelte.js';
  import AttachmentImage from '$lib/AttachmentImage.svelte';
  import { auth } from '$lib/auth.svelte.js';
  import Avatar from '$lib/Avatar.svelte';
  import Lightbox from '$lib/Lightbox.svelte';
  import { canonicalizePath } from '$lib/canonical.js';
  import { idFrom, pretty } from '$lib/ids.js';
  import { whenAbsolute, whenRelative } from '$lib/format.js';
  import { formatBytes } from '$lib/upload.js';
  import { annotationsFrom, markersFrom, type ReviewComment } from '$lib/comments.js';
  import { markerInkFor } from '@onelight/player';
  import { hashtagsIn, segmentCommentBody } from './comment-text.js';

  type Asset = {
    id: string;
    public_id: string;
    project_id: string;
    name: string;
    kind: string;
    status: string;
    current_version_id: string | null;
    has_thumbnail?: boolean;
    updated_at?: number;
  };
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
    created_at?: number;
    author_user_id?: string | null;
    carried_from_comment_id?: string | null;
  };
  type Member = { user: { id: string; name: string; email: string; avatar_url?: string | null }; role: string };
  type NoteFilter = 'all' | 'open' | 'completed';
  type UploadState = { status: 'idle' | 'uploading' | 'registering' | 'failed'; progress: number; error: string };

  let asset = $state<Asset | null>(null);
  let versions = $state<Version[]>([]);
  let selectedVersionId = $state<string | null>(null);
  let source = $state('');
  let renditionOptions = $state<PlayerRendition[]>([]);
  /* The version's generated poster: the player shows it while the first
     frame decodes, so opening an asset is never a black box. */
  let posterUrl = $state<string | null>(null);
  let filmstrip = $state<{ url: string; cues: SpriteCue[] } | null>(null);
  let waveformUrl = $state<string | null>(null);
  /* Peak data and the spectrogram: the two halves of the audio stage. */
  let peaksUrl = $state<string | null>(null);
  let spectrogramUrl = $state<string | null>(null);
  /* The still itself, at full resolution, and the previous version of it for
     A/B. Images have no proxy ladder: still_tiles is the review file. */
  let stillUrl = $state<string | null>(null);
  let stillPrevUrl = $state<string | null>(null);
  /* First caption track's URL; the player takes one track. */
  let captionsUrl = $state<string | null>(null);
  let rate = $state<{ num: number; den: number } | null>(null);
  let dropFrame = $state(false);
  let durationFrames = $state<number | null>(null);
  let error = $state('');
  let comments = $state<Comment[]>([]);
  let bodyText = $state('');
  let commentError = $state('');
  let currentFrame = $state(0);
  let player = $state<Player | null>(null);
  let stills = $state<ImageViewer | null>(null);
  /* Which instrument this asset gets. The page is the same page either way:
     the same notes rail, the same anchors, the same versions. */
  const mediaKind = $derived(asset?.kind === 'audio' || asset?.kind === 'image' ? asset.kind : 'video');
  /* Drawings and thumbnails come from whichever instrument is on screen. */
  const clearInstrumentDrawing = (): void => {
    player?.clearDrawing();
    stills?.clearDrawing();
  };
  let noteFilter = $state<NoteFilter>('all');
  let activeTag = $state<string | null>(null);
  let highlightedId = $state<string | null>(null);
  let pendingDrawing = $state<PendingDrawing | null>(null);
  let members = $state<Member[]>([]);
  let membersFor: string | null = null;
  /* Versions are a menu off the header, not a rail: the rail belongs to notes,
     which are what a reviewer actually does here. */
  let versionMenuOpen = $state(false);
  /* The note being replied to, or null for a new thread. */
  let replyTo = $state<Comment | null>(null);
  /* A note anchors to the playhead unless the reviewer nudges it; null means
     "follow the playhead". */
  let frameOverride = $state<number | null>(null);
  /* The player's loop in/out, mirrored here. A note covering a range wants
     exactly those two numbers, so setting in/out on the timeline is the range
     UI -- there is no second set of controls to learn or keep in sync. */
  let playerRange = $state<{ in: number | null; out: number | null }>({ in: null, out: null });
  /* The rail can be folded away to give the picture the whole window. Open by
     default: notes are the job. */
  let notesOpen = $state(true);
  const NOTES_OPEN_KEY = 'onelight.notes.open';
  $effect(() => {
    try {
      notesOpen = localStorage.getItem(NOTES_OPEN_KEY) !== '0';
    } catch {
      /* Storage can be unavailable; the rail stays open. */
    }
  });
  const setNotesOpen = (open: boolean): void => {
    notesOpen = open;
    try {
      localStorage.setItem(NOTES_OPEN_KEY, open ? '1' : '0');
    } catch {
      /* Non-persistent, still applied for the session. */
    }
  };
  /* Renaming happens in place on the title: PATCH /assets/:id already takes a
     name, and nothing in the UI ever offered it. */
  let renaming = $state(false);
  let renameText = $state('');
  let railError = $state('');
  let copyNotice = $state('');
  let uploadState = $state<UploadState>({ status: 'idle', progress: 0, error: '' });
  let carryForwardOnUpload = $state(true);
  let prevVersion = $state<Version | null>(null);
  /* The open notes of the previous version, by id, not by count: what the
     banner offers is the notes that are not here yet, and whether one is here
     yet is answered by the copies on screen. Holding a count instead meant the
     banner still offered seven notes right after all seven were copied (they
     are still open on their own version, which is not the question). */
  let prevOpenIds = $state<string[]>([]);
  let settledSources = $state<string[]>([]);
  let carrying = $state(false);
  let carryNotice = $state('');
  /* Status lines say what just happened, then get out of the way. */
  const noticeFor = (message: string): void => {
    carryNotice = message;
    setTimeout(() => {
      if (carryNotice === message) carryNotice = '';
    }, 4000);
  };
  /* The Info drawer: everything the probe knows about the version on screen,
     grouped the way a post professional reads it -- picture, color, motion,
     sound, file. The full ffprobe record is stored per version; this renders
     it instead of hiding it. */
  type InfoDetail = {
    original_filename: string | null;
    size: number;
    source_timecode_start: string | null;
    media_info: {
      format?: {
        format_long_name?: string;
        bit_rate?: string;
        tags?: Record<string, string>;
      };
      streams?: Array<Record<string, unknown>>;
    };
  };
  let infoOpen = $state(false);
  let infoDetail = $state<InfoDetail | null>(null);
  let infoFor: string | null = null;
  const toggleInfo = (): void => {
    infoOpen = !infoOpen;
    if (!infoOpen || !selectedVersionId || infoFor === selectedVersionId) return;
    infoFor = selectedVersionId;
    infoDetail = null;
    void (async () => {
      try {
        infoDetail = await api<InfoDetail>(`/api/v1/versions/${selectedVersionId}`);
      } catch {
        infoFor = null;
      }
    })();
  };

  type InfoGroup = { title: string; rows: Array<[string, string]>; alert?: boolean };
  const infoGroups = $derived.by((): InfoGroup[] => {
    if (!infoDetail) return [];
    const streams = infoDetail.media_info.streams ?? [];
    const str = (value: unknown): string | null =>
      typeof value === 'string' && value ? value : typeof value === 'number' ? String(value) : null;
    const video = streams.find((stream) => stream.codec_type === 'video');
    const audio = streams.filter((stream) => stream.codec_type === 'audio');
    const groups: InfoGroup[] = [];
    if (video) {
      const codec = [str(video.codec_name)?.toUpperCase(), str(video.profile)].filter(Boolean).join(' ');
      const size = video.width && video.height ? `${String(video.width)} x ${String(video.height)}` : null;
      groups.push({
        title: 'Picture',
        rows: (
          [
            ['Codec', codec || null],
            ['Frame size', size],
            ['Aspect', str(video.display_aspect_ratio)],
            ['Pixel format', str(video.pix_fmt)],
            ['Scan', str(video.field_order)]
          ] as Array<[string, string | null]>
        ).filter((row): row is [string, string] => row[1] !== null)
      });
      const primaries = str(video.color_primaries);
      const transfer = str(video.color_transfer);
      const nonRec709 = Boolean((primaries && primaries !== 'bt709') || (transfer && transfer !== 'bt709'));
      groups.push({
        title: 'Color',
        alert: nonRec709,
        rows: (
          [
            ['Primaries', primaries],
            ['Transfer', transfer],
            ['Matrix', str(video.color_space)],
            ['Range', str(video.color_range)]
          ] as Array<[string, string | null]>
        ).filter((row): row is [string, string] => row[1] !== null)
      });
    }
    const motionRows: Array<[string, string]> = [];
    if (rate) {
      const exact = rate.den === 1 ? `${rate.num} fps` : `${rate.num}/${rate.den} (${(rate.num / rate.den).toFixed(3)}) fps`;
      motionRows.push(['Frame rate', `${exact}${dropFrame ? ', drop frame' : ''}`]);
    }
    if (durationFrames) {
      motionRows.push(['Duration', `${timecodeAt(Math.max(0, durationFrames - 1))} (${String(durationFrames)} frames)`]);
    }
    if (infoDetail.source_timecode_start) motionRows.push(['Start timecode', infoDetail.source_timecode_start]);
    if (motionRows.length) groups.push({ title: 'Motion', rows: motionRows });
    if (audio.length) {
      groups.push({
        title: 'Sound',
        rows: audio.map((stream, index) => [
          audio.length > 1 ? `Track ${String(index + 1)}` : 'Track',
          [
            str(stream.codec_name)?.toUpperCase(),
            str(stream.channel_layout) ?? (stream.channels ? `${String(stream.channels)}ch` : null),
            str(stream.sample_rate) ? `${Number(stream.sample_rate) / 1000} kHz` : null
          ]
            .filter(Boolean)
            .join(', ')
        ])
      });
    }
    const format = infoDetail.media_info.format;
    const fileRows: Array<[string, string | null]> = [
      ['Filename', infoDetail.original_filename],
      ['Container', format?.format_long_name ?? null],
      ['Size', infoDetail.size ? formatBytes(infoDetail.size) : null],
      ['Bitrate', format?.bit_rate ? `${(Number(format.bit_rate) / 1_000_000).toFixed(1)} Mb/s` : null],
      ['Encoder', format?.tags?.encoder ?? null],
      ['Created', format?.tags?.creation_time ? format.tags.creation_time.slice(0, 10) : null]
    ];
    groups.push({
      title: 'File',
      rows: fileRows.filter((row): row is [string, string] => row[1] !== null)
    });
    return groups;
  });

  /* The NLE round trip: notes leave as marker files and marker files come
     back as notes, both scoped to the version on screen. */
  let exchangeOpen = $state(false);
  let exportFormat = $state('resolve_edl');
  let exportBase = $state<'source' | 'record_run'>('source');
  let exportBusy = $state(false);
  let importBusy = $state(false);
  let exchangeNotice = $state('');
  let exchangeError = $state('');
  const EXPORT_FORMATS: ReadonlyArray<readonly [string, string]> = [
    ['resolve_edl', 'Resolve marker EDL'],
    ['avid_txt', 'Avid marker text'],
    ['avid_xml', 'Avid marker XML'],
    ['fcpxml', 'Final Cut Pro FCPXML'],
    ['xmeml', 'Premiere / FCP7 XML'],
    ['csv', 'CSV'],
    ['json', 'JSON'],
    ['text', 'Plain text'],
    ['pdf', 'PDF report']
  ];
  /* Comment id to version number, filled from every comment fetch, so
     carried badges can say which version a note came from. Reactive: the
     source version's comments often load after the visible ones render. */
  let versionNoByComment = $state<Record<string, number>>({});
  /* Bumped on every asset or version switch; stale async loads stand down. */
  let versionToken = 0;

  const routeAssetId = $derived(idFrom(page.params.assetId));
  /* Canonical ULIDs, set once the asset loads. The route may carry short
     public ids, which only the bootstrap fetch understands; every other
     call in this file goes out with canonical ids. */
  let assetId = $state<string | null>(null);
  let projectId = $state<string | null>(null);
  let projectInfo = $state<{ public_id: string; name: string } | null>(null);
  let projectRole = $state<string | null>(null);
  const projectSeg = $derived(
    projectInfo ? pretty(projectInfo.public_id, projectInfo.name) : (page.params.id ?? '')
  );
  const assetSeg = $derived(
    asset ? pretty(asset.public_id, asset.name) : (page.params.assetId ?? '')
  );
  const selectedVersion = $derived(versions.find((version) => version.id === selectedVersionId) ?? null);
  const newestVersion = $derived(versions[0] ?? null);
  const isNewestSelected = $derived(Boolean(selectedVersion && newestVersion && selectedVersion.id === newestVersion.id));
  /* Provenance, read off the notes on screen: a source that already has a copy
     here is not on offer. Derived, so a carry (or a note arriving over SSE)
     settles the banner without a refetch. */
  const carriedSources = $derived(
    new Set(
      comments
        .map((comment) => comment.carried_from_comment_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
    )
  );
  /* A copy the reviewer deleted is gone from `comments` but stays carried as
     far as the server is concerned, so provenance alone would put the banner
     back to offer a note that will never copy again. A completed press settles
     every open note of its source, deleted copies included. */
  const prevOpenCount = $derived(
    prevOpenIds.filter((id) => !carriedSources.has(id) && !settledSources.includes(id)).length
  );
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

  /* One marker per thread. Replies inherit their parent's frame (the replies
     endpoint copies frameIn on purpose, so a reply sits at the same moment), so
     feeding replies in here would stack a second marker on top of the first for
     every reply in a thread. */
  const markers = $derived<TimelineMarker[]>(
    markersFrom(comments.filter((comment) => !comment.parent_id))
  );

  const tagsOf = (comment: Comment): string[] =>
    Array.isArray(comment.tags) ? comment.tags : hashtagsIn(comment.body_text);

  /* Notes speak timecode, not frame indices: "Frame 1487" is not a thing anyone
     says out loud in a review. The frame is still what is stored and seeked. */
  const timecodeAt = (frame: number): string => {
    try {
      return formatTimecode(timecodeFromFrames(frame, rate ?? { num: 24, den: 1 }, dropFrame));
    } catch {
      return String(frame);
    }
  };

  const visibleComments = $derived(
    comments.filter((comment) => {
      const stateMatch =
        noteFilter === 'all' ? true : noteFilter === 'open' ? !comment.completed_at : Boolean(comment.completed_at);
      if (!stateMatch) return false;
      return activeTag === null || tagsOf(comment).includes(activeTag);
    })
  );

  /* Threads. The list endpoint returns replies alongside their parents (only
     carry-forward filters to roots), so the nesting is assembled here.
     Replies are keyed to their parent and ordered oldest first, the way a
     conversation reads. */
  const repliesByParent = $derived.by(() => {
    const map = new Map<string, Comment[]>();
    for (const comment of comments) {
      if (!comment.parent_id) continue;
      const list = map.get(comment.parent_id) ?? [];
      list.push(comment);
      map.set(comment.parent_id, list);
    }
    for (const list of map.values())
      list.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
    return map;
  });
  /* Filters apply to threads, not to messages: a reply is never stranded from
     its parent, and a thread the filter kept keeps all of its replies. */
  const threads = $derived(visibleComments.filter((comment) => !comment.parent_id));
  const repliesOf = (comment: Comment): Comment[] => repliesByParent.get(comment.id) ?? [];

  /* A range note when the player has both in and out set, and the range is a
     real span. Otherwise the note is a single frame. */
  const rangeActive = $derived(
    playerRange.in !== null && playerRange.out !== null && playerRange.out > playerRange.in
  );

  /* The frame a new note will anchor to: a range's in point, then a drawing's
     own frame, then any nudge the reviewer made, otherwise wherever the
     playhead is. This is what replaced the old "At playhead (N)" button -- the
     anchor simply follows the playhead, so there is nothing to press. */
  const anchorFrame = $derived(
    rangeActive
      ? (playerRange.in as number)
      : pendingDrawing
        ? pendingDrawing.frame
        : (frameOverride ?? currentFrame)
  );
  const anchorIsPlayhead = $derived(!rangeActive && !pendingDrawing && frameOverride === null);
  const nudgeAnchor = (delta: number): void => {
    frameOverride = Math.max(0, anchorFrame + delta);
  };

  /* Range authoring lives in the composer: opening a range seeds the out
     point two seconds past the anchor (or the playhead when it is already
     ahead), and the ends nudge by single frames. The marks and the range
     are one thing, so the timeline draws the span the moment it opens. */
  const openRange = (): void => {
    const rate =
      selectedVersion?.frame_rate_num && selectedVersion.frame_rate_den
        ? selectedVersion.frame_rate_num / selectedVersion.frame_rate_den
        : 24;
    const last = Math.max(1, (selectedVersion?.duration_frames ?? 1) - 1);
    const start = Math.min(anchorFrame, last - 1);
    const ahead = currentFrame > start + 1 ? currentFrame : start + Math.round(rate * 2);
    player?.setRange(start, Math.min(last, Math.max(start + 1, ahead)));
  };
  const nudgeRange = (end: 'in' | 'out', delta: number): void => {
    if (playerRange.in === null || playerRange.out === null) return;
    const nextIn = end === 'in' ? playerRange.in + delta : playerRange.in;
    const nextOut = end === 'out' ? playerRange.out + delta : playerRange.out;
    if (nextIn < 0 || nextOut <= nextIn) return;
    player?.setRange(nextIn, nextOut);
  };

  const renameAsset = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const name = renameText.trim();
    if (!asset || !name || name === asset.name) {
      renaming = false;
      return;
    }
    try {
      asset = await apiPatch<Asset>(`/api/v1/assets/${asset.id}`, { name });
      renaming = false;
      error = '';
    } catch (caught) {
      error = messageFrom(caught, 'The name could not be changed.');
    }
  };

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
      const listing = await api<{ items: Rendition[]; captions?: Array<{ url: string | null }> }>(
        `/api/v1/versions/${versionId}/renditions`
      );
      const items = listing.items;
      if (token !== versionToken) return;
      captionsUrl = listing.captions?.find((track) => track.url)?.url ?? null;
      renditionOptions = items
        .filter((candidate) => ['proxy_540', 'proxy_1080', 'proxy_2160'].includes(candidate.kind))
        .flatMap((candidate) => {
          const url = urlForRendition(candidate);
          return url ? [{ kind: candidate.kind, url }] : [];
        });
      /* The playable file, per kind: the 1080 proxy for footage, the AAC
         proxy for a mix. A still has neither and is shown, not played. */
      const rendition =
        items.find((candidate) => candidate.kind === 'proxy_1080') ??
        items.find((candidate) => candidate.kind === 'proxy_audio') ??
        items.find((candidate) => candidate.kind.startsWith('proxy_'));
      source = (rendition && urlForRendition(rendition)) || '';
      const still = items.find((candidate) => candidate.kind === 'still_tiles');
      stillUrl = still ? urlForRendition(still) : null;
      const poster = items.find((candidate) => candidate.kind === 'poster');
      posterUrl = poster ? urlForRendition(poster) : null;
      const peaks = items.find((candidate) => candidate.kind === 'audio_peaks');
      waveformUrl = peaks ? urlForRendition(peaks) : null;
      const waveform = items.find((candidate) => candidate.kind === 'waveform_data');
      peaksUrl = waveform ? urlForRendition(waveform) : null;
      const spectrogram = items.find((candidate) => candidate.kind === 'spectrogram');
      spectrogramUrl = spectrogram ? urlForRendition(spectrogram) : null;
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

  /* Queue the export, wait for the worker, then hand the browser the signed
     download. The job is project-scoped; the version filter keeps it to the
     version on screen, which is what a review session means by "export". */
  const runExport = async (): Promise<void> => {
    if (!projectId || !selectedVersionId || exportBusy) return;
    exportBusy = true;
    exchangeError = '';
    exchangeNotice = 'Preparing the export.';
    try {
      const job = await apiPost<{ id: string }>(`/api/v1/projects/${projectId}/export`, {
        format: exportFormat,
        timecode_base: exportBase,
        filters: { version_id: selectedVersionId }
      });
      for (let waited = 0; ; waited += 800) {
        if (waited > 60_000) throw new Error('The export is taking a while; it will keep running, try the download again shortly.');
        await new Promise((resolve) => setTimeout(resolve, 800));
        const status = await api<{ status: string; error: string | null }>(`/api/v1/exports/${job.id}`);
        if (status.status === 'failed') throw new Error(status.error ?? 'The export failed.');
        if (status.status === 'complete') break;
      }
      const { url } = await api<{ url: string }>(`/api/v1/exports/${job.id}/download`);
      const link = document.createElement('a');
      link.href = url;
      link.download = '';
      link.click();
      exchangeNotice = 'Export downloaded.';
    } catch (caught) {
      exchangeError = messageFrom(caught, 'The export failed.');
      exchangeNotice = '';
    } finally {
      exportBusy = false;
    }
  };

  const importMarkers = async (event: Event): Promise<void> => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !selectedVersionId || importBusy) return;
    importBusy = true;
    exchangeError = '';
    exchangeNotice = '';
    try {
      const content = await file.text();
      const format = /\.csv$/i.test(file.name) ? 'csv' : 'resolve_edl';
      const result = await apiPost<{ imported: number; skipped: number }>(
        `/api/v1/versions/${selectedVersionId}/comments/import`,
        { format, content, timecode_base: exportBase }
      );
      exchangeNotice =
        `${result.imported} ${result.imported === 1 ? 'note' : 'notes'} imported` +
        (result.skipped ? `, ${result.skipped} outside this version skipped.` : '.');
      await refreshComments(selectedVersionId, versionToken);
    } catch (caught) {
      exchangeError = messageFrom(caught, 'The file could not be imported.');
    } finally {
      importBusy = false;
    }
  };

  /* Carry-forward offers notes from the immediately previous version when
     the newest is on screen and that previous version still has open notes. */
  /* The still one version back, for the viewer's A/B. Fetched only for image
     assets and only when there is a version before this one; everything else
     leaves the compare controls off. */
  const loadPreviousStill = async (token: number): Promise<void> => {
    stillPrevUrl = null;
    if (asset?.kind !== 'image') return;
    const index = versions.findIndex((version) => version.id === selectedVersionId);
    const previous = index >= 0 ? versions[index + 1] : undefined;
    if (!previous) return;
    try {
      const listing = await api<{ items: Rendition[] }>(
        `/api/v1/versions/${previous.id}/renditions`
      );
      if (token !== versionToken) return;
      const still = listing.items.find((candidate) => candidate.kind === 'still_tiles');
      stillPrevUrl = still ? urlForRendition(still) : null;
    } catch {
      /* No A/B for this version; the viewer simply does not offer it. */
    }
  };

  const checkCarrySource = async (token: number): Promise<void> => {
    prevVersion = null;
    prevOpenIds = [];
    settledSources = [];
    if (!isNewestSelected || versions.length < 2) return;
    const previous = versions[1];
    if (!previous) return;
    try {
      const items = (await api<{ items: Comment[] }>(`/api/v1/versions/${previous.id}/comments`)).items;
      if (token !== versionToken) return;
      rememberVersionNos(items, previous.version_no);
      prevVersion = previous;
      prevOpenIds = items
        .filter((comment) => !comment.completed_at && !comment.parent_id)
        .map((comment) => comment.id);
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
    posterUrl = null;
    captionsUrl = null;
    peaksUrl = null;
    spectrogramUrl = null;
    stillUrl = null;
    infoOpen = false;
    infoFor = null;
    infoDetail = null;
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
    await loadPreviousStill(token);
    if (token !== versionToken) return;
    await refreshComments(versionId, token);
    if (token !== versionToken) return;
    await checkCarrySource(token);
  };

  const load = async (id: string): Promise<void> => {
    versionToken += 1;
    asset = null; versions = []; selectedVersionId = null; source = ''; renditionOptions = [];
    filmstrip = null; waveformUrl = null; peaksUrl = null; spectrogramUrl = null; posterUrl = null;
    stillUrl = null; stillPrevUrl = null; rate = null; dropFrame = false; durationFrames = null;
    error = ''; comments = []; commentError = ''; highlightedId = null; pendingDrawing = null;
    noteFilter = 'all'; activeTag = null; railError = ''; prevVersion = null; prevOpenIds = []; settledSources = [];
    versionNoByComment = {};
    assetId = null;
    projectId = null;
    let canonical = '';
    try {
      const loaded = await api<Asset>(`/api/v1/assets/${id}`);
      if (id !== routeAssetId) return;
      asset = loaded;
      assetId = loaded.id;
      projectId = loaded.project_id;
      canonical = loaded.id;
    } catch (caught) {
      error = messageFrom(caught, 'This asset is not available.');
      return;
    }
    const pid = projectId;
    if (pid) {
      void loadMembers(pid);
      /* The project's public identity, for the address bar and the links
         out; the page works before it arrives. */
      void api<{ id: string; public_id: string; name: string; my_role?: string | null }>(
        `/api/v1/projects/${pid}`
      )
        .then((loadedProject) => {
          if (asset?.project_id !== loadedProject.id) return;
          projectInfo = { public_id: loadedProject.public_id, name: loadedProject.name };
          projectRole = loadedProject.my_role ?? null;
          if (asset)
            canonicalizePath(
              `/projects/${pretty(loadedProject.public_id, loadedProject.name)}/assets/${pretty(asset.public_id, asset.name)}`
            );
        })
        .catch(() => {
          /* Cosmetic only. */
        });
    }
    try {
      versions = (await api<{ items: Version[] }>(`/api/v1/assets/${canonical}/versions`)).items;
    } catch {
      versions = [];
    }
    if (id !== routeAssetId) return;
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
    const id = routeAssetId;
    if (id) void load(id);
  });

  /* The original is the negative and downloads at editor; anyone else gets
     the review proxy. One button, the best file the role allows. */
  let downloadBusy = $state(false);
  const downloadCurrent = async (): Promise<void> => {
    const versionId = selectedVersionId;
    if (!versionId || downloadBusy) return;
    downloadBusy = true;
    try {
      const wantOriginal = projectRole === 'editor' || projectRole === 'manager';
      const signed = await api<{ url: string }>(
        `/api/v1/versions/${versionId}/download${wantOriginal ? '' : '?kind=proxy'}`
      );
      window.location.assign(signed.url);
    } catch (caught) {
      railError = messageFrom(caught, 'The download could not start.');
    } finally {
      downloadBusy = false;
    }
  };

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

  /* Copy the open notes of any version onto the one on screen. The banner
     below the notes is the common case (the version just before this one);
     the version menu aims the same thing anywhere in the stack, which is what
     a recut needs when v4 is really a revision of v2. Repeat presses are safe:
     the server skips sources already carried here. */
  const carryFrom = async (from: Version): Promise<void> => {
    const target = selectedVersionId;
    if (!target || carrying || from.id === target) return;
    carrying = true;
    railError = '';
    carryNotice = '';
    try {
      const result = await apiPost<{ items: string[] }>(
        `/api/v1/versions/${target}/carry-forward`,
        { from_version_id: from.id }
      );
      const count = result.items.length;
      noticeFor(
        count === 0
          ? `Every open note on v${from.version_no} is already here.`
          : `${count} ${count === 1 ? 'note' : 'notes'} copied from v${from.version_no}.`
      );
      const token = versionToken;
      await refreshComments(target, token);
      await checkCarrySource(token);
      if (token !== versionToken) return;
      /* Every open note on that version has now been answered for, whatever
         the reviewer does with the copies. checkCarrySource clears this on a
         version switch, so it only settles the press just made. */
      if (from.id === prevVersion?.id) settledSources = [...prevOpenIds];
    } catch (caught) {
      railError = messageFrom(caught, 'Notes could not be copied.');
    } finally {
      carrying = false;
    }
  };

  const carryForward = async (): Promise<void> => {
    if (prevVersion) await carryFrom(prevVersion);
  };

  /* ---- the chosen thumbnail ----

     The generated poster is a frame ten percent in, which is a guess: a slate,
     a fade up, an empty room. Here the picture can be decided instead, either
     by keeping the frame on screen or by uploading one. Both take the same
     road: a PNG through an ordinary upload session, then PUT
     /assets/:id/thumbnail. No transcode, because a still is already a still. */
  let thumbBusy = $state(false);
  let moreOpen = $state(false);
  let thumbNotice = $state('');

  const putThumbnail = async (file: File): Promise<void> => {
    const target = asset;
    const pid = projectId;
    if (!target || !pid || thumbBusy) return;
    thumbBusy = true;
    thumbNotice = '';
    railError = '';
    try {
      const sessionId = await uploadFile({ projectId: pid, file, relativePath: '' });
      asset = await apiPut<Asset>(`/api/v1/assets/${target.id}/thumbnail`, { upload_id: sessionId });
      thumbNotice = 'Thumbnail set.';
      setTimeout(() => {
        if (thumbNotice === 'Thumbnail set.') thumbNotice = '';
      }, 4000);
    } catch (caught) {
      railError = messageFrom(caught, 'That thumbnail could not be set.');
    } finally {
      thumbBusy = false;
    }
  };

  const thumbnailFromFrame = async (): Promise<void> => {
    const blob = await (player ? player.captureFrame() : stills?.captureFrame());
    if (!blob) {
      railError = 'This frame could not be captured. Wait for the picture to load, then try again.';
      return;
    }
    await putThumbnail(new File([blob], `thumbnail-${String(currentFrame)}.png`, { type: 'image/png' }));
  };

  const thumbnailFromFile = async (event: Event): Promise<void> => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) await putThumbnail(file);
  };

  const clearThumbnail = async (): Promise<void> => {
    const target = asset;
    if (!target || thumbBusy) return;
    thumbBusy = true;
    thumbNotice = '';
    try {
      await apiDelete(`/api/v1/assets/${target.id}/thumbnail`);
      asset = { ...target, has_thumbnail: false, updated_at: Date.now() };
      thumbNotice = 'The generated poster stands again.';
      setTimeout(() => {
        if (thumbNotice === 'The generated poster stands again.') thumbNotice = '';
      }, 4000);
    } catch (caught) {
      railError = messageFrom(caught, 'That thumbnail could not be cleared.');
    } finally {
      thumbBusy = false;
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
    copyNotice = (await copyText(url.toString())) ? 'Link copied' : 'Copy failed';
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
    /* Enter sends, shift+Enter breaks the line. The footer says so, so it has
       to be true. The mention menu gets Enter first (handled below). */
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !(mentionQuery !== null && mentionMatches.length > 0)
    ) {
      event.preventDefault();
      const form = (event.currentTarget as HTMLElement).closest('form');
      if (form instanceof HTMLFormElement) form.requestSubmit();
      return;
    }
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

  /* Files waiting on the composer; they upload after the note is created,
     because attachments hang off a comment id. */
  let pendingFiles = $state<File[]>([]);
  let attachInput = $state<HTMLInputElement | null>(null);
  let lightbox = $state<{ url: string; name: string } | null>(null);

  const resolveAttachmentUrl = async (comment: Comment, attachment: { id: string }): Promise<string> => {
    const issued = await api<{ url: string }>(
      `/api/v1/comments/${comment.id}/attachments/${attachment.id}`
    );
    return issued.url;
  };

  const attachPicked = (event: Event): void => {
    const input = event.currentTarget as HTMLInputElement;
    pendingFiles = [...pendingFiles, ...Array.from(input.files ?? [])].slice(0, 5);
    input.value = '';
  };

  const prettySize = (bytes: number): string =>
    bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} kB`;

  const openAttachment = async (comment: Comment, attachment: { id: string }): Promise<void> => {
    try {
      const issued = await api<{ url: string }>(
        `/api/v1/comments/${comment.id}/attachments/${attachment.id}`
      );
      window.open(issued.url, '_blank', 'noopener');
    } catch (caught) {
      commentError = messageFrom(caught, 'The file is not available.');
    }
  };

  const addComment = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const versionId = selectedVersionId;
    if (!versionId || !bodyText.trim()) return;
    const drawing = pendingDrawing;
    const parent = replyTo;
    /* A reply belongs to its parent's moment, not the playhead: it inherits the
       parent's anchor rather than pinning a second marker on the timeline. */
    const frame = parent ? null : anchorFrame;
    const mentionIds = [...new Set(picked.filter((entry) => bodyText.includes(`@${entry.name}`)).map((entry) => entry.id))];
    try {
      /* Replies have their own endpoint, which owns the parent and the version
         and refuses to nest a reply under a reply. POST /versions/:id/comments
         accepts parent_id in its schema and then ignores it, so sending a reply
         there quietly creates a second top-level thread instead. */
      const created = await apiPost<Comment>(
        parent ? `/api/v1/comments/${parent.id}/replies` : `/api/v1/versions/${versionId}/comments`,
        {
          body_text: bodyText,
          ...(frame !== null ? { frame_in: frame } : {}),
          /* A range note carries the player's out point too. Replies inherit
             their parent's span, so they never send one. */
          ...(!parent && rangeActive ? { frame_out: playerRange.out as number } : {}),
          ...(drawing ? { annotation: { strokes: drawing.strokes } } : {}),
          ...(mentionIds.length ? { mentions: mentionIds } : {})
        }
      );
      const uploaded: NonNullable<Comment['attachments']> = [];
      for (const file of pendingFiles) {
        const form = new FormData();
        form.set('file', file);
        const response = await fetch(`/api/v1/comments/${created.id}/attachments`, {
          method: 'POST',
          body: form
        });
        if (!response.ok) throw new Error(`${file.name} could not be attached.`);
        const row = (await response.json()) as { id: string };
        uploaded.push({ id: row.id, filename: file.name, size: file.size, content_type: file.type });
      }
      created.attachments = uploaded;
      pendingFiles = [];
      /* An SSE echo of this comment may already have refetched the list. */
      if (!comments.some((comment) => comment.id === created.id))
        comments = [...comments, created].sort(commentOrder);
      const versionNo = versions.find((version) => version.id === versionId)?.version_no;
      if (versionNo) versionNoByComment[created.id] = versionNo;
      bodyText = '';
      frameOverride = null;
      replyTo = null;
      commentError = '';
      picked = [];
      mentionQuery = null;
      if (drawing) {
        clearInstrumentDrawing();
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

  /* Resolving was one-way. A note resolved by mistake, or reopened because the
     fix did not hold, had nowhere to go. */
  const reopenComment = async (id: string): Promise<void> => {
    try {
      const reopened = await apiDelete<Comment>(`/api/v1/comments/${id}/complete`);
      comments = comments.map((comment) => (comment.id === id ? { ...comment, ...reopened } : comment));
      commentError = '';
    } catch (caught) {
      commentError = messageFrom(caught, 'The note could not be reopened.');
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
    if (comment.frame_in === null) return;
    /* A ranged note re-arms its marks, so the span shows on the timeline
       and P loops it; a plain note leaves the marks alone. */
    if (comment.frame_out !== null && comment.frame_out > comment.frame_in)
      player?.setRange(comment.frame_in, comment.frame_out);
    player?.seekToFrame(comment.frame_in);
  };

  /* A timeline marker click seeks in the player and highlights the note. */
  const highlightComment = (id: string): void => {
    highlightedId = id;
    document.getElementById(`note-${id}`)?.scrollIntoView({ block: 'nearest' });
  };

  const discardDrawing = (): void => {
    clearInstrumentDrawing();
    pendingDrawing = null;
  };
</script>

<svelte:head><title>{asset?.name ?? 'Review room'} | Onelight</title></svelte:head>

<main class="review">
  <header class="topbar">
    <a href={`/projects/${projectSeg}`}>Back to project</a>
    {#if asset}
      <!-- Rename in place. PATCH /assets/:id has always taken a name; nothing
           in the UI ever offered it, so a mis-named upload stayed mis-named. -->
      {#if renaming}
        <form class="rename" onsubmit={renameAsset}>
          <!-- svelte-ignore a11y_autofocus -->
          <input
            bind:value={renameText}
            aria-label="Media name"
            maxlength="500"
            autofocus
            onkeydown={(event) => { if (event.key === 'Escape') renaming = false; }}
            onblur={() => { renaming = false; }}
          />
          <button type="submit">Save</button>
        </form>
      {:else}
        <h1>
          <button type="button" class="renametrigger" onclick={() => { renameText = asset?.name ?? ''; renaming = true; }} title="Rename">
            {asset.name}
          </button>
        </h1>
      {/if}
      <span class="grow"></span>
      <!-- On desktop this wrapper is display:contents and changes nothing; on
           a phone it is the actions band that scrolls under the title row. -->
      <div class="acts" class:panelopen={versionMenuOpen || infoOpen || moreOpen}>
      <!-- Versions: a menu that states which version you are looking at, rather
           than a rail competing with the notes for the same space. -->
      <div class="vmenu" use:dismissable={() => { versionMenuOpen = false; }}>
        <button
          type="button"
          class="vtrigger"
          aria-haspopup="menu"
          aria-expanded={versionMenuOpen}
          onclick={() => { versionMenuOpen = !versionMenuOpen; }}
        >
          <span class="tc vtrigger-no">v{selectedVersion?.version_no ?? '--'}</span>
          {#if asset && selectedVersion && selectedVersion.id === asset.current_version_id}
            <span class="vtrigger-current">Current</span>
          {/if}
          <span class="caret" aria-hidden="true">▾</span>
        </button>
        {#if versionMenuOpen}
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <div
            class="vpanel"
            role="menu"
            tabindex="-1"
            onmouseleave={() => { versionMenuOpen = false; }}
          >
            {#if versions.length === 0}<p class="empty">No versions.</p>{/if}
            {#each versions as version (version.id)}
              <div class="vrow" class:active={version.id === selectedVersionId}>
                <button
                  type="button"
                  role="menuitem"
                  class="vpick"
                  aria-current={version.id === selectedVersionId ? 'true' : undefined}
                  onclick={() => { versionMenuOpen = false; void selectVersion(version.id, { fromUser: true }); }}
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
                  <span class="vmeta">{memberName(version.uploaded_by)} · {whenRelative(version.created_at)}</span>
                </button>
                <span class="vacts">
                  {#if asset && version.id !== asset.current_version_id}
                    <button type="button" class="quiet setcur" onclick={() => void setCurrent(version)}>Set current</button>
                  {/if}
                  {#if version.id !== selectedVersionId}
                    <!-- Copies onto the version on screen, not onto this row:
                         you are pulling notes towards what you are watching. -->
                    <button
                      type="button"
                      class="quiet setcur"
                      disabled={carrying}
                      title={`Copy the open notes of v${version.version_no} onto v${selectedVersion?.version_no ?? '--'}`}
                      onclick={() => { versionMenuOpen = false; void carryFrom(version); }}
                    >Copy notes here</button>
                  {/if}
                </span>
              </div>
            {/each}
            {#if railError}<p class="error-text" role="alert">{railError}</p>{/if}
            <!-- Adding a version is a version verb: it lived in the top bar
                 with its own checkbox beside it, which cost the bar two
                 controls to say what this menu is already about. -->
            <div class="vfoot">
              <label class="filebtn vupload">
                Upload a new version
                <input
                  type="file"
                  onchange={uploadVersion}
                  disabled={uploadState.status === 'uploading' || uploadState.status === 'registering'}
                />
              </label>
              <label class="carry-opt">
                <input type="checkbox" bind:checked={carryForwardOnUpload} />
                Carry open notes forward
              </label>
            </div>
          </div>
        {/if}
      </div>
      <div class="infowrap" use:dismissable={() => { infoOpen = false; }}>
        <button type="button" class="info-trigger" aria-expanded={infoOpen} onclick={toggleInfo}>Info</button>
        {#if infoOpen}
          <div class="info-panel" role="dialog" aria-label="Version details">
            {#if infoGroups.length === 0}
              <p class="info-empty">Nothing probed yet.</p>
            {/if}
            {#each infoGroups as group (group.title)}
              <section class="info-group" class:alert={group.alert}>
                <h3>
                  {group.title}
                  {#if group.alert}<span class="info-flag">Not Rec.709</span>{/if}
                </h3>
                <dl>
                  {#each group.rows as [term, value] (term)}
                    <dt>{term}</dt>
                    <dd class="tc">{value}</dd>
                  {/each}
                </dl>
              </section>
            {/each}
          </div>
        {/if}
      </div>
      <!-- One overflow menu for what this asset can do, rather than a row of
           four buttons competing with the version, the info panel and the
           approval decision for the same strip of bar. -->
      <div class="morewrap" use:dismissable={() => { moreOpen = false; }}>
        <button
          type="button"
          class="more-trigger"
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          aria-label="More actions"
          title="More actions"
          onclick={() => { moreOpen = !moreOpen; }}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor"><circle cx="3" cy="8" r="1.4" /><circle cx="8" cy="8" r="1.4" /><circle cx="13" cy="8" r="1.4" /></svg>
        </button>
        {#if moreOpen}
          <div class="more-panel" role="menu" tabindex="-1">
            {#if versions.length >= 2}
              <a
                class="more-item"
                role="menuitem"
                href={`/projects/${projectSeg}/assets/${assetSeg}/compare${selectedVersionId ? `?a=${selectedVersionId}` : ''}`}
              >Compare versions</a>
            {/if}
            {#if selectedVersionId}
              <button
                type="button"
                role="menuitem"
                class="more-item"
                disabled={downloadBusy}
                onclick={() => { moreOpen = false; void downloadCurrent(); }}
              >{projectRole === 'editor' || projectRole === 'manager' ? 'Download the original' : 'Download the proxy'}</button>
            {/if}
            <p class="more-label">Thumbnail</p>
            <button
              type="button"
              role="menuitem"
              class="more-item"
              disabled={thumbBusy}
              onclick={() => { moreOpen = false; void thumbnailFromFrame(); }}
            >Use this frame</button>
            <label class="more-item more-upload">
              Upload a picture…
              <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={thumbBusy} onchange={(event) => { moreOpen = false; void thumbnailFromFile(event); }} />
            </label>
            {#if asset?.has_thumbnail}
              <button
                type="button"
                role="menuitem"
                class="more-item"
                disabled={thumbBusy}
                onclick={() => { moreOpen = false; void clearThumbnail(); }}
              >Use the generated poster</button>
            {/if}
          </div>
        {/if}
      </div>
      <label class="approval">Approval
        <select value={asset.status} onchange={(event) => updateApproval((event.currentTarget as HTMLSelectElement).value)}>
          <option value="none">No decision</option>
          <option value="in_review">In review</option>
          <option value="approved">Approved</option>
          <option value="changes_requested">Changes requested</option>
        </select>
      </label>
      </div>
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
    <div class="content" class:notes-closed={!notesOpen}>
      <div class="maincol">
        {#if mediaKind === 'image' && stillUrl}
          <!-- A still is reviewed in the still viewer: zoom, one-to-one, and
               A/B against the version before it. The notes rail either side
               of this is identical to the footage room's. -->
          <ImageViewer
            bind:this={stills}
            src={stillUrl}
            alt={asset.name}
            compareSrc={stillPrevUrl}
            compareLabel={prevVersion ? `v${prevVersion.version_no}` : 'Previous version'}
            {annotations}
            allowDrawing
            drawDefaultColor={annotationInkFor(auth.user?.id ?? null)}
            ondrawingchange={(drawing) => { pendingDrawing = drawing; }}
          />
          {#if copyNotice}<p class="copy-note" role="status">{copyNotice}</p>{/if}
        {:else if source}
          <Player
            bind:this={player}
            kind={mediaKind === 'audio' ? 'audio' : 'video'}
            {posterUrl}
            {peaksUrl}
            {spectrogramUrl}
            src={source}
            rate={rate ?? { num: 24, den: 1 }}
            {dropFrame}
            {annotations}
            {durationFrames}
            {markers}
            renditions={renditionOptions}
            {filmstrip}
            {waveformUrl}
            captionsSrc={captionsUrl ?? undefined}
            allowDrawing
            drawDefaultColor={annotationInkFor(auth.user?.id ?? null)}
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
            onrangechange={(range) => { playerRange = range; }}
            oncopytimecode={copyText}
          onshare={() => void copyFrameLink()}
          />
          <!-- The frame readout used to be repeated here under the player, next
               to the copy button, costing a row of vertical space to say what
               the transport already says. Copy moved into the transport; only
               the confirmation is left, and only while it has something to
               say. -->
          {#if copyNotice}<p class="copy-note" role="status">{copyNotice}</p>{/if}
        {:else if selectedVersion && (selectedVersion.transcode_status === 'pending' || selectedVersion.transcode_status === 'processing')}
          <p class="empty stage-empty">Transcoding this version. The proxy appears when it is ready.</p>
        {:else}
          <p class="empty stage-empty">A review proxy is not ready yet.</p>
        {/if}
      </div>
      <!-- The rail is notes, and it is always here. Notes used to sit under the
           player, so writing one meant scrolling the footage off screen. -->
      <aside class="rail">
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
            <div class="exchange" use:dismissable={() => { exchangeOpen = false; }}>
              <button
                type="button"
                class="exchange-trigger"
                aria-expanded={exchangeOpen}
                onclick={() => { exchangeOpen = !exchangeOpen; exchangeNotice = ''; exchangeError = ''; }}
              >
                Export <span class="caret" aria-hidden="true">▾</span>
              </button>
              {#if exchangeOpen}
                <div class="exchange-panel" role="dialog" aria-label="Export and import notes">
                  <p class="exchange-title">Send notes to the NLE</p>
                  <label>Format
                    <select bind:value={exportFormat}>
                      {#each EXPORT_FORMATS as [value, label] (value)}
                        <option {value}>{label}</option>
                      {/each}
                    </select>
                  </label>
                  <label>Timecode
                    <select bind:value={exportBase}>
                      <option value="source">Source timecode</option>
                      <option value="record_run">From zero</option>
                    </select>
                  </label>
                  <button type="button" class="exchange-run" onclick={() => void runExport()} disabled={exportBusy || !selectedVersionId}>
                    {exportBusy ? 'Preparing' : 'Export this version'}
                  </button>
                  {#if exportFormat === 'resolve_edl'}
                    <!-- Resolve has two EDL doors and the obvious one conforms
                         cuts; the one that makes markers is buried. Say it here,
                         at the moment it matters. -->
                    <p class="exchange-hint">
                      In Resolve: right-click the timeline in the Media Pool, then
                      Timelines, Import, Timeline Markers from EDL. The regular
                      timeline import makes cuts, not markers.
                    </p>
                  {/if}
                  <p class="exchange-title">Bring markers back</p>
                  <p class="exchange-hint">A Resolve marker EDL or an Onelight CSV becomes notes on this version.</p>
                  <label class="filebtn exchange-import">
                    {importBusy ? 'Importing' : 'Import EDL or CSV'}
                    <input
                      type="file"
                      accept=".edl,.csv,text/plain,text/csv"
                      onchange={(event) => void importMarkers(event)}
                      disabled={importBusy || !selectedVersionId}
                    />
                  </label>
                  {#if exchangeNotice}<p class="exchange-note" role="status">{exchangeNotice}</p>{/if}
                  {#if exchangeError}<p class="error-text" role="alert">{exchangeError}</p>{/if}
                </div>
              {/if}
            </div>
          </div>
          {#if carryAvailable && prevVersion}
            <div class="carry-row">
              <span>
                {prevOpenCount} open {prevOpenCount === 1 ? 'note' : 'notes'} on
                <span class="tc">v{prevVersion.version_no}</span>
                {prevOpenCount === 1 ? 'has' : 'have'} not been carried to this version.
              </span>
              <button type="button" onclick={() => void carryForward()} disabled={carrying}>
                {carrying ? 'Carrying' : `Carry forward from v${prevVersion.version_no}`}
              </button>
            </div>
          {/if}
          {#if carryNotice}<p class="carry-note" role="status">{carryNotice}</p>{/if}
          {#if thumbNotice}<p class="carry-note" role="status">{thumbNotice}</p>{/if}
          {#snippet note(comment: Comment, isReply: boolean)}
            <!-- The whole note seeks to its frame. Buttons and links inside stop
                 the event, so Resolve and #tag still do their own thing.
                 svelte-ignore is deliberate: this is a convenience click over a
                 region that already exposes the same seek on a real button. -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <article
              id={`note-${comment.id}`}
              class:completed={comment.completed_at}
              class:highlighted={highlightedId === comment.id}
              class:reply={isReply}
              class:seekable={comment.frame_in !== null}
              onclick={(event) => {
                if ((event.target as HTMLElement).closest('button, a, textarea, input')) return;
                seekToComment(comment);
              }}
            >
              <div class="note-body">
                <span class="head">
                  <Avatar
                    name={comment.author_name ?? 'Reviewer'}
                    id={comment.author_user_id}
                    url={comment.author_user_id
                      ? (members.find((member) => member.user.id === comment.author_user_id)?.user.avatar_url ?? null)
                      : null}
                    size={22}
                  />
                  <strong>{comment.author_name ?? 'Reviewer'}</strong>
                  <span class="noteink" style={`background: ${markerInkFor(comment.author_user_id ?? comment.author_name)};`} aria-hidden="true"></span>
                  {#if comment.frame_in !== null && !isReply}
                    <button
                      type="button"
                      class="chip tc"
                      onclick={() => seekToComment(comment)}
                      aria-label={`Go to frame ${comment.frame_in}`}
                    >
                      {timecodeAt(comment.frame_in)}{comment.frame_out !== null && comment.frame_out > comment.frame_in ? ` / ${timecodeAt(comment.frame_out)}` : ''}
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
                {#if comment.attachments?.length}
                  <span class="files">
                    {#each comment.attachments as attachment (attachment.id)}
                      {#if attachment.content_type.startsWith('image/')}
                        <AttachmentImage
                          {attachment}
                          resolve={() => resolveAttachmentUrl(comment, attachment)}
                          onopen={(url) => { lightbox = { url, name: attachment.filename }; }}
                        />
                      {:else}
                        <button
                          type="button"
                          class="filechip"
                          title={`${attachment.filename} (${prettySize(attachment.size)})`}
                          onclick={() => void openAttachment(comment, attachment)}
                        >
                          <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M10.5 4.5l-5 5a1.8 1.8 0 002.5 2.5l5.5-5.5a3 3 0 00-4.2-4.2L4 7.5" /></svg>
                          <span class="filename">{attachment.filename}</span>
                        </button>
                      {/if}
                    {/each}
                  </span>
                {/if}
                <span class="note-actions">
                  {#if !isReply}
                    <button type="button" class="linky" onclick={() => { replyTo = comment; composerEl?.focus(); }}>Reply</button>
                  {/if}
                  {#if !comment.completed_at}
                    <button type="button" class="linky" onclick={() => completeComment(comment.id)}>Resolve</button>
                  {:else}
                    <span class="resolved">Resolved</span>
                    <button type="button" class="linky" onclick={() => reopenComment(comment.id)}>Unresolve</button>
                  {/if}
                </span>
              </div>
            </article>
          {/snippet}

          <!-- One composer, rendered where the writing is happening: beneath the
               thread when replying, pinned to the foot of the rail otherwise.
               Only ever one at a time, so there is a single textarea to focus
               and no question about which box a keystroke lands in. -->
          {#snippet composerForm()}
          <form class="composer-form" class:inline={replyTo !== null} onsubmit={addComment}>
            {#if replyTo}
              <div class="replying">
                <span>Reply to <strong>{replyTo.author_name ?? 'Reviewer'}</strong></span>
                <button type="button" class="linky" onclick={() => { replyTo = null; }}>Cancel</button>
              </div>
            {:else}
              <div class="anchor-row">
                {#if rangeActive}
                  <!-- The player's loop in/out IS the range: one set of marks,
                       and the timeline draws the span the moment it opens. -->
                  <span class="stepper range" title="The note covers this range">
                    <span class="rangeword">from</span>
                    <button type="button" use:holdRepeat={() => nudgeRange('in', -1)} aria-label="Start one frame earlier">◂</button>
                    <span class="tc anchor-tc">{timecodeAt(playerRange.in as number)}</span>
                    <button type="button" use:holdRepeat={() => nudgeRange('in', 1)} aria-label="Start one frame later">▸</button>
                    <span class="rangeword">to</span>
                    <button type="button" use:holdRepeat={() => nudgeRange('out', -1)} aria-label="End one frame earlier">◂</button>
                    <span class="tc anchor-tc">{timecodeAt(playerRange.out as number)}</span>
                    <button type="button" use:holdRepeat={() => nudgeRange('out', 1)} aria-label="End one frame later">▸</button>
                  </span>
                  <span class="anchor-hint">{(playerRange.out as number) - (playerRange.in as number) + 1} frames</span>
                  <button type="button" class="linky" onclick={() => player?.clearRange()}>Single frame</button>
                {:else if pendingDrawing}
                  <span class="drawing-chip">Drawing at <span class="tc">{timecodeAt(pendingDrawing.frame)}</span></span>
                  <button type="button" class="linky" onclick={discardDrawing}>Discard</button>
                {:else}
                  <span class="stepper">
                    <button type="button" use:holdRepeat={() => nudgeAnchor(-1)} aria-label="One frame earlier">◂</button>
                    <span class="tc anchor-tc" aria-live="off">{timecodeAt(anchorFrame)}</span>
                    <button type="button" use:holdRepeat={() => nudgeAnchor(1)} aria-label="One frame later">▸</button>
                  </span>
                  <button type="button" class="linky" onclick={openRange} title="The note covers a stretch of time instead of one frame (or mark it with I and O)">Cover a range</button>
                  {#if anchorIsPlayhead}
                    <span class="anchor-hint">follows the playhead</span>
                  {:else}
                    <button type="button" class="linky" onclick={() => { frameOverride = null; }}>Follow playhead</button>
                  {/if}
                {/if}
              </div>
            {/if}
            <label class="sr-label">
              <span class="sr-only">Note</span>
              <span class="composer">
                <textarea
                  placeholder={replyTo ? 'Write a reply' : 'Write a note at this frame'}
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
            {#if pendingFiles.length}
              <span class="files">
                {#each pendingFiles as file, index (index)}
                  <span class="filechip pending">
                    <span class="filename">{file.name}</span>
                    <button type="button" class="filedrop" aria-label={`Remove ${file.name}`} onclick={() => { pendingFiles = pendingFiles.filter((_, at) => at !== index); }}>×</button>
                  </span>
                {/each}
              </span>
            {/if}
            <div class="composer-foot">
              <span class="composer-hint">
                {#if replyTo}Reply to this note{:else if rangeActive}Note covers the marked range{:else}Enter to send{/if}
              </span>
              <span class="foot-actions">
                <button type="button" class="attach" onclick={() => attachInput?.click()} aria-label="Attach files">
                  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M10.5 4.5l-5 5a1.8 1.8 0 002.5 2.5l5.5-5.5a3 3 0 00-4.2-4.2L4 7.5" /></svg>
                </button>
                <input bind:this={attachInput} type="file" class="attachinput" multiple accept="application/pdf,image/*" onchange={attachPicked} />
                <button type="submit" class="primary" disabled={!bodyText.trim()}>{replyTo ? 'Reply' : 'Add note'}</button>
              </span>
            </div>
          </form>
          {#if commentError}<p class="error" role="alert">{commentError}</p>{/if}
          {/snippet}

          <div class="thread-list">
            {#if threads.length === 0}
              <p class="empty">{comments.length === 0 ? 'No notes yet.' : 'No notes match this filter.'}</p>
            {/if}
            {#each threads as comment (comment.id)}
              <div class="thread">
                {@render note(comment, false)}
                {#each repliesOf(comment) as reply (reply.id)}
                  {@render note(reply, true)}
                {/each}
                <!-- The reply box belongs under the thread it answers, not at
                     the other end of the rail. -->
                {#if replyTo && (replyTo.id === comment.id || replyTo.parent_id === comment.id)}
                  {@render composerForm()}
                {/if}
              </div>
            {/each}
          </div>

          <!-- New notes compose at the foot of the rail and stay there: the list
               scrolls behind it, so the box never leaves the screen. -->
          {#if !replyTo}
            <div class="composer-dock">
              {@render composerForm()}
            </div>
          {/if}
        </section>
      </aside>
      <!-- Fold the rail away to give the picture the window. -->
      <button
        type="button"
        class="railtoggle"
        aria-expanded={notesOpen}
        onclick={() => setNotesOpen(!notesOpen)}
        title={notesOpen ? 'Hide notes' : 'Show notes'}
      >
        <span aria-hidden="true">{notesOpen ? '›' : '‹'}</span>
        <span class="sr-only">{notesOpen ? 'Hide notes' : 'Show notes'}</span>
      </button>
    </div>
  {:else}
    <!-- The room's own shape while the asset loads: a dark stage where the
         picture will be, a rail where the notes will be, breathing. Strictly
         neutral; this is the review world. -->
    <div class="content ghost" aria-hidden="true">
      <div class="ghost-stage">
        <span class="skeleton ghost-frame"></span>
        <span class="ghost-deck">
          <span class="skeleton ghost-strip"></span>
          <span class="skeleton ghost-controls"></span>
        </span>
      </div>
      <aside class="ghost-rail">
        {#each [82, 58, 71, 44] as width, index (index)}
          <span class="ghost-note">
            <span class="skeleton ghost-head" style:width={`${String(30 + ((index * 13) % 22))}%`}></span>
            <span class="skeleton ghost-body" style:width={`${String(width)}%`}></span>
          </span>
        {/each}
      </aside>
    </div>
  {/if}
</main>

{#if lightbox}
  <Lightbox url={lightbox.url} name={lightbox.name} onclose={() => (lightbox = null)} />
{/if}

<style>
  /* Review room world: strictly neutral, R=G=B, no gradients, no tinted
     chrome. Separation by value step, not borders. */
  .review { min-height: 100vh; background: var(--n-050); color: var(--n-800); font-size: var(--text-13); }
  .topbar { display: flex; align-items: center; gap: var(--pad-2); padding: 10px var(--pad-2); background: var(--n-100); flex-wrap: wrap; }
  .topbar a { color: var(--n-600); font-size: var(--text-13); text-decoration: none; }
  .topbar a:hover { color: var(--n-800); }
  h1 { margin: 0; font-family: var(--font-ui); font-size: var(--text-16); font-weight: 500; color: var(--n-900); }
  .renametrigger { background: none; padding: 2px 6px; margin: 0 -6px; color: inherit; font: inherit; border-radius: var(--radius); }
  .renametrigger:hover { background: var(--n-200); }
  .rename { display: flex; align-items: center; gap: 6px; }
  .rename input { font-size: var(--text-16); min-width: 260px; }

  /* Versions menu: says which version you are on, and opens the rest. */
  .infowrap { position: relative; }
  .info-trigger { background: var(--n-150); color: var(--n-800); padding: 8px 12px; border-radius: var(--radius); font-size: var(--text-13); font-weight: 500; }
  .info-trigger:hover, .info-trigger[aria-expanded='true'] { background: var(--n-300); color: var(--n-900); }
  .info-panel { position: absolute; right: 0; top: calc(100% + 6px); z-index: 30; width: 320px; max-height: 70vh; overflow-y: auto; background: var(--n-100); border: 1px solid var(--n-300); border-radius: var(--radius); padding: 16px; display: flex; flex-direction: column; gap: 14px; }
  .info-group h3 { margin: 0 0 6px; font-size: var(--text-12); font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--n-600); display: flex; align-items: center; gap: 8px; }
  .info-group.alert h3 { color: var(--n-800); }
  .info-flag { font-size: var(--text-12); letter-spacing: normal; text-transform: none; background: var(--n-300); color: var(--n-900); padding: 1px 7px; border-radius: 2px; font-weight: 500; }
  .info-group dl { display: grid; grid-template-columns: auto 1fr; gap: 3px 14px; margin: 0; font-size: var(--text-13); }
  .info-group dt { color: var(--n-600); }
  .info-group dd { margin: 0; color: var(--n-900); overflow-wrap: anywhere; }
  .info-empty { margin: 0; color: var(--n-600); font-size: var(--text-13); }
  .vmenu { position: relative; }
  .vtrigger { display: inline-flex; align-items: center; gap: 8px; }
  .vtrigger-no { font-weight: 600; color: var(--n-900); }
  .vtrigger-current { color: var(--n-600); font-size: var(--text-11); }
  .caret { color: var(--n-600); font-size: 10px; }
  .vpanel { position: absolute; top: calc(100% + 6px); right: 0; z-index: 30; width: 280px; padding: 6px; background: var(--n-150); border-radius: var(--radius-lg); box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5); }
  .grow { flex: 1; }
  .approval { display: flex; align-items: center; gap: 8px; color: var(--n-600); font-size: var(--text-13); }
  select, input, textarea { border: 0; border-radius: var(--radius); background: var(--n-200); color: var(--n-900); padding: 8px 10px; }

  /* Upload-new-version: a file input styled as the button it acts as. */
  .filebtn { position: relative; display: inline-block; border-radius: var(--radius); background: var(--n-200); color: var(--n-800); padding: 8px 12px; font-size: var(--text-13); font-weight: 500; cursor: pointer; }
  .filebtn:hover { background: var(--n-300); color: var(--n-900); }
  .filebtn input { position: absolute; inset: 0; width: 100%; opacity: 0; cursor: pointer; }
  .filebtn:focus-within { outline: 1px solid var(--n-800); outline-offset: 2px; }
  .carry-opt { display: flex; align-items: center; gap: 6px; color: var(--n-600); font-size: var(--text-13); }
  .carry-opt input { width: auto; padding: 0; accent-color: var(--n-700); }
  .upload-status { margin: 0; padding: 8px var(--pad-2); background: var(--n-150); color: var(--n-800); font-size: var(--text-13); }

  /* Stage left, notes right, both full height: the notes rail scrolls on its
     own so the footage never leaves the screen to write a note. The rail is
     clamped rather than fixed so it stays usable on a laptop, and it folds away
     when the picture wants the window. The grid animates, so the rail slides
     rather than blinking out. */
  .content { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) clamp(320px, 26vw, 420px); align-items: stretch; height: calc(100vh - 52px); transition: grid-template-columns 180ms ease; }
  .content.notes-closed { grid-template-columns: minmax(0, 1fr) 0px; }
  .content.notes-closed .rail { overflow: hidden; }
  /* A column too, so the player has a definite height to divide. overflow
     hidden rather than auto: the stage shrinks to fit instead of the page
     growing a scrollbar and hiding the transport below the fold. */
  .maincol { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
  .maincol > :global(.player) { flex: 1; min-height: 0; }
  /* The handle sits on the rail's LEFT edge, against the stage, where the rail
     meets the picture. On the right it was pinned to the window edge, which is
     both the last place you look and exactly where it disappears when the rail
     is closed. Anchored to the rail's inside edge, it travels with the rail and
     is always the thing between the two panes. */
  .railtoggle { position: absolute; top: 10px; right: clamp(320px, 26vw, 420px); z-index: 5; width: 22px; height: 44px; padding: 0; border-radius: var(--radius) 0 0 var(--radius); background: var(--n-200); color: var(--n-700); font-size: 13px; line-height: 1; transition: right 180ms ease, width 180ms ease, height 180ms ease; }
  .railtoggle:hover { background: var(--n-300); color: var(--n-900); }
  /* Closed, this is the only way back to the notes, so it stops being a sliver:
     a 22px tab against the window edge was a dart-throw. */
  .content.notes-closed .railtoggle { right: 0; width: 36px; height: 72px; font-size: 16px; background: var(--n-300); color: var(--n-900); }
  .content.notes-closed .railtoggle:hover { background: var(--n-400); }
  @media (prefers-reduced-motion: reduce) {
    .railtoggle { transition: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .content { transition: none; }
  }
  @media (max-width: 900px) {
    .content, .content.notes-closed { grid-template-columns: minmax(0, 1fr); height: auto; }
    .railtoggle { display: none; }
  }
  /* Above the phone width the wrapper adds no box at all. */
  .acts { display: contents; }
  /* Phone: the header is two bands — where you are, then what you can do.
     The actions scroll sideways as one row instead of stacking four. */
  @media (max-width: 720px) {
    .topbar { row-gap: 6px; }
    h1 { flex: 1; min-width: 0; }
    .renametrigger { display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .grow { display: none; }
    .acts {
      display: flex;
      flex-basis: 100%;
      align-items: center;
      gap: 10px;
      overflow-x: auto;
      scrollbar-width: none;
      -webkit-overflow-scrolling: touch;
      mask-image: linear-gradient(90deg, #000 calc(100% - 24px), transparent);
    }
    .acts > * { flex: none; }
    /* A mask paints its subtree through itself, and fixed positioning does not
       escape that the way it escapes overflow: with the fade on, a panel opened
       from this band was laid out correctly over the page and then painted only
       where the 40px band is, which read as a button that does nothing. The fade
       is there to say the row scrolls; while a panel is open, the panel says
       everything. */
    .acts.panelopen { mask-image: none; }
    .carry-opt { white-space: nowrap; }
    /* Panels anchored inside a sideways scroller would be clipped by it;
       pin them to the viewport instead. */
    .info-panel, .vpanel { position: fixed; left: var(--pad-2); right: var(--pad-2); top: 96px; width: auto; }
  }
  .stage-empty { padding: 18vh 0; text-align: center; background: var(--n-000); margin: 0; }
  .empty { color: var(--n-600); }

  /* The waiting room. Neutral skeleton ink, one value step above the stage. */
  .content.ghost { --skeleton-ink: var(--n-150); }
  .ghost-stage { display: flex; flex-direction: column; gap: 10px; padding: var(--pad-2); min-width: 0; }
  .ghost-frame { flex: 1; min-height: 0; border-radius: var(--radius); }
  .ghost-deck { display: grid; gap: 8px; }
  .ghost-strip { height: 58px; }
  .ghost-controls { height: 34px; width: 42%; justify-self: center; }
  .ghost-rail { display: flex; flex-direction: column; gap: 18px; padding: var(--pad-2); background: var(--n-100); }
  .ghost-note { display: grid; gap: 7px; }
  .ghost-head { height: 11px; opacity: 0.7; }
  .ghost-body { height: 13px; }
  @media (max-width: 720px) {
    .content.ghost { height: auto; }
    .ghost-frame { aspect-ratio: 16 / 9; flex: none; }
    .ghost-rail { display: none; }
  }
  .error { padding: 12px var(--pad-2); margin: 0; color: var(--warn); }
  .error-text { color: var(--warn); font-size: var(--text-13); }

  .copy-note { color: var(--n-600); font-size: var(--text-13); }

  /* ---- version rail ---- */
  .rail { display: flex; flex-direction: column; min-height: 0; background: var(--n-100); }
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
  .vacts { display: flex; flex-wrap: wrap; gap: 6px; }
  .setcur { justify-self: start; margin: 0 0 8px 10px; padding: 3px 8px; font-size: var(--text-13); }
  .vacts .setcur + .setcur { margin-left: 0; }

  /* ---- notes ---- */
  .notes { display: flex; flex-direction: column; min-height: 0; flex: 1; padding: var(--pad-2); gap: 10px; }
  /* The list scrolls between a fixed head and a docked composer. */
  .thread-list { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; margin: 0 -6px; padding: 0 6px; }
  .thread { margin-bottom: 10px; }
  /* One control, not a filled panel with a button loose beneath it. The surface
     holds the anchor, the field and the send together and ends where the
     control ends; the field itself is transparent so there is no box-inside-a-
     box, and the whole thing lights up when it has focus. Same 10px inset as a
     note, so note text and composer text share a left edge. */
  .composer-form { display: grid; gap: 8px; padding: 10px; background: var(--n-150); border-radius: var(--radius-lg); box-shadow: inset 0 0 0 1px var(--n-200); }
  .composer-form:focus-within { box-shadow: inset 0 0 0 1px var(--n-400); }
  .composer-form textarea { background: none; padding: 0; min-height: 64px; resize: vertical; }
  .composer-form textarea::placeholder { color: var(--n-500); }
  .composer-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .composer-hint { color: var(--n-500); font-size: var(--text-11); }
  .composer-form .primary { padding: 6px 14px; font-size: var(--text-12); }
  .composer-form .primary:disabled { opacity: 0.45; cursor: default; }
  /* Docked, so the list scrolls behind it and the box is always there. */
  .composer-dock { position: sticky; bottom: 0; padding-top: 8px; background: var(--n-100); }
  /* The dock must read as a dock: without a lifted edge, whatever slides
     beneath it looks like a layout collision rather than a surface. */
  @media (max-width: 720px) {
    .composer-dock { box-shadow: 0 -12px 24px rgba(6, 8, 10, 0.55); }
  }
  /* A reply composes under its thread, indented to the same line as the replies
     it is joining. */
  .composer-form.inline { margin: 2px 0 0 14px; background: var(--n-200); }
  .files { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 0; }
  .filechip { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; border: 0; border-radius: 9px; background: var(--n-150); color: var(--n-800); padding: 3px 9px; font-size: var(--text-12); cursor: pointer; }
  .filechip:hover { background: var(--n-300); color: var(--n-900); }
  .filechip.pending { cursor: default; }
  .filename { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; }
  .filedrop { border: 0; background: none; color: var(--n-600); padding: 0 0 0 2px; font-size: 13px; line-height: 1; cursor: pointer; }
  .filedrop:hover { color: var(--n-900); }
  .foot-actions { display: flex; align-items: center; gap: 8px; }
  .attach { display: inline-flex; align-items: center; border: 0; border-radius: var(--radius); background: var(--n-200); color: var(--n-700); padding: 6px 8px; cursor: pointer; }
  .attach:hover { background: var(--n-300); color: var(--n-900); }
  .attachinput { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
  .sr-label { display: grid; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

  /* Frame anchor: a styled stepper, not a number input with browser spinners.
     There is no "At playhead" button because the anchor already is the
     playhead until you nudge it. */
  .stepper { display: inline-flex; align-items: center; gap: 2px; background: var(--n-200); border-radius: var(--radius); padding: 2px; }
  .stepper button { background: none; padding: 3px 7px; font-size: var(--text-13); line-height: 1; color: var(--n-700); }
  .stepper button:hover { background: var(--n-300); color: var(--n-900); }
  .anchor-tc { padding: 0 6px; color: var(--n-900); font-weight: 600; }
  .stepper.range { padding: 4px 2px; }
  .rangeword { color: var(--ink-text-dim); font-size: var(--text-12); }
  .noteink { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .anchor-hint { color: var(--n-500); font-size: var(--text-11); }
  .replying { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--n-700); }
  .replying strong { color: var(--n-900); font-weight: 600; }
  .linky { background: none; padding: 0; color: var(--n-600); font-size: var(--text-13); font-weight: 500; }
  .linky:hover { background: none; color: var(--n-900); text-decoration: underline; }

  /* A reply is indented and quieter: the thread reads as one conversation. */
  .notes article.reply { margin-left: 14px; padding-left: 10px; box-shadow: inset 2px 0 0 var(--n-300); background: none; }
  .notes article.reply:hover { background: var(--n-150); }
  .notes article.seekable { cursor: pointer; }
  .note-body { flex: 1; min-width: 0; }
  .note-actions { display: flex; align-items: center; gap: 12px; margin-top: 6px; }
  .notes-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0 0 12px; }
  .notes h2 { margin: 0; font-size: var(--text-13); font-weight: 600; color: var(--n-900); }
  .filters { display: flex; gap: 2px; background: var(--n-150); border-radius: var(--radius); padding: 2px; }
  .filters button { background: none; padding: 5px 10px; }
  .filters button[aria-pressed='true'] { background: var(--n-400); color: var(--n-900); }
  .exchange { position: relative; }
  .exchange-trigger { display: inline-flex; align-items: center; gap: 6px; background: var(--n-150); padding: 6px 10px; border-radius: var(--radius); font-size: var(--text-13); }
  .exchange-trigger:hover, .exchange-trigger[aria-expanded='true'] { background: var(--n-300); color: var(--n-900); }
  .exchange-panel { position: absolute; right: 0; top: calc(100% + 6px); z-index: 30; width: 264px; display: flex; flex-direction: column; gap: 10px; background: var(--n-100); border: 1px solid var(--n-300); border-radius: var(--radius); padding: 14px; }
  .exchange-panel label { display: flex; flex-direction: column; gap: 4px; font-size: var(--text-13); color: var(--n-700); }
  .exchange-panel select { width: 100%; }
  .exchange-title { margin: 0; font-size: var(--text-13); font-weight: 600; color: var(--n-900); }
  .exchange-run + .exchange-title { margin-top: 6px; }
  .exchange-run { background: var(--n-800); color: var(--n-000); padding: 8px 12px; border-radius: var(--radius); }
  .exchange-run:hover:not(:disabled) { background: var(--n-900); color: var(--n-000); }
  .exchange-run:disabled { opacity: 0.6; cursor: default; }
  .exchange-hint { margin: 0; font-size: var(--text-12); color: var(--n-600); }
  .exchange-import { text-align: center; }
  .exchange-note { margin: 0; font-size: var(--text-12); color: var(--n-700); }
  .tagfilter { margin-left: auto; background: var(--n-300); color: var(--n-900); font-weight: 600; padding: 4px 10px; }
  .tagfilter span { color: var(--n-600); font-weight: 400; margin-left: 6px; }
  /* The overflow menu: the asset's own verbs, one click from the bar. */
  .morewrap { position: relative; }
  .more-trigger { display: grid; place-items: center; width: 34px; height: 34px; padding: 0; background: var(--n-150); color: var(--n-800); border-radius: var(--radius); }
  .more-trigger[aria-expanded='true'] { background: var(--n-200); }
  .more-panel { position: absolute; right: 0; top: calc(100% + 4px); z-index: 30; min-width: 210px; display: grid; gap: 1px; padding: 4px; border-radius: var(--radius); background: var(--n-100); box-shadow: 0 16px 40px rgba(0, 0, 0, 0.35); }
  .more-item { display: block; width: 100%; border: 0; border-radius: 2px; background: none; color: var(--n-900); padding: 8px 10px; font-size: var(--text-13); font-weight: 500; text-align: left; text-decoration: none; cursor: pointer; }
  a.more-item, a.more-item:hover { color: var(--n-900); }
  .more-item:hover { background: var(--n-200); }
  .more-item:disabled { opacity: 0.5; cursor: default; }
  .more-label { margin: 6px 0 2px; padding: 0 10px; color: var(--n-600); font-size: var(--text-12); }
  /* The file input itself is unstylable across browsers; the label is the
     button, and the input is the part that never shows. */
  .more-upload input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
  .more-upload:focus-within { outline: 1px solid var(--accent-bright); outline-offset: -1px; }
  /* Phone: the same escape from the actions scroller the other two panels
     make. It sits here rather than beside them because the base .more-panel
     rule above carries equal specificity, and a rule later in the file wins. */
  @media (max-width: 720px) {
    .more-panel { position: fixed; left: var(--pad-2); right: var(--pad-2); top: 96px; }
  }
  /* The version menu's footer: where a new version comes from. */
  .vfoot { display: grid; gap: 6px; margin-top: 4px; padding: 8px 10px 2px; border-top: 1px solid var(--n-200); }
  /* .filebtn already carries the button dress and the invisible input. */
  .vupload { display: block; text-align: center; }
  .carry-note { margin: 0 0 12px; color: var(--n-700); font-size: var(--text-13); }
  .carry-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 10px 12px; margin: 0 0 12px; background: var(--n-150); border-radius: var(--radius); color: var(--n-800); }
  .notes article { display: flex; justify-content: space-between; gap: 20px; padding: 10px; margin: 0 0 2px; border-radius: var(--radius); }
  .notes article:hover { background: var(--n-150); }
  .notes article.highlighted { background: var(--n-200); }
  .notes article div { flex: 1; }
  .notes article p { margin: 6px 0 0; color: var(--n-800); line-height: 1.45; white-space: pre-wrap; }
  .notes article.completed p { color: var(--n-500); }
  /* A resolved note is still a note about a moment: it keeps its timecode, keeps
     seeking, and only its prose steps back. The ring matches the timeline. */
  .notes article.completed .chip { background: transparent; box-shadow: inset 0 0 0 1px var(--n-400); color: var(--n-700); }
  .notes article.completed .chip:hover { background: var(--n-200); color: var(--n-900); }
  .head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .head strong { color: var(--n-900); font-size: var(--text-13); font-weight: 600; }
  /* The timecode is the note's address: centred, tabular, and big enough to
     read at a glance instead of squinting at 11px. */
  .chip { display: inline-flex; align-items: center; justify-content: center; min-width: 92px; border-radius: var(--radius); background: var(--n-200); color: var(--n-900); padding: 3px 8px; font-size: var(--text-12); font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: 0.01em; }
  .chip:hover { background: var(--n-300); }
  .chip:hover { background: var(--n-800); }
  .drawn { color: var(--warn); font-size: var(--text-13); }
  .carried { color: var(--n-600); background: var(--n-150); border-radius: 2px; padding: 1px 6px; font-size: var(--text-11); }
  .resolved { color: var(--ok); font-size: var(--text-13); align-self: center; }

  /* Mentions and hashtags carry weight and value, never hue: the review
     room stays strictly neutral. */
  .mention { color: var(--n-900); font-weight: 600; }
  .tag { display: inline; border: 0; border-radius: 2px; background: var(--n-150); color: var(--n-900); font-weight: 600; font-size: inherit; padding: 0 3px; cursor: pointer; }
  .tag:hover { background: var(--n-300); }

  .composer-form label { display: grid; gap: 8px; color: var(--n-600); font-size: var(--text-13); }
  .anchor-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .drawing-chip { color: var(--n-800); font-size: var(--text-13); }
  .drawing-chip .tc { font-variant-numeric: tabular-nums; }
  .composer { position: relative; display: grid; }
  .notes textarea { min-height: 96px; background: var(--n-150); }
  .mention-menu { position: absolute; left: 0; right: auto; top: 100%; z-index: 4; display: grid; min-width: 260px; background: var(--n-200); border-radius: var(--radius); padding: 2px; }
  .mention-menu button { display: flex; align-items: baseline; gap: 10px; background: none; text-align: left; padding: 7px 10px; border-radius: 2px; }
  .mention-menu button.active, .mention-menu button:hover { background: var(--n-400); }
  .mention-menu strong { color: var(--n-900); font-weight: 600; font-size: var(--text-13); }
  .mention-menu span { color: var(--n-600); font-size: var(--text-13); }

  button { border: 0; border-radius: var(--radius); background: var(--n-200); color: var(--n-800); padding: 8px 12px; font-size: var(--text-13); font-weight: 500; }
  button:hover { background: var(--n-300); color: var(--n-900); }
  button:disabled { color: var(--n-500); background: var(--n-150); }
  button.primary { background: var(--n-800); color: var(--n-050); justify-self: start; }
  button.primary:hover { background: var(--n-900); }
  button.quiet { background: none; color: var(--n-600); }
  button.quiet:hover { color: var(--n-900); background: var(--n-200); }
  button[aria-pressed='true'] { background: var(--n-400); color: var(--n-900); }
  .tc { font-variant-numeric: tabular-nums; }
  button:focus-visible, a:focus-visible, input:focus-visible, textarea:focus-visible { outline: 1px solid var(--n-800); outline-offset: 2px; }
  select:focus-visible { outline: none; background: var(--n-300); }
</style>
