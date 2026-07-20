<script lang="ts">
  import type { Snippet } from 'svelte';
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { auth } from '$lib/auth.svelte.js';

  /* Settings is one room with a rail, not a lobby with doors: every section
     is one click from every other, and where you are is always visible. The
     rail is grouped by who the setting is about: you, everyone, the machine. */

  let { children }: { children: Snippet } = $props();

  onMount(() => {
    if (!auth.ready) void auth.hydrate();
  });

  const isAdmin = $derived(auth.user?.role === 'admin');
  const isGuest = $derived(auth.user?.role === 'guest');

  type Item = { href: string; label: string };
  const YOU: Item[] = [
    { href: '/settings/profile', label: 'Profile' },
    { href: '/settings/notifications', label: 'Notifications' },
    { href: '/settings/sessions', label: 'Sessions' },
    { href: '/settings/tokens', label: 'API tokens' }
  ];
  const WORKSPACE: Item[] = [{ href: '/settings/members', label: 'Members' }];
  const WORKSPACE_ADMIN: Item[] = [
    { href: '/settings/storage', label: 'Storage' },
    { href: '/settings/trash', label: 'Trash' },
    { href: '/settings/audit', label: 'Audit log' }
  ];
  const SYSTEM: Item[] = [
    { href: '/settings/system', label: 'System' },
    { href: '/settings/email', label: 'Email' },
    { href: '/settings/jobs', label: 'Job queue' },
    { href: '/settings/webhooks', label: 'Webhooks' }
  ];

  const groups = $derived(
    [
      { title: 'You', items: YOU },
      /* Guests get no workspace surfaces: their account is scoped to what
         they were granted, and the team roster is not theirs to browse. */
      ...(isGuest ? [] : [{ title: 'Workspace', items: isAdmin ? [...WORKSPACE, ...WORKSPACE_ADMIN] : WORKSPACE }]),
      ...(isAdmin ? [{ title: 'System', items: SYSTEM }] : [])
    ]
  );

  const current = (href: string): 'page' | undefined =>
    page.url.pathname === href ? 'page' : undefined;

  /* On the phone rail (a sideways scroller) the active pill must be visible
     without hunting: whenever the route changes, bring it into view. */
  let navEl = $state<HTMLElement | null>(null);
  $effect(() => {
    void page.url.pathname;
    const nav = navEl;
    /* Two frames, not one: the first can still precede style application on
       a cold load, and centering only works after the row is scrollable. */
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const active = nav?.querySelector('[aria-current="page"]');
        active?.scrollIntoView({ block: 'nearest', inline: 'center' });
      })
    );
    return () => cancelAnimationFrame(raf);
  });
</script>

<div class="settings">
  <aside aria-label="Settings sections">
    <p class="railtitle">Settings</p>
    <nav bind:this={navEl}>
      {#each groups as group (group.title)}
        <p class="grouptitle">{group.title}</p>
        {#each group.items as item (item.href)}
          <a href={item.href} aria-current={current(item.href)}>{item.label}</a>
        {/each}
      {/each}
    </nav>
  </aside>
  <div class="content">
    {@render children()}
  </div>
</div>

<style>
  .settings {
    display: grid;
    grid-template-columns: 208px minmax(0, 1fr);
    gap: clamp(28px, 4vw, 64px);
    min-height: calc(100vh - var(--topbar-h, 0px));
    padding: 0 clamp(24px, 4vw, 64px);
    background: var(--ink-000);
    color: var(--ink-text);
  }
  aside {
    padding: 44px 0 48px;
    border-right: 1px solid var(--ink-100);
  }
  .railtitle {
    margin: 0 0 20px;
    font-family: var(--font-display);
    font-size: var(--text-20);
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  nav {
    position: sticky;
    top: 24px;
    display: grid;
    gap: 2px;
    padding-right: 16px;
  }
  .grouptitle {
    margin: 18px 0 4px;
    font-size: var(--text-11);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-text-dim);
  }
  .grouptitle:first-child {
    margin-top: 0;
  }
  nav a {
    padding: 7px 10px;
    margin: 0 -10px;
    border-radius: var(--radius);
    color: var(--ink-text-dim);
    font-size: var(--text-13);
    font-weight: 500;
    text-decoration: none;
  }
  nav a:hover {
    color: var(--ink-text);
    background: var(--ink-100);
  }
  nav a[aria-current='page'] {
    color: var(--ink-text);
    background: var(--ink-100);
  }
  .content {
    min-width: 0;
  }
  a:focus-visible {
    outline: 1px solid var(--accent-bright);
    outline-offset: 2px;
  }
  /* Phone: the rail becomes one sideways-scrolling row of pills pinned under
     the topbar. Group titles go — thirteen labels in reading order carry the
     structure well enough on a strip you thumb through. */
  @media (max-width: 720px) {
    .settings {
      grid-template-columns: 1fr;
      /* Stacked, the two grid children become rows; without this the
         min-height stretches them evenly and short pages get a huge gap
         between rail and heading. */
      grid-template-rows: auto 1fr;
      gap: 0;
      padding: 0 var(--pad-2);
    }
    aside {
      position: sticky;
      top: 0;
      z-index: 5;
      /* Grid items default to min-width auto, which would size this to the
         full row of pills and drag the page wide; the nav scrolls instead. */
      min-width: 0;
      margin: 0 calc(-1 * var(--pad-2));
      padding: 0;
      border-right: 0;
      border-bottom: 1px solid var(--ink-100);
      background: var(--ink-000);
    }
    .railtitle,
    .grouptitle {
      display: none;
    }
    nav {
      position: static;
      display: flex;
      gap: 4px;
      padding: 8px var(--pad-2);
      overflow-x: auto;
      scrollbar-width: none;
      -webkit-overflow-scrolling: touch;
    }
    nav a {
      flex: none;
      margin: 0;
      padding: 8px 12px;
      white-space: nowrap;
    }
    .content {
      padding-bottom: var(--pad-3);
    }
    /* Every settings page opens with main.page's 44px desktop padding; under
       a sticky rail that reads as dead space, so tighten it here once. */
    .content > :global(main.page) {
      padding-top: 20px;
    }
  }
</style>
