<script lang="ts">
  import { generatedAvatarFor } from '@onelight/core';
  import { washFor } from '$lib/washes.js';

  /* A person's picture, or a generated stand-in that is theirs alone: their
     initial on a wash picked by hashing who they are. Same person, same
     colour, every session and every surface -- so a thread reads by colour
     before it reads by name. */

  interface Props {
    name: string;
    /* Stabilises the colour for registered users; viewers hash by name. */
    id?: string | null;
    url?: string | null;
    size?: number;
  }

  const { name, id = null, url = null, size = 26 }: Props = $props();

  /* A picture that fails to decode falls back to the generated face rather
     than a broken-image glyph. */
  let broken = $state(false);
  $effect(() => {
    void url;
    broken = false;
  });

  const generated = $derived(generatedAvatarFor(name, id));
</script>

{#if url && !broken}
  <img
    class="avatar"
    style={`width: ${size}px; height: ${size}px;`}
    src={url}
    alt=""
    loading="lazy" decoding="async"
    onerror={() => {
      broken = true;
    }}
  />
{:else}
  <span
    class="avatar gen"
    style={`width: ${size}px; height: ${size}px; font-size: ${Math.round(size * 0.44)}px; background-image: ${washFor(generated.palette)};`}
    aria-hidden="true"
  >{generated.initial}</span>
{/if}

<style>
  .avatar { flex: none; border-radius: 50%; object-fit: cover; display: block; }
  .gen { display: grid; place-items: center; background-size: 100% 100%; color: rgba(250, 248, 244, 0.92); font-weight: 600; user-select: none; }
</style>
