<script lang="ts">
  /* A full-window look at one image: dark veil, the picture as large as the
     window allows, Escape or any click puts it away.

     Built on a native <dialog> opened with showModal(), so the browser traps
     Tab inside it and restores focus to whatever opened it on close -- the
     hand-rolled veil did neither, letting keyboard focus wander the page behind
     the picture and dropping it to <body> on close. Mirrors ConfirmHost. */

  interface Props {
    url: string;
    name?: string;
    onclose: () => void;
  }

  const { url, name = '', onclose }: Props = $props();

  let dialog = $state<HTMLDialogElement | null>(null);

  $effect(() => {
    const element = dialog;
    if (!element) return;
    if (!element.open) element.showModal();
    /* The dialog's own 'close' (Escape is handled natively) routes back to the
       parent so it can unmount us. */
    const onNativeClose = (): void => onclose();
    element.addEventListener('close', onNativeClose);
    return () => element.removeEventListener('close', onNativeClose);
  });

  const dismiss = (): void => dialog?.close();
</script>

<!-- A click on the ::backdrop targets the dialog itself; a click on the picture
     stops at the picture. -->
<dialog
  bind:this={dialog}
  class="veil"
  aria-label={name || 'Image'}
  onclick={(event) => { if (event.target === dialog) dismiss(); }}
>
  <img src={url} alt={name} />
  {#if name}<p class="caption">{name}</p>{/if}
  <button type="button" class="close" aria-label="Close" onclick={dismiss}>
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>
  </button>
</dialog>

<style>
  .veil { position: fixed; inset: 0; width: 100vw; height: 100vh; max-width: 100vw; max-height: 100vh; margin: 0; padding: 0; border: 0; z-index: 60; display: grid; place-items: center; background: rgba(5, 7, 10, 0.9); color: inherit; outline: none; animation: lightbox-in 200ms ease both; cursor: zoom-out; }
  .veil::backdrop { background: transparent; }
  img { max-width: min(94vw, 1800px); max-height: 88vh; object-fit: contain; border-radius: 3px; cursor: default; }
  .caption { position: absolute; bottom: 18px; left: 50%; transform: translateX(-50%); margin: 0; color: rgba(250, 248, 244, 0.75); font-size: 13px; }
  .close { position: absolute; top: 16px; right: 16px; display: grid; place-items: center; width: 38px; height: 38px; padding: 0; border: 0; border-radius: 50%; background: rgba(13, 17, 23, 0.6); color: rgba(250, 248, 244, 0.85); cursor: pointer; }
  .close:hover { background: rgba(13, 17, 23, 0.9); color: #fff; }
  @keyframes lightbox-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    .veil { animation: none; }
  }
</style>
