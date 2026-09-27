<script lang="ts">
  import { untrack } from 'svelte';
  import { api, messageFrom, type Asset, type Version, type VersionList } from '$lib/api.js';
  import { formatBytes } from '$lib/upload.js';
  import { whenAbsolute } from '$lib/format.js';
  import { formatTimecode, timecodeFromFrames } from '@onelight/core';
  import { undo } from './undo.svelte.js';

  let { assetId, versionId = null, neutral = false, onversionselect, onclose, refreshKey = 0 }: {
    assetId: string;
    versionId?: string | null;
    neutral?: boolean;
    onversionselect?: (id: string) => void;
    onclose?: () => void;
    refreshKey?: number;
  } = $props();
  let asset = $state<Asset | null>(null);
  let versions = $state<Version[]>([]);
  let chosen = $state<string | null>(null);
  let chosenAsset: string | null = null;
  let detail = $state<Version | null>(null);
  let loading = $state(true);
  let error = $state('');
  let detailError = $state('');
  let retry = $state(0);
  let lastUndoRevision = undo.revision;
  $effect(() => {
    const revision = undo.revision;
    if (revision !== lastUndoRevision) { lastUndoRevision = revision; retry += 1; }
  });
  type Context = {
    shares: { items: Array<{ id: string; title: string; revoked_at: number | null; expires_at: number | null }>; has_more: boolean } | null;
    activity: { items: Array<{ id: string; type: string; at: number }>; has_more: boolean };
  };
  let context = $state<Context | null>(null);
  let contextError = $state('');

  $effect(() => {
    const id = assetId;
    void retry;
    void refreshKey;
    let active = true;
    const request = new AbortController();
    context = null; contextError = '';
    void api<Context>(`/api/v1/assets/${id}/context`, { signal: request.signal }).then((loaded) => {
      if (active) context = loaded;
    }).catch((caught: unknown) => {
      if (active) contextError = messageFrom(caught, 'Sharing and recent activity could not be loaded.');
    });
    return () => { active = false; request.abort(); };
  });

  $effect(() => {
    const id = assetId;
    void retry;
    void refreshKey;
    let active = true;
    const request = new AbortController();
    const previous = untrack(() => chosenAsset === id ? chosen : null);
    if (chosenAsset !== id) chosen = null;
    asset = null; versions = []; loading = true; error = '';
    void Promise.all([
      api<Asset>(`/api/v1/assets/${id}`, { signal: request.signal }),
      api<VersionList>(`/api/v1/assets/${id}/versions`, { signal: request.signal })
    ]).then(([loaded, listing]) => {
      if (!active) return;
      asset = { ...loaded, current_version_id: listing.stack_state.current_version_id }; versions = listing.items;
      chosenAsset = id;
      chosen = listing.items.find((version) => version.id === previous)?.id ?? listing.items.find((version) => version.id === listing.stack_state.current_version_id)?.id ?? listing.items[0]?.id ?? null;
    }).catch((caught: unknown) => {
      if (active) error = messageFrom(caught, 'Asset details could not be loaded.');
    }).finally(() => { if (active) loading = false; });
    return () => { active = false; request.abort(); };
  });

  const selected = $derived(versionId && versions.some((version) => version.id === versionId) ? versionId : chosen);
  $effect(() => {
    const id = selected;
    let active = true;
    const request = new AbortController();
    detail = null; detailError = '';
    if (id && versions.some((version) => version.id === id))
      void api<Version>(`/api/v1/versions/${id}`, { signal: request.signal }).then((loaded) => {
        if (active) detail = loaded;
      }).catch((caught: unknown) => {
        if (active) detailError = messageFrom(caught, 'Version metadata could not be loaded.');
      });
    return () => { active = false; request.abort(); };
  });

  const text = (value: unknown): string | null =>
    typeof value === 'string' && value ? value : typeof value === 'number' ? String(value) : null;
  const duration = (version: Version): string | null => {
    if (version.duration_frames === null) return null;
    const frames = `${version.duration_frames} frames`;
    if (!version.frame_rate_num || !version.frame_rate_den) return frames;
    try {
      const timecode = formatTimecode(timecodeFromFrames(Math.max(0, version.duration_frames - 1), { num: version.frame_rate_num, den: version.frame_rate_den }, version.drop_frame));
      return `${timecode} (${frames})`;
    } catch { return frames; }
  };
  type Group = { title: string; rows: Array<[string, string]> };
  const groups = $derived.by((): Group[] => {
    if (!detail) return [];
    const info = (detail.media_info ?? {}) as {
      streams?: Array<Record<string, unknown>>;
      format?: { format_long_name?: string; bit_rate?: string; tags?: Record<string, string> };
    };
    const streams = Array.isArray(info.streams) ? info.streams.filter((stream) => stream && typeof stream === 'object') : [];
    const video = streams.find((stream) => stream.codec_type === 'video');
    const audio = streams.filter((stream) => stream.codec_type === 'audio');
    const rows = (items: Array<[string, string | null]>): Array<[string, string]> =>
      items.filter((item): item is [string, string] => item[1] !== null);
    const result: Group[] = [];
    if (video) {
      result.push({ title: 'Picture', rows: rows([
        ['Codec', [text(video.codec_name)?.toUpperCase(), text(video.profile)].filter(Boolean).join(' ') || null],
        ['Frame size', video.width && video.height ? `${String(video.width)} x ${String(video.height)}` : null],
        ['Aspect', text(video.display_aspect_ratio)], ['Pixel format', text(video.pix_fmt)], ['Scan', text(video.field_order)]
      ]) });
      result.push({ title: 'Color', rows: rows([
        ['Primaries', text(video.color_primaries)], ['Transfer', text(video.color_transfer)],
        ['Matrix', text(video.color_space)], ['Range', text(video.color_range)]
      ]) });
    }
    result.push({ title: 'Motion', rows: rows([
      ['Frame rate', detail.frame_rate_num && detail.frame_rate_den ? `${detail.frame_rate_num}/${detail.frame_rate_den} (${(detail.frame_rate_num / detail.frame_rate_den).toFixed(3)}) fps${detail.drop_frame ? ', drop frame' : ''}` : null],
      ['Duration', duration(detail)],
      ['Start timecode', detail.source_timecode_start]
    ]) });
    if (audio.length) result.push({ title: 'Sound', rows: audio.map((stream, index) => [
      `Track ${index + 1}`,
      [text(stream.codec_name)?.toUpperCase(), text(stream.channel_layout) ?? (stream.channels ? `${String(stream.channels)}ch` : null), stream.sample_rate ? `${Number(stream.sample_rate) / 1000} kHz` : null].filter(Boolean).join(', ')
    ]) });
    result.push({ title: 'File', rows: rows([
      ['Filename', detail.original_filename], ['Container', info.format?.format_long_name ?? null],
      ['Size', formatBytes(detail.size)], ['Bitrate', info.format?.bit_rate ? `${(Number(info.format.bit_rate) / 1_000_000).toFixed(1)} Mb/s` : null],
      ['Encoder', info.format?.tags?.encoder ?? null], ['Created', info.format?.tags?.creation_time?.slice(0, 10) ?? null]
    ]) });
    return result.filter((group) => group.rows.length);
  });
</script>

<section class="inspector" class:neutral aria-label="Asset inspector" aria-busy={loading}>
  <header><h2>Asset inspector</h2><div class="actions"><button type="button" onclick={() => { retry += 1; }} disabled={loading} aria-label="Refresh inspector">Refresh</button>{#if onclose}<button type="button" onclick={onclose} aria-label="Close inspector">Close</button>{/if}</div></header>
  {#if error}
    <p role="alert">{error}</p><button type="button" onclick={() => { retry += 1; }}>Try again</button>
  {:else if loading}<p role="status">Loading asset details...</p>
  {:else if asset}
    <div class="identity"><h3>{asset.name}</h3><p>{asset.kind} · {asset.status.replaceAll('_', ' ')}</p></div>
    <section><h3>Versions and processing</h3>
      {#if versions.length === 0}<p>No versions have been uploaded.</p>{/if}
      <div class="versions">{#each versions as version (version.id)}
        <button type="button" class:active={selected === version.id} aria-pressed={selected === version.id}
          onclick={() => { chosen = version.id; onversionselect?.(version.id); }}>
          <span>v{version.version_no}{version.id === asset.current_version_id ? ' · Current' : ''}</span>
          <span>{version.transcode_status.replaceAll('_', ' ')}</span>
          <small>{whenAbsolute(version.created_at)}</small>
        </button>
      {/each}</div>
    </section>
    {#if detailError}<p role="alert">{detailError}</p>
    {:else if selected && !detail}<p role="status">Loading version metadata...</p>
    {:else}{#each groups as group (group.title)}
      <section><h3>{group.title}</h3><dl>{#each group.rows as [term, value]}<dt>{term}</dt><dd>{value}</dd>{/each}</dl></section>
    {/each}{/if}
    {#if contextError}<p role="alert">{contextError}</p>
    {:else if !context}<p role="status">Loading sharing and activity...</p>
    {:else}
      <section><h3>Shared in</h3>
        {#if context.shares === null}<p>Share membership is visible to project managers.</p>
        {:else if !context.shares.items.length}<p>This asset is not in a share.</p>
        {:else}<ul>{#each context.shares.items as share (share.id)}<li><a href={`/projects/${asset.project_id}/shares/${share.id}`}>{share.title}</a><span>{share.revoked_at ? 'Revoked' : share.expires_at && share.expires_at <= Date.now() ? 'Expired' : 'Active'}</span></li>{/each}</ul>
          {#if context.shares.has_more}<p>Showing the 50 newest memberships.</p>{/if}
        {/if}
        <a href={`/projects/${asset.project_id}/shares`}>Open project shares</a>
      </section>
      <section><h3>Recent recorded activity</h3>
        {#if !context.activity.items.length}<p>No retained activity for this asset.</p>
        {:else}<ol>{#each context.activity.items as event (event.id)}<li><span>{event.type.replaceAll('.', ' ').replaceAll('_', ' ')}</span><time datetime={new Date(event.at).toISOString()}>{whenAbsolute(event.at)}</time></li>{/each}</ol>{/if}
        <p>{context.activity.has_more ? 'Showing the 50 newest retained events. ' : ''}This is recorded project activity, not a full audit history.</p>
      </section>
    {/if}
  {/if}
</section>

<style>
  .inspector { --surface: var(--ink-100, #161c24); --raised: var(--ink-200, #202833); --text: var(--ink-900, #e7e9ed); --muted: var(--ink-600, #a5aab3); display: grid; align-content: start; gap: 24px; padding: 20px; background: var(--surface); color: var(--text); min-width: 0; font-size: 13px; }
  .neutral { --surface: #191919; --raised: #2a2a2a; --text: #e5e5e5; --muted: #aaa; }
  header { display: flex; gap: 12px; align-items: center; justify-content: space-between; }
  .actions { display: flex; gap: 4px; }
  h2, h3, p { margin: 0; } h2 { font-size: 16px; font-weight: 600; } h3 { font-size: 13px; font-weight: 600; margin-bottom: 10px; }
  p { color: var(--muted); line-height: 1.55; overflow-wrap: anywhere; } .identity h3 { font-size: 17px; overflow-wrap: anywhere; }
  button { border: 0; border-radius: 4px; padding: 8px 10px; font: inherit; color: inherit; background: var(--raised); cursor: pointer; }
  button:hover, button:focus-visible { background: color-mix(in srgb, var(--raised), white 10%); outline: none; }
  .versions { display: grid; gap: 4px; max-height: 240px; overflow: auto; } .versions button { display: grid; grid-template-columns: 1fr auto; gap: 6px; text-align: left; background: transparent; }
  .versions button.active { background: var(--raised); } small { font: inherit; color: var(--muted); grid-column: 1 / -1; }
  dl { display: grid; grid-template-columns: minmax(80px, auto) minmax(0, 1fr); gap: 8px 14px; margin: 0; } dt { color: var(--muted); } dd { margin: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
  a { display: inline-block; margin-top: 10px; color: inherit; text-underline-offset: 3px; }
  ul, ol { padding: 0; margin: 0 0 12px; list-style: none; display: grid; gap: 14px; max-height: 280px; overflow: auto; }
  li { display: grid; gap: 4px; } li a { margin: 0; } li > span:last-child, time { color: var(--muted); }
</style>
