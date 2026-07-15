<script lang="ts">
  import '../lib/fonts.css';
  import '../lib/tokens.css';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { auth } from '$lib/auth.svelte.js';
  import { notifications } from '$lib/notifications.svelte.js';
  import NotificationsPanel from '$lib/NotificationsPanel.svelte';
  import type { Snippet } from 'svelte';

  let { children }: { children: Snippet } = $props();

  let notificationsOpen = $state(false);

  const PUBLIC_PREFIXES = ['/login', '/setup', '/invite', '/reset', '/s'];
  const isPublic = $derived(
    PUBLIC_PREFIXES.some(
      (prefix) => page.url.pathname === prefix || page.url.pathname.startsWith(`${prefix}/`)
    )
  );
  /* The review room owns its chrome: strictly neutral, nothing tinted near footage. */
  const inReviewRoom = $derived(/^\/projects\/[^/]+\/assets\/./.test(page.url.pathname));
  const chrome = $derived(auth.signedIn && !isPublic && !inReviewRoom);

  onMount(() => {
    if (!auth.ready) void auth.hydrate();
  });

  /* Cheap unread poll: one GET on an interval, only while the tab is visible. */
  $effect(() => {
    if (!chrome) return;
    void notifications.refresh();
    const tick = (): void => {
      if (document.visibilityState === 'visible') void notifications.refresh();
    };
    const interval = setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', tick);
    };
  });

  const isTyping = (target: EventTarget | null): boolean =>
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable);

  /* Global "/" jumps to search everywhere in the app world (skipped while
     typing and in the review room, which owns its own keyboard surface). */
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
    if (!chrome || isTyping(event.target)) return;
    event.preventDefault();
    if (page.url.pathname === '/search') {
      window.dispatchEvent(new CustomEvent('onelight:focus-search'));
    } else {
      void goto('/search');
    }
  };

  const current = (path: string): 'page' | undefined =>
    (path === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(path))
      ? 'page'
      : undefined;
</script>

<svelte:window onkeydown={onKeydown} />

{#if chrome}
  <header class="topbar">
    <a class="wordmark" href="/">Onelight</a>
    <nav aria-label="Primary">
      <a href="/" aria-current={current('/')}>Projects</a>
      <a href="/search" aria-current={current('/search')}>Search</a>
      <a href="/settings" aria-current={current('/settings')}>Settings</a>
    </nav>
    <button
      type="button"
      class="bell"
      onclick={() => (notificationsOpen = !notificationsOpen)}
      aria-expanded={notificationsOpen}
      aria-label={notifications.unread > 0
        ? `Notifications, ${notifications.unread} unread`
        : 'Notifications'}
    >
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
        <path d="M8 2a4 4 0 0 0-4 4v2.5L2.8 11h10.4L12 8.5V6a4 4 0 0 0-4-4Z" />
        <path d="M6.6 13a1.5 1.5 0 0 0 2.8 0" />
      </svg>
      {#if notifications.unread > 0}
        <span class="badge tc">{notifications.unread > 99 ? '99+' : notifications.unread}</span>
      {/if}
    </button>
  </header>
  <NotificationsPanel bind:open={notificationsOpen} />
{/if}

<!-- display: contents, so this wrapper adds no box and changes no layout; it
     exists only to hand --topbar-h down to the page. Custom properties still
     inherit through it, and because it mirrors `chrome`, the offset tracks
     whether the header is really rendered rather than guessing from the route.
     That matters for `/`, which is dual-mode: the signed-out hero has no
     header and must stay a full 100vh. -->
<div class="pages" class:bare={!chrome}>
  {@render children()}
</div>

<style>
  /* App-level defaults live here, not in tokens.css: the token file is a
     verbatim port of mockups/tokens.css (phase-0 T19). */
  :global(body) {
    /* The topbar is static, so it stacks above the page rather than overlaying
       it: a page asking for 100vh would make the document 100vh + this and
       scroll by exactly this much with nothing in the overflow. Pages subtract
       it via calc(100vh - var(--topbar-h, 0px)). Declared here so the height
       and the offset are one number and cannot drift. */
    --topbar-h: 52px;
    min-height: 100vh;
    background: var(--ink-000);
    color: var(--ink-text);
  }
  .pages {
    display: contents;
  }
  /* No header rendered (login, setup, invite, reset, share links, the review
     room, and the signed-out hero) -- there is nothing to subtract. */
  .pages.bare {
    --topbar-h: 0px;
  }
  :global(input),
  :global(textarea),
  :global(select) {
    font: inherit;
  }

  /* Topbar: separation by value step, no border line. */
  .topbar {
    display: flex;
    align-items: center;
    gap: 28px;
    padding: 0 clamp(24px, 4vw, 40px);
    height: var(--topbar-h);
    background: var(--ink-000);
    font-size: var(--text-13);
  }
  .wordmark {
    font-family: var(--font-display);
    font-size: var(--text-14);
    font-weight: 700;
    color: var(--ink-text);
    text-decoration: none;
  }
  nav {
    display: flex;
    gap: 20px;
    flex: 1;
  }
  nav a {
    color: var(--ink-text-dim);
    font-weight: 500;
    text-decoration: none;
  }
  nav a:hover,
  nav a[aria-current='page'] {
    color: var(--ink-text);
  }
  /* An icon button, so it opts out of the app's filled-button convention. */
  .bell {
    position: relative;
    display: inline-flex;
    align-items: center;
    padding: 8px;
    margin: -8px;
    border: 0;
    border-radius: var(--radius);
    background: none;
    color: var(--ink-text-dim);
  }
  .bell:hover,
  .bell[aria-expanded='true'] {
    color: var(--ink-text);
  }
  .badge {
    position: absolute;
    top: -3px;
    right: -7px;
    min-width: 16px;
    padding: 1px 4px;
    border-radius: 8px;
    background: var(--accent);
    color: #0b1214;
    font-size: var(--text-11);
    font-weight: 600;
    text-align: center;
    line-height: 1.3;
  }
  a:focus-visible,
  button:focus-visible {
    outline: 1px solid var(--accent-bright);
    outline-offset: 2px;
  }
</style>
