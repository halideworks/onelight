<script lang="ts">
  import { goto } from '$app/navigation';
  import { api, createProject, getBootstrap, messageFrom } from '$lib/api.js';
  import { auth } from '$lib/auth.svelte.js';
  import ProjectCover from '$lib/ProjectCover.svelte';
  import { pretty } from '$lib/ids.js';
  import { pageWashFor } from '$lib/washes.js';
  import { grainLayer } from '$lib/grain.js';
  import HeroWash from '$lib/HeroWash.svelte';
  import Player from '@onelight/player/Player.svelte';

  type Project = {
    id: string;
    public_id: string;
    name: string;
    status: string;
    palette: string;
    cover_url?: string | null;
    my_role?: string;
  };
  let projects = $state<Project[]>([]);

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

  $effect(() => {
    if (!auth.ready || !auth.signedIn || projectsLoaded) return;
    projectsLoaded = true;
    void (async () => {
      try {
        projects = (await api<{ items: Project[] }>('/api/v1/projects')).items;
      } catch {
        /* The empty state stands in. */
      }
    })();
  });

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
        <span class="count">{projects.length} {projects.length === 1 ? 'project' : 'projects'}</span>
        <div class="viewtoggle" role="group" aria-label="Project view">
          <button type="button" aria-pressed={view === 'grid'} onclick={() => setView('grid')}>Grid</button>
          <button type="button" aria-pressed={view === 'list'} onclick={() => setView('list')}>List</button>
        </div>
      </div>

      {#if projects.length === 0}<p class="empty">No projects yet. Name one to start.</p>{/if}

      <div class="projectlist" class:grid={view === 'grid'}>
        {#each projects as project (project.id)}
          <a class="project" href={`/projects/${pretty(project.public_id, project.name)}`}>
            <!-- Every project has a picture: the one it chose, or the one
                 generated from its palette and name. Neither costs a request
                 beyond this page's own. -->
            <span class="thumb"><ProjectCover {project} monogram={view === 'grid'} /></span>
            <span class="meta">
              <span class="name">{project.name}</span>
              <small>{project.my_role ?? 'viewer'}</small>
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

  .listhead { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 28px 0 10px; }
  .count { color: var(--ink-text-dim); font-size: var(--text-13); }
  .viewtoggle { display: flex; gap: 2px; padding: 2px; border-radius: var(--radius); background: var(--ink-100); }
  .viewtoggle button { border: 0; border-radius: 2px; background: none; color: var(--ink-text-dim); padding: 4px 10px; font-size: var(--text-12); font-weight: 500; }
  .viewtoggle button:hover { color: #fff; }
  .viewtoggle button[aria-pressed='true'] { background: var(--ink-300); color: #fff; }

  .projectlist { display: grid; gap: 2px; }
  .projectlist.grid { grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }

  /* List row: thumbnail as a small swatch. */
  .project { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-radius: var(--radius); background: var(--ink-100); transition: background 100ms ease; }
  .project:hover { background: var(--ink-200); }
  .meta { flex: 1; min-width: 0; display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .project small { color: var(--ink-text-dim); }
  .thumb { flex: none; width: 34px; height: 24px; border-radius: 2px; overflow: hidden; display: grid; }

  /* Grid card: the thumbnail leads and the name sits under it. */
  .grid .project { flex-direction: column; align-items: stretch; gap: 0; padding: 0; overflow: hidden; }
  /* The thumb scales with its column instead of clamping at one height that
     only suited 180px cards. */
  .grid .thumb { width: 100%; height: auto; aspect-ratio: 16 / 9; border-radius: 0; }
  /* The component's own <span> is the box; let it fill the wrapper. */
  .thumb :global(.cover) { width: 100%; height: 100%; }
  .grid .meta { padding: 10px 12px; }

  .empty { color: var(--ink-text-dim); }
  .error { margin: 12px 0 0; color: var(--warn); font-size: var(--text-13); }
</style>
