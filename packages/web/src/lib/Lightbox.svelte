<script lang="ts">
  /* A full-window look at one image: dark veil, the picture as large as the
     window allows, Escape or any click puts it away. */

  interface Props {
    url: string;
    name?: string;
    onclose: () => void;
  }

  const { url, name = '', onclose }: Props = $props();

  const focusSelf = (element: HTMLElement): void => {
    element.focus();
  };
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="veil"
  role="dialog"
  aria-modal="true"
  aria-label={name || 'Image'}
  tabindex="-1"
  use:focusSelf
  onclick={onclose}
  onkeydown={(event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onclose();
    }
  }}
>
  <img src={url} alt={name} />
  {#if name}<p class="caption">{name}</p>{/if}
  <button type="button" class="close" aria-label="Close" onclick={onclose}>
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>
  </button>
</div>

<style>
  .veil { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; background: rgba(5, 7, 10, 0.9); outline: none; animation: lightbox-in 200ms ease both; cursor: zoom-out; }
  img { max-width: min(94vw, 1800px); max-height: 88vh; object-fit: contain; border-radius: 3px; }
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
