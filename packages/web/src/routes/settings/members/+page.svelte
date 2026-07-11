<script lang="ts">
  import { onMount } from 'svelte';
  import { api, apiDelete, apiPatch, apiPost, messageFrom } from '$lib/api.js';

  type User = { id: string; email: string; name: string; role: 'admin' | 'member'; disabled_at: number | null };
  type Invite = { id: string; email: string; role: string; expires_at: number };
  let users = $state<User[]>([]);
  let invites = $state<Invite[]>([]);
  let email = $state('');
  let inviteUrl = $state('');
  let error = $state('');

  const load = async (): Promise<void> => {
    try {
      const [usersPayload, invitesPayload] = await Promise.all([
        api<{ items: User[] }>('/api/v1/users'),
        api<{ items: Invite[] }>('/api/v1/invites')
      ]);
      users = usersPayload.items;
      invites = invitesPayload.items;
    } catch (caught) {
      error = messageFrom(caught, 'Members could not be loaded.');
    }
  };

  const invite = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    try {
      const body = await apiPost<{ accept_url?: string }>('/api/v1/invites', { email, role: 'member', project_grants: [] });
      inviteUrl = body.accept_url ?? '';
      email = '';
      error = '';
      await load();
    } catch (caught) {
      error = messageFrom(caught, 'Invite could not be created.');
    }
  };

  const changeRole = async (user: User, role: User['role']): Promise<void> => {
    try {
      await apiPatch(`/api/v1/users/${user.id}`, { role });
      error = '';
      await load();
    } catch (caught) {
      error = messageFrom(caught, 'The role could not be changed.');
    }
  };

  const revokeInvite = async (id: string): Promise<void> => {
    try {
      await apiDelete(`/api/v1/invites/${id}`);
    } catch {
      /* Reload shows the true state either way. */
    }
    await load();
  };

  onMount(load);
</script>

<svelte:head><title>Members | Onelight</title></svelte:head>
<main class="page">
  <a href="/settings">Settings</a>
  <h1>Members</h1>
  <form class="invite" onsubmit={invite}><label>Email <input type="email" bind:value={email} required /></label><button type="submit">Invite member</button></form>
  {#if inviteUrl}<section class="revealed" aria-live="polite"><strong>Invite link</strong><input readonly value={inviteUrl} aria-label="Invite link" /><button type="button" onclick={() => navigator.clipboard?.writeText(inviteUrl)}>Copy link</button></section>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <section aria-label="Workspace members" class="list"><h2>Workspace members</h2>{#each users as user (user.id)}<article><div><strong>{user.name}</strong><span>{user.email}</span></div><select aria-label={`Role for ${user.name}`} value={user.role} onchange={(event) => changeRole(user, (event.currentTarget as HTMLSelectElement).value as User['role'])}><option value="member">Member</option><option value="admin">Admin</option></select></article>{/each}</section>
  <section aria-label="Pending invites" class="list"><h2>Pending invites</h2>{#if invites.length === 0}<p class="empty">No pending invites.</p>{/if}{#each invites as pending (pending.id)}<article><div><strong>{pending.email}</strong><span>{pending.role}</span></div><button type="button" onclick={() => revokeInvite(pending.id)}>Revoke</button></article>{/each}</section>
</main>

<style>
  /* App world, no borders: rows and fields separate by value step. */
  .page { min-height: 100vh; padding: 48px clamp(24px, 8vw, 120px); background: var(--ink-000); }
  a { color: var(--ink-text-dim); }
  h1 { margin: 48px 0 28px; font-family: var(--font-display); font-size: clamp(40px, 7vw, 72px); font-weight: 700; letter-spacing: -0.02em; }
  h2 { margin: 44px 0 12px; font-size: var(--text-16); }
  .invite, .revealed { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; }
  label { display: grid; gap: 8px; color: var(--ink-text-dim); font-size: var(--text-13); }
  input, select { border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 10px 12px; }
  input { min-width: min(420px, 80vw); }
  button { border: 0; border-radius: var(--radius); background: var(--accent); color: #071216; padding: 11px 16px; font-weight: 600; }
  button:hover { background: var(--accent-bright); }
  button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: 2px; }
  .revealed { margin-top: 24px; padding: 16px; border-radius: var(--radius); background: var(--ink-100); }
  .revealed strong { flex-basis: 100%; }
  .list { max-width: 760px; }
  article { display: flex; justify-content: space-between; gap: 20px; align-items: center; padding: 14px; margin: 0 -14px 2px; border-radius: var(--radius); background: var(--ink-100); }
  article div { display: grid; gap: 4px; }
  article span, .empty { color: var(--ink-text-dim); }
  .error { color: var(--warn); }
</style>
