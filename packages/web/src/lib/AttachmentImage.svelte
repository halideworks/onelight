<script lang="ts">
  import type { CommentAttachment } from '$lib/comments.js';

  /* An attached image, shown as itself: the thumbnail resolves its signed
     URL on mount and refreshes it once if it expires under the viewer.
     Clicking hands the URL to the host's lightbox. */

  interface Props {
    attachment: CommentAttachment;
    /* Resolves a fresh signed URL; the host owns which endpoint signs. */
    resolve: () => Promise<string>;
    onopen: (url: string, attachment: CommentAttachment) => void;
  }

  const { attachment, resolve, onopen }: Props = $props();

  let url = $state<string | null>(null);
  let failed = $state(false);
  let retried = false;

  $effect(() => {
    void attachment.id;
    void (async () => {
      try {
        url = await resolve();
      } catch {
        failed = true;
      }
    })();
  });

  const onError = async (): Promise<void> => {
    /* Signed URLs live 15 minutes; one refresh covers the viewer who left
       the thread open. A second failure is a real failure. */
    if (retried) {
      failed = true;
      return;
    }
    retried = true;
    try {
      url = await resolve();
    } catch {
      failed = true;
    }
  };
</script>

{#if url && !failed}
  <button
    type="button"
    class="thumb"
    title={attachment.filename}
    onclick={async () => {
      try {
        onopen(await resolve(), attachment);
      } catch {
        /* The thumbnail stays; the lightbox just does not open. */
      }
    }}
  >
    <img src={url} alt={attachment.filename} loading="lazy" onerror={() => void onError()} />
  </button>
{:else if failed}
  <span class="dead">{attachment.filename}</span>
{/if}

<style>
  .thumb { display: block; max-width: 220px; border: 0; border-radius: var(--radius, 3px); overflow: hidden; padding: 0; background: none; cursor: zoom-in; }
  /* Minimum bounds keep a tiny image a real target; cover scales it up
     rather than leaving a sliver nobody can click. */
  .thumb img { display: block; min-width: 56px; min-height: 36px; max-width: 100%; max-height: 140px; object-fit: cover; border-radius: inherit; }
  .thumb:hover img { opacity: 0.9; }
  .dead { color: inherit; opacity: 0.6; font-size: 12px; }
</style>
