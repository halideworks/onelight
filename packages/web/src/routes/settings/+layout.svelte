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
      { title: 'Workspace', items: isAdmin ? [...WORKSPACE, ...WORKSPACE_ADMIN] : WORKSPACE },
      ...(isAdmin ? [{ title: 'System', items: SYSTEM }] : [])
    ]
  );

  const current = (href: string): 'page' | undefined =>
    page.url.pathname === href ? 'page' : undefined;
</script>

<div class="settings">
  <aside aria-label="Settings sections">
    <p class="railtitle">Settings</p>
    <nav>
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
  @media (max-width: 760px) {
    .settings {
      grid-template-columns: 1fr;
      gap: 0;
    }
    aside {
      border-right: 0;
      border-bottom: 1px solid var(--ink-100);
      padding-bottom: 16px;
    }
    nav {
      position: static;
      display: flex;
      flex-wrap: wrap;
      gap: 2px 10px;
      align-items: baseline;
    }
    .grouptitle {
      width: 100%;
      margin: 12px 0 2px;
    }
  }
</style>
