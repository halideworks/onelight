<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';

  /* The rail in the layout is the index now; this route just lands on the
     first section instead of showing a second copy of the same links. */
  onMount(() => {
    void goto('/settings/profile', { replaceState: true });
  });
</script>

<svelte:head><title>Settings | Onelight</title></svelte:head>
