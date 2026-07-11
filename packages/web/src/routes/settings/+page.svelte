<svelte:head><title>Settings | Onelight</title></svelte:head>
<main class="page">
  <h1>Settings</h1>
  <nav>
    <a href="/settings/members"><strong>Members</strong><span>Users, invites, and roles</span></a>
    <a href="/settings/tokens"><strong>API tokens</strong><span>Command-line tools and integrations</span></a>
  </nav>
</main>
<style>
  .page { min-height: 100vh; padding: 48px clamp(24px, 8vw, 120px); background: var(--ink-000); }
  h1 { margin: 0 0 32px; font-family: var(--font-display); font-size: var(--text-56); font-weight: 700; letter-spacing: -0.02em; }
  nav { display: grid; gap: 2px; max-width: 560px; }
  a { display: grid; gap: 4px; padding: 16px 14px; margin: 0 -14px; border-radius: var(--radius); color: var(--ink-text); text-decoration: none; }
  a:hover { background: var(--ink-100); }
  a span { color: var(--ink-text-dim); font-size: var(--text-13); }
  a:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
</style>
