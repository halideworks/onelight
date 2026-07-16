<script lang="ts">
  import { askConfirm, askText } from '$lib/confirm.svelte.js';
  import { tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { api, apiDelete, apiPatch, apiPost, createAssetVersion, messageFrom } from '$lib/api.js';
  import { createMediaCache } from '$lib/asset-media.svelte.js';
  import AssetSelect from '$lib/AssetSelect.svelte';
  import ScrubThumb from '$lib/ScrubThumb.svelte';
  import { whenAbsolute, whenRelative } from '$lib/format.js';
  import { projectEvents } from '$lib/sse.svelte.js';
  import type { ProjectEvent } from '$lib/sse.svelte.js';
  import {
    filesFromDataTransfer,
    filesFromInput,
    formatBytes,
    formatRate,
    uploadFile,
    UploadQuarantinedError
  } from '$lib/upload.js';
  import type { PendingFile } from '$lib/upload.js';
  import { washFor } from '$lib/washes.js';

  type Asset = {
    id: string;
    project_id: string;
    folder_id: string | null;
    name: string;
    kind: string;
    status: string;
    current_version_id?: string | null;
    created_at: number;
    updated_at: number;
  };
  type Project = { id: string; name: string; palette: string; status: string };
  type Folder = { id: string; parent_id: string | null; name: string };
  type TreeNode = { folder: Folder; childIds: string[] | null; expanded: boolean };
  type UploadItem = {
    key: number;
    file: File;
    relativePath: string;
    sessionId: string | null;
    bytes: number;
    rate: number;
    status: 'queued' | 'uploading' | 'failed' | 'quarantined' | 'done';
    error: string;
    /* Upload-time version stacking: when set, the finished upload becomes a
       new version of this asset instead of a new asset. */
    versionOf: string | null;
    carryForward: boolean;
  };

  let project = $state<Project | null>(null);
  type Share = { id: string; title: string; slug: string; allow_download: string; revoked_at: number | null };

  let assets = $state<Asset[]>([]);
  let nextCursor = $state<string | null>(null);
  let loadingMore = $state(false);
  let error = $state('');
  let listError = $state('');
  let queue = $state<UploadItem[]>([]);
  let uploading = $state(false);
  let dropActive = $state(false);
  let nextKey = 0;

  /* Folder tree (phase-0 T20). Children load lazily per folder; 'root' is the
     synthetic all-assets row. */
  let nodes = $state<Record<string, TreeNode>>({});
  let rootIds = $state<string[]>([]);
  let selectedFolder = $state<string | null>(null);
  /* A share is browsed like a folder, so it shares the rail and the grid, but
     it is not a folder: an asset lives in exactly one folder and in any number
     of shares. Two selections, one visible at a time. */
  let selectedShare = $state<string | null>(null);
  let shares = $state<Share[]>([]);
  let shareError = $state('');
  let shareMenu = $state<{ x: number; y: number; ids: string[] } | null>(null);
  let shareChoice = $state('');
  let focusedRow = $state('root');
  let renaming = $state<string | null>(null);
  let renameValue = $state('');
  let newFolderName = $state('');
  let treeError = $state('');
  let dropTarget = $state<string | null>(null);
  let dragging = $state<string | null>(null);

  const projectId = $derived(page.params.id);
  const wash = $derived(washFor(project?.palette));

  const media = createMediaCache();
  const observeMedia = media.observe;

  /* One place decides what the grid is showing: a folder, a share, or
     everything. */
  const listSuffix = (): string =>
    selectedShare
      ? `&share_id=${encodeURIComponent(selectedShare)}`
      : selectedFolder
        ? `&folder_id=${encodeURIComponent(selectedFolder)}`
        : '';

  const loadAssets = async (id: string): Promise<void> => {
    const folder = selectedFolder;
    const share = selectedShare;
    const suffix = listSuffix();
    try {
      const loaded = await api<{ items: Asset[]; next_cursor: string | null }>(
        `/api/v1/projects/${id}/assets?limit=100${suffix}`
      );
      if (id !== projectId || folder !== selectedFolder || share !== selectedShare) return;
      assets = loaded.items;
      nextCursor = loaded.next_cursor;
      selected = selected.filter((entry) => loaded.items.some((asset) => asset.id === entry));
    } catch {
      /* Keep whatever list we had; the page error covers hard failures. */
    }
  };

  const loadMoreAssets = async (): Promise<void> => {
    const id = projectId;
    const cursor = nextCursor;
    if (!id || !cursor || loadingMore) return;
    loadingMore = true;
    const folder = selectedFolder;
    const share = selectedShare;
    const suffix = listSuffix();
    try {
      const loaded = await api<{ items: Asset[]; next_cursor: string | null }>(
        `/api/v1/projects/${id}/assets?limit=100&cursor=${encodeURIComponent(cursor)}${suffix}`
      );
      if (id !== projectId || folder !== selectedFolder || share !== selectedShare) return;
      const known = new Set(assets.map((asset) => asset.id));
      assets = [...assets, ...loaded.items.filter((asset) => !known.has(asset.id))];
      nextCursor = loaded.next_cursor;
    } catch (caught) {
      listError = messageFrom(caught, 'More assets could not be loaded.');
    } finally {
      loadingMore = false;
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
    project = null; assets = []; nextCursor = null; error = ''; listError = ''; queue = [];
    nodes = {}; rootIds = []; selectedFolder = null; focusedRow = 'root';
    selectedShare = null; shares = []; shareError = ''; shareMenu = null;
    renaming = null; treeError = ''; newFolderName = '';
    selected = []; anchor = null; batch = { running: false, label: '', done: 0, total: 0, errors: [] };
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
    await Promise.all([loadAssets(id), loadShares(id)]);
  };

  $effect(() => {
    const id = projectId;
    if (id) void load(id);
  });

  /* ---- live updates (project SSE) ---- */

  const refreshAsset = async (assetId: string): Promise<void> => {
    try {
      const asset = await api<Asset>(`/api/v1/assets/${assetId}`);
      assets = assets.map((entry) => (entry.id === assetId ? asset : entry));
      media.refresh(asset);
    } catch {
      /* The row keeps its last known state. */
    }
  };

  const onProjectEvent = (id: string, event: ProjectEvent): void => {
    const payload = event.payload;
    const assetId = typeof payload.asset_id === 'string' ? payload.asset_id : null;
    if (!assetId) return;
    if (event.type === 'asset.created') {
      void (async () => {
        if (assets.some((asset) => asset.id === assetId)) return;
        try {
          const asset = await api<Asset>(`/api/v1/assets/${assetId}`);
          if (id !== projectId || asset.project_id !== id) return;
          if (selectedFolder && asset.folder_id !== selectedFolder) return;
          if (assets.some((entry) => entry.id === assetId)) return;
          assets = [asset, ...assets];
        } catch {
          /* A later refresh picks it up. */
        }
      })();
    } else if (event.type === 'version.transcode') {
      const status = typeof payload.status === 'string' ? payload.status : null;
      if (status) media.setTranscodeStatus(assetId, status);
      if (status === 'ready') {
        const known = assets.find((asset) => asset.id === assetId);
        media.refresh(known ?? { id: assetId });
      }
    } else if (event.type === 'asset.version_created') {
      void refreshAsset(assetId);
    } else if (event.type === 'version.probed') {
      const known = assets.find((asset) => asset.id === assetId);
      if (known) media.refresh(known);
    }
  };

  $effect(() => {
    const id = projectId;
    if (!id) return;
    return projectEvents(
      id,
      ['asset.created', 'asset.version_created', 'version.transcode', 'version.probed'],
      (event) => onProjectEvent(id, event)
    );
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
    selectedShare = null;
    selected = [];
    anchor = null;
    if (id) await expand(id);
    const project_ = projectId;
    if (project_) await loadAssets(project_);
  };

  const selectShare = async (id: string): Promise<void> => {
    selectedShare = id;
    selectedFolder = null;
    selected = [];
    anchor = null;
    const project_ = projectId;
    if (project_) await loadAssets(project_);
  };

  const loadShares = async (id: string): Promise<void> => {
    try {
      const loaded = await api<{ items: Share[] }>(
        `/api/v1/shares?project_id=${encodeURIComponent(id)}`
      );
      if (id !== projectId) return;
      shares = loaded.items.filter((share) => !share.revoked_at);
    } catch {
      /* Shares are one section of the rail, not the page: a manager-only read
         failing for a viewer must not take the project down with it. */
      shares = [];
    }
  };

  /* Putting assets in front of a client should not mean leaving the page you
     are looking at them on. */
  const addToShare = async (shareId: string, ids: string[]): Promise<void> => {
    shareError = '';
    try {
      const result = await apiPost<{ added: number }>(`/api/v1/shares/${shareId}/assets`, {
        asset_ids: ids
      });
      const share = shares.find((entry) => entry.id === shareId);
      shareError =
        result.added === 0
          ? `Already in ${share?.title ?? 'that share'}.`
          : `Added ${result.added} to ${share?.title ?? 'the share'}.`;
      if (selectedShare === shareId && projectId) await loadAssets(projectId);
    } catch (caught) {
      shareError = messageFrom(caught, 'Those assets could not be shared.');
    }
  };

  const createShareWith = async (ids: string[]): Promise<void> => {
    const id = projectId;
    if (!id) return;
    const title = await askText({
      title: `New share of ${ids.length} ${ids.length === 1 ? 'item' : 'items'}`,
      body: 'Anyone with the link can watch what is in this share. Download, comments and a passphrase are set in the share\u2019s settings.',
      label: 'Share name',
      initial: selectedName === 'All assets' ? (project?.name ?? '') : selectedName,
      placeholder: 'Client review',
      confirmLabel: 'Create share'
    });
    if (!title) return;
    shareError = '';
    try {
      const created = await apiPost<{ share: Share; url: string }>('/api/v1/shares', {
        project_id: id,
        title,
        asset_ids: ids
      });
      shares = [...shares, created.share];
      shareError = `Created ${created.share.title}.`;
    } catch (caught) {
      shareError = messageFrom(caught, 'That share could not be created.');
    }
  };

  /* Right-click is where a file manager keeps its verbs, so that is where the
     share actions are. A selected asset brings the whole selection; an
     unselected one acts on itself, the same rule the drag uses. */
  const openShareMenu = (event: MouseEvent, assetId: string): void => {
    event.preventDefault();
    const ids = selected.includes(assetId) ? selected : [assetId];
    shareMenu = { x: event.clientX, y: event.clientY, ids };
  };

  const closeShareMenu = (): void => {
    shareMenu = null;
  };

  /* Reads the menu's assets and closes it, in that order. `{@const menu = ...}`
     in the template is a derived view of shareMenu rather than a copy of it, so
     closing first and reading second read from null. */
  const takeMenuIds = (): string[] => {
    const ids = shareMenu?.ids ?? [];
    shareMenu = null;
    return ids;
  };

  /* Right-clicking near the right or bottom edge would otherwise open a menu
     that runs off the screen. Its height depends on how many shares exist, so
     it is measured once it exists rather than estimated. */
  const keepOnScreen = (node: HTMLElement): void => {
    const box = node.getBoundingClientRect();
    const overflowX = box.right - (window.innerWidth - 8);
    const overflowY = box.bottom - (window.innerHeight - 8);
    if (overflowX > 0) node.style.left = `${Math.max(8, box.left - overflowX)}px`;
    if (overflowY > 0) node.style.top = `${Math.max(8, box.top - overflowY)}px`;
    node.focus();
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
    if (
      !(await askConfirm({
        title: `Delete "${node.folder.name}" and every folder inside it?`,
        body: 'Assets in those folders are kept and return to All assets.',
        confirmLabel: 'Delete folder',
        danger: true
      }))
    )
      return;
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
    /* A folder onto itself is a no-op; assets can go anywhere, including the
       root, which is how you get one back out of a folder. */
    const assetDrag = draggingAssets !== null && draggingAssets.length > 0;
    if (!assetDrag && (!dragging || dragging === target)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    dropTarget = target ?? 'root';
  };

  const onDrop = (event: DragEvent, target: string | null): void => {
    event.preventDefault();
    /* Two things can land on a folder: another folder (reparent) and a
       selection of assets (file them). Assets could not be dropped anywhere
       before -- moving one meant opening it -- even though the folder rows were
       already drop targets for folders. */
    const assetIds = draggingAssets;
    const id = dragging;
    dragging = null;
    draggingAssets = null;
    dropTarget = null;
    if (assetIds?.length) {
      void moveAssets(assetIds, target);
      return;
    }
    if (id) void moveFolder(id, target);
  };

  /* Dropping on a share adds; dropping on a folder moves. A share row takes
     assets only -- a folder dragged onto a share means nothing, so it is not
     accepted rather than silently ignored. */
  const onShareDragOver = (event: DragEvent, shareId: string): void => {
    if (!draggingAssets?.length) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    dropTarget = `share:${shareId}`;
  };

  const onShareDrop = (event: DragEvent, shareId: string): void => {
    event.preventDefault();
    const assetIds = draggingAssets;
    draggingAssets = null;
    dropTarget = null;
    if (assetIds?.length) void addToShare(shareId, assetIds);
  };

  /* The assets being dragged, or null. Kept apart from `dragging` (a folder id)
     so a folder drag and an asset drag can never be mistaken for each other. */
  let draggingAssets = $state<string[] | null>(null);

  const beginAssetDrag = (event: DragEvent, id: string): void => {
    /* Dragging an unselected asset drags just that one; dragging a selected one
       brings the whole selection, which is what every file manager does. */
    const ids = selected.includes(id) ? selected : [id];
    draggingAssets = ids;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      /* Something has to be set or Firefox refuses to start the drag. */
      event.dataTransfer.setData('text/plain', ids.join(','));
    }
  };

  const moveAssets = async (ids: string[], folderId: string | null): Promise<void> => {
    try {
      await Promise.all(
        ids.map((id) => apiPatch(`/api/v1/assets/${id}`, { folder_id: folderId }))
      );
      /* Reload rather than patch in place: the visible list is folder-scoped,
         so a moved asset may belong somewhere else now. */
      if (projectId) await loadAssets(projectId);
      selected = [];
      error = '';
    } catch (caught) {
      error = messageFrom(caught, 'Those assets could not be moved.');
    }
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
    selectedShare
      ? (shares.find((share) => share.id === selectedShare)?.title ?? 'Share')
      : selectedFolder
        ? (nodes[selectedFolder]?.folder.name ?? 'Folder')
        : 'All assets'
  );

  /* ---- view mode, sorting, selection ---- */

  const VIEW_KEY = 'onelight.assets.view';
  const initialView = (): 'grid' | 'list' =>
    typeof localStorage !== 'undefined' && localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
  let view = $state<'grid' | 'list'>(initialView());
  const setView = (next: 'grid' | 'list'): void => {
    view = next;
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* Private mode: the toggle still works for this visit. */
    }
  };

  type SortKey = 'name' | 'status' | 'created_at' | 'updated_at';
  let sortKey = $state<SortKey>('created_at');
  let sortDir = $state<1 | -1>(-1);
  const sortBy = (key: SortKey): void => {
    if (sortKey === key) {
      sortDir = sortDir === 1 ? -1 : 1;
    } else {
      sortKey = key;
      sortDir = key === 'name' || key === 'status' ? 1 : -1;
    }
  };
  /* Client-side sort over the pages loaded so far; unloaded pages join the
     order as they arrive via Load more. */
  const sortedAssets = $derived.by(() => {
    const list = [...assets];
    list.sort((a, b) => {
      const left = a[sortKey];
      const right = b[sortKey];
      const compared =
        typeof left === 'string' && typeof right === 'string'
          ? left.localeCompare(right, undefined, { sensitivity: 'base' })
          : Number(left) - Number(right);
      return compared * sortDir || a.id.localeCompare(b.id);
    });
    return list;
  });
  const displayed = $derived(view === 'grid' ? assets : sortedAssets);

  let selected = $state<string[]>([]);
  let anchor = $state<string | null>(null);
  const isSelected = (id: string): boolean => selected.includes(id);

  /* Click opens, hold selects.

     It used to be the other way round: a click selected and only a double-click
     opened, so the obvious gesture on a thumbnail -- click the picture you want
     to watch -- put a blue outline on it and did nothing else. Modifier-clicks
     still select (shift for a range, ctrl/cmd to add), because that is what
     they do everywhere, and holding is the touch-friendly way to get there
     without a keyboard.

     A drag must not become a click or a hold, so any movement past a few pixels
     cancels both. */
  const HOLD_MS = 380;
  const HOLD_SLOP = 6;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let holdFired = false;
  let pressAt: { x: number; y: number } | null = null;

  const cancelHold = (): void => {
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  };

  const onCardPointerDown = (event: PointerEvent, id: string): void => {
    /* Let modifier-clicks and non-primary buttons fall through to select. */
    if (event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey) return;
    holdFired = false;
    pressAt = { x: event.clientX, y: event.clientY };
    cancelHold();
    holdTimer = setTimeout(() => {
      holdFired = true;
      holdTimer = null;
      toggleOne(id);
      /* Confirm the hold on devices that can: without it, a long press feels
         like the app froze. */
      navigator.vibrate?.(8);
    }, HOLD_MS);
  };

  const onCardPointerMove = (event: PointerEvent): void => {
    if (!pressAt) return;
    if (Math.hypot(event.clientX - pressAt.x, event.clientY - pressAt.y) > HOLD_SLOP) {
      pressAt = null;
      cancelHold();
    }
  };

  const onCardPointerUp = (): void => {
    pressAt = null;
    cancelHold();
  };

  const onCardClick = (event: MouseEvent, id: string): void => {
    /* The hold already acted; the click that follows it must not also open. */
    if (holdFired) {
      holdFired = false;
      event.preventDefault();
      return;
    }
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      handleSelect(event, id);
      return;
    }
    /* With a selection running, a plain click keeps picking rather than
       yanking you into a review room mid-multi-select. */
    if (selected.length > 0) {
      toggleOne(id);
      return;
    }
    void goto(assetHref(id));
  };

  const toggleOne = (id: string): void => {
    selected = selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id];
    anchor = id;
  };

  const handleSelect = (event: MouseEvent | KeyboardEvent, id: string): void => {
    if (event.shiftKey && anchor) {
      const order = displayed.map((asset) => asset.id);
      const from = order.indexOf(anchor);
      const to = order.indexOf(id);
      if (from >= 0 && to >= 0) {
        const [low, high] = from < to ? [from, to] : [to, from];
        selected = order.slice(low, high + 1);
        return;
      }
    }
    if (event.ctrlKey || event.metaKey) {
      selected = isSelected(id) ? selected.filter((entry) => entry !== id) : [...selected, id];
      anchor = id;
      return;
    }
    selected = isSelected(id) && selected.length === 1 ? [] : [id];
    anchor = id;
  };

  const toggleAll = (): void => {
    selected = selected.length === displayed.length ? [] : displayed.map((asset) => asset.id);
  };

  const assetHref = (id: string): string => `/projects/${projectId}/assets/${id}`;

  const onItemKeydown = (event: KeyboardEvent, id: string): void => {
    if (event.key === ' ') {
      event.preventDefault();
      handleSelect(event, id);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void goto(assetHref(id));
    }
  };

  const STATUS_LABEL: Record<string, string> = {
    in_review: 'In review',
    approved: 'Approved',
    changes_requested: 'Changes requested'
  };
  const transcodeLabel = (status: string | null): string | null =>
    status === 'pending' || status === 'processing'
      ? 'Processing'
      : status === 'failed'
        ? 'Transcode failed'
        : null;

  /* ---- batch operations ---- */

  let batch = $state<{
    running: boolean;
    label: string;
    done: number;
    total: number;
    errors: Array<{ name: string; message: string }>;
  }>({ running: false, label: '', done: 0, total: 0, errors: [] });
  let moveOpen = $state(false);
  let moveTarget = $state('');
  let folderChoices = $state<Array<{ id: string; name: string; depth: number }>>([]);
  let approvalChoice = $state<'none' | 'in_review' | 'approved' | 'changes_requested'>('approved');

  const nameOf = (id: string): string => assets.find((asset) => asset.id === id)?.name ?? id;

  const runBatch = async (
    label: string,
    ids: string[],
    run: (id: string) => Promise<void>
  ): Promise<void> => {
    if (batch.running) return;
    batch = { running: true, label, done: 0, total: ids.length, errors: [] };
    for (const id of ids) {
      try {
        await run(id);
      } catch (caught) {
        batch.errors.push({ name: nameOf(id), message: messageFrom(caught, 'The operation failed.') });
      }
      batch.done += 1;
    }
    batch = { ...batch, running: false };
  };

  const openMove = async (): Promise<void> => {
    const id = projectId;
    if (!id) return;
    moveOpen = true;
    moveTarget = '';
    /* The move picker needs the whole tree, not just expanded branches. */
    const collected: Array<{ id: string; name: string; depth: number }> = [];
    const walk = async (parent: string | null, depth: number): Promise<void> => {
      const suffix = parent ? `?parent_id=${encodeURIComponent(parent)}` : '';
      const children = (await api<{ items: Folder[] }>(`/api/v1/projects/${id}/folders${suffix}`)).items;
      for (const folder of children) {
        collected.push({ id: folder.id, name: folder.name, depth });
        await walk(folder.id, depth + 1);
      }
    };
    try {
      await walk(null, 0);
      folderChoices = collected;
    } catch (caught) {
      error = messageFrom(caught, 'Folders could not be loaded.');
      moveOpen = false;
    }
  };

  const applyMove = async (): Promise<void> => {
    const ids = [...selected];
    moveOpen = false;
    await runBatch('Moving', ids, async (id) => {
      await apiPatch(`/api/v1/assets/${id}`, { folder_id: moveTarget || null });
    });
    selected = [];
    const id = projectId;
    if (id) await loadAssets(id);
  };

  const applyApproval = async (): Promise<void> => {
    const ids = [...selected];
    await runBatch('Setting status', ids, async (id) => {
      const updated = await apiPatch<Asset>(`/api/v1/assets/${id}/approval`, { status: approvalChoice });
      assets = assets.map((asset) => (asset.id === id ? { ...asset, status: updated.status } : asset));
    });
  };

  const trashSelected = async (): Promise<void> => {
    const ids = [...selected];
    if (
      !(await askConfirm({
        title: `Move ${ids.length === 1 ? nameOf(ids[0]) : `${String(ids.length)} assets`} to trash?`,
        body: 'Trashed assets stop appearing in the project. They are not deleted.',
        confirmLabel: 'Move to trash',
        danger: true
      }))
    )
      return;
    await runBatch('Trashing', ids, async (id) => {
      await apiPost(`/api/v1/assets/${id}/trash`);
    });
    selected = [];
    const id = projectId;
    if (id) await loadAssets(id);
  };

  /* ---- uploads ---- */

  /* A preview of the dropped file, made locally from the File itself -- no
     server, no wait. A queue row that says "Waiting" next to nothing reads as
     "nothing happened"; a row with the frame you just dropped reads as "we have
     it, press Upload". The URLs are revoked when the row goes, or a long
     session leaks a blob per file. */
  const previews = new Map<number, string>();
  const previewFor = (key: number, file: File): string | null => {
    if (!file.type.startsWith('video/') && !file.type.startsWith('image/')) return null;
    const existing = previews.get(key);
    if (existing) return existing;
    const url = URL.createObjectURL(file);
    previews.set(key, url);
    return url;
  };
  const dropPreview = (key: number): void => {
    const url = previews.get(key);
    if (url) {
      URL.revokeObjectURL(url);
      previews.delete(key);
    }
  };

  const enqueue = (files: PendingFile[]): void => {
    const additions = files.map(({ file, relativePath }) => ({
      key: nextKey++,
      file,
      relativePath,
      sessionId: null,
      bytes: 0,
      rate: 0,
      status: 'queued' as const,
      error: '',
      versionOf: null,
      carryForward: true
    }));
    queue = [...queue, ...additions];
  };

  const chooseFiles = (event: Event): void => {
    const input = event.currentTarget as HTMLInputElement;
    if (input.files) enqueue(filesFromInput(input.files));
    input.value = '';
  };

  const onQueueDrop = async (event: DragEvent): Promise<void> => {
    /* Folder-tree drags carry no files; leave them to the tree. */
    if (dragging || !event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    dropActive = false;
    enqueue(await filesFromDataTransfer(event.dataTransfer));
  };

  const onQueueDragOver = (event: DragEvent): void => {
    if (dragging || !event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    dropActive = true;
  };

  /* Drop anywhere on the page, not only on the upload panel.

     Two things made this worth doing properly. Dragging a file onto any part of
     the page that was not the panel did nothing, so the panel had to be found
     first -- and the panel is the smallest thing on the screen. Worse, a file
     dropped on a page with no drop handler makes the browser navigate to it:
     the review page vanishes and is replaced by the .mov you were trying to
     upload. The window guard below is what stops that, drop zone or not.

     A folder-tree drag carries no files and is left to the tree. */
  let pageDropActive = $state(false);
  /* dragenter/leave fire for every child crossed, so a boolean flickers; the
     depth counter only lets go when the pointer has actually left the page. */
  let pageDropDepth = 0;
  const isFileDrag = (event: DragEvent): boolean =>
    !dragging && Boolean(event.dataTransfer?.types.includes('Files'));
  const endPageDrop = (): void => {
    pageDropDepth = 0;
    pageDropActive = false;
  };
  const onPageDragEnter = (event: DragEvent): void => {
    if (!isFileDrag(event)) return;
    pageDropDepth += 1;
    pageDropActive = true;
  };
  const onPageDragOver = (event: DragEvent): void => {
    if (!isFileDrag(event)) return;
    /* Both preventDefaults are required: without the dragover one the drop
       never fires, and the browser opens the file instead. */
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };
  const onPageDragLeave = (event: DragEvent): void => {
    if (!isFileDrag(event)) return;
    pageDropDepth -= 1;
    if (pageDropDepth <= 0) endPageDrop();
  };
  const onPageDrop = async (event: DragEvent): Promise<void> => {
    if (!isFileDrag(event)) {
      /* Not ours, but still stop the browser navigating to a dropped file. */
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
      return;
    }
    event.preventDefault();
    endPageDrop();
    enqueue(await filesFromDataTransfer(event.dataTransfer as DataTransfer));
  };

  /* Resumable upload: the session id stays on the item, so a retry reuses the
     session, skips completed parts, and continues from the failure. Files run
     one at a time, four parts in parallel inside each file. */
  const uploadOne = async (item: UploadItem): Promise<void> => {
    const id = projectId;
    if (!id || item.status === 'uploading' || item.status === 'done' || item.status === 'quarantined') return;
    item.status = 'uploading';
    item.error = '';
    try {
      const sessionId = await uploadFile({
        projectId: id,
        file: item.file,
        relativePath: item.relativePath,
        sessionId: item.sessionId,
        onSession: (session) => {
          item.sessionId = session;
        },
        onProgress: (progress) => {
          item.bytes = progress.bytes;
          item.rate = progress.rate;
        }
      });
      item.sessionId = sessionId;
      if (item.versionOf) {
        await createAssetVersion(item.versionOf, {
          upload_id: sessionId,
          name: item.file.name,
          carry_forward: item.carryForward
        });
        await refreshAsset(item.versionOf);
      } else {
        await apiPost(`/api/v1/projects/${id}/assets`, {
          upload_id: sessionId,
          name: item.file.name,
          ...(selectedFolder ? { folder_id: selectedFolder } : {})
        });
        await loadAssets(id);
      }
      item.rate = 0;
      item.status = 'done';
    } catch (caught) {
      item.rate = 0;
      if (caught instanceof UploadQuarantinedError) {
        item.status = 'quarantined';
        item.error = caught.message;
        return;
      }
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
    for (const item of queue) if (item.status === 'done') dropPreview(item.key);
    queue = queue.filter((item) => item.status !== 'done');
  };

  const hasPending = $derived(queue.some((item) => item.status === 'queued' || item.status === 'failed'));
  const pendingCount = $derived(queue.filter((item) => item.status === 'queued' || item.status === 'failed').length);
  const overall = $derived.by(() => {
    let total = 0;
    let bytes = 0;
    let rate = 0;
    let done = 0;
    for (const item of queue) {
      total += item.file.size;
      bytes += item.status === 'done' ? item.file.size : item.bytes;
      if (item.status === 'uploading') rate += item.rate;
      if (item.status === 'done') done += 1;
    }
    return { total, bytes, rate, done, count: queue.length };
  });
  const versionOptions = $derived(assets.map((asset) => ({ id: asset.id, name: asset.name })));
</script>

<svelte:head><title>{project?.name ?? 'Project'} | Onelight</title></svelte:head>

<!-- Window-level, so a file dropped anywhere lands here instead of the browser
     navigating away from the page to open it. -->
<svelte:window
  ondragenter={onPageDragEnter}
  ondragover={onPageDragOver}
  ondragleave={onPageDragLeave}
  ondrop={onPageDrop}
  ondragend={endPageDrop}
  onscroll={closeShareMenu}
  onkeydown={(event) => { if (event.key === 'Escape') closeShareMenu(); }}
/>

<main class="room" class:pagedrop={pageDropActive} style={`background-image: ${wash};`}>
  {#if pageDropActive}
    <div class="dropveil" aria-hidden="true">
      <div class="dropcard">
        <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
        </svg>
        <strong>Drop to upload</strong>
        <span>Adding to {selectedName}. Folder structure is kept.</span>
      </div>
    </div>
  {/if}
  <header class="wash">
    <div class="washrow">
      <!-- No "Projects" link: the nav bar two rows up already has one, and the
           palette's name was never information -- it labelled a colour the page
           is already painted in. -->
      <h1>{project?.name ?? 'Project'}</h1>
      <span class="grow"></span>
      <a href={`/projects/${projectId}/settings`}>Settings</a>
    </div>
  </header>
  {#if error}
    <p class="error page-error" role="alert">{error}</p>
  {:else}
    <div class="body">
      <aside class="pane" aria-label="Folders and shares">
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

        <!-- Shares sit in the rail beside the folders because that is what they
             are to the person using them: another way the project's media is
             grouped. As a button in the header they were a place you went;
             here they are a place things go, and assets can be dropped
             straight onto one. -->
        <h2 class="pane-label" id="shares-label">Shares</h2>
        <div class="tree" role="list" aria-labelledby="shares-label">
          {#each shares as share (share.id)}
            <div
              class="row"
              class:selected={selectedShare === share.id}
              class:droptarget={dropTarget === `share:${share.id}`}
              role="listitem"
            >
              <button
                type="button"
                class="rowbtn"
                aria-pressed={selectedShare === share.id}
                onclick={() => void selectShare(share.id)}
                ondragover={(event) => onShareDragOver(event, share.id)}
                ondragleave={() => (dropTarget = dropTarget === `share:${share.id}` ? null : dropTarget)}
                ondrop={(event) => onShareDrop(event, share.id)}
              >
                <span class="name">{share.title}</span>
              </button>
              <span class="acts">
                <a class="act" href={`/projects/${projectId}/shares`} onclick={(event) => event.stopPropagation()}>Settings</a>
              </span>
            </div>
          {:else}
            <p class="hint none">No shares yet. Select media and right-click to make one.</p>
          {/each}
        </div>
        {#if shareError}<p class="sharenote" aria-live="polite">{shareError}</p>{/if}
      </aside>

      <section class="main">
        <section
          class="uploader"
          class:dropactive={dropActive}
          aria-label="Upload"
          ondragover={onQueueDragOver}
          ondragleave={() => (dropActive = false)}
          ondrop={onQueueDrop}
        >
          <form class="upload" onsubmit={uploadAll}>
            <span class="upload-label">Add media to {selectedName}</span>
            <label class="filebtn">Add files
              <input type="file" multiple onchange={chooseFiles} />
            </label>
            <label class="filebtn">Add a folder
              <input type="file" webkitdirectory multiple onchange={chooseFiles} />
            </label>
            <button type="submit" class="uploadbtn" class:ready={hasPending && !uploading} disabled={!hasPending || uploading}>
              {#if uploading}Uploading{:else if pendingCount > 0}Upload {pendingCount} {pendingCount === 1 ? 'file' : 'files'}{:else}Upload{/if}
            </button>
            {#if queue.some((item) => item.status === 'done')}
              <button type="button" class="quiet" onclick={clearFinished}>Clear finished</button>
            {/if}
          </form>
          <p class="hint">Drop files or folders anywhere in this panel. Folder structure is kept as each file's relative path.</p>
          {#if queue.length > 1}
            <p class="summary tc" aria-live="polite">
              {overall.done} of {overall.count} files, {formatBytes(overall.bytes)} of {formatBytes(overall.total)}{overall.rate > 0 ? `, ${formatRate(overall.rate)}` : ''}
            </p>
          {/if}
          {#if queue.length > 0}
            <ul class="queue" aria-label="Upload queue">
              {#each queue as item (item.key)}
                {@const preview = previewFor(item.key, item.file)}
                <li class={`q-${item.status}`}>
                  <span class="qthumb" aria-hidden="true">
                    {#if preview && item.file.type.startsWith('video/')}
                      <!-- preload=metadata is enough for a first frame, and does
                           not pull the whole file into memory. -->
                      <video src={preview} preload="metadata" muted playsinline></video>
                    {:else if preview}
                      <img src={preview} alt="" />
                    {/if}
                  </span>
                  <span class="qname">
                    {item.file.name}
                    {#if item.relativePath && item.relativePath !== item.file.name}
                      <span class="qpath">{item.relativePath}</span>
                    {/if}
                  </span>
                  <span class="stackpick">
                    <AssetSelect
                      options={versionOptions}
                      bind:value={item.versionOf}
                      label={`New version of, for ${item.file.name}`}
                      placeholder="New version of..."
                      disabled={item.status !== 'queued' && item.status !== 'failed'}
                    />
                    {#if item.versionOf}
                      <label class="carry">
                        <input type="checkbox" bind:checked={item.carryForward} disabled={item.status !== 'queued' && item.status !== 'failed'} />
                        Carry comments forward
                      </label>
                    {/if}
                  </span>
                  <span
                    class="bar"
                    role="progressbar"
                    aria-valuenow={item.file.size > 0 ? Math.round((item.bytes / item.file.size) * 100) : 0}
                    aria-valuemin="0"
                    aria-valuemax="100"
                  ><span style={`width: ${item.file.size > 0 ? (item.bytes / item.file.size) * 100 : 0}%;`}></span></span>
                  <span class="state tc">
                    {#if item.status === 'queued'}Ready to upload
                    {:else if item.status === 'uploading'}{formatBytes(item.bytes)} of {formatBytes(item.file.size)}{item.rate > 0 ? `, ${formatRate(item.rate)}` : ''}
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
        </section>

        <div class="browser-bar">
          <h2 class="browser-title">{selectedName}</h2>
          <span class="grow"></span>
          <div class="views" role="group" aria-label="View mode">
            <button type="button" class="viewbtn" aria-pressed={view === 'grid'} onclick={() => setView('grid')}>Grid</button>
            <button type="button" class="viewbtn" aria-pressed={view === 'list'} onclick={() => setView('list')}>List</button>
          </div>
        </div>

        {#if selected.length > 0 || batch.running || batch.errors.length > 0}
          <div class="batchbar" aria-live="polite">
            {#if batch.running}
              <span class="tc">{batch.label} {batch.done} of {batch.total}</span>
            {:else if selected.length > 0}
              <span class="tc">{selected.length} selected</span>
              <button type="button" class="quiet" onclick={() => void openMove()}>Move to folder</button>
              <span class="approval">
                <select bind:value={shareChoice} aria-label="Share to add to">
                  <option value="">New share…</option>
                  {#each shares as share (share.id)}
                    <option value={share.id}>{share.title}</option>
                  {/each}
                </select>
                <button
                  type="button"
                  class="quiet"
                  onclick={() =>
                    void (shareChoice ? addToShare(shareChoice, selected) : createShareWith(selected))}
                >
                  {shareChoice ? 'Add to share' : 'Create share'}
                </button>
              </span>
              <span class="approval">
                <select bind:value={approvalChoice} aria-label="Approval status to apply">
                  <option value="none">No status</option>
                  <option value="in_review">In review</option>
                  <option value="approved">Approved</option>
                  <option value="changes_requested">Changes requested</option>
                </select>
                <button type="button" class="quiet" onclick={() => void applyApproval()}>Set status</button>
              </span>
              <button type="button" class="quiet danger" onclick={() => void trashSelected()}>Trash</button>
              <button type="button" class="quiet" onclick={() => { selected = []; anchor = null; }}>Clear</button>
            {/if}
            {#if !batch.running && batch.errors.length > 0}
              <ul class="batch-errors">
                {#each batch.errors as failure, index (index)}
                  <li class="error">{failure.name}: {failure.message}</li>
                {/each}
              </ul>
              <button type="button" class="quiet" onclick={() => (batch = { ...batch, errors: [] })}>Dismiss</button>
            {/if}
          </div>
          {#if moveOpen}
            <div class="movebar">
              <label>Destination
                <select bind:value={moveTarget} aria-label="Destination folder">
                  <option value="">All assets (no folder)</option>
                  {#each folderChoices as choice (choice.id)}
                    <option value={choice.id}>{String.fromCharCode(160).repeat(choice.depth * 3)}{choice.name}</option>
                  {/each}
                </select>
              </label>
              <button type="button" class="quiet" onclick={() => void applyMove()}>Move {selected.length}</button>
              <button type="button" class="quiet" onclick={() => (moveOpen = false)}>Cancel</button>
            </div>
          {/if}
        {/if}

        {#snippet sortHeader(key: SortKey, label: string)}
          <th aria-sort={sortKey === key ? (sortDir === 1 ? 'ascending' : 'descending') : undefined}>
            <button type="button" class="colsort" onclick={() => sortBy(key)}>
              {label}
              {#if sortKey === key}
                <svg class="dir" class:desc={sortDir === -1} viewBox="0 0 8 8" width="8" height="8" aria-hidden="true"><path d="M4 2l3 4H1z" fill="currentColor" /></svg>
              {/if}
            </button>
          </th>
        {/snippet}

        {#if displayed.length === 0}
          <p class="empty">{selectedFolder ? 'No assets in this folder. Drop media above to fill it.' : 'No assets yet. Upload media to start a review.'}</p>
        {:else if view === 'grid'}
          <div class="grid" role="listbox" aria-multiselectable="true" aria-label="Assets">
            {#each displayed as asset (asset.id)}
              {@const entry = media.entries[asset.id]}
              {@const detail = entry?.media}
              <div
                class="card"
                class:picked={isSelected(asset.id)}
                role="option"
                aria-selected={isSelected(asset.id)}
                tabindex="0"
                draggable="true"
                use:observeMedia={asset}
                ondragstart={(event) => beginAssetDrag(event, asset.id)}
                ondragend={() => { draggingAssets = null; dropTarget = null; }}
                onpointerdown={(event) => onCardPointerDown(event, asset.id)}
                onpointermove={onCardPointerMove}
                onpointerup={onCardPointerUp}
                onpointercancel={onCardPointerUp}
                onclick={(event) => onCardClick(event, asset.id)}
                oncontextmenu={(event) => openShareMenu(event, asset.id)}
                onkeydown={(event) => onItemKeydown(event, asset.id)}
              >
                <ScrubThumb
                  poster={detail?.posterUrl ?? null}
                  sprite={detail?.spriteUrl ?? null}
                  spriteVtt={detail?.spriteVttUrl ?? null}
                  alt=""
                />
                <div class="card-line">
                  <a
                    class="card-name"
                    href={assetHref(asset.id)}
                    onclick={(event) => event.stopPropagation()}
                  >{asset.name}</a>
                  {#if detail && detail.versionCount > 1}
                    <span class="vbadge tc" title={`${detail.versionCount} versions`}>v{detail.versionCount}</span>
                  {/if}
                </div>
                <div class="card-meta">
                  {#if STATUS_LABEL[asset.status]}
                    <span class={`chip s-${asset.status}`}>{STATUS_LABEL[asset.status]}</span>
                  {/if}
                  {#if transcodeLabel(detail?.transcodeStatus ?? null)}
                    <span class="chip t-{detail?.transcodeStatus}">{transcodeLabel(detail?.transcodeStatus ?? null)}</span>
                  {/if}
                  <span class="kind">{asset.kind}</span>
                </div>
              </div>
            {/each}
          </div>
        {:else}
          <table class="list" aria-label="Assets">
            <thead>
              <tr>
                <th class="sel">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={displayed.length > 0 && selected.length === displayed.length}
                    indeterminate={selected.length > 0 && selected.length < displayed.length}
                    onchange={toggleAll}
                  />
                </th>
                {@render sortHeader('name', 'Name')}
                {@render sortHeader('status', 'Status')}
                <th>Versions</th>
                {@render sortHeader('created_at', 'Created')}
                {@render sortHeader('updated_at', 'Updated')}
              </tr>
            </thead>
            <tbody>
              {#each displayed as asset (asset.id)}
                {@const entry = media.entries[asset.id]}
                {@const detail = entry?.media}
                <tr
                  class:picked={isSelected(asset.id)}
                  tabindex="0"
                  draggable="true"
                  use:observeMedia={asset}
                  ondragstart={(event) => beginAssetDrag(event, asset.id)}
                  ondragend={() => { draggingAssets = null; dropTarget = null; }}
                  onpointerdown={(event) => onCardPointerDown(event, asset.id)}
                  onpointermove={onCardPointerMove}
                  onpointerup={onCardPointerUp}
                  onpointercancel={onCardPointerUp}
                  onclick={(event) => onCardClick(event, asset.id)}
                  oncontextmenu={(event) => openShareMenu(event, asset.id)}
                  onkeydown={(event) => onItemKeydown(event, asset.id)}
                >
                  <td class="sel">
                    <input
                      type="checkbox"
                      aria-label={`Select ${asset.name}`}
                      checked={isSelected(asset.id)}
                      onclick={(event) => event.stopPropagation()}
                      onchange={() => {
                        selected = isSelected(asset.id)
                          ? selected.filter((entry_) => entry_ !== asset.id)
                          : [...selected, asset.id];
                        anchor = asset.id;
                      }}
                    />
                  </td>
                  <td class="namecell">
                    <!-- A list of filenames tells you nothing about the
                         footage. The poster is small enough to keep the row a
                         row, and it is the same image the grid already has. -->
                    <span class="rowthumb" aria-hidden="true">
                      {#if detail?.posterUrl}
                        <img src={detail.posterUrl} alt="" loading="lazy" />
                      {/if}
                    </span>
                    <a href={assetHref(asset.id)} onclick={(event) => event.stopPropagation()}>{asset.name}</a>
                  </td>
                  <td>
                    {#if STATUS_LABEL[asset.status]}
                      <span class={`chip s-${asset.status}`}>{STATUS_LABEL[asset.status]}</span>
                    {/if}
                    {#if transcodeLabel(detail?.transcodeStatus ?? null)}
                      <span class="chip t-{detail?.transcodeStatus}">{transcodeLabel(detail?.transcodeStatus ?? null)}</span>
                    {/if}
                  </td>
                  <td class="tc">{detail ? detail.versionCount : ''}</td>
                  <td class="tc" title={whenAbsolute(asset.created_at)}>{whenRelative(asset.created_at)}</td>
                  <td class="tc" title={whenAbsolute(asset.updated_at)}>{whenRelative(asset.updated_at)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
          <p class="hint">Sorting orders the {assets.length} loaded assets; load more to include the rest.</p>
        {/if}
        {#if nextCursor}
          <button type="button" class="quiet more" onclick={() => void loadMoreAssets()} disabled={loadingMore}>
            {loadingMore ? 'Loading' : 'Load more'}
          </button>
        {/if}
        {#if displayed.length > 0}
          <p class="hint">Click opens, hold selects. Ctrl-click adds, Shift-click extends, right-click shares.</p>
        {/if}
      </section>
    </div>
  {/if}
</main>

<!-- Right-click menu. Positioned at the pointer and dismissed by the next
     click anywhere, Escape, or a scroll -- a menu that outlives its context is
     worse than no menu. -->
{#if shareMenu}
  {@const menu = shareMenu}
  <div
    class="menuveil"
    role="presentation"
    onclick={closeShareMenu}
    oncontextmenu={(event) => { event.preventDefault(); closeShareMenu(); }}
  ></div>
  <div
    class="ctxmenu"
    role="menu"
    tabindex="-1"
    aria-label="Asset actions"
    style={`left: ${menu.x}px; top: ${menu.y}px;`}
    use:keepOnScreen
  >
    <p class="ctxhead">{menu.ids.length} {menu.ids.length === 1 ? 'item' : 'items'}</p>
    {#each shares as share (share.id)}
      <button type="button" role="menuitem" onclick={() => void addToShare(share.id, takeMenuIds())}>
        Add to {share.title}
      </button>
    {/each}
    <button type="button" role="menuitem" onclick={() => void createShareWith(takeMenuIds())}>
      New share…
    </button>
  </div>
{/if}

<style>
  /* App world: dark ink base, the project's palette as the header wash.
     Separation by value step and space, not borders. */
  /* The palette washes the whole room, not a band across the top. It used to be
     a header-only strip showing the top third of the gradient (100% 300% at
     50% 0%), so a project's colour was a stripe you scrolled past. Fixed
     attachment holds the wash still while content moves over it.

     The veil is not decoration. Every palette runs dark to light by design, so
     a full-height wash ends in cream -- and this is a dark app whose body text
     is --ink-text. Washing the page without it turned the lower half into light
     grey on cream. The veil stays clear at the top, where the wash does its
     work behind the title, and deepens to near-ink by the content, so colour
     reaches the whole page and text contrast never depends on where in the
     gradient a paragraph happens to land. */
  .room { position: relative; min-height: calc(100vh - var(--topbar-h, 0px)); background-color: var(--ink-000); background-size: 100% 100%; background-attachment: fixed; color: var(--ink-text); font-size: var(--text-13); }
  .room::before { content: ''; position: fixed; inset: 0; pointer-events: none; background: linear-gradient(180deg, rgba(13, 17, 23, 0.05) 0%, rgba(13, 17, 23, 0.45) 26%, rgba(13, 17, 23, 0.88) 58%, rgba(13, 17, 23, 0.95) 100%); }
  .room > :global(*) { position: relative; }
  .wash { padding: var(--pad-3) var(--pad-4) var(--pad-4); }
  .washrow { display: flex; gap: 16px; align-items: baseline; }
  .washrow a { color: rgba(250, 248, 244, 0.72); font-size: var(--text-13); text-decoration: none; }
  .washrow a:hover { color: rgba(250, 248, 244, 0.96); }
  .grow { flex: 1; }
  .eyebrow { margin: var(--pad-3) 0 0; color: rgba(250, 248, 244, 0.62); font-size: var(--text-13); font-weight: 500; }
  h1 { margin: 4px 0 0; font-family: var(--font-display); font-size: clamp(2rem, 5vw, var(--text-56)); font-weight: 700; letter-spacing: -0.02em; color: rgba(250, 248, 244, 0.96); }
  /* No max-width. On a 2560px display this page was a 1400px strip with a
     third of the screen empty beside it, while the asset grid -- the thing you
     came for -- wrapped at four across. The folder pane stays a fixed column;
     everything else it does not need goes to the assets. */
  .body { padding: var(--pad-3) var(--pad-4) var(--pad-4); display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: var(--pad-4); align-items: start; }
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
  .act { border: 0; border-radius: 2px; background: none; color: var(--ink-text-dim); padding: 2px 6px; font-size: var(--text-13); }
  .act:hover { background: var(--ink-300); color: var(--ink-text); }
  .rename { flex: 1; min-width: 0; border: 0; border-radius: 2px; background: var(--ink-300); color: var(--ink-text); padding: 3px 6px; font-size: var(--text-13); }
  /* A share row is a button so the keyboard and the drop target are the same
     element; the tree rows above it are div treeitems because they carry the
     tree's own roving-tabindex keyboard model. */
  .rowbtn { flex: 1; min-width: 0; display: flex; align-items: center; border: 0; background: none; color: inherit; padding: 0; font: inherit; text-align: left; }
  .rowbtn:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: 2px; }
  #shares-label { margin-top: 20px; }
  .hint.none { margin-top: 0; }
  .sharenote { margin: 8px 0 0; color: var(--ink-text-dim); font-size: var(--text-12); }
  a.act { text-decoration: none; }
  .newfolder { display: flex; gap: 6px; margin-top: 14px; }
  .newfolder input { flex: 1; min-width: 0; border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 8px 10px; font-size: var(--text-13); }
  .newfolder input::placeholder { color: var(--ink-text-dim); }
  .hint { margin: 12px 0 0; color: var(--ink-text-dim); font-size: var(--text-13); }

  /* ---- uploader ---- */
  .uploader { border-radius: var(--radius-lg); padding: 14px; margin: -14px -14px var(--pad-2); }
  /* A panel, not a boxed-in region. The hairline outline read as a stray border
     around nothing; separation here comes from a value step, like everywhere
     else in this app, and the drop state is the only time an edge appears --
     when an edge is actually saying something. */
  .uploader { border-radius: var(--radius-lg); background: var(--ink-100); box-shadow: none; transition: background 120ms ease, box-shadow 120ms ease; }
  .uploader:hover { background: var(--ink-150, var(--ink-100)); }
  .uploader.dropactive { background: var(--ink-200); box-shadow: inset 0 0 0 2px var(--accent); }

  /* The thing to press next should look like it. */
  .uploadbtn.ready { background: var(--accent); color: #0b1214; box-shadow: 0 0 0 4px rgba(72, 146, 155, 0.18); }
  .uploadbtn.ready:hover { background: var(--accent-bright); }

  .qthumb { flex: none; width: 52px; height: 30px; border-radius: 2px; overflow: hidden; background: var(--ink-200); display: grid; place-items: center; }
  .qthumb video, .qthumb img { width: 100%; height: 100%; object-fit: cover; display: block; }

  /* Dragging over the page: one obvious target, nowhere to miss. */
  .menuveil { position: fixed; inset: 0; z-index: 60; }
  .ctxmenu { position: fixed; z-index: 61; min-width: 200px; max-height: 60vh; overflow-y: auto; display: grid; gap: 1px; padding: 4px; border-radius: var(--radius); background: var(--ink-100); box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5); }
  .ctxmenu button { border: 0; border-radius: 2px; background: none; color: var(--ink-text); padding: 7px 10px; font-size: var(--text-13); text-align: left; }
  .ctxmenu button:hover { background: var(--ink-300); }
  .ctxhead { margin: 0; padding: 6px 10px; color: var(--ink-text-dim); font-size: var(--text-12); }
  .ctxmenu:focus-visible { outline: none; }

  .dropveil { position: fixed; inset: 0; z-index: 40; display: grid; place-items: center; background: rgba(5, 8, 12, 0.72); pointer-events: none; }
  .dropcard { display: grid; justify-items: center; gap: 8px; padding: 28px 40px; border-radius: var(--radius-lg); background: var(--ink-100); color: var(--ink-text); box-shadow: inset 0 0 0 2px var(--accent); }
  .dropcard strong { font-size: var(--text-20); font-weight: 600; }
  .dropcard span { color: var(--ink-text-dim); font-size: var(--text-13); }
  .dropcard svg { color: var(--accent-bright); }
  .upload { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  .upload-label { color: var(--ink-text-dim); margin-right: 4px; }
  /* The native file input stays in the tree for keyboard and screen reader
     use but is visually replaced by the label styled as a quiet button. */
  .filebtn { position: relative; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 9px 16px; font-size: var(--text-13); font-weight: 500; cursor: pointer; }
  .filebtn:hover { background: var(--ink-300); }
  .filebtn:focus-within { outline: 1px solid var(--accent); outline-offset: 2px; }
  .filebtn input { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  button { border: 0; border-radius: var(--radius); background: var(--accent); color: #0b1214; padding: 9px 16px; font-size: var(--text-13); font-weight: 600; }
  button:hover { background: var(--accent-bright); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.quiet { background: var(--ink-200); color: var(--ink-text); font-weight: 500; }
  button.quiet:hover { background: var(--ink-300); }
  button.danger { color: var(--warn); }
  .summary { margin: 12px 0 0; color: var(--ink-text-dim); font-variant-numeric: tabular-nums; }
  .queue { list-style: none; margin: var(--pad) 0 0; padding: 0; display: grid; gap: 2px; }
  .queue li { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 10px 12px; border-radius: var(--radius); background: var(--ink-100); }
  .qname { flex: 1; min-width: 160px; font-weight: 500; display: grid; gap: 2px; }
  .qpath { color: var(--ink-text-dim); font-size: var(--text-13); font-weight: 400; overflow-wrap: anywhere; }
  .stackpick { flex: none; width: 220px; display: grid; gap: 6px; }
  .carry { display: flex; align-items: center; gap: 8px; color: var(--ink-text-dim); font-size: var(--text-13); }
  .carry input { accent-color: var(--accent); margin: 0; }
  .queue .bar { flex: 2; min-width: 120px; height: 3px; border-radius: 2px; background: var(--ink-200); overflow: hidden; display: block; }
  .queue .bar span { display: block; height: 100%; background: var(--accent); }
  .queue .state { min-width: 80px; color: var(--ink-text-dim); font-variant-numeric: tabular-nums; }
  li.q-done .state { color: var(--ok); }
  li.q-quarantined .state { color: var(--warn); font-weight: 600; }
  li.q-quarantined { background: var(--ink-200); }
  li.q-failed .state { color: var(--warn); }

  /* ---- browser chrome ---- */
  .browser-bar { display: flex; align-items: center; gap: 14px; margin-top: var(--pad-2); }
  .browser-title { margin: 0; font-size: var(--text-14); font-weight: 600; }
  .views { display: flex; gap: 2px; }
  .viewbtn { background: var(--ink-100); color: var(--ink-text-dim); font-weight: 500; padding: 6px 12px; }
  .viewbtn:hover { background: var(--ink-200); color: var(--ink-text); }
  .viewbtn[aria-pressed='true'] { background: var(--ink-300); color: var(--ink-text); }
  .batchbar { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 12px; padding: 10px 12px; border-radius: var(--radius); background: var(--ink-200); }
  .batchbar .tc { font-variant-numeric: tabular-nums; font-weight: 500; }
  .batchbar select, .movebar select { border: 0; border-radius: var(--radius); background: var(--ink-300); color: var(--ink-text); padding: 7px 9px; font-size: var(--text-13); }
  .approval { display: inline-flex; gap: 6px; align-items: center; }
  .batch-errors { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; flex-basis: 100%; }
  .movebar { display: flex; align-items: end; gap: 10px; margin-top: 6px; padding: 10px 12px; border-radius: var(--radius); background: var(--ink-100); }
  .movebar label { display: grid; gap: 6px; color: var(--ink-text-dim); font-size: var(--text-13); font-weight: 500; min-width: 220px; }

  /* ---- grid ---- */
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 14px; margin-top: var(--pad-2); }
  .card { cursor: pointer; }
  /* List rows carry the same poster the grid does, at row height. */
  .namecell { display: flex; align-items: center; gap: 10px; }
  .rowthumb { flex: none; width: 44px; height: 26px; border-radius: 2px; overflow: hidden; background: var(--ink-200); }
  .rowthumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .card { display: grid; gap: 8px; padding: 8px; margin: -8px; border-radius: var(--radius-lg); }
  .card:hover { background: var(--ink-100); }
  .card.picked { background: var(--ink-200); }
  .card:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: -1px; }
  .card-line { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .card-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-text); font-weight: 500; font-size: var(--text-13); text-decoration: none; }
  .card-name:hover { color: var(--accent-bright); }
  .vbadge { flex: none; padding: 1px 6px; border-radius: 8px; background: var(--ink-300); color: var(--ink-text); font-size: var(--text-12); font-weight: 600; font-variant-numeric: tabular-nums; }
  .card-meta { display: flex; align-items: center; gap: 8px; min-height: 18px; }
  .kind { color: var(--ink-text-dim); font-size: var(--text-13); }
  .chip { padding: 1px 7px; border-radius: 8px; background: var(--ink-200); font-size: var(--text-12); font-weight: 500; }
  .chip.s-approved { color: var(--ok); }
  .chip.s-in_review { color: var(--info); }
  .chip.s-changes_requested { color: var(--note); }
  .chip.t-pending, .chip.t-processing { color: var(--ink-text-dim); }
  .chip.t-failed { color: var(--warn); }

  /* ---- list ---- */
  table.list { width: 100%; border-collapse: collapse; margin-top: var(--pad-2); font-size: var(--text-13); }
  table.list th { text-align: left; padding: 6px 10px; color: var(--ink-text-dim); font-weight: 500; }
  table.list th.sel, table.list td.sel { width: 28px; padding-right: 0; }
  .colsort { background: none; color: var(--ink-text-dim); padding: 0; font-size: var(--text-13); font-weight: 500; display: inline-flex; align-items: center; gap: 5px; }
  .colsort:hover { background: none; color: var(--ink-text); }
  .dir { flex: none; }
  .dir.desc { transform: rotate(180deg); }
  table.list td { padding: 10px; }
  table.list tbody tr { border-radius: var(--radius); }
  table.list tbody tr:nth-child(odd) { background: var(--ink-100); }
  table.list tbody tr:hover { background: var(--ink-200); }
  table.list tbody tr.picked { background: var(--ink-300); }
  table.list tbody tr:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: -1px; }
  .namecell a { color: var(--ink-text); font-weight: 500; text-decoration: none; }
  .namecell a:hover { color: var(--accent-bright); }
  td.tc, .state.tc, .summary.tc { font-variant-numeric: tabular-nums; }
  input[type='checkbox'] { accent-color: var(--accent); margin: 0; }

  .more { margin-top: var(--pad-2); }
  .empty { color: var(--ink-text-dim); margin-top: var(--pad-2); }
  .error { color: var(--warn); }
  .page-error { padding: var(--pad-3) var(--pad-4); }
  button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
</style>
