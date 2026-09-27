<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import type Player from '@onelight/player/Player.svelte';
  import type ImageViewer from '@onelight/player/ImageViewer.svelte';
  import type { PlayerRendition } from '@onelight/player';
  import { api, messageFrom, type Asset, type Version, type VersionList, type RenditionList } from '$lib/api.js';
  import AssetInspector from './AssetInspector.svelte';
  import { undo } from './undo.svelte.js';

  let { assets, assetId, href, onnavigate, onclose, hasMore = false, onmore, refreshKey = 0 }: {
    assets: Array<{ id: string; name: string }>;
    assetId: string;
    href: (id: string) => string;
    onnavigate: (id: string) => void;
    onclose: () => void;
    hasMore?: boolean;
    onmore?: () => Promise<void>;
    refreshKey?: number;
  } = $props();
  let dialog = $state<HTMLDialogElement | null>(null);
  let asset = $state<Asset | null>(null);
  let version = $state<Version | null>(null);
  let renditions = $state<PlayerRendition[]>([]);
  let loading = $state(true);
  let error = $state('');
  let retry = $state(0);
  let inspect = $state(false);
  let paging = $state(false);
  let navigationError = $state('');
  let disposed = false;
  let moveGeneration = 0;
  onDestroy(() => { disposed = true; });
  $effect(() => { void assetId; moveGeneration += 1; navigationError = ''; });
  let hasAudio = $state(true);
  let projectTransfer = $state<'srgb' | 'gamma22' | 'bt1886' | null>(null);
  let PlayerComponent = $state<typeof Player | null>(null);
  let ImageComponent = $state<typeof ImageViewer | null>(null);
  const index = $derived(assets.findIndex((entry) => entry.id === assetId));
  const name = $derived(asset?.name ?? assets[index]?.name ?? 'Asset preview');
  const url = (kind: string): string | null => renditions.find((item) => item.kind === kind)?.url ?? null;
  const source = $derived(url('proxy_1080') ?? url('proxy_audio') ?? url('proxy_540') ?? url('proxy_2160'));
  const still = $derived(url('still_review') ?? url('still_tiles') ?? url('poster'));
  const videoOptions = $derived(renditions.filter((item) => ['proxy_540', 'proxy_1080', 'proxy_2160', 'hdr_av1', 'hdr_hevc'].includes(item.kind)));

  $effect(() => {
    const element = dialog;
    if (!element) return;
    element.showModal();
    return () => { if (element.open) element.close(); };
  });
  $effect(() => {
    const id = assetId;
    void retry;
    void refreshKey;
    void undo.revision;
    let active = true;
    const request = new AbortController();
    asset = null; version = null; renditions = []; loading = true; error = ''; projectTransfer = null;
    void (async () => {
      try {
        const [loaded, listing] = await Promise.all([
          api<Asset>(`/api/v1/assets/${id}`, { signal: request.signal }),
          api<VersionList>(`/api/v1/assets/${id}/versions`, { signal: request.signal })
        ]);
        if (!active) return;
        asset = { ...loaded, current_version_id: listing.stack_state.current_version_id };
        const selected = listing.items.find((item) => item.id === listing.stack_state.current_version_id) ?? listing.items[0] ?? null;
        version = selected;
        if (selected) {
          const [media, project] = await Promise.all([
            api<RenditionList>(`/api/v1/versions/${selected.id}/renditions`, { signal: request.signal }),
            api<{ display_transfer: 'srgb' | 'gamma22' | 'bt1886' | null }>(`/api/v1/projects/${loaded.project_id}`, { signal: request.signal }),
            loaded.kind === 'video' || loaded.kind === 'audio'
              ? import('@onelight/player/Player.svelte').then((module) => { if (active) PlayerComponent = module.default; })
              : loaded.kind === 'image'
                ? import('@onelight/player/ImageViewer.svelte').then((module) => { if (active) ImageComponent = module.default; })
                : Promise.resolve()
          ]);
          if (!active) return;
          renditions = media.items.flatMap((item) => item.url ? [{ kind: item.kind, url: item.url, meta: item.meta }] : []);
          hasAudio = media.has_audio;
          projectTransfer = project.display_transfer;
        }
      } catch (caught) { if (active) error = messageFrom(caught, 'This preview could not be loaded.'); }
      finally { if (active) loading = false; }
    })();
    return () => { active = false; request.abort(); };
  });
  const move = async (delta: number): Promise<void> => {
    if (disposed || !dialog?.open || paging) return;
    navigationError = '';
    const next = assets[index + delta];
    if (next) { onnavigate(next.id); return; }
    if (delta < 0 || !hasMore || !onmore || index < 0) return;
    const id = assetId;
    const generation = moveGeneration;
    const count = assets.length;
    paging = true;
    try {
      await onmore();
      await tick();
      if (disposed || !dialog?.open || generation !== moveGeneration || id !== assetId) return;
      const position = assets.findIndex((entry) => entry.id === id);
      const following = position < 0 ? undefined : assets[position + 1];
      if (assets.length > count && following) onnavigate(following.id);
      else navigationError = hasMore ? 'No additional assets loaded. Try Next again.' : 'You have reached the end of this view.';
    } catch (caught) {
      if (!disposed && dialog?.open && generation === moveGeneration && id === assetId)
        navigationError = messageFrom(caught, 'More assets could not be loaded. Try Next again.');
    } finally { if (!disposed) paging = false; }
  };
  const keydown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .player, .viewer')) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault(); event.stopPropagation(); void move(event.key === 'ArrowLeft' ? -1 : 1);
    }
  };
</script>

<dialog bind:this={dialog} class="quick-look" aria-label={`Quick Look: ${name}`} onclose={onclose} onkeydown={keydown}>
  <header>
    <div class="title"><h2>{name}</h2><p>{index + 1} of {assets.length} loaded assets{hasMore ? ' · More available' : ''}</p></div>
    <nav aria-label="Preview navigation">
      <button type="button" disabled={paging || index <= 0} onclick={() => { void move(-1); }} aria-label="Previous preview">Previous</button>
      <button type="button" disabled={paging || index < 0 || (index + 1 >= assets.length && !(hasMore && onmore))} onclick={() => { void move(1); }} aria-label="Next preview">{paging ? 'Loading...' : 'Next'}</button>
      <button type="button" aria-pressed={inspect} onclick={() => { inspect = !inspect; }}>Info</button>
      <a href={href(assetId)}>Open review</a>
      <button type="button" onclick={() => dialog?.close()} aria-label="Close Quick Look">Close</button>
    </nav>
  </header>
  {#if navigationError}<p class="navigation-status" role="status">{navigationError}</p>{/if}
  <div class="body" class:inspecting={inspect}>
    <div class="stage">
      {#if error}<div class="fallback"><p role="alert">{error}</p><button type="button" onclick={() => { retry += 1; }}>Try again</button></div>
      {:else if loading}<p role="status">Loading preview...</p>
      {:else if asset?.kind === 'image' && still && ImageComponent}
        {#key assetId}<ImageComponent src={still} alt={name} chrome="simple" />{/key}
      {:else if source && version && PlayerComponent && (asset?.kind === 'video' || asset?.kind === 'audio')}
        {#key assetId}
          <PlayerComponent src={source} kind={asset.kind === 'audio' ? 'audio' : 'video'} chrome="simple"
            rate={version.frame_rate_num && version.frame_rate_den ? { num: version.frame_rate_num, den: version.frame_rate_den } : { num: 24, den: 1 }}
            dropFrame={version.drop_frame} durationFrames={version.duration_frames} renditions={videoOptions}
            posterUrl={url('poster')} peaksUrl={url('waveform_data')} spectrogramUrl={url('spectrogram')}
            sourceHasAudio={hasAudio} displayTransferOverride={asset.display_transfer ?? null}
            projectDisplayTransfer={projectTransfer} sourceTransfer={typeof version.color.transfer === 'string' ? version.color.transfer : null}
            shuttleAudio={{ x1: url('reference_audio_1x'), x2: url('shuttle_audio_2x'), x4: url('shuttle_audio_4x') }} />
        {/key}
      {:else if still}<img src={still} alt={name} />
      {:else}<div class="fallback"><h3>{version?.transcode_status === 'failed' ? 'Processing failed' : version?.transcode_status === 'pending' || version?.transcode_status === 'processing' ? 'Preview is processing' : 'No preview available'}</h3><p>Open the asset to review its details and available downloads.</p><a href={href(assetId)}>Open asset</a> <button type="button" onclick={() => { retry += 1; }}>Refresh preview</button></div>{/if}
    </div>
    {#if inspect}<aside><AssetInspector {assetId} {refreshKey} neutral onclose={() => { inspect = false; }} /></aside>{/if}
  </div>
</dialog>

<style>
  .quick-look { position: fixed; inset: 0; margin: auto; width: min(1440px, calc(100vw - 48px)); height: min(940px, calc(100dvh - 48px)); max-width: none; max-height: none; border: 0; border-radius: 8px; padding: 0; background: #111; color: #e5e5e5; outline: none; }
  .quick-look[open] { display: flex; flex-direction: column; } .quick-look::backdrop { background: rgb(0 0 0 / 82%); }
  header { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 16px 20px; background: #1b1b1b; }
  .title { min-width: 0; } h2 { margin: 0; font-size: 17px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } p { margin: 6px 0 0; color: #aaa; font-size: 13px; }
  .navigation-status { margin: 0; padding: 12px 20px; background: #222; }
  nav { display: flex; flex-wrap: wrap; gap: 6px; flex-shrink: 0; } button, a { font: inherit; font-size: 13px; color: inherit; background: #2b2b2b; padding: 9px 12px; border: 0; border-radius: 4px; text-decoration: none; cursor: pointer; }
  button:hover, a:hover, button:focus-visible, a:focus-visible { background: #3b3b3b; outline: none; } button:disabled { opacity: .4; cursor: default; }
  .body { display: grid; grid-template-columns: minmax(0, 1fr); flex: 1; min-height: 0; } .body.inspecting { grid-template-columns: minmax(0, 1fr) 330px; }
  .stage { display: flex; flex-direction: column; align-items: stretch; justify-content: center; min-width: 0; min-height: 0; overflow: hidden; } .stage > :global(.player), .stage > :global(.viewer) { flex: 1; min-height: 0; }
  .stage > p, .fallback { padding: 30px; text-align: center; } .fallback a { display: inline-block; margin-top: 18px; } img { width: 100%; height: 100%; object-fit: contain; } aside { min-height: 0; overflow: auto; background: #191919; }
  @media (max-width: 760px) { .quick-look { width: 100vw; height: 100dvh; border-radius: 0; } header { align-items: stretch; flex-direction: column; gap: 12px; padding: 14px; } nav { flex-wrap: nowrap; overflow-x: auto; } nav > * { white-space: nowrap; } .body.inspecting { grid-template-columns: minmax(0, 1fr); overflow: auto; } .body.inspecting .stage { min-height: 45dvh; } .body.inspecting aside { overflow: visible; } }
</style>
