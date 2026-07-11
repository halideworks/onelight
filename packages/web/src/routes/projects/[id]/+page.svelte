<script lang="ts">
  import { tick } from 'svelte';
  import { page } from '$app/state';
  import { api, apiDelete, apiPatch, apiPost, messageFrom } from '$lib/api.js';

  type Asset = { id: string; name: string; kind: string; status: string; current_version_id?: string | null };
  type Project = { id: string; name: string; palette: string; status: string };
  type Folder = { id: string; parent_id: string | null; name: string };
  type TreeNode = { folder: Folder; childIds: string[] | null; expanded: boolean };
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

  /* Folder tree (phase-0 T20). Children load lazily per folder; 'root' is the
     synthetic all-assets row. */
  let nodes = $state<Record<string, TreeNode>>({});
  let rootIds = $state<string[]>([]);
  let selectedFolder = $state<string | null>(null);
  let focusedRow = $state('root');
  let renaming = $state<string | null>(null);
  let renameValue = $state('');
  let newFolderName = $state('');
  let treeError = $state('');
  let dropTarget = $state<string | null>(null);
  let dragging = $state<string | null>(null);

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
    const folder = selectedFolder;
    const suffix = folder ? `?folder_id=${encodeURIComponent(folder)}` : '';
    try {
      const items = (await api<{ items: Asset[] }>(`/api/v1/projects/${id}/assets${suffix}`)).items;
      if (id !== projectId || folder !== selectedFolder) return;
      assets = items;
    } catch {
      /* Keep whatever list we had; the page error covers hard failures. */
    }
  };

  const loadChildren = async (parentId: string | null): Promise<void> => {
    const id = projectId;
    if (!id) return;
    const suffix = parentId ? `?parent_id=${encodeURIComponent(parentId)}` : '';
    const children = (await api<{ items: Folder[] }>(`/api/v1/projects/${id}/folders${suffix}`)).items;
    if (id !== projectId) return;
    for (const folder of children) {
      const existing = nodes[folder.id];
      nodes[folder.id] = existing ? { ...existing, folder } : { folder, childIds: null, expanded: false };
    }
    const ids = children.map((folder) => folder.id);
    if (parentId === null) {
      rootIds = ids;
    } else {
      const parent = nodes[parentId];
      if (parent) nodes[parentId] = { ...parent, childIds: ids };
    }
  };

  const load = async (id: string): Promise<void> => {
    project = null; assets = []; error = ''; queue = [];
    nodes = {}; rootIds = []; selectedFolder = null; focusedRow = 'root';
    renaming = null; treeError = ''; newFolderName = '';
    try {
      const loaded = await api<Project>(`/api/v1/projects/${id}`);
      if (id !== projectId) return;
      project = loaded;
    } catch (caught) {
      error = messageFrom(caught, 'This project is not available.');
      return;
    }
    try {
      await loadChildren(null);
    } catch (caught) {
      treeError = messageFrom(caught, 'Folders could not be loaded.');
    }
    await loadAssets(id);
  };

  $effect(() => {
    const id = projectId;
    if (id) void load(id);
  });

  /* ---- tree rows and keyboard ---- */

  type Row = { id: string; depth: number };
  const visibleRows = $derived.by(() => {
    const rows: Row[] = [{ id: 'root', depth: 0 }];
    const walk = (ids: string[], depth: number): void => {
      for (const id of ids) {
        rows.push({ id, depth });
        const node = nodes[id];
        if (node?.expanded && node.childIds) walk(node.childIds, depth + 1);
      }
    };
    walk(rootIds, 1);
    return rows;
  });

  const focusRow = async (id: string): Promise<void> => {
    focusedRow = id;
    await tick();
    document.getElementById(`tree-row-${id}`)?.focus();
  };

  const expand = async (id: string): Promise<void> => {
    const node = nodes[id];
    if (!node) return;
    nodes[id] = { ...node, expanded: true };
    if (node.childIds === null) {
      try {
        await loadChildren(id);
      } catch (caught) {
        treeError = messageFrom(caught, 'Folders could not be loaded.');
      }
    }
  };

  const collapse = (id: string): void => {
    const node = nodes[id];
    if (node) nodes[id] = { ...node, expanded: false };
  };

  const select = async (id: string | null): Promise<void> => {
    selectedFolder = id;
    if (id) await expand(id);
    const project_ = projectId;
    if (project_) await loadAssets(project_);
  };

  const startRename = (id: string): void => {
    const node = nodes[id];
    if (!node) return;
    renaming = id;
    renameValue = node.folder.name;
  };

  const commitRename = async (): Promise<void> => {
    const id = renaming;
    if (!id) return;
    const node = nodes[id];
    const name = renameValue.trim();
    renaming = null;
    if (!node || !name || name === node.folder.name) return;
    treeError = '';
    try {
      const updated = await apiPatch<Folder>(`/api/v1/folders/${id}`, { name });
      nodes[id] = { ...node, folder: updated };
      await loadChildren(updated.parent_id);
    } catch (caught) {
      treeError = messageFrom(caught, 'The folder could not be renamed.');
    }
    void focusRow(id);
  };

  const cancelRename = (): void => {
    const id = renaming;
    renaming = null;
    if (id) void focusRow(id);
  };

  const createFolder = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const id = projectId;
    const name = newFolderName.trim();
    if (!id || !name) return;
    treeError = '';
    try {
      await apiPost(`/api/v1/projects/${id}/folders`, { name, parent_id: selectedFolder });
    } catch (caught) {
      treeError = messageFrom(caught, 'The folder could not be created.');
      return;
    }
    newFolderName = '';
    if (selectedFolder) {
      const parent = nodes[selectedFolder];
      if (parent) nodes[selectedFolder] = { ...parent, expanded: true };
    }
    try {
      await loadChildren(selectedFolder);
    } catch {
      /* The next expand reloads. */
    }
  };

  const isInSubtree = (candidate: string | null, ancestor: string): boolean => {
    let current = candidate;
    while (current) {
      if (current === ancestor) return true;
      current = nodes[current]?.folder.parent_id ?? null;
    }
    return false;
  };

  const removeFolder = async (id: string): Promise<void> => {
    const node = nodes[id];
    if (!node) return;
    if (!confirm(`Delete "${node.folder.name}" and every folder inside it? Assets in those folders are kept and return to All assets.`)) return;
    treeError = '';
    try {
      await apiDelete(`/api/v1/folders/${id}`);
    } catch (caught) {
      treeError = messageFrom(caught, 'The folder could not be deleted.');
      return;
    }
    const parent = node.folder.parent_id;
    if (selectedFolder && isInSubtree(selectedFolder, id)) await select(parent);
    try {
      await loadChildren(parent);
    } catch {
      /* The next expand reloads. */
    }
    void focusRow(parent ?? 'root');
  };

  /* Move via drag and drop; the API rejects cycles, depth overruns, and name
     conflicts, and its message is surfaced verbatim. */
  const moveFolder = async (id: string, newParent: string | null): Promise<void> => {
    const node = nodes[id];
    if (!node || id === newParent || node.folder.parent_id === newParent) return;
    treeError = '';
    try {
      await apiPatch(`/api/v1/folders/${id}`, { parent_id: newParent });
    } catch (caught) {
      treeError = messageFrom(caught, 'The folder could not be moved.');
      return;
    }
    const oldParent = node.folder.parent_id;
    if (newParent) {
      const target = nodes[newParent];
      if (target) nodes[newParent] = { ...target, expanded: true };
    }
    try {
      await loadChildren(oldParent);
      await loadChildren(newParent);
    } catch {
      /* The next expand reloads. */
    }
  };

  const onDragStart = (event: DragEvent, id: string): void => {
    dragging = id;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', id);
    }
  };

  const onDragOver = (event: DragEvent, target: string | null): void => {
    if (!dragging || dragging === target) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    dropTarget = target ?? 'root';
  };

  const onDrop = (event: DragEvent, target: string | null): void => {
    event.preventDefault();
    const id = dragging;
    dragging = null;
    dropTarget = null;
    if (id) void moveFolder(id, target);
  };

  const onTreeKeydown = (event: KeyboardEvent): void => {
    if (renaming) return;
    const rows = visibleRows;
    const index = rows.findIndex((row) => row.id === focusedRow);
    if (index < 0) return;
    const id = focusedRow;
    const node = id === 'root' ? null : nodes[id];
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const next = rows[index + 1];
      if (next) void focusRow(next.id);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      const previous = rows[index - 1];
      if (previous) void focusRow(previous.id);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (id === 'root') {
        const first = rows[1];
        if (first) void focusRow(first.id);
      } else if (node && !node.expanded) {
        void expand(id);
      } else if (node?.childIds && node.childIds.length > 0) {
        void focusRow(node.childIds[0]);
      }
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (node?.expanded) collapse(id);
      else if (node) void focusRow(node.folder.parent_id ?? 'root');
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void select(id === 'root' ? null : id);
    } else if (event.key === 'F2') {
      event.preventDefault();
      if (id !== 'root') startRename(id);
    } else if (event.key === 'Delete') {
      event.preventDefault();
      if (id !== 'root') void removeFolder(id);
    }
  };

  const focusInput = (element: HTMLInputElement): void => {
    element.focus();
    element.select();
  };

  const selectedName = $derived(
    selectedFolder ? (nodes[selectedFolder]?.folder.name ?? 'Folder') : 'All assets'
  );

  /* ---- uploads ---- */

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
      /* New assets land in the folder selected in the tree. */
      await apiPost(`/api/v1/projects/${projectId}/assets`, {
        upload_id: sessionId,
        name: item.file.name,
        ...(selectedFolder ? { folder_id: selectedFolder } : {})
      });
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
      <aside class="pane" aria-label="Folders">
        <h2 class="pane-label" id="folders-label">Folders</h2>
        <div class="tree" role="tree" aria-labelledby="folders-label">
          {#each visibleRows as row (row.id)}
            {#if row.id === 'root'}
              <div
                id="tree-row-root"
                class="row root"
                class:selected={selectedFolder === null}
                class:droptarget={dropTarget === 'root'}
                role="treeitem"
                aria-level="1"
                aria-selected={selectedFolder === null}
                tabindex={focusedRow === 'root' ? 0 : -1}
                onclick={() => select(null)}
                onkeydown={onTreeKeydown}
                onfocus={() => (focusedRow = 'root')}
                ondragover={(event) => onDragOver(event, null)}
                ondragleave={() => (dropTarget = dropTarget === 'root' ? null : dropTarget)}
                ondrop={(event) => onDrop(event, null)}
              >
                <span class="name">All assets</span>
              </div>
            {:else}
              {@const node = nodes[row.id]}
              {#if node}
                <div
                  id={`tree-row-${row.id}`}
                  class="row"
                  class:selected={selectedFolder === row.id}
                  class:droptarget={dropTarget === row.id}
                  role="treeitem"
                  aria-level={row.depth + 1}
                  aria-selected={selectedFolder === row.id}
                  aria-expanded={node.expanded}
                  tabindex={focusedRow === row.id ? 0 : -1}
                  style={`padding-left: ${10 + row.depth * 14}px;`}
                  draggable={renaming === row.id ? 'false' : 'true'}
                  onclick={() => select(row.id)}
                  ondblclick={() => startRename(row.id)}
                  onkeydown={onTreeKeydown}
                  onfocus={() => (focusedRow = row.id)}
                  ondragstart={(event) => onDragStart(event, row.id)}
                  ondragend={() => { dragging = null; dropTarget = null; }}
                  ondragover={(event) => onDragOver(event, row.id)}
                  ondragleave={() => (dropTarget = dropTarget === row.id ? null : dropTarget)}
                  ondrop={(event) => onDrop(event, row.id)}
                >
                  <button
                    type="button"
                    class="caret"
                    class:open={node.expanded}
                    tabindex="-1"
                    aria-label={node.expanded ? `Collapse ${node.folder.name}` : `Expand ${node.folder.name}`}
                    onclick={(event) => { event.stopPropagation(); if (node.expanded) collapse(row.id); else void expand(row.id); }}
                  >
                    <svg viewBox="0 0 8 8" width="8" height="8" aria-hidden="true"><path d="M2 1l4 3-4 3z" fill="currentColor" /></svg>
                  </button>
                  {#if renaming === row.id}
                    <input
                      class="rename"
                      bind:value={renameValue}
                      use:focusInput
                      aria-label={`Rename ${node.folder.name}`}
                      onkeydown={(event) => {
                        event.stopPropagation();
                        if (event.key === 'Enter') void commitRename();
                        else if (event.key === 'Escape') cancelRename();
                      }}
                      onblur={cancelRename}
                      onclick={(event) => event.stopPropagation()}
                      ondblclick={(event) => event.stopPropagation()}
                    />
                  {:else}
                    <span class="name">{node.folder.name}</span>
                    <span class="acts">
                      <button type="button" class="act" tabindex="-1" aria-label={`Rename ${node.folder.name}`} onclick={(event) => { event.stopPropagation(); startRename(row.id); }}>Rename</button>
                      <button type="button" class="act" tabindex="-1" aria-label={`Delete ${node.folder.name}`} onclick={(event) => { event.stopPropagation(); void removeFolder(row.id); }}>Delete</button>
                    </span>
                  {/if}
                </div>
              {/if}
            {/if}
          {/each}
        </div>
        <form class="newfolder" onsubmit={createFolder}>
          <input
            bind:value={newFolderName}
            placeholder={selectedFolder ? `New folder in ${selectedName}` : 'New folder'}
            aria-label={selectedFolder ? `New folder in ${selectedName}` : 'New folder at the top level'}
            maxlength="200"
          />
          <button type="submit" class="quiet" disabled={!newFolderName.trim()}>Create</button>
        </form>
        {#if treeError}<p class="error" role="alert">{treeError}</p>{/if}
        <p class="hint">Arrows navigate, Enter opens, F2 renames, drag to move.</p>
      </aside>

      <section class="main">
        <form class="upload" onsubmit={uploadAll}>
          <label class="file">Add media to {selectedName} <input type="file" multiple onchange={chooseFiles} /></label>
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
          {#if assets.length === 0}
            <p class="empty">{selectedFolder ? 'No assets in this folder.' : 'No assets yet. Upload media to start a review.'}</p>
          {/if}
          {#each assets as asset (asset.id)}
            <a class="asset" href={`/projects/${projectId}/assets/${asset.id}`}>
              <span class="asset-name">{asset.name}</span>
              <span class="asset-meta">{asset.kind}</span>
              <span class="asset-meta">{asset.status}</span>
            </a>
          {/each}
        </section>
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
  .body { padding: var(--pad-3) var(--pad-4) var(--pad-4); display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: var(--pad-4); max-width: 1200px; align-items: start; }
  @media (max-width: 760px) { .body { grid-template-columns: 1fr; } }

  /* ---- folder tree pane ---- */
  .pane-label { margin: 0 0 10px; font-size: var(--text-13); font-weight: 600; color: var(--ink-text-dim); }
  .tree { display: grid; gap: 1px; }
  .row { display: flex; align-items: center; gap: 6px; padding: 7px 10px; border-radius: var(--radius); cursor: default; }
  .row:hover { background: var(--ink-100); }
  .row.selected { background: var(--ink-200); }
  .row.droptarget { background: var(--ink-300); }
  .row:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: -1px; }
  .row .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
  .row.root .name { color: var(--ink-text); }
  .caret { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; padding: 0; border: 0; border-radius: 2px; background: none; color: var(--ink-text-dim); }
  .caret:hover { color: var(--ink-text); }
  .caret.open svg { transform: rotate(90deg); }
  .acts { display: none; gap: 2px; flex: none; }
  .row:hover .acts, .row:focus-within .acts { display: inline-flex; }
  .act { border: 0; border-radius: 2px; background: none; color: var(--ink-text-dim); padding: 2px 6px; font-size: var(--text-12); }
  .act:hover { background: var(--ink-300); color: var(--ink-text); }
  .rename { flex: 1; min-width: 0; border: 0; border-radius: 2px; background: var(--ink-300); color: var(--ink-text); padding: 3px 6px; font-size: var(--text-13); }
  .newfolder { display: flex; gap: 6px; margin-top: 14px; }
  .newfolder input { flex: 1; min-width: 0; border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 8px 10px; font-size: var(--text-13); }
  .newfolder input::placeholder { color: var(--ink-text-dim); }
  .hint { margin: 12px 0 0; color: var(--ink-text-dim); font-size: var(--text-12); }

  /* ---- uploads and assets ---- */
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
