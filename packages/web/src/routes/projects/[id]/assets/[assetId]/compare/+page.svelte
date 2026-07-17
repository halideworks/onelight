<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { formatTimecode, timecodeFromFrames } from '@onelight/core';
  import { api, messageFrom } from '$lib/api.js';
  import { idFrom } from '$lib/ids.js';

  /* Two versions of the same asset against each other: side by side, or one
     picture with a wipe line. One transport drives both. Frame-step accuracy
     is the contract here; play stays in sync by correction rather than
     promising motion lockstep, because two decoders never advance as one. */

  type Asset = { id: string; name: string; current_version_id: string | null };
  type Version = {
    id: string;
    version_no: number;
    frame_rate_num: number | null;
    frame_rate_den: number | null;
    drop_frame: boolean;
    duration_frames: number | null;
    transcode_status: string;
  };
  type Rendition = { kind: string; blob_key?: string; blobKey?: string; url?: string | null };

  let asset = $state<Asset | null>(null);
  let versions = $state<Version[]>([]);
  let error = $state('');
  let aId = $state<string | null>(null);
  let bId = $state<string | null>(null);
  let sourceA = $state('');
  let sourceB = $state('');
  let videoA = $state<HTMLVideoElement | null>(null);
  let videoB = $state<HTMLVideoElement | null>(null);
  let mode = $state<'side' | 'wipe'>('side');
  let playing = $state(false);
  let frame = $state(0);
  let wipe = $state(50);
  let draggingWipe = false;

  const projectId = $derived(idFrom(page.params.id));
  const assetId = $derived(idFrom(page.params.assetId));
  const versionA = $derived(versions.find((version) => version.id === aId) ?? null);
  const versionB = $derived(versions.find((version) => version.id === bId) ?? null);

  /* Version A owns the clock: rate, drop-frame, and the timeline length. */
  const rate = $derived(
    versionA && versionA.frame_rate_num && versionA.frame_rate_den
      ? { num: versionA.frame_rate_num, den: versionA.frame_rate_den }
      : { num: 24, den: 1 }
  );
  const fps = $derived(rate.num / rate.den);
  const lastFrame = $derived(Math.max((versionA?.duration_frames ?? 1) - 1, 0));

  const timecodeAt = (at: number): string => {
    try {
      return formatTimecode(timecodeFromFrames(at, rate, versionA?.drop_frame ?? false));
    } catch {
      return String(at);
    }
  };

  const mediaPath = (key: string): string =>
    `/api/v1/media/${key.split('/').map(encodeURIComponent).join('/')}`;
  const urlForRendition = (rendition: Rendition): string | null => {
    if (rendition.url) return rendition.url;
    const key = rendition.blob_key ?? rendition.blobKey;
    return key ? mediaPath(key) : null;
  };

  const sourceFor = async (versionId: string): Promise<string> => {
    const items = (await api<{ items: Rendition[] }>(`/api/v1/versions/${versionId}/renditions`)).items;
    const rendition =
      items.find((candidate) => candidate.kind === 'proxy_1080') ??
      items.find((candidate) => candidate.kind.startsWith('proxy_'));
    return (rendition && urlForRendition(rendition)) || '';
  };

  /* Seeks land mid-frame so both decoders present the frame the number names,
     not the boundary between it and its neighbor. */
  const seekMedia = (at: number): void => {
    const t = (at + 0.5) / fps;
    if (videoA) videoA.currentTime = Math.min(t, Math.max(videoA.duration - 0.001, 0) || t);
    if (videoB) videoB.currentTime = Math.min(t, Math.max(videoB.duration - 0.001, 0) || t);
  };

  const seekTo = (at: number): void => {
    frame = Math.max(0, Math.min(lastFrame, Math.round(at)));
    seekMedia(frame);
  };

  const pause = (): void => {
    playing = false;
    videoA?.pause();
    videoB?.pause();
    /* Re-land on the exact frame, so a pause mid-play is frame-true. */
    seekMedia(frame);
  };

  const play = (): void => {
    if (!videoA || !videoB) return;
    playing = true;
    if (videoB.currentTime !== videoA.currentTime) videoB.currentTime = videoA.currentTime;
    void videoA.play();
    void videoB.play();
  };

  const toggle = (): void => {
    if (playing) pause();
    else play();
  };

  const step = (delta: number): void => {
    if (playing) pause();
    seekTo(frame + delta);
  };

  /* While playing, A's clock is the truth: the readout follows it and B is
     pulled back whenever it drifts past half a frame. */
  $effect(() => {
    if (!playing) return;
    let raf = 0;
    const watch = (): void => {
      if (videoA) {
        frame = Math.max(0, Math.min(lastFrame, Math.floor(videoA.currentTime * fps)));
        if (videoB && Math.abs(videoB.currentTime - videoA.currentTime) > 0.5 / fps)
          videoB.currentTime = videoA.currentTime;
        if (videoA.ended || videoA.paused) {
          playing = false;
          videoB?.pause();
          return;
        }
      }
      raf = requestAnimationFrame(watch);
    };
    raf = requestAnimationFrame(watch);
    return () => cancelAnimationFrame(raf);
  });

  const pickSource = async (which: 'a' | 'b', versionId: string): Promise<void> => {
    if (playing) pause();
    try {
      const url = await sourceFor(versionId);
      if (which === 'a') {
        aId = versionId;
        sourceA = url;
      } else {
        bId = versionId;
        sourceB = url;
      }
    } catch (caught) {
      error = messageFrom(caught, 'That version is not playable yet.');
    }
  };

  /* When a video (re)loads, put it back on the current frame. */
  const onLoaded = (): void => {
    seekMedia(frame);
  };

  onMount(() => {
    void (async () => {
      try {
        if (!assetId) return;
        asset = await api<Asset>(`/api/v1/assets/${assetId}`);
        versions = (await api<{ items: Version[] }>(`/api/v1/assets/${assetId}/versions`)).items;
        const params = page.url.searchParams;
        const wantedA = params.get('a');
        const wantedB = params.get('b');
        const newest = versions[0] ?? null;
        const previous = versions[1] ?? null;
        const startA =
          (wantedA && versions.find((version) => version.id === wantedA)?.id) ?? newest?.id ?? null;
        const startB =
          (wantedB && versions.find((version) => version.id === wantedB)?.id) ??
          (previous && previous.id !== startA ? previous.id : (versions.find((version) => version.id !== startA)?.id ?? null));
        if (startA) await pickSource('a', startA);
        if (startB) await pickSource('b', startB);
      } catch (caught) {
        error = messageFrom(caught, 'This asset is not available.');
      }
    })();
    const onKey = (event: KeyboardEvent): void => {
      if ((event.target as HTMLElement).closest('input, select, textarea')) return;
      if (event.key === ' ') {
        event.preventDefault();
        toggle();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        step(event.shiftKey ? -10 : -1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        step(event.shiftKey ? 10 : 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const wipeFrom = (event: PointerEvent, surface: HTMLElement): void => {
    const box = surface.getBoundingClientRect();
    wipe = Math.max(0, Math.min(100, ((event.clientX - box.left) / box.width) * 100));
  };
</script>

<svelte:head><title>Compare {asset?.name ?? ''} | Onelight</title></svelte:head>

<main class="compare">
  <header class="topbar">
    <a href={`/projects/${projectId}/assets/${assetId}`}>Back to review</a>
    {#if asset}<h1>{asset.name}</h1>{/if}
    <span class="grow"></span>
    <div class="pickers">
      <label>A
        <select value={aId} onchange={(event) => void pickSource('a', (event.currentTarget as HTMLSelectElement).value)}>
          {#each versions as version (version.id)}
            <option value={version.id}>v{version.version_no}</option>
          {/each}
        </select>
      </label>
      <label>B
        <select value={bId} onchange={(event) => void pickSource('b', (event.currentTarget as HTMLSelectElement).value)}>
          {#each versions as version (version.id)}
            <option value={version.id}>v{version.version_no}</option>
          {/each}
        </select>
      </label>
    </div>
    <div class="modes" role="group" aria-label="Compare mode">
      <button type="button" aria-pressed={mode === 'side'} onclick={() => { mode = 'side'; }}>Side by side</button>
      <button type="button" aria-pressed={mode === 'wipe'} onclick={() => { mode = 'wipe'; }}>Wipe</button>
    </div>
  </header>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {:else if !sourceA || !sourceB}
    <p class="empty">
      {versions.length < 2 ? 'Comparing needs at least two versions.' : 'Loading both versions.'}
    </p>
  {:else}
    {#if mode === 'side'}
      <div class="stage side">
        <figure>
          <!-- svelte-ignore a11y_media_has_caption -->
          <video bind:this={videoA} src={sourceA} preload="auto" playsinline onloadeddata={onLoaded}></video>
          <figcaption class="tc">v{versionA?.version_no}</figcaption>
        </figure>
        <figure>
          <!-- svelte-ignore a11y_media_has_caption -->
          <video bind:this={videoB} src={sourceB} preload="auto" playsinline onloadeddata={onLoaded}></video>
          <figcaption class="tc">v{versionB?.version_no}</figcaption>
        </figure>
      </div>
    {:else}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="stage wipe"
        onpointerdown={(event) => { draggingWipe = true; (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); wipeFrom(event, event.currentTarget as HTMLElement); }}
        onpointermove={(event) => { if (draggingWipe) wipeFrom(event, event.currentTarget as HTMLElement); }}
        onpointerup={() => { draggingWipe = false; }}
      >
        <!-- svelte-ignore a11y_media_has_caption -->
        <video bind:this={videoA} src={sourceA} preload="auto" playsinline onloadeddata={onLoaded}></video>
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          bind:this={videoB}
          class="over"
          src={sourceB}
          preload="auto"
          playsinline
          onloadeddata={onLoaded}
          style={`clip-path: inset(0 0 0 ${wipe}%);`}
        ></video>
        <span class="wipeline" style={`left: ${wipe}%;`} aria-hidden="true"></span>
        <span class="wipetag a">v{versionA?.version_no}</span>
        <span class="wipetag b">v{versionB?.version_no}</span>
      </div>
    {/if}

    <div class="transport">
      <button type="button" class="playpause" onclick={toggle}>{playing ? 'Pause' : 'Play'}</button>
      <button type="button" onclick={() => step(-1)} aria-label="Back one frame">&lt;</button>
      <button type="button" onclick={() => step(1)} aria-label="Forward one frame">&gt;</button>
      <span class="clock tc">{timecodeAt(frame)}</span>
      <input
        class="seek"
        type="range"
        min="0"
        max={lastFrame}
        step="1"
        value={frame}
        oninput={(event) => { if (playing) pause(); seekTo(Number((event.currentTarget as HTMLInputElement).value)); }}
        aria-label="Seek"
      />
      <span class="hint">Space plays. Arrows step a frame; hold Shift for ten.</span>
    </div>
  {/if}
</main>

<style>
  .compare { min-height: 100vh; display: flex; flex-direction: column; background: var(--n-000); color: var(--n-800); font-size: var(--text-13); }
  .topbar { display: flex; align-items: center; gap: 16px; padding: 12px 20px; }
  .topbar a { color: var(--n-600); text-decoration: none; }
  .topbar a:hover { color: var(--n-900); }
  h1 { margin: 0; font-size: var(--text-16); font-weight: 600; color: var(--n-900); }
  .grow { flex: 1; }

  .pickers { display: flex; gap: 12px; }
  .pickers label { display: inline-flex; align-items: center; gap: 6px; color: var(--n-600); }
  .pickers select { background: var(--n-150); color: var(--n-800); border: 0; border-radius: var(--radius); padding: 6px 8px; }

  .modes { display: flex; gap: 2px; background: var(--n-150); border-radius: var(--radius); padding: 2px; }
  .modes button { background: none; border: 0; border-radius: var(--radius); color: var(--n-700); padding: 6px 12px; font-size: var(--text-13); cursor: pointer; }
  .modes button[aria-pressed='true'] { background: var(--n-400); color: var(--n-900); }

  .stage { flex: 1; min-height: 0; padding: 0 20px; }
  .stage.side { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: center; }
  figure { margin: 0; min-width: 0; position: relative; }
  video { display: block; width: 100%; max-height: calc(100vh - 170px); background: #000; }
  figcaption { position: absolute; top: 10px; left: 10px; background: rgba(10, 10, 10, 0.75); color: var(--n-900); padding: 3px 8px; border-radius: 2px; font-size: var(--text-12); }

  .stage.wipe { position: relative; display: flex; align-items: center; justify-content: center; cursor: ew-resize; touch-action: none; }
  .stage.wipe video { position: relative; max-width: 100%; }
  .stage.wipe video.over { position: absolute; inset: 0; margin: auto; max-height: calc(100vh - 170px); }
  .wipeline { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--n-900); pointer-events: none; }
  .wipetag { position: absolute; top: 10px; background: rgba(10, 10, 10, 0.75); color: var(--n-900); padding: 3px 8px; border-radius: 2px; font-size: var(--text-12); pointer-events: none; }
  .wipetag.a { left: 10px; }
  .wipetag.b { right: 10px; }

  .transport { display: flex; align-items: center; gap: 10px; padding: 14px 20px; }
  .transport button { border: 0; border-radius: var(--radius); background: var(--n-200); color: var(--n-800); padding: 8px 12px; font-size: var(--text-13); cursor: pointer; }
  .transport button:hover { background: var(--n-300); color: var(--n-900); }
  .playpause { min-width: 72px; }
  .clock { min-width: 108px; text-align: center; color: var(--n-900); }
  .tc { font-variant-numeric: tabular-nums; }
  .seek { flex: 1; accent-color: var(--n-700); }
  .hint { color: var(--n-500); white-space: nowrap; }

  .error { padding: 24px 20px; color: var(--warn); }
  .empty { padding: 24px 20px; color: var(--n-600); }
  @media (max-width: 900px) {
    .stage.side { grid-template-columns: 1fr; }
    .hint { display: none; }
  }
</style>
