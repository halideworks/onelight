<script lang="ts">
  import { onMount } from 'svelte';
  import { auth } from '$lib/auth.svelte.js';

  onMount(() => {
    if (!auth.ready) void auth.hydrate();
  });

  const isAdmin = $derived(auth.user?.role === 'admin');
</script>

<svelte:head><title>Settings | Onelight</title></svelte:head>
<main class="page">
  <h1>Settings</h1>

  <!-- Grouped by who the setting is about: you, everyone, and the machine.
       One flat list stopped scaling the moment admin surfaces arrived. -->
  <section aria-label="Your account">
    <h2>You</h2>
    <nav>
      <a href="/settings/profile"><strong>Profile</strong><span>Your name and picture</span></a>
      <a href="/settings/sessions"><strong>Sessions</strong><span>Browsers signed in to your account</span></a>
      <a href="/settings/notifications"><strong>Notifications</strong><span>Email delivery and muted projects</span></a>
      <a href="/settings/tokens"><strong>API tokens</strong><span>Command-line tools and integrations</span></a>
    </nav>
  </section>

  <section aria-label="Workspace">
    <h2>Workspace</h2>
    <nav>
      <a href="/settings/members"><strong>Members</strong><span>Users, invites, and roles</span></a>
      {#if isAdmin}
        <a href="/settings/storage"><strong>Storage</strong><span>What each project weighs on disk</span></a>
        <a href="/settings/audit"><strong>Audit log</strong><span>Who did what, and when</span></a>
      {/if}
    </nav>
  </section>

  {#if isAdmin}
    <section aria-label="System">
      <h2>System</h2>
      <nav>
        <a href="/settings/jobs"><strong>Job queue</strong><span>Transcodes, probes, and background work</span></a>
      </nav>
    </section>
  {/if}
</main>
<style>
  .page { min-height: calc(100vh - var(--topbar-h, 0px)); padding: 48px clamp(24px, 5vw, 96px); background: var(--ink-000); }
  h1 { margin: 0 0 32px; font-family: var(--font-display); font-size: var(--text-56); font-weight: 700; letter-spacing: -0.02em; }
  section { max-width: 640px; margin: 0 0 28px; }
  h2 { margin: 0 0 6px; font-size: var(--text-13); font-weight: 600; color: var(--ink-text-dim); }
  nav { display: grid; gap: 2px; }
  a { display: grid; gap: 4px; padding: 14px; margin: 0 -14px; border-radius: var(--radius); color: var(--ink-text); text-decoration: none; }
  a:hover { background: var(--ink-100); }
  a span { color: var(--ink-text-dim); font-size: var(--text-13); }
  a:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
</style>
