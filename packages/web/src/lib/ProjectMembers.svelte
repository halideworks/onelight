<script lang="ts">
  import { goto } from '$app/navigation';
  import { api, apiDelete, apiPut, messageFrom } from '$lib/api.js';
  import { askConfirm } from '$lib/confirm.svelte.js';
  import { auth } from '$lib/auth.svelte.js';
  import Avatar from '$lib/Avatar.svelte';

  /* The per-project role editor, shared by project settings and the projects
     list. Roles are the same conversation in both places, and duplicating a
     list that can lock someone out of their own project is how the two copies
     drift apart. */

  type Member = {
    user: { id: string; name: string; email: string; avatar_url?: string | null };
    role: string;
  };
  type User = { id: string; name: string; email: string };

  const {
    projectId,
    isManager,
    restricted = false,
    leaveTo = null,
    onchange = undefined
  }: {
    projectId: string;
    isManager: boolean;
    restricted?: boolean;
    /* Where to send someone who has just removed their own last way in. */
    leaveTo?: string | null;
    onchange?: ((members: Member[]) => void) | undefined;
  } = $props();

  const ROLES = ['manager', 'editor', 'commenter', 'viewer'] as const;
  /* What each role can actually do, in the words a person would use. A role
     picker with no explanation is a quiz. */
  const ROLE_NOTES: Record<string, string> = {
    manager: 'Everything, including settings, members and approval.',
    editor: 'Upload versions, organise folders, comment.',
    commenter: 'Watch and leave notes.',
    viewer: 'Watch only.'
  };

  let members = $state<Member[]>([]);
  let workspaceUsers = $state<User[]>([]);
  let addUserId = $state('');
  let addRole = $state<string>('viewer');
  let error = $state('');
  let saved = $state('');
  let loaded = $state(false);
  let loadedFor = '';

  $effect(() => {
    const id = projectId;
    if (!id || loadedFor === id) return;
    loadedFor = id;
    loaded = false;
    void (async () => {
      try {
        const [loadedMembers, loadedUsers] = await Promise.all([
          api<{ items: Member[] }>(`/api/v1/projects/${id}/members`),
          /* Everyone in the workspace, so someone can actually be added --
             including yourself, if you removed your own grant. */
          api<{ items: User[] }>('/api/v1/users').catch(() => ({ items: [] as User[] }))
        ]);
        members = loadedMembers.items;
        workspaceUsers = loadedUsers.items;
        loaded = true;
        onchange?.(members);
      } catch (caught) {
        error = messageFrom(caught, 'The people on this project could not be loaded.');
      }
    })();
  });

  const note = (message: string): void => {
    error = '';
    saved = message;
    onchange?.(members);
  };

  const setRole = async (member: Member, role: string): Promise<void> => {
    try {
      await apiPut(`/api/v1/projects/${projectId}/members/${member.user.id}`, { role });
      members = members.map((entry) =>
        entry.user.id === member.user.id ? { ...entry, role } : entry
      );
      note(`${member.user.name} is now ${role}`);
    } catch (caught) {
      error = messageFrom(caught, 'That role could not be changed.');
    }
  };

  /* Everyone in the workspace who has no role here yet. */
  const addable = $derived(
    workspaceUsers
      .filter((user) => !members.some((member) => member.user.id === user.id))
      .sort((a, b) => a.name.localeCompare(b.name))
  );

  const addMember = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const user = addable.find((candidate) => candidate.id === addUserId);
    if (!user) return;
    try {
      await apiPut(`/api/v1/projects/${projectId}/members/${user.id}`, { role: addRole });
      members = [...members, { user, role: addRole }];
      addUserId = '';
      note(`${user.name} added as ${addRole}`);
    } catch (caught) {
      error = messageFrom(caught, 'That person could not be added.');
    }
  };

  const removeMember = async (member: Member): Promise<void> => {
    /* Removing yourself is allowed -- a manager may genuinely be leaving -- but
       it is a door that locks behind you on a restricted project, so it says so
       rather than just doing it. */
    const isSelf = member.user.id === auth.user?.id;
    const locksOut = isSelf && restricted && auth.user?.role !== 'admin';
    const confirmed = await askConfirm({
      title: isSelf ? 'Remove your own access?' : `Remove ${member.user.name}?`,
      body: isSelf
        ? locksOut
          ? 'This project is restricted, so you will lose access to it immediately and will not be able to add yourself back. A workspace admin, or another manager, would have to.'
          : 'You will lose your role here. The project is not restricted, so you can still open it as a workspace member.'
        : `${member.user.name} loses their role on this project. Their notes stay.`,
      confirmLabel: isSelf ? 'Remove my access' : 'Remove',
      danger: true
    });
    if (!confirmed) return;
    try {
      await apiDelete(`/api/v1/projects/${projectId}/members/${member.user.id}`);
      members = members.filter((entry) => entry.user.id !== member.user.id);
      note(`${member.user.name} removed`);
      if (locksOut && leaveTo) await goto(leaveTo);
    } catch (caught) {
      error = messageFrom(caught, 'That member could not be removed.');
    }
  };
</script>

{#if error}<p class="error" role="alert">{error}</p>{/if}
{#if saved}<p class="saved" role="status">{saved}</p>{/if}
{#if loaded && members.length === 0}
  <p class="empty">No one has a role on this project yet.</p>
{/if}
{#if isManager}
  <form class="addform" onsubmit={addMember}>
    <select bind:value={addUserId} aria-label="Person to add">
      <option value="" disabled>Add someone…</option>
      {#each addable as user (user.id)}
        <option value={user.id}>{user.name} ({user.email})</option>
      {/each}
    </select>
    <select bind:value={addRole} aria-label="Role for the new member">
      {#each ROLES as role (role)}<option value={role}>{role}</option>{/each}
    </select>
    <button type="submit" disabled={!addUserId}>Add</button>
  </form>
  {#if loaded && addable.length === 0}
    <p class="empty">Everyone in the workspace already has a role here.</p>
  {/if}
{/if}
<ul class="members">
  {#each members as member (member.user.id)}
    <li>
      <span class="who">
        <Avatar name={member.user.name} id={member.user.id} url={member.user.avatar_url ?? null} size={30} />
        <span class="whotext">
          <strong>{member.user.name}</strong>
          <small>{member.user.email}</small>
        </span>
      </span>
      <span class="rolecell">
        <select
          value={member.role}
          disabled={!isManager}
          aria-label={`Role for ${member.user.name}`}
          title={ROLE_NOTES[member.role]}
          onchange={(event) => void setRole(member, event.currentTarget.value)}
        >
          {#each ROLES as role (role)}<option value={role}>{role}</option>{/each}
        </select>
      </span>
      <!-- Quiet until meant: a filled red button on every row made the
           list read as a demolition plan. -->
      <button type="button" class="quiet remove" disabled={!isManager} onclick={() => void removeMember(member)}>Remove</button>
    </li>
  {/each}
</ul>
<p class="rolelegend">
  {#each ROLES as role, index (role)}
    <span><strong>{role}</strong> {ROLE_NOTES[role].toLowerCase()}</span>{#if index < ROLES.length - 1}<span class="sep" aria-hidden="true"></span>{/if}
  {/each}
</p>

<style>
  .members { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
  .members li { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 12px; padding: 8px; margin: 0 -8px; border-radius: var(--radius); }
  .members li:hover { background: var(--ink-200); }
  .addform { display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; }
  .addform select { min-width: 0; }
  .addform select:first-child { flex: 1; max-width: 420px; }
  .who { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .whotext { display: grid; gap: 2px; min-width: 0; }
  .who small { color: var(--ink-text-dim); }
  .rolecell { display: grid; justify-items: end; }
  select { border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 7px 10px; font-size: var(--text-13); }
  select:focus-visible { outline: none; background: var(--ink-300); }
  button { border: 0; border-radius: var(--radius); background: var(--accent); color: #0b1214; padding: 8px 14px; font-size: var(--text-13); font-weight: 600; }
  button:hover { background: var(--accent-bright); }
  button.quiet { background: var(--ink-200); color: var(--ink-text); font-weight: 500; }
  button.quiet:hover { background: var(--ink-300); }
  button:disabled { opacity: 0.5; cursor: default; }
  button:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: 2px; }
  /* Removing someone is a real action, not the row's theme: quiet until
     pointed at, and only then does it say what it costs. */
  button.remove { color: var(--ink-text-dim); }
  button.remove:hover:not(:disabled) { background: var(--warn); color: #12080a; }
  /* One legend under the list instead of a note per row saying the same
     four sentences over and over. */
  .rolelegend { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 12px 0 0; color: var(--ink-text-dim); font-size: var(--text-12); }
  .rolelegend strong { color: var(--ink-text); font-weight: 600; }
  .rolelegend .sep { width: 3px; height: 3px; border-radius: 50%; background: var(--ink-300); }
  .empty { margin: 0 0 12px; color: var(--ink-text-dim); }
  .saved { margin: 0 0 12px; color: var(--ink-text-dim); font-size: var(--text-13); }
  .error { margin: 0 0 12px; color: var(--warn); }

  /* Phone: a member row becomes two lines, who they are then what they can do. */
  @media (max-width: 720px) {
    .members li { grid-template-columns: minmax(0, 1fr) auto; row-gap: 6px; }
    .members li .who { grid-column: 1 / -1; }
  }
</style>
