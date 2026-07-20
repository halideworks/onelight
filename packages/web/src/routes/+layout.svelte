<script lang="ts">
  import '../lib/fonts.css';
  import '../lib/tokens.css';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { auth } from '$lib/auth.svelte.js';
  import { notifications } from '$lib/notifications.svelte.js';
  import NotificationsPanel from '$lib/NotificationsPanel.svelte';
  import Avatar from '$lib/Avatar.svelte';
  import ConfirmHost from '$lib/ConfirmHost.svelte';
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
    /* The field is in the nav now, so "/" focuses it here rather than
       navigating somewhere to find one. */
    searchEl?.focus();
    searchEl?.select();
  };

  let searchEl = $state<HTMLInputElement | null>(null);
  let searchText = $state('');
  /* Keep the field in step with the URL: arriving on /search?q=x, or going
     back, should not leave the box saying something else. */
  $effect(() => {
    if (page.url.pathname === '/search') searchText = page.url.searchParams.get('q') ?? '';
  });

  let searchDebounce: ReturnType<typeof setTimeout> | null = null;
  const runSearch = (replace: boolean): void => {
    const query = searchText.trim();
    if (!query) {
      if (page.url.pathname === '/search') void goto('/search', { replaceState: replace, keepFocus: true });
      return;
    }
    void goto(`/search?q=${encodeURIComponent(query)}`, { replaceState: replace, keepFocus: true });
  };
  /* Typing navigates, but only once you have paused: a keystroke per history
     entry would make Back useless. Already on /search, each update replaces. */
  const searchAsYouType = (): void => {
    if (searchDebounce !== null) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => runSearch(page.url.pathname === '/search'), 260);
  };
  const submitSearch = (event: SubmitEvent): void => {
    event.preventDefault();
    if (searchDebounce !== null) clearTimeout(searchDebounce);
    runSearch(false);
  };

  const current = (path: string): 'page' | undefined =>
    (path === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(path))
      ? 'page'
      : undefined;
</script>

<svelte:window onkeydown={onKeydown} />

{#if chrome}
  <header class="topbar">
    <a class="wordmark" href="/">
      <!-- The chip, same mark as the favicon: tab and masthead are one
           system. Inline so it never waits on a fetch. -->
      <svg viewBox="0 0 32 32" width="20" height="20" aria-hidden="true">
        <rect x="0.5" y="0.5" width="31" height="31" rx="8.5" fill="#10151d" />
        <rect x="5" y="8" width="5" height="16" rx="1.2" fill="#2c3f56" />
        <rect x="11" y="8" width="5" height="16" rx="1.2" fill="#934337" />
        <rect x="17" y="8" width="5" height="16" rx="1.2" fill="#cf8a56" />
        <rect x="23" y="8" width="4" height="16" rx="1.2" fill="#F7E1A0" />
      </svg>
      Onelight
    </a>
    <nav aria-label="Primary">
      <a href="/" aria-current={current('/')}>Projects</a>
      <a href="/settings" aria-current={current('/settings')}>Settings</a>
    </nav>
    <!-- Search is a field, not a link to a field. Typing here goes to /search
         with the query already in the URL, so the results page is a real
         address you can share or reload rather than somewhere you land empty
         and start again. -->
    <form class="navsearch" role="search" onsubmit={submitSearch}>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" stroke-linecap="round" />
      </svg>
      <input
        bind:this={searchEl}
        bind:value={searchText}
        type="search"
        placeholder="Search"
        aria-label="Search assets and comments"
        oninput={searchAsYouType}
      />
    </form>
    <!-- On phones the search field is hidden; this icon keeps /search one tap
         away instead of unreachable. -->
    <a class="searchlink" href="/search" aria-label="Search">
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" stroke-linecap="round" />
      </svg>
    </a>
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
    {#if auth.user}
      <a class="me" href="/settings/profile" aria-label="Your profile">
        <Avatar name={auth.user.name} id={auth.user.id} url={auth.user.avatar_url ?? null} size={26} />
      </a>
    {/if}
  </header>
  <NotificationsPanel bind:open={notificationsOpen} />
{/if}
<ConfirmHost />

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
  /* Dropdowns never wear a focus ring, whatever the browser's heuristic:
     every page styles select focus as a background value step instead. */
  :global(select:focus),
  :global(select:focus-visible) {
    outline: none;
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
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-display);
    font-size: var(--text-14);
    font-weight: 700;
    color: var(--ink-text);
    text-decoration: none;
  }
  .wordmark svg {
    flex: none;
  }
  nav {
    display: flex;
    gap: 20px;
  }
  .navsearch { flex: 1; display: flex; align-items: center; gap: 6px; max-width: 420px; margin-left: 8px; padding: 0 10px; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text-dim); }
  .navsearch:focus-within { background: var(--ink-300); color: var(--ink-text); outline: 1px solid var(--accent-bright); outline-offset: 1px; }
  .navsearch input { flex: 1; min-width: 0; border: 0; background: none; color: var(--ink-text); padding: 7px 0; font-size: var(--text-13); }
  .navsearch input:focus-visible { outline: none; }
  .navsearch input::placeholder { color: var(--ink-text-dim); }
  .searchlink {
    display: none;
    align-items: center;
    padding: 8px;
    margin: -8px 0 -8px auto;
    border-radius: var(--radius);
    color: var(--ink-text-dim);
  }
  .searchlink:hover { color: var(--ink-text); }
  /* Coarse pointers get full-height nav targets; the visual stays quiet. */
  @media (pointer: coarse) {
    nav a { padding: 12px 4px; margin: -12px -4px; }
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
  /* An icon button, so it opts out of the app's filled-button convention.
     margin-left auto: the search field caps its own width, so the leftover
     space belongs behind it, not to the right of the avatar. The bell and
     the avatar anchor the frame's right edge. */
  .bell {
    position: relative;
    display: inline-flex;
    align-items: center;
    padding: 8px;
    margin: -8px;
    margin-left: auto;
    border: 0;
    border-radius: var(--radius);
    background: none;
    color: var(--ink-text-dim);
  }
  .bell:hover,
  .bell[aria-expanded='true'] {
    color: var(--ink-text);
  }
  /* Unread is a flag, not decoration. The accent is the app's ordinary
     interactive colour and sat unnoticed on the bell; a warm badge reads as
     "something is waiting" at a glance. */
  .badge {
    position: absolute;
    top: -3px;
    right: -7px;
    min-width: 16px;
    padding: 1px 4px;
    border-radius: 8px;
    background: var(--note);
    color: #14100a;
    font-size: var(--text-11);
    font-weight: 600;
    text-align: center;
    line-height: 1.3;
  }
  .me { display: inline-flex; border-radius: 50%; }
  .me:hover { box-shadow: 0 0 0 2px var(--ink-300); }
  /* Phone. This block sits after the .bell rule on purpose: it strips the
     bell's auto margin and hands it to the search icon, and the cascade only
     lets it if it is the later declaration. The bar reads wordmark left,
     then search / bell / avatar as one right-hand cluster. */
  @media (max-width: 720px) {
    .topbar { gap: 20px; }
    .navsearch { display: none; }
    /* The wordmark already goes home and the avatar already opens settings:
       on a phone the text links only crowd the bar. */
    nav { display: none; }
    .searchlink { display: inline-flex; margin-left: auto; }
    .bell { margin-left: 0; }
  }
  a:focus-visible,
  button:focus-visible {
    outline: 1px solid var(--accent-bright);
    outline-offset: 2px;
  }
</style>
