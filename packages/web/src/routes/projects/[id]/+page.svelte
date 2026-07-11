<script lang="ts">
  import { page } from '$app/state';
  import { api, apiPost, messageFrom } from '$lib/api.js';

  type Asset = { id: string; name: string; kind: string; status: string; current_version_id?: string | null };
  type Project = { id: string; name: string; palette: string; status: string };
  type UploadItem = {
    file: File;
    sessionId: string | null;
    progress: number;
    status: 'queued' | 'uploading' | 'failed' | 'quarantined' | 'done';
    error: string;
  };

  let project = $state<Project | null>(null);
  let assets = $state<Asset[]>([]);
  let error = $state('');
  let queue = $state<UploadItem[]>([]);
  let uploading = $state(false);

  const projectId = $derived(page.params.id);

  /* One grammar: vertical, dark anchor at top, light terminal at bottom.
     Stops follow mockups/projects.html where the mockup defines the wash. */
  const WASHES: Record<string, string> = {
    kuwanomi: 'linear-gradient(180deg, #3d1c2a 0%, var(--kuwanomi-a) 34%, #5a7ba0 76%, var(--kuwanomi-b) 112%)',
    sakinezu: 'linear-gradient(180deg, var(--sakinezu-b) 0%, var(--sakinezu-a) 70%, #55696a 110%)',
    shinai: 'linear-gradient(180deg, var(--shinai-a) 0%, var(--shinai-m) 55%, var(--shinai-b) 105%)',
    yorukou: 'linear-gradient(180deg, var(--yorukou-a) 0%, var(--yorukou-m) 62%, var(--yorukou-b) 108%)',
    tetsukon: 'linear-gradient(180deg, #16283a 0%, var(--tetsukon-a) 40%, var(--tetsukon-m) 78%, var(--tetsukon-b) 116%)',
    ebicha: 'linear-gradient(180deg, var(--ebicha-a) 0%, var(--ebicha-m) 55%, var(--ebicha-b) 108%)',
    sumimai: 'linear-gradient(180deg, var(--sumimai-a) 0%, var(--sumimai-m) 58%, var(--sumimai-b) 108%)',
    yoai: 'linear-gradient(180deg, var(--yoai-a) 0%, var(--yoai-m) 55%, var(--yoai-b) 105%)',
    kachitetsu: 'linear-gradient(180deg, var(--kachitetsu-a) 0%, var(--kachitetsu-m) 55%, var(--kachitetsu-b) 105%)',
    mokutan: 'linear-gradient(180deg, var(--mokutan-a) 0%, var(--mokutan-m) 55%, var(--mokutan-b) 105%)'
  };
  const wash = $derived(WASHES[project?.palette ?? ''] ?? WASHES.sumimai);

  const loadAssets = async (id: string): Promise<void> => {
    try {
      assets = (await api<{ items: Asset[] }>(`/api/v1/projects/${id}/assets`)).items;
    } catch {
      /* Keep whatever list we had; the page error covers hard failures. */
    }
  };

  const load = async (id: string): Promise<void> => {
    project = null; assets = []; error = ''; queue = [];
    try {
      const loaded = await api<Project>(`/api/v1/projects/${id}`);
      if (id !== projectId) return;
      project = loaded;
    } catch (caught) {
      error = messageFrom(caught, 'This project is not available.');
      return;
    }
    await loadAssets(id);
  };

  $effect(() => {
    const id = projectId;
    if (id) void load(id);
  });

  const chooseFiles = (event: Event): void => {
    const files = (event.currentTarget as HTMLInputElement).files;
    if (!files) return;
    const additions: UploadItem[] = [];
    for (const file of files) {
      additions.push({ file, sessionId: null, progress: 0, status: 'queued', error: '' });
    }
    queue = [...queue, ...additions];
    (event.currentTarget as HTMLInputElement).value = '';
  };

  /* Resumable upload: the session id is kept on the item, so a retry reuses
     the same session, lists its persisted parts, skips completed part numbers,
     and continues from where the failure happened. */
  const uploadOne = async (item: UploadItem): Promise<void> => {
    if (!projectId || item.status === 'uploading' || item.status === 'done' || item.status === 'quarantined') return;
    item.status = 'uploading';
    item.error = '';
    try {
      if (!item.sessionId) {
        const created = await apiPost<{ upload: { id: string } }>('/api/v1/uploads', {
          project_id: projectId,
          filename: item.file.name,
          relative_path: '',
          size: item.file.size
        });
        item.sessionId = created.upload.id;
      }
      const sessionId = item.sessionId;
      const multipart = await apiPost<{ upload: { status: string }; part_size?: number }>(`/api/v1/uploads/${sessionId}/multipart`);
      if (multipart.upload.status !== 'completed') {
        const partSize = multipart.part_size;
        if (!partSize) throw new Error('The upload session did not return a part size.');
        const existing = (await api<{ items: Array<{ part_no: number; etag: string }> }>(`/api/v1/uploads/${sessionId}/parts`)).items;
        const parts: Array<{ part_no: number; etag: string }> = [];
        const count = Math.max(1, Math.ceil(item.file.size / partSize));
        for (let partNo = 1; partNo <= count; partNo += 1) {
          const known = existing.find((part) => part.part_no === partNo && part.etag);
          if (known) {
            parts.push({ part_no: known.part_no, etag: known.etag });
          } else {
            const start = (partNo - 1) * partSize;
            const response = await fetch(`/api/v1/uploads/${sessionId}/parts/${partNo}`, {
              method: 'PUT',
              headers: { 'content-type': 'application/octet-stream' },
              body: item.file.slice(start, Math.min(item.file.size, start + partSize))
            });
            if (!response.ok) throw new Error(`Part ${partNo} could not be uploaded.`);
            parts.push({ part_no: partNo, etag: response.headers.get('etag') ?? '' });
          }
          item.progress = Math.round((partNo / count) * 90);
        }
        try {
          await apiPost(`/api/v1/uploads/${sessionId}/complete`, { parts });
        } catch (caught) {
          const message = messageFrom(caught, 'Upload completion failed.');
          if (message.toLowerCase().includes('checksum')) {
            item.status = 'quarantined';
            item.error = 'Checksum mismatch: the upload is quarantined and cannot be resumed.';
            return;
          }
          throw caught;
        }
      }
      item.progress = 95;
      await apiPost(`/api/v1/projects/${projectId}/assets`, { upload_id: sessionId, name: item.file.name });
      item.progress = 100;
      item.status = 'done';
      await loadAssets(projectId);
    } catch (caught) {
      item.status = 'failed';
      item.error = messageFrom(caught, 'Upload failed.');
    }
  };

  const uploadAll = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    if (uploading) return;
    uploading = true;
    try {
      for (const item of queue) {
        if (item.status === 'queued' || item.status === 'failed') await uploadOne(item);
      }
    } finally {
      uploading = false;
    }
  };

  const retry = async (item: UploadItem): Promise<void> => {
    if (uploading) return;
    uploading = true;
    try {
      await uploadOne(item);
    } finally {
      uploading = false;
    }
  };

  const clearFinished = (): void => {
    queue = queue.filter((item) => item.status !== 'done');
  };

  const hasPending = $derived(queue.some((item) => item.status === 'queued' || item.status === 'failed'));
</script>

<svelte:head><title>{project?.name ?? 'Project'} | Onelight</title></svelte:head>

<main class="room">
  <header class="wash" style={`background-image: ${wash};`}>
    <a href="/">Projects</a>
    <p class="eyebrow">{project?.palette ?? ''}</p>
    <h1>{project?.name ?? 'Project'}</h1>
  </header>
  {#if error}
    <p class="error page-error" role="alert">{error}</p>
  {:else}
    <div class="body">
      <form class="upload" onsubmit={uploadAll}>
        <label class="file">Add media <input type="file" multiple onchange={chooseFiles} /></label>
        <button type="submit" disabled={!hasPending || uploading}>{uploading ? 'Uploading' : 'Upload'}</button>
        {#if queue.some((item) => item.status === 'done')}
          <button type="button" class="quiet" onclick={clearFinished}>Clear finished</button>
        {/if}
      </form>
      {#if queue.length > 0}
        <ul class="queue" aria-label="Upload queue">
          {#each queue as item (item.file)}
            <li class={`q-${item.status}`}>
              <span class="name">{item.file.name}</span>
              <span class="bar" role="progressbar" aria-valuenow={item.progress} aria-valuemin="0" aria-valuemax="100"><span style={`width: ${item.progress}%;`}></span></span>
              <span class="state">
                {#if item.status === 'queued'}Waiting
                {:else if item.status === 'uploading'}{item.progress}%
                {:else if item.status === 'done'}Done
                {:else if item.status === 'quarantined'}Quarantined
                {:else}Failed{/if}
              </span>
              {#if item.status === 'failed'}
                <button type="button" class="quiet" onclick={() => retry(item)}>Resume</button>
              {/if}
              {#if item.error}<span class="error">{item.error}</span>{/if}
            </li>
          {/each}
        </ul>
      {/if}
      <section aria-label="Assets" class="assets">
        {#if assets.length === 0}<p class="empty">No assets yet. Upload media to start a review.</p>{/if}
        {#each assets as asset (asset.id)}
          <a class="asset" href={`/projects/${projectId}/assets/${asset.id}`}>
            <span class="asset-name">{asset.name}</span>
            <span class="asset-meta">{asset.kind}</span>
            <span class="asset-meta">{asset.status}</span>
          </a>
        {/each}
      </section>
    </div>
  {/if}
</main>

<style>
  /* App world: dark ink base, the project's palette as the header wash.
     Separation by value step and space, not borders. */
  .room { min-height: 100vh; background: var(--ink-000); color: var(--ink-text); font-size: var(--text-13); }
  .wash { padding: var(--pad-3) var(--pad-4) var(--pad-4); background-size: 100% 300%; background-position: 50% 0%; }
  .wash a { color: rgba(250, 248, 244, 0.72); font-size: var(--text-13); text-decoration: none; }
  .wash a:hover { color: rgba(250, 248, 244, 0.96); }
  .eyebrow { margin: var(--pad-3) 0 0; color: rgba(250, 248, 244, 0.62); font-size: var(--text-13); font-weight: 500; }
  h1 { margin: 4px 0 0; font-family: var(--font-display); font-size: clamp(2rem, 5vw, var(--text-56)); font-weight: 700; letter-spacing: -0.02em; color: rgba(250, 248, 244, 0.96); }
  .body { padding: var(--pad-3) var(--pad-4) var(--pad-4); max-width: 900px; }
  .upload { display: flex; flex-wrap: wrap; align-items: end; gap: 14px; }
  .upload .file { display: grid; gap: 8px; color: var(--ink-text-dim); }
  button { border: 0; border-radius: var(--radius); background: var(--accent); color: #0b1214; padding: 9px 16px; font-size: var(--text-12); font-weight: 600; }
  button:hover { background: var(--accent-bright); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.quiet { background: var(--ink-200); color: var(--ink-text); font-weight: 500; }
  button.quiet:hover { background: var(--ink-300); }
  .queue { list-style: none; margin: var(--pad-2) 0 0; padding: 0; display: grid; gap: 2px; }
  .queue li { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 10px 12px; border-radius: var(--radius); background: var(--ink-100); }
  .queue .name { flex: 1; min-width: 160px; font-weight: 500; }
  .queue .bar { flex: 2; min-width: 120px; height: 3px; border-radius: 2px; background: var(--ink-200); overflow: hidden; display: block; }
  .queue .bar span { display: block; height: 100%; background: var(--accent); }
  .queue .state { min-width: 80px; color: var(--ink-text-dim); font-variant-numeric: tabular-nums; }
  li.q-done .state { color: var(--ok); }
  li.q-quarantined .state { color: var(--warn); font-weight: 600; }
  li.q-quarantined { background: var(--ink-200); }
  li.q-failed .state { color: var(--warn); }
  .assets { display: grid; gap: 2px; margin-top: var(--pad-4); }
  .asset { display: flex; align-items: baseline; gap: var(--pad-2); padding: 14px 12px; margin: 0 -12px; border-radius: var(--radius); color: var(--ink-text); text-decoration: none; }
  .asset:hover { background: var(--ink-100); }
  .asset-name { flex: 1; font-weight: 500; font-size: var(--text-14); }
  .asset-meta { color: var(--ink-text-dim); font-size: var(--text-12); }
  .empty { color: var(--ink-text-dim); }
  .error { color: var(--warn); }
  .page-error { padding: var(--pad-3) var(--pad-4); }
  button:focus-visible, a:focus-visible, input:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
</style>
