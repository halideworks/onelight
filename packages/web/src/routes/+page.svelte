<script lang="ts">
  import { goto } from '$app/navigation';
  import { api, apiDelete, apiPatch, createProject, getBootstrap, messageFrom } from '$lib/api.js';
  import { auth } from '$lib/auth.svelte.js';
  import { askConfirm, askText } from '$lib/confirm.svelte.js';
  import { notifications } from '$lib/notifications.svelte.js';
  import { whenAbsolute, whenRelative } from '$lib/format.js';
  import { triggerDownload } from '$lib/downloads.js';
  import ProjectCover from '$lib/ProjectCover.svelte';
  import ProjectMembers from '$lib/ProjectMembers.svelte';
  import { pretty } from '$lib/ids.js';
  import { pageWashFor } from '$lib/washes.js';
  import { grainLayer } from '$lib/grain.js';
  import HeroWash from '$lib/HeroWash.svelte';
  import Player from '@onelight/player/Player.svelte';
  import Slider from '@onelight/player/Slider.svelte';

  type Project = {
    id: string;
    public_id: string;
    name: string;
    status: string;
    palette: string;
    restricted?: boolean;
    cover_url?: string | null;
    my_role?: string;
    created_at: number;
    updated_at: number;
    /* Older servers do not send it; the sort falls back rather than sorting
       everything into one heap. */
    last_activity_at?: number;
  };
  let projects = $state<Project[]>([]);
  let archived = $state<Project[]>([]);
  let listError = $state('');
  let busy = $state(false);

  /* The archive is a second room, not a filter chip: archived projects are out
     of the way by default and looked at deliberately. */
  let showArchived = $state(false);
  const shelf = $derived(showArchived ? archived : projects);

  let filter = $state('');
  type SortKey = 'activity' | 'name' | 'created';
  let sortKey = $state<SortKey>('activity');
  let sortDir = $state<'asc' | 'desc'>('desc');
  const SORT_LABELS: Record<SortKey, string> = {
    activity: 'Recently edited',
    name: 'Name',
    created: 'Created'
  };

  const activityOf = (project: Project): number =>
    project.last_activity_at ?? project.updated_at ?? project.created_at ?? 0;

  const displayed = $derived.by(() => {
    const needle = filter.trim().toLowerCase();
    const rows = needle
      ? shelf.filter((project) => project.name.toLowerCase().includes(needle))
      : [...shelf];
    const sign = sortDir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      if (sortKey === 'name') return sign * a.name.localeCompare(b.name);
      if (sortKey === 'created') return sign * (a.created_at - b.created_at);
      return sign * (activityOf(a) - activityOf(b));
    });
    return rows;
  });

  /* Grid or list, remembered per user: a wall of thumbnails is right for a few
     projects, a list is right for forty. */
  const VIEW_KEY = 'onelight.projects.view';
  let view = $state<'grid' | 'list'>('grid');
  $effect(() => {
    try {
      if (localStorage.getItem(VIEW_KEY) === 'list') view = 'list';
    } catch {
      /* Storage can be unavailable; the default view stands. */
    }
  });
  /* How big a project card is, remembered per person: the same control the
     asset grid has, for the same reason.
     The size is a width in pixels and it moves continuously. It used to be an
     index into four fixed sizes, which made the grid lurch between four
     layouts; a size control should answer the hand. */
  const SIZE_KEY = 'onelight.projects.cardsize';
  const CARD_MIN = 140;
  const CARD_MAX = 420;
  const CARD_DEFAULT = 220;
  /* What the four old steps meant, so a stored index becomes the width it
     used to draw rather than a card 2px wide. */
  const LEGACY_SIZES = [150, 220, 300, 400];
  let cardSize = $state(CARD_DEFAULT);
  $effect(() => {
    try {
      const stored = Number(localStorage.getItem(SIZE_KEY));
      if (!Number.isFinite(stored)) return;
      if (Number.isInteger(stored) && stored >= 0 && stored < LEGACY_SIZES.length)
        cardSize = LEGACY_SIZES[stored] ?? CARD_DEFAULT;
      else if (stored >= CARD_MIN && stored <= CARD_MAX) cardSize = stored;
    } catch {
      /* Storage can be unavailable; the default size stands. */
    }
  });
  const setSize = (next: number): void => {
    cardSize = Math.round(next);
  };
  /* Written on release, not on every pointer move: a drag across the range
     is one decision, not two hundred writes to localStorage. */
  const commitSize = (next: number): void => {
    cardSize = Math.round(next);
    try {
      localStorage.setItem(SIZE_KEY, String(cardSize));
    } catch {
      /* Non-persistent, still applied for the session. */
    }
  };

  const setView = (next: 'grid' | 'list'): void => {
    view = next;
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* Non-persistent, still applied for the session. */
    }
  };
  /* The layout owns session hydration (one GET /auth/session). Load projects
     once it reports a signed-in session, exactly once. */
  let projectsLoaded = false;
  /* "Loading" and "loaded, empty" are different truths: the empty-state line
     must never flash while the shelves are still on their way. */
  let shelvesLoaded = $state(false);

  let newProjectName = $state('');
  let creating = $state(false);
  let createError = $state('');

  /* The setup door exists only while the workspace has no users: once set
     up, a signed-out landing offers Sign in and nothing else. */
  let setupRequired = $state(false);
  $effect(() => {
    if (auth.ready && !auth.signedIn)
      void getBootstrap().then(
        (bootstrap) => (setupRequired = bootstrap.setup_required),
        () => {},
      );
  });

  /* Every page of both shelves: a projects list that stops at fifty and says
     nothing is a list that lies about what you own. */
  const fetchShelf = async (status: 'active' | 'archived'): Promise<Project[]> => {
    const items: Project[] = [];
    let cursor: string | null = null;
    for (;;) {
      const query = new URLSearchParams({ status, limit: '200' });
      if (cursor) query.set('cursor', cursor);
      const page: { items: Project[]; next_cursor: string | null } = await api(
        `/api/v1/projects?${query.toString()}`
      );
      items.push(...page.items);
      if (!page.next_cursor) return items;
      cursor = page.next_cursor;
    }
  };

  const reload = async (): Promise<void> => {
    try {
      const [active, shelved] = await Promise.all([fetchShelf('active'), fetchShelf('archived')]);
      projects = active;
      archived = shelved;
      listError = '';
    } catch (caught) {
      listError = messageFrom(caught, 'The projects could not be loaded.');
    } finally {
      shelvesLoaded = true;
    }
  };

  $effect(() => {
    if (!auth.ready || !auth.signedIn || projectsLoaded) return;
    projectsLoaded = true;
    void reload();
  });

  /* ---- selection: click opens, hold selects. The asset grid taught these
          gestures; a projects list that behaved differently would be a second
          set of rules for the same picture-in-a-grid. ---- */
  let selected = $state<string[]>([]);
  let anchor = $state<string | null>(null);
  const isSelected = (id: string): boolean => selected.includes(id);
  const selectedProjects = $derived(displayed.filter((project) => isSelected(project.id)));
  /* Leaving the shelf, or filtering a card out from under a selection, must
     not leave invisible items selected and armed for a delete. */
  $effect(() => {
    const visible = new Set(displayed.map((project) => project.id));
    if (selected.some((id) => !visible.has(id)))
      selected = selected.filter((id) => visible.has(id));
  });

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

  const toggleOne = (id: string): void => {
    selected = isSelected(id) ? selected.filter((entry) => entry !== id) : [...selected, id];
    anchor = id;
  };

  const onCardPointerDown = (event: PointerEvent, id: string): void => {
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

  const handleSelect = (event: MouseEvent, id: string): void => {
    if (event.shiftKey && anchor) {
      const order = displayed.map((project) => project.id);
      const from = order.indexOf(anchor);
      const to = order.indexOf(id);
      if (from >= 0 && to >= 0) {
        const [low, high] = from < to ? [from, to] : [to, from];
        selected = order.slice(low, high + 1);
        return;
      }
    }
    if (event.ctrlKey || event.metaKey) {
      toggleOne(id);
      return;
    }
    selected = isSelected(id) && selected.length === 1 ? [] : [id];
    anchor = id;
  };

  const onCardClick = (event: MouseEvent, project: Project): void => {
    /* The hold already acted; the click that follows it must not also open. */
    if (holdFired) {
      holdFired = false;
      event.preventDefault();
      return;
    }
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      event.preventDefault();
      handleSelect(event, project.id);
      return;
    }
    /* With a selection running, a plain click keeps picking rather than
       yanking you into a project mid-multi-select. */
    if (selected.length > 0) {
      event.preventDefault();
      toggleOne(project.id);
      return;
    }
    void notifications.markProjectRead(project.id);
  };

  /* ---- the right-click menu ---- */
  let menu = $state<{ x: number; y: number; ids: string[] } | null>(null);
  const closeMenu = (): void => {
    menu = null;
  };
  const openMenu = (event: MouseEvent, id: string): void => {
    event.preventDefault();
    /* Right-clicking outside the selection acts on what you pointed at; inside
       it, on all of it. Anything else silently drops the other cards. */
    if (!isSelected(id)) {
      selected = [id];
      anchor = id;
    }
    menu = { x: event.clientX, y: event.clientY, ids: [...selected] };
  };
  const takeMenu = (): string[] => {
    const ids = menu?.ids ?? [];
    closeMenu();
    return ids;
  };
  const keepOnScreen = (node: HTMLElement): void => {
    const box = node.getBoundingClientRect();
    const overflowX = box.right - (window.innerWidth - 8);
    const overflowY = box.bottom - (window.innerHeight - 8);
    if (overflowX > 0) node.style.left = `${Math.max(8, box.left - overflowX)}px`;
    if (overflowY > 0) node.style.top = `${Math.max(8, box.top - overflowY)}px`;
    node.focus();
  };

  const byId = (id: string): Project | undefined =>
    projects.find((project) => project.id === id) ?? archived.find((project) => project.id === id);
  const nameOf = (id: string): string => byId(id)?.name ?? 'this project';
  const canManage = (project: Project | undefined): boolean =>
    project?.my_role === 'manager' || auth.user?.role === 'admin';

  /* ---- the verbs ---- */
  const setStatus = async (ids: string[], status: 'active' | 'archived'): Promise<void> => {
    if (ids.length === 0 || busy) return;
    busy = true;
    try {
      for (const id of ids) await apiPatch(`/api/v1/projects/${id}`, { status });
      selected = [];
      await reload();
    } catch (caught) {
      listError = messageFrom(caught, 'That change could not be saved.');
    } finally {
      busy = false;
    }
  };

  const download = (ids: string[]): void => {
    /* One zip per project, spaced out: the endpoint streams a project at a
       time, and browsers allow the first programmatic download freely then ask
       once about the rest. An <a download> rather than a navigation, so a
       failure lands in the download manager instead of replacing the page. */
    for (const [index, id] of ids.entries())
      setTimeout(() => triggerDownload(`/api/v1/projects/${id}/zip`), index * 900);
  };

  const removeProjects = async (ids: string[]): Promise<void> => {
    if (ids.length === 0 || busy) return;
    /* No trash for projects: this cascades through every asset, version, note
       and share in them. Typing the name is the only guard that survives an
       accidental double-click, so the single-project case asks for it. */
    if (ids.length === 1) {
      const name = nameOf(ids[0] as string);
      const typed = await askText({
        title: `Delete ${name}?`,
        body: 'Every asset, version, note and share in this project is deleted with it, and there is no trash to fetch them back from. Type the project name to confirm.',
        label: 'Project name',
        confirmLabel: 'Delete forever',
        danger: true
      });
      if (typed?.trim() !== name) return;
    } else {
      const confirmed = await askConfirm({
        title: `Delete ${ids.length} projects?`,
        body: 'Every asset, version, note and share in them is deleted too. There is no trash to fetch them back from.',
        confirmLabel: `Delete ${ids.length} projects forever`,
        danger: true
      });
      if (!confirmed) return;
    }
    busy = true;
    try {
      for (const id of ids) await apiDelete(`/api/v1/projects/${id}`);
      selected = [];
      await reload();
    } catch (caught) {
      listError = messageFrom(caught, 'That project could not be deleted.');
    } finally {
      busy = false;
    }
  };

  /* ---- people, without leaving the list ---- */
  let peopleFor = $state<Project | null>(null);
  let peopleDialog = $state<HTMLDialogElement | null>(null);
  $effect(() => {
    if (peopleFor && !peopleDialog?.open) peopleDialog?.showModal();
    else if (!peopleFor && peopleDialog?.open) peopleDialog.close();
  });

  /* ---- notification badges ---- */
  const unreadFor = (id: string): number => notifications.unreadByProject[id] ?? 0;
  const clearBadge = async (event: MouseEvent, id: string): Promise<void> => {
    event.preventDefault();
    event.stopPropagation();
    await notifications.markProjectRead(id);
  };

  /* Name is the only required field: the server round-robins the palette and
     enrols the creator as manager. */
  const create = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const name = newProjectName.trim();
    if (!name || creating) return;
    creating = true;
    createError = '';
    try {
      const project = await createProject({ name });
      await goto(`/projects/${pretty(project.public_id, project.name)}`);
    } catch (caught) {
      createError = messageFrom(caught, 'The project could not be created.');
      creating = false;
    }
  };

  /* The signed-out landing carries the full wash, dark into the light
     terminal at the very bottom edge, with the cover grammar's placed
     light; content stays on the dark two thirds. The CSS wash is the
     ground truth; the shader canvas covers it with the same ramp when
     WebGL is available. */
  let demoPlayer = $state<{ seekToFrame: (frame: number) => void } | undefined>();
  const DEMO_FRAME = 90;
  /* Land on the annotated frame once the media can actually seek: retry
     until the player reports it, stop the moment the viewer drives. */
  let demoLanded = false;
  let demoTouched = false;
  $effect(() => {
    if (!auth.ready || auth.signedIn) return;
    const timer = setInterval(() => {
      if (demoLanded || demoTouched) {
        clearInterval(timer);
        return;
      }
      demoPlayer?.seekToFrame(DEMO_FRAME);
    }, 350);
    return () => clearInterval(timer);
  });
  /* One note per drawing tool, each in its author's ink. */
  const DEMO_NOTES = [
    {
      frame: 45,
      ink: '#8fca6a',
      tc: '00:00:01:15',
      text: 'Sign catches a specular. Matte it down.',
      strokes: [
        {
          tool: 'arrow' as const,
          color: '#8fca6a',
          width: 0.004,
          points: [
            [0.3, 0.12],
            [0.52, 0.24]
          ] as Array<[number, number]>
        }
      ]
    },
    {
      frame: 90,
      ink: '#6aa5d8',
      tc: '00:00:03:00',
      text: 'Cape lining drifts magenta. Pull it toward the wall red.',
      strokes: [
        {
          tool: 'ellipse' as const,
          color: '#6aa5d8',
          width: 0.004,
          points: [
            [0.42, 0.4],
            [0.72, 0.88]
          ] as Array<[number, number]>
        }
      ]
    },
    {
      frame: 260,
      ink: '#d477a2',
      tc: '00:00:08:20',
      text: 'Hold this transmission card eight more frames.',
      strokes: [
        {
          tool: 'text' as const,
          color: '#d477a2',
          width: 0.05,
          text: 'HOLD +8',
          points: [[0.08, 0.16]] as Array<[number, number]>
        }
      ]
    },
    {
      frame: 320,
      ink: '#d8a069',
      tc: '00:00:10:20',
      text: 'Shadows crush at the derrick. Lift the floor a touch.',
      strokes: [
        {
          tool: 'pen' as const,
          color: '#d8a069',
          width: 0.004,
          points: [
            [0.32, 0.63],
            [0.3, 0.72],
            [0.35, 0.67],
            [0.33, 0.79],
            [0.39, 0.71],
            [0.38, 0.84],
            [0.44, 0.74],
            [0.45, 0.85],
            [0.49, 0.72],
            [0.47, 0.64],
            [0.42, 0.7],
            [0.41, 0.6],
            [0.36, 0.66],
            [0.34, 0.6]
          ] as Array<[number, number]>
        }
      ]
    }
  ];
  let demoFrameNow = $state(0);
  const demoFrame = (frame: number): void => {
    demoFrameNow = frame;
    if (frame === DEMO_FRAME) demoLanded = true;
    else if (demoLanded) demoTouched = true;
  };
  /* The reel loops; the player's frame clock follows the element. */
  let demoBox = $state<HTMLDivElement | undefined>();
  $effect(() => {
    const video = demoBox?.querySelector('video');
    if (video) video.loop = true;
  });
  const demoSeekBack = (): void => {
    demoPlayer?.seekToFrame(DEMO_FRAME);
  };
  const heroWash = [
    grainLayer,
    'radial-gradient(90% 62% at 70% 12%, rgba(255, 255, 255, 0.09), rgba(255, 255, 255, 0) 60%)',
    'linear-gradient(180deg in oklab, #0d1117 0%, var(--sumimai-a) 18%, var(--sumimai-m) 66%, var(--sumimai-b) 112%)'
  ].join(', ');
</script>

<svelte:head><title>Onelight</title></svelte:head>

<svelte:window
  onscroll={closeMenu}
  onkeydown={(event) => {
    if (event.key !== 'Escape') return;
    /* One key backs out of both, menu first: Escape with a menu open should
       not also throw away the selection it was opened on. */
    if (menu) closeMenu();
    else if (selected.length > 0) selected = [];
  }}
/>

<main
  class="shell"
  class:signed-in={auth.signedIn}
  style={`background-image: ${auth.signedIn ? pageWashFor(null) : heroWash}`}
>
  {#if auth.signedIn}
    <p class="eyebrow">One-light dailies</p>
    <h1>Choose a project.</h1>
    <section class="projects" aria-label="Projects">
      <!-- Creating a project leads: it is the one thing a new workspace must
           do, and it used to be stranded under the list. -->
      {#if auth.user?.role !== 'guest'}
      <form class="newproject" onsubmit={create}>
        <input
          bind:value={newProjectName}
          placeholder="New project"
          aria-label="New project name"
          maxlength="200"
          disabled={creating}
        />
        <button type="submit" disabled={!newProjectName.trim() || creating}>
          {creating ? 'Creating…' : 'Create project'}
        </button>
      </form>
      {/if}
      {#if createError}<p class="error" role="alert">{createError}</p>{/if}

      <div class="listhead">
        <span class="count">
          {displayed.length}
          {displayed.length === 1 ? 'project' : 'projects'}{filter.trim() ? ` matching "${filter.trim()}"` : ''}
        </span>
        <input
          class="filter"
          bind:value={filter}
          placeholder="Filter by name"
          aria-label="Filter projects by name"
          maxlength="200"
        />
        <label class="sortpick">
          <span class="vh">Sort by</span>
          <select bind:value={sortKey}>
            {#each Object.entries(SORT_LABELS) as [key, label] (key)}
              <option value={key}>{label}</option>
            {/each}
          </select>
        </label>
        <button
          type="button"
          class="dirbtn"
          aria-label={sortDir === 'desc' ? 'Descending, click for ascending' : 'Ascending, click for descending'}
          onclick={() => (sortDir = sortDir === 'desc' ? 'asc' : 'desc')}
        >
          <svg class="dir" class:desc={sortDir === 'desc'} viewBox="0 0 8 8" width="10" height="10" aria-hidden="true"><path d="M4 2l3 4H1z" fill="currentColor" /></svg>
        </button>
        {#if archived.length > 0 || showArchived}
          <button
            type="button"
            class="archbtn"
            aria-pressed={showArchived}
            onclick={() => { showArchived = !showArchived; selected = []; }}
          >{showArchived ? 'Back to projects' : `Archive (${archived.length})`}</button>
        {/if}
        {#if view === 'grid'}
          <span class="sizectl">
            <Slider
              label="Card size"
              length="104px"
              min={CARD_MIN}
              max={CARD_MAX}
              value={cardSize}
              valueText={`${String(cardSize)} pixels wide`}
              oninput={setSize}
              onchange={commitSize}
            />
          </span>
        {/if}
        <div class="viewtoggle" role="group" aria-label="Project view">
          <button type="button" aria-pressed={view === 'grid'} onclick={() => setView('grid')}>Grid</button>
          <button type="button" aria-pressed={view === 'list'} onclick={() => setView('list')}>List</button>
        </div>
      </div>

      {#if listError}<p class="error" role="alert">{listError}</p>{/if}

      {#if selected.length > 0}
        <div class="selbar" aria-live="polite">
          <span class="count">{selected.length} selected</span>
          {#if showArchived}
            <button type="button" class="quiet" disabled={busy} onclick={() => void setStatus(selected, 'active')}>Restore</button>
          {:else}
            <button type="button" class="quiet" disabled={busy} onclick={() => void setStatus(selected, 'archived')}>Archive</button>
          {/if}
          <button type="button" class="quiet" onclick={() => download(selected)}>Download zip</button>
          {#if selected.length === 1 && canManage(byId(selected[0] as string))}
            <button type="button" class="quiet" onclick={() => (peopleFor = byId(selected[0] as string) ?? null)}>People</button>
          {/if}
          {#if auth.user?.role === 'admin'}
            <button type="button" class="quiet danger" disabled={busy} onclick={() => void removeProjects(selected)}>Delete</button>
          {/if}
          <button type="button" class="quiet" onclick={() => (selected = [])}>Clear</button>
        </div>
      {/if}

      {#if !shelvesLoaded}
        <!-- The shape of what is coming, breathing, instead of a flash of
             "No projects yet" that the data then contradicts. -->
        <div
          class="projectlist ghosts"
          class:grid={view === 'grid'}
          style={`--card: ${String(cardSize)}px;`}
          aria-hidden="true"
        >
          {#each { length: view === 'grid' ? 8 : 5 } as _, index (index)}
            <div class="project">
              <span class="thumb"><span class="skeleton fill"></span></span>
              <span class="meta">
                <span class="skeleton line" style:width={`${String(46 + ((index * 17) % 38))}%`}></span>
                <span class="skeleton line thin"></span>
              </span>
            </div>
          {/each}
        </div>
      {:else if displayed.length === 0}
        <p class="empty">
          {#if filter.trim()}Nothing matches that name.
          {:else if showArchived}The archive is empty.
          {:else}No projects yet. Name one to start.{/if}
        </p>
      {/if}

      <div
        class="projectlist"
        class:grid={view === 'grid'}
        style={`--card: ${String(cardSize)}px;`}
      >
        {#each displayed as project (project.id)}
          {@const unread = unreadFor(project.id)}
          <a
            class="project"
            class:picked={isSelected(project.id)}
            href={`/projects/${pretty(project.public_id, project.name)}`}
            aria-current={isSelected(project.id) ? 'true' : undefined}
            onpointerdown={(event) => onCardPointerDown(event, project.id)}
            onpointermove={onCardPointerMove}
            onpointerup={onCardPointerUp}
            onpointercancel={onCardPointerUp}
            onclick={(event) => onCardClick(event, project)}
            oncontextmenu={(event) => openMenu(event, project.id)}
          >
            <!-- Every project has a picture: the one it chose, or the one
                 generated from its palette and name. Neither costs a request
                 beyond this page's own. -->
            <span class="thumb">
              <ProjectCover {project} monogram={view === 'grid'} />
              {#if unread > 0}
                <!-- The badge is the clear button: a count you cannot dismiss
                     from where you read it is a count you learn to ignore. -->
                <button
                  type="button"
                  class="badge"
                  title={`${unread} unread ${unread === 1 ? 'notification' : 'notifications'}. Click to clear.`}
                  onclick={(event) => void clearBadge(event, project.id)}
                >{unread > 99 ? '99+' : unread}</button>
              {/if}
            </span>
            <span class="meta">
              <span class="name">{project.name}</span>
              <small title={whenAbsolute(sortKey === 'created' ? project.created_at : activityOf(project))}>
                {project.my_role ?? 'viewer'} · {sortKey === 'created'
                  ? `created ${whenRelative(project.created_at)}`
                  : whenRelative(activityOf(project))}
              </small>
            </span>
          </a>
        {/each}
      </div>
    </section>
  {:else if auth.ready}
    <HeroWash />
    <div class="hero">
      <span class="lockup">
        <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true">
          <rect x="0.5" y="0.5" width="31" height="31" rx="8.5" fill="#10151d" />
          <rect x="5" y="8" width="5" height="16" rx="1.2" fill="#2c3f56" />
          <rect x="11" y="8" width="5" height="16" rx="1.2" fill="#934337" />
          <rect x="17" y="8" width="5" height="16" rx="1.2" fill="#cf8a56" />
          <rect x="23" y="8" width="4" height="16" rx="1.2" fill="#F7E1A0" />
        </svg>
        Onelight
      </span>
      <div class="stage">
        <div class="pitch">
          <h1>Color-true. Frame-exact. Yours.</h1>
          <p class="lede">A self-hosted review room for post-production teams.</p>
          <div class="doors">
            <a class="signin" href="/login">Sign in</a>
            {#if setupRequired}<a class="setup" href="/setup">First run setup</a>{/if}
          </div>
        </div>
        <!-- The product, not a picture of it: the real player on a public
             domain reel, opened on an annotated frame. -->
        <div class="demo">
          <div class="demoplayer" bind:this={demoBox}>
            <Player
              bind:this={demoPlayer}
              src="/demo/destination-earth.mp4"
              rate={{ num: 30000, den: 1001 }}
              durationFrames={360}
              chrome="simple"
              annotations={DEMO_NOTES.map((note) => ({
                frame: note.frame,
                strokes: note.strokes
              }))}
              markers={DEMO_NOTES.map((note) => ({
                id: `demo-${String(note.frame)}`,
                frameIn: note.frame,
                author: 'Onelight',
                text: note.text
              }))}
              onframechange={demoFrame}
            />
            <div class="demoticks">
              {#each DEMO_NOTES as note (note.frame)}
                <button
                  type="button"
                  class="tick"
                  style={`left: calc(12px + (100% - 24px) * ${String(note.frame / 360)}); background: ${note.ink};`}
                  aria-label={`Note at ${note.tc}`}
                  onclick={() => demoPlayer?.seekToFrame(note.frame)}
                ></button>
              {/each}
            </div>
          </div>
          <div class="demonotes">
            {#each DEMO_NOTES as note (note.frame)}
              <button type="button" class="demonote" onclick={() => demoPlayer?.seekToFrame(note.frame)}>
                <span class="ink" aria-hidden="true" style={`background: ${note.ink};`}></span>
                <span class="tc">{note.tc}</span>
                <span class="notetext">{note.text}</span>
              </button>
            {/each}
          </div>
          <p class="reel">Destination Earth (1956), public domain.</p>
        </div>
      </div>
      <p class="facts">Self-hosted. AGPL-3.0.</p>
    </div>
  {/if}
</main>

<!-- Right-click menu, positioned at the pointer and dismissed by the next
     click anywhere, Escape or a scroll: a menu that outlives its context is
     worse than no menu. -->
{#if menu}
  <!-- Every read of the menu is optional: closing it inside a handler nulls
       the state while this block is still on screen, and a bare menu.ids threw
       on the way out. -->
  {@const ids = menu.ids}
  {@const only = ids.length === 1 ? byId(ids[0] as string) : undefined}
  <div
    class="menuveil"
    role="presentation"
    onclick={closeMenu}
    oncontextmenu={(event) => { event.preventDefault(); closeMenu(); }}
  ></div>
  <div
    class="ctxmenu"
    role="menu"
    tabindex="-1"
    aria-label="Project actions"
    style={`left: ${menu.x}px; top: ${menu.y}px;`}
    use:keepOnScreen
  >
    <p class="ctxhead">{ids.length === 1 ? nameOf(ids[0] as string) : `${ids.length} projects`}</p>
    {#if only}
      <button type="button" role="menuitem" onclick={() => { const target = only; closeMenu(); void goto(`/projects/${pretty(target.public_id, target.name)}`); }}>Open</button>
      {#if canManage(only)}
        <button type="button" role="menuitem" onclick={() => { const target = only; closeMenu(); void goto(`/projects/${pretty(target.public_id, target.name)}/settings`); }}>Settings</button>
        <button type="button" role="menuitem" onclick={() => { const target = only; closeMenu(); peopleFor = target; }}>People…</button>
      {/if}
    {/if}
    <button type="button" role="menuitem" onclick={() => download(takeMenu())}>Download zip</button>
    {#if showArchived}
      <button type="button" role="menuitem" onclick={() => void setStatus(takeMenu(), 'active')}>Restore from archive</button>
    {:else}
      <button type="button" role="menuitem" onclick={() => void setStatus(takeMenu(), 'archived')}>Archive</button>
    {/if}
    {#if auth.user?.role === 'admin'}
      <div class="ctxsep"></div>
      <button type="button" role="menuitem" class="danger" onclick={() => void removeProjects(takeMenu())}>Delete forever</button>
    {/if}
  </div>
{/if}

<!-- People, without leaving the list: the same editor project settings uses. -->
<dialog
  class="people"
  bind:this={peopleDialog}
  aria-label="People"
  oncancel={(event) => { event.preventDefault(); peopleFor = null; }}
  onclick={(event) => { if (event.target === peopleDialog) peopleFor = null; }}
>
  {#if peopleFor}
    {@const target = peopleFor}
    <div class="peoplebody">
      <div class="peoplehead">
        <h2>{target.name}</h2>
        <button type="button" class="quiet" onclick={() => (peopleFor = null)}>Done</button>
      </div>
      <ProjectMembers
        projectId={target.id}
        isManager={canManage(target)}
        restricted={target.restricted ?? false}
      />
    </div>
  {/if}
</dialog>

<style>
  /* Signed out, the landing is the one page allowed the FULL wash: it ends
     on the light terminal like a horizon, and the content keeps to the dark
     two thirds so nothing ever sits on cream. Signed in, it takes the same
     page wash as every working page. */
  .shell { position: relative; min-height: calc(100vh - var(--topbar-h, 0px)); padding: 12vh 9vw; background-color: var(--ink-000); background-repeat: repeat, no-repeat, no-repeat; }
  .shell:not(.signed-in) { height: 100vh; min-height: 0; padding: 4vh 8vw 5vh; overflow: hidden; }
  /* Signed in this is a working page, not a landing page: less air, no hero. */
  .shell.signed-in { padding: 6vh 9vw; background-repeat: repeat, no-repeat; }

  .hero { position: relative; z-index: 1; display: grid; grid-template-rows: auto 1fr auto; height: 100%; }
  .stage { align-self: center; display: grid; grid-template-columns: minmax(380px, 1fr) auto; align-items: center; gap: clamp(32px, 5vw, 80px); padding: 2vh 0; }
  @media (max-width: 1080px) { .stage { grid-template-columns: 1fr; } }
  /* The reel is 4:3 and owns its half: the player gets a definite box sized
     from the viewport so the picture fills it edge to edge, with the
     transport underneath at the same width. */
  .demo { width: min(46vw, 96vh, 760px); }
  @media (max-width: 1080px) { .demo { width: min(92vw, 640px); justify-self: center; } }
  /* Phone: the one-screen horizon becomes a scrolling page — clipping the
     demo's notes at 100vh read as a broken page, not a design. The demo takes
     the column's width so it centres instead of bleeding off the right edge. */
  @media (max-width: 720px) {
    .shell:not(.signed-in) { height: auto; min-height: 100vh; overflow: visible; padding: 5vh var(--pad-2) 48px; }
    .demo { width: 100%; }
    /* The veil stays a veil: the player's phone deck is three bands tall and
       was burying half the demo frame. On the landing the instrument is a
       prop — timecode and transport on one slim line, scrub under it,
       everything else stays off the picture. */
    .demoplayer :global(.transport-row.main) { flex-wrap: nowrap; justify-content: center; column-gap: 12px; row-gap: 0; }
    .demoplayer :global(.deck) { display: flex; width: auto; align-items: center; gap: 10px; }
    .demoplayer :global(.deck .readout-sub),
    .demoplayer :global(.deck .shuttle),
    .demoplayer :global(.side) { display: none; }
    .demoplayer :global(.deck button) { min-height: 32px; }
    .demoplayer :global(.transport) { padding-bottom: 24px; }
  }
  .demoplayer { position: relative; aspect-ratio: 4 / 3; }
  /* The controls live ON the picture: translucent ink strips over the
     bottom edge, the scrub beneath them, the waveform scope in the top
     corner. Compression for effect; the review room keeps its layout. */
  .demoplayer :global(.player) { position: absolute; inset: 0; padding: 0 !important; }
  .demoplayer :global(.stage) { height: 100% !important; padding: 0 !important; }
  .demoplayer :global(.frame-box) { width: 100% !important; }
  /* The control band reads as a light veil over the picture, not a slab:
     a thin wash of ink with the frame blurred through it. Where
     backdrop-filter is unsupported the ink deepens to keep legibility. */
  .demoplayer :global(button[title="Full screen (F)"]) { display: none; }
  .demoplayer :global(.scrub-mark) { display: none; }
  .demoplayer :global(.transport) { position: absolute; left: 0; right: 0; bottom: 0; z-index: 2; background: rgba(13, 17, 23, 0.55); border-radius: 0; padding-bottom: 30px; }
  @supports (backdrop-filter: blur(1px)) {
    .demoplayer :global(button[title="Full screen (F)"]) { display: none; }
  .demoplayer :global(.scrub-mark) { display: none; }
  .demoplayer :global(.transport) { background: rgba(13, 17, 23, 0.28); backdrop-filter: blur(16px); }
  }
  /* Horizontal inset comes from left/right, never padding: the scrub
     measures its clientWidth to place the handle, and padding would count
     into it and walk the playhead off the track. */
  .demoplayer :global(.scrub) { position: absolute; left: 12px; right: 12px; bottom: 0; z-index: 3; padding: 0 0 10px; background: transparent; }
  .demoticks { position: absolute; left: 0; right: 0; bottom: 6px; height: 16px; z-index: 4; pointer-events: none; }
  .demoticks .tick { position: absolute; top: 0; width: 3px; height: 100%; padding: 0; border: 0; border-radius: 1px; cursor: pointer; pointer-events: auto; opacity: 0.9; }
  .demoticks .tick:hover { opacity: 1; }
  /* The instrument sheds its grey for the landing exactly as the
     presentation room does: the player's neutral scale re-maps so its
     slabs vanish into the wash, the picture floats on the gradient with
     its own corner radius, and the transport reads in cream on
     translucent ink. */
  .demoplayer {
    --n-000: transparent;
    --n-050: transparent;
    --n-100: transparent;
    --n-150: rgba(250, 248, 244, 0.14);
    --vol-track: rgba(250, 248, 244, 0.22);
    --n-200: rgba(13, 17, 23, 0.5);
    --n-300: rgba(13, 17, 23, 0.66);
    --n-400: rgba(13, 17, 23, 0.85);
    --n-500: rgba(250, 248, 244, 0.42);
    --n-600: rgba(250, 248, 244, 0.6);
    --n-700: rgba(250, 248, 244, 0.75);
    --n-800: rgba(250, 248, 244, 0.9);
    --n-900: #faf8f4;
  }
  .demoplayer :global(video) { border-radius: var(--radius-lg); }
  .demonotes { display: grid; gap: 7px; margin-top: 14px; }
  .demonote { display: flex; align-items: baseline; gap: 10px; padding: 0; border: 0; background: none; text-align: left; font-size: var(--text-13); color: rgba(255, 255, 255, 0.86); cursor: pointer; }
  .demonote:hover .notetext { color: #fff; }
  .demonote .ink { flex: none; width: 9px; height: 9px; border-radius: 50%; align-self: center; }
  .demonote .tc { font-variant-numeric: tabular-nums; color: rgba(255, 255, 255, 0.6); }
  .reel { margin: 10px 0 0; font-size: var(--text-12); color: rgba(255, 255, 255, 0.45); }
  .lockup { display: inline-flex; align-items: center; gap: 9px; font-family: var(--font-display); font-size: var(--text-16); font-weight: 700; color: var(--ink-text); }
  .lockup svg { flex: none; }
  .pitch { max-width: 720px; }
  .pitch .lede { color: rgba(255, 255, 255, 0.74); }
  .doors { display: flex; align-items: center; gap: 22px; margin-top: 44px; }
  .signin { display: inline-block; border-radius: var(--radius); background: var(--accent); color: #0b1214; padding: 11px 26px; font-size: var(--text-14); font-weight: 600; }
  .signin:hover { background: var(--accent-bright); }
  .setup { color: var(--ink-text-dim); border-bottom: 1px solid rgba(255, 255, 255, 0.35); padding-bottom: 3px; }
  .setup:hover { color: var(--ink-text); }
  .facts { margin: 0; color: rgba(255, 255, 255, 0.55); font-size: var(--text-13); }
  .eyebrow { margin: 0 0 24px; color: var(--ink-text-dim); font-size: var(--text-13); }
  h1 { max-width: 760px; margin: 0; font-family: var(--font-display); font-size: clamp(42px, 8vw, 92px); line-height: 0.98; }
  /* The heading over a list you came here to use does not need to be 92px. */
  .signed-in h1 { font-size: clamp(24px, 3vw, 34px); line-height: 1.1; margin: 0 0 24px; }
  .lede { max-width: 460px; margin: 32px 0 48px; font-size: 19px; color: var(--ink-text-dim); }
  a { color: inherit; text-decoration: none; }
  a:focus-visible { outline: 2px solid var(--accent-bright); outline-offset: 4px; }

  /* The list uses the window: the grid flows into as many columns as fit,
     and only the create form and the list rows keep a readable measure. A
     640px strip on a 2560px display was a column of air. */
  .projects { max-width: none; }
  .newproject { max-width: 640px; }
  .projectlist:not(.grid) { max-width: 900px; }
  .newproject { display: flex; gap: 6px; }
  .newproject input { flex: 1; min-width: 0; border: 0; border-radius: var(--radius); background: var(--ink-100); color: var(--ink-text); padding: 10px 14px; font-size: var(--text-13); }
  .newproject input::placeholder { color: var(--ink-text-dim); }
  .newproject button { border: 0; border-radius: var(--radius); background: var(--accent); color: #0b1214; padding: 10px 16px; font-size: var(--text-13); font-weight: 600; white-space: nowrap; }
  .newproject button:hover { background: var(--accent-bright); }
  .newproject button:disabled { opacity: 0.5; cursor: default; }

  /* Count on the left, controls gathered on the right: space-between scattered
     five controls across a 2560px window with the filter stranded in the
     middle of nothing. */
  .listhead { display: flex; align-items: center; gap: 8px; margin: 28px 0 10px; }
  .count { margin-right: auto; }
  .count { color: var(--ink-text-dim); font-size: var(--text-13); }
  .viewtoggle { display: flex; gap: 2px; padding: 2px; border-radius: var(--radius); background: var(--ink-100); }
  .viewtoggle button { border: 0; border-radius: 2px; background: none; color: var(--ink-text-dim); padding: 4px 10px; font-size: var(--text-12); font-weight: 500; }
  .viewtoggle button:hover { color: #fff; }
  .viewtoggle button[aria-pressed='true'] { background: var(--ink-300); color: #fff; }

  .projectlist { display: grid; gap: 2px; }
  /* Cards are exactly the size the slider says, not that size stretched to
     fill the row. minmax(--card, 1fr) meant the drawn width was really
     container/columns, so a continuous slider still moved the thumbnails in
     jumps: every time the column count dropped, every card leapt wider. Fixed
     tracks make the size continuous and honest, at the price of a gutter on
     the right, which is what a contact sheet looks like everywhere else.
     min(...,100%) keeps a card wider than its container from overflowing. */
  .projectlist.grid { grid-template-columns: repeat(auto-fill, min(var(--card, 220px), 100%)); gap: 14px; }
  .sizectl { display: flex; align-items: center; }
  @media (max-width: 720px) {
    .projectlist.grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
    .sizectl { display: none; }
  }

  /* List row: thumbnail as a small swatch. */
  .project { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-radius: var(--radius); background: var(--ink-100); transition: background 100ms ease; }
  .project:hover { background: var(--ink-200); }
  .meta { flex: 1; min-width: 0; display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .project small { color: var(--ink-text-dim); }
  .thumb { flex: none; width: 34px; height: 24px; border-radius: 2px; overflow: hidden; display: grid; }

  /* Grid card: the thumbnail leads and the name sits under it. Same system as
     the asset grid inside a project -- a padded box whose background is the
     hover and selection state, and a picture with its own corner radius -- so
     picking things works the same way in both places. */
  .grid .project { display: grid; gap: 8px; padding: 8px; border-radius: var(--radius-lg); background: none; }
  .grid .project:hover { background: var(--ink-100); }
  /* The thumb scales with its column instead of clamping at one height that
     only suited 180px cards. */
  .grid .thumb { width: 100%; height: auto; aspect-ratio: 16 / 9; border-radius: var(--radius); }
  /* The component's own <span> is the box; let it fill the wrapper. */
  .thumb :global(.cover) { width: 100%; height: 100%; }
  .grid .meta { display: grid; gap: 3px; padding: 0 2px; }
  .grid .meta small { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .empty { color: var(--ink-text-dim); }
  .error { margin: 12px 0 0; color: var(--warn); font-size: var(--text-13); }

  /* Ghost cards while the shelves load: same layout, one value step up,
     breathing (the .skeleton vocabulary from tokens.css). */
  .ghosts .project { pointer-events: none; }
  .ghosts .thumb :global(.skeleton.fill) { width: 100%; height: 100%; border-radius: inherit; }
  .ghosts :global(.skeleton.line) { height: 13px; }
  .ghosts :global(.skeleton.line.thin) { height: 11px; width: 30%; opacity: 0.6; }
  .ghosts .meta { align-items: center; }
  .ghosts.grid .meta { padding: 2px; }

  /* The head is a control bar now: count, filter, sort, the archive door and
     the view toggle, wrapping rather than overflowing. */
  .listhead { flex-wrap: wrap; }
  .filter { min-width: 140px; width: 240px; border: 0; border-radius: var(--radius); background: var(--ink-100); color: var(--ink-text); padding: 7px 12px; font-size: var(--text-13); }
  .filter::placeholder { color: var(--ink-text-dim); }
  .filter:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: 1px; }
  .sortpick select, .dirbtn, .archbtn { border: 0; border-radius: var(--radius); background: var(--ink-100); color: var(--ink-text); padding: 7px 10px; font-size: var(--text-12); }
  .sortpick select:focus-visible { outline: none; background: var(--ink-300); }
  .dirbtn { min-width: 30px; padding: 8px; display: grid; place-items: center; color: var(--ink-text); }
  .dirbtn:hover { color: var(--ink-text); }
  .dir.desc { transform: rotate(180deg); }
  .dirbtn:hover, .archbtn:hover { background: var(--ink-200); }
  .archbtn[aria-pressed='true'] { background: var(--ink-300); }
  /* Visually hidden, still read aloud. */
  .vh { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

  .selbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 10px; padding: 8px 12px; border-radius: var(--radius); background: var(--ink-100); }
  .selbar .quiet { border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 6px 12px; font-size: var(--text-12); font-weight: 500; }
  .selbar .quiet:hover { background: var(--ink-300); }
  .selbar .quiet:disabled { opacity: 0.5; cursor: default; }
  .selbar .danger { color: var(--warn); }
  .selbar .danger:hover:not(:disabled) { background: var(--warn); color: #12080a; }

  /* Selection is a value step, the same one the asset grid uses: cards go to
     ink-200 over their hover, rows in the list go one step further because
     they already sit on ink-100. */
  .grid .project.picked, .grid .project.picked:hover { background: var(--ink-200); }
  .projectlist:not(.grid) .project.picked { background: var(--ink-300); }
  .project:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: -1px; }
  .thumb { position: relative; }
  /* The unread count: the same yellow disc the nav bell wears. */
  .badge { position: absolute; top: 5px; right: 5px; min-width: 18px; height: 18px; display: grid; place-items: center; padding: 0 5px; border: 0; border-radius: 9px; background: #edc95f; color: #191307; font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; cursor: pointer; }
  .badge:hover { background: #f6dc8b; }
  .projectlist:not(.grid) .badge { top: -3px; right: -3px; }

  .menuveil { position: fixed; inset: 0; z-index: 60; }
  .ctxmenu { position: fixed; z-index: 61; min-width: 200px; max-height: 60vh; overflow-y: auto; display: grid; gap: 1px; padding: 4px; border-radius: var(--radius); background: var(--ink-100); box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5); }
  .ctxmenu button { border: 0; border-radius: 2px; background: none; color: var(--ink-text); padding: 7px 10px; font-size: var(--text-13); text-align: left; }
  .ctxmenu button:hover { background: var(--ink-300); }
  .ctxmenu:focus-visible { outline: none; }
  .ctxhead { margin: 0; padding: 6px 10px 4px; color: var(--ink-text-dim); font-size: var(--text-12); overflow-wrap: anywhere; }
  .ctxsep { height: 1px; margin: 3px 0; background: var(--ink-300); }
  .ctxmenu button.danger { color: var(--warn); }
  .ctxmenu button.danger:hover { background: color-mix(in oklab, var(--warn) 22%, var(--ink-200)); color: #fff; }

  .people { width: min(620px, calc(100vw - 24px)); padding: 0; border: 0; border-radius: var(--radius-lg); background: var(--ink-100); color: var(--ink-text); box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55); }
  .people::backdrop { background: rgba(5, 8, 12, 0.7); }
  .peoplebody { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; padding: 20px; }
  .peoplehead { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .peoplehead h2 { margin: 0; font-size: var(--text-16); font-weight: 600; overflow-wrap: anywhere; }
  .peoplehead .quiet { border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 7px 14px; font-size: var(--text-13); font-weight: 500; }
  .peoplehead .quiet:hover { background: var(--ink-300); }
</style>
