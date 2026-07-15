<script lang="ts">
  import { tick } from 'svelte';
  import { messageFrom } from '$lib/api.js';
  import { whenAbsolute, whenRelative, excerpt } from '$lib/format.js';
  import { notifications, describeNotification, notificationLink } from '$lib/notifications.svelte.js';

  let { open = $bindable(false) }: { open?: boolean } = $props();

  let dialog = $state<HTMLDialogElement | null>(null);
  /* Drives the transform. Kept separate from `open` because the panel has to be
     displayed before it can animate in, and has to finish animating out before
     it stops being displayed. */
  let shown = $state(false);
  let error = $state('');

  const MOTION_MS = 180;
  const reducedMotion = (): boolean =>
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const unreadIds = $derived(
    notifications.items.filter((item) => item.read_at === null).map((item) => item.id)
  );

  /* showModal() gives the focus trap, Escape, inert background, and the top
     layer for free -- all of which a hand-rolled overlay would have to
     reimplement. A dialog cannot transition straight out of display:none, so
     the transform flips one frame after it is shown. */
  $effect(() => {
    if (open) {
      if (dialog?.open) return;
      dialog?.showModal();
      error = '';
      void notifications.refresh().catch(() => {
        /* The list already on screen stands in; the poll retries. */
      });
      if (reducedMotion()) {
        shown = true;
        return;
      }
      requestAnimationFrame(() => {
        shown = true;
      });
    } else if (dialog?.open) {
      void dismiss();
    }
  });

  const dismiss = async (): Promise<void> => {
    shown = false;
    if (!reducedMotion()) await new Promise((resolve) => setTimeout(resolve, MOTION_MS));
    dialog?.close();
  };

  const close = (): void => {
    open = false;
  };

  /* Escape fires `cancel`, which would close the dialog instantly and skip the
     out transition. */
  const onCancel = (event: Event): void => {
    event.preventDefault();
    close();
  };

  /* A click on the ::backdrop is dispatched with the dialog itself as target;
     clicks inside the panel target its children. */
  const onClick = (event: MouseEvent): void => {
    if (event.target === dialog) close();
  };

  const follow = async (id: string): Promise<void> => {
    await markOne(id);
    close();
  };

  const markOne = async (id: string): Promise<void> => {
    try {
      await notifications.markRead([id]);
      error = '';
    } catch (caught) {
      error = messageFrom(caught, 'The notification could not be marked read.');
    }
  };

  const markAllVisible = async (): Promise<void> => {
    try {
      await notifications.markRead(unreadIds);
      error = '';
    } catch (caught) {
      error = messageFrom(caught, 'Notifications could not be marked read.');
    }
  };

  const loadMore = async (): Promise<void> => {
    try {
      await notifications.loadMore();
      error = '';
    } catch (caught) {
      error = messageFrom(caught, 'More notifications could not be loaded.');
    }
    await tick();
  };
</script>

<dialog bind:this={dialog} class:shown aria-label="Notifications" oncancel={onCancel} onclick={onClick}>
  <div class="panel">
    <div class="head">
      <h2>Notifications</h2>
      {#if unreadIds.length > 0}
        <button type="button" class="quiet" onclick={markAllVisible}>Mark all read</button>
      {/if}
      <button type="button" class="icon" onclick={close} aria-label="Close notifications">
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>
    {#if error}<p class="error" role="alert">{error}</p>{/if}

    <section aria-label="Notifications" class="list">
      {#if notifications.loaded && notifications.items.length === 0}
        <p class="empty">Nothing yet. Comments, approvals, and transcode results land here.</p>
      {/if}
      {#each notifications.items as item (item.id)}
        {@const described = describeNotification(item)}
        {@const link = notificationLink(item)}
        <article class:unread={item.read_at === null}>
          <span class="dot" aria-hidden="true"></span>
          <div class="body">
            {#if link}
              <a href={link} onclick={() => void follow(item.id)}>{described.title}</a>
            {:else}
              <span class="title">{described.title}</span>
            {/if}
            {#if described.detail}<p class="detail">{excerpt(described.detail)}</p>{/if}
          </div>
          <span class="when" title={whenAbsolute(item.created_at)}>{whenRelative(item.created_at)}</span>
          {#if item.read_at === null}
            <button type="button" class="quiet" onclick={() => markOne(item.id)}>Mark read</button>
          {/if}
        </article>
      {/each}
      {#if notifications.nextCursor}
        <button type="button" class="quiet more" onclick={loadMore}>Load older</button>
      {/if}
    </section>

    <a class="prefs" href="/settings/notifications" onclick={close}>Notification preferences</a>
  </div>
</dialog>

<style>
  /* Right-hand drawer: full height, a slice of the width, over the page it was
     opened from. margin-inline-start:auto is what pins it right, since a modal
     dialog is otherwise centred. */
  dialog {
    width: min(420px, 100vw);
    max-width: 100vw;
    height: 100dvh;
    max-height: 100dvh;
    margin: 0 0 0 auto;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: var(--ink-100);
    color: var(--ink-text);
    transform: translateX(100%);
    transition: transform 180ms ease-out;
  }
  dialog.shown {
    transform: translateX(0);
  }
  dialog::backdrop {
    background: rgba(5, 8, 12, 0.7);
  }
  @media (prefers-reduced-motion: reduce) {
    dialog {
      transition: none;
    }
  }

  .panel { display: flex; flex-direction: column; height: 100%; padding: 20px 18px; overflow-y: auto; }
  .head { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
  h2 { flex: 1; margin: 0; font-family: var(--font-display); font-size: var(--text-16); font-weight: 700; }
  .list { display: grid; gap: 2px; align-content: start; flex: 1; }
  article { display: flex; align-items: baseline; gap: 10px; padding: 10px 12px; margin: 0 -12px; border-radius: var(--radius); background: var(--ink-100); font-size: var(--text-13); }
  .dot { width: 6px; height: 6px; border-radius: 50%; flex: none; align-self: center; background: transparent; }
  article.unread .dot { background: var(--accent); }
  article.unread { background: var(--ink-200); }
  .body { flex: 1; min-width: 0; display: grid; gap: 3px; }
  .body a, .title { color: var(--ink-text); font-weight: 500; text-decoration: none; }
  .body a:hover { color: var(--accent-bright); }
  .detail { margin: 0; color: var(--ink-text-dim); overflow-wrap: anywhere; }
  .when { color: var(--ink-text-dim); font-size: var(--text-13); white-space: nowrap; font-variant-numeric: tabular-nums; }
  button { border: 0; border-radius: var(--radius); background: var(--accent); color: #0b1214; padding: 9px 16px; font-size: var(--text-13); font-weight: 600; }
  button:hover { background: var(--accent-bright); }
  button.quiet { background: var(--ink-200); color: var(--ink-text); font-weight: 500; padding: 6px 10px; }
  button.quiet:hover { background: var(--ink-300); }
  button.icon { background: none; color: var(--ink-text-dim); padding: 6px; margin: -6px; display: inline-flex; }
  button.icon:hover { background: none; color: var(--ink-text); }
  .more { justify-self: start; margin-top: 10px; }
  .prefs { margin-top: 16px; color: var(--ink-text-dim); font-size: var(--text-13); text-decoration: none; }
  .prefs:hover { color: var(--ink-text); }
  .empty { color: var(--ink-text-dim); font-size: var(--text-13); }
  .error { color: var(--warn); font-size: var(--text-13); }
  button:focus-visible, a:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: 2px; }
</style>
