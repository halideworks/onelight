<script lang="ts">
  import { washFor } from '$lib/washes.js';

  /* A project's picture, in the one place that decides what a project looks
     like. Two cases, one component: a cover the project chose, or a generated
     one.

     The generated cover is not a placeholder standing in until someone uploads
     a real image -- most projects will never set one, so it has to be good on
     its own. It is built from what the project already has: the palette wash it
     was assigned at creation, its monogram, and a light source placed by
     hashing the id. Same project, same cover, every session and every machine,
     with no storage and no request. */

  interface Props {
    /* Anything with an identity and a picture: a project, or a shared asset
       drawing its poster. The generated case needs a name to letter and an id
       to hash, which both have. */
    project: { id: string; name: string; palette: string; cover_url?: string | null };
    /* Grid cards want the monogram; a 34x24 list swatch would just show a
       cropped letter, so it gets the wash and the light alone. */
    monogram?: boolean;
  }

  const { project, monogram = true }: Props = $props();

  /* A cover URL that does not decode is the one case that used to reach the
     viewer as a broken image: signed poster URLs expire, and a share can be
     opened long after its link was minted. Falling back to the generated cover
     keeps a picture in the frame, and it is the same picture this project
     would have had with no cover at all. */
  let broken = $state(false);
  $effect(() => {
    /* A new URL deserves a fresh attempt. */
    project.cover_url;
    broken = false;
  });

  /* Two initials at most: "Fall Campaign" -> FC, "Reel" -> R. Splitting on
     whitespace keeps hyphenated and punctuated names from producing noise. */
  const initials = $derived(
    project.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => [...word][0]?.toUpperCase() ?? '')
      .join(''),
  );

  const hash = $derived.by(() => {
    let value = 2166136261;
    for (let index = 0; index < project.id.length; index += 1) {
      value ^= project.id.charCodeAt(index);
      value = Math.imul(value, 16777619);
    }
    return value >>> 0;
  });

  /* The light stays in the upper band and off the monogram's left edge, so
     every draw of the hash lands somewhere that still looks composed. */
  const lightX = $derived(24 + (hash % 56));
  const lightY = $derived(8 + ((hash >>> 8) % 34));
  const tilt = $derived(((hash >>> 16) % 9) - 4);
</script>

{#if project.cover_url && !broken}
  <span class="cover" aria-hidden="true">
    <img
      src={project.cover_url}
      alt=""
      loading="lazy"
      onerror={() => {
        broken = true;
      }}
    />
  </span>
{:else}
  <span
    class="cover generated"
    aria-hidden="true"
    style={`background-image: radial-gradient(120% 90% at ${lightX}% ${lightY}%, rgba(255, 255, 255, 0.17), rgba(255, 255, 255, 0) 62%), ${washFor(project.palette)};`}
  >
    {#if monogram && initials}
      <span class="mono" style={`transform: rotate(${tilt}deg);`}>{initials}</span>
    {/if}
  </span>
{/if}

<style>
  .cover { display: block; position: relative; overflow: hidden; background-size: 100% 100%; background-color: var(--ink-200); }
  img { width: 100%; height: 100%; object-fit: cover; display: block; }

  /* The cover is its own container, so the monogram is sized against the box it
     sits in rather than a fixed pixel size that only suits one of them: the
     same rule reads correctly on a 104px grid card and a 200px settings
     preview. */
  .generated { container-type: size; }

  /* The monogram is architecture, not a label: large, set into the lower right,
     and dim enough that the name underneath stays the thing you read. It sits
     fully inside the frame -- a letter clipped by the bottom edge reads as a
     bug, not as a crop. */
  .mono {
    position: absolute;
    right: 7cqw;
    bottom: 6cqh;
    font-family: var(--font-display);
    font-size: 58cqh;
    line-height: 0.78;
    letter-spacing: -0.04em;
    color: rgba(255, 255, 255, 0.18);
    user-select: none;
  }
</style>
