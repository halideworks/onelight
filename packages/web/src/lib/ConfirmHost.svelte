<script lang="ts">
  import { confirmState, settleConfirm } from '$lib/confirm.svelte.js';

  /* Mounted once, in the root layout. showModal() carries the focus trap,
     Escape, the inert background and the top layer, so none of that is
     hand-rolled here -- the same reason the notifications drawer is a dialog. */
  let dialog = $state<HTMLDialogElement | null>(null);
  let text = $state('');
  const pending = $derived(confirmState.pending);

  $effect(() => {
    if (pending && !dialog?.open) {
      text = pending.initial ?? '';
      dialog?.showModal();
    } else if (!pending && dialog?.open) dialog.close();
  });

  /* A prompt with an empty field has nothing to submit; the button says so
     rather than accepting and failing later. */
  const ready = $derived(!pending?.prompt || text.trim().length > 0);

  const accept = (): void => {
    if (!pending) return;
    if (!pending.prompt) {
      settleConfirm(true);
      return;
    }
    if (!ready) return;
    settleConfirm(text.trim());
  };

  const dismiss = (): void => settleConfirm(pending?.prompt ? null : false);

  /* A click on the ::backdrop is dispatched with the dialog as its target. */
  const onClick = (event: MouseEvent): void => {
    if (event.target === dialog) dismiss();
  };

  const focusField = (node: HTMLInputElement): void => {
    node.focus();
    node.select();
  };
</script>

<dialog
  bind:this={dialog}
  aria-labelledby="confirm-title"
  oncancel={(event) => {
    event.preventDefault();
    dismiss();
  }}
  onclick={onClick}
>
  {#if pending}
    <div class="body">
      <h2 id="confirm-title">{pending.title}</h2>
      {#if pending.body}<p>{pending.body}</p>{/if}
      {#if pending.prompt}
        <!-- A form so Enter submits, which is what every prompt has ever done. -->
        <form
          onsubmit={(event) => {
            event.preventDefault();
            accept();
          }}
        >
          <input
            bind:value={text}
            use:focusField
            aria-label={pending.label ?? pending.title}
            placeholder={pending.placeholder ?? ''}
            maxlength="200"
          />
        </form>
      {/if}
      <div class="actions">
        <button type="button" class="quiet" onclick={dismiss}>
          {pending.cancelLabel ?? 'Cancel'}
        </button>
        <!-- Autofocus lands on Cancel, never on the destructive button: a
             stray Enter should not delete anything. -->
        <button
          type="button"
          class:danger={pending.danger}
          class:primary={!pending.danger}
          disabled={!ready}
          onclick={accept}
        >
          {pending.confirmLabel ?? 'Confirm'}
        </button>
      </div>
    </div>
  {/if}
</dialog>

<style>
  dialog { width: min(420px, calc(100vw - 48px)); padding: 0; border: 0; border-radius: var(--radius-lg); background: var(--ink-100); color: var(--ink-text); box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55); }
  dialog::backdrop { background: rgba(5, 8, 12, 0.7); }
  /* minmax(0, 1fr), not the implicit auto track: these bodies interpolate raw
     filenames, and an auto track refuses to shrink below their min-content
     width, which pushed the dialog past its own box and grew a scrollbar. */
  .body { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; padding: 20px; }
  h2 { margin: 0; font-size: var(--text-16); font-weight: 600; overflow-wrap: anywhere; }
  p { margin: 0; color: var(--ink-text-dim); font-size: var(--text-13); line-height: 1.5; overflow-wrap: anywhere; }
  form { display: grid; grid-template-columns: minmax(0, 1fr); }
  input { border: 0; border-radius: var(--radius); background: var(--ink-200); color: var(--ink-text); padding: 9px 12px; font-size: var(--text-13); }
  input::placeholder { color: var(--ink-text-dim); }
  input:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: 1px; }
  .actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 8px; }
  button { border: 0; border-radius: var(--radius); padding: 8px 14px; font-size: var(--text-13); font-weight: 600; }
  button:disabled { opacity: 0.5; cursor: default; }
  .primary { background: var(--accent); color: #0b1214; }
  .primary:not(:disabled):hover { background: var(--accent-bright); }
  /* Destructive actions are red, and only destructive actions are red. */
  .danger { background: var(--warn); color: #12080a; }
  .danger:not(:disabled):hover { filter: brightness(1.12); }
  .quiet { background: var(--ink-200); color: var(--ink-text); font-weight: 500; }
  .quiet:hover { background: var(--ink-300); }
  button:focus-visible { outline: 1px solid var(--accent-bright); outline-offset: 2px; }
  @media (max-width: 720px) {
    dialog { width: min(420px, calc(100vw - 24px)); }
    .body { padding: 16px; }
    /* Full-width stacked buttons: at this size a right-aligned pair leaves the
       confirm under the thumb of nobody in particular. */
    .actions { flex-direction: column-reverse; }
    .actions button { width: 100%; }
  }
  @media (pointer: coarse) {
    button { min-height: var(--tap); }
  }
</style>
