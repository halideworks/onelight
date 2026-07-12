<script lang="ts">
  import '../lib/fonts.css';
  import '../lib/tokens.css';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { auth } from '$lib/auth.svelte.js';
  import { notifications } from '$lib/notifications.svelte.js';
  import type { Snippet } from 'svelte';

  let { children }: { children: Snippet } = $props();

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
    <a
      class="bell"
      href="/notifications"
      aria-current={current('/notifications')}
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
    </a>
  </header>
{/if}

{@render children()}

<style>
  /* App-level defaults live here, not in tokens.css: the token file is a
     verbatim port of mockups/tokens.css (phase-0 T19). */
  :global(body) {
    min-height: 100vh;
    background: var(--ink-000);
    color: var(--ink-text);
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
    height: 52px;
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
  .bell {
    position: relative;
    display: inline-flex;
    align-items: center;
    padding: 8px;
    margin: -8px;
    border-radius: var(--radius);
    color: var(--ink-text-dim);
  }
  .bell:hover,
  .bell[aria-current='page'] {
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
  a:focus-visible {
    outline: 1px solid var(--accent-bright);
    outline-offset: 2px;
  }
</style>
