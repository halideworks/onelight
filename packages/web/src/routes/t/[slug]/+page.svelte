<script lang="ts">
  import { page } from '$app/state';
  import { PALETTES } from '@onelight/core';
  import { api, apiPost, messageFrom } from '$lib/api.js';
  import { downloadSequentially, triggerDownload } from '$lib/downloads.js';
  import {
    filesFromDataTransfer,
    filesFromInput,
    formatBytes,
    formatRate,
    uploadFile
  } from '$lib/upload.js';
  import type { PendingFile } from '$lib/upload.js';
  import { pageWashFor } from '$lib/washes.js';

  /* The transfer portal: one page for both directions. A package lists the
     files and hands them over; a request takes files in through the same
     engine members use, chunked and verified. Washed world: this page is a
     door for outsiders, not a review surface. */

  type TransferFile = {
    asset_id: string;
    name: string;
    kind: string;
    size: number | null;
    checksum_crc32c: string | null;
  };
  type PublicTransfer = {
    slug: string;
    kind: 'package' | 'request';
    title: string;
    message: string;
    requires_passphrase: boolean;
    expires_at: number | null;
    byte_cap: number | null;
    received_bytes: number;
  };
  type Shell = {
    transfer: PublicTransfer;
    authorized: boolean;
    files: TransferFile[];
  };

  /* The whole route param IS the slug: transfer slugs carry hyphens by
     design, so nothing here may try to parse an id out of them. */
  const slug = $derived(page.params.slug ?? '');

  let shell = $state<Shell | null>(null);
  let error = $state('');
  let gateError = $state('');
  let name = $state('');
  let passphrase = $state('');

  /* The wash is picked by the slug so a link keeps its face between visits
     without the page knowing anything about the project behind it. */
  const wash = $derived.by(() => {
    let hash = 0;
    for (const char of slug) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return pageWashFor(PALETTES[hash % PALETTES.length] ?? 'sumimai');
  });

  const load = async (at: string): Promise<void> => {
    shell = null;
    error = '';
    try {
      shell = await api<Shell>(`/api/v1/t/${at}`);
    } catch (caught) {
      error = messageFrom(caught, 'This transfer link is not available.');
    }
  };

  $effect(() => {
    if (slug) void load(slug);
  });

  const access = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    gateError = '';
    try {
      shell = await apiPost<Shell>(`/api/v1/t/${slug}/access`, {
        name,
        ...(passphrase ? { passphrase } : {})
      });
    } catch (caught) {
      gateError = messageFrom(caught, 'That did not work. Check the passphrase.');
    }
  };

  /* ------------------------------ Package ------------------------------ */

  let downloadBusy = $state<string | null>(null);

  const downloadOne = async (file: TransferFile): Promise<void> => {
    downloadBusy = file.asset_id;
    try {
      const signed = await apiPost<{ url: string }>(
        `/api/v1/t/${slug}/files/${file.asset_id}/download`,
        {}
      );
      triggerDownload(signed.url);
    } catch (caught) {
      error = messageFrom(caught, 'The download could not start.');
    } finally {
      downloadBusy = null;
    }
  };

  /* Every file, one at a time, through the browser's own download manager:
     an interruption costs one file, not the batch. */
  let bulkNote = $state('');
  let bulkRunning = $state(false);
  const downloadAllFiles = async (): Promise<void> => {
    const files = shell?.files ?? [];
    if (bulkRunning || files.length === 0) return;
    bulkRunning = true;
    bulkNote = '';
    try {
      const result = await downloadSequentially(
        files.map((file) => ({
          label: file.name,
          url: async () =>
            (
              await apiPost<{ url: string }>(
                `/api/v1/t/${slug}/files/${file.asset_id}/download`,
                {}
              )
            ).url
        })),
        (progress) => {
          bulkNote = `Starting ${Math.min(progress.done + 1, progress.total)} of ${progress.total}`;
        }
      );
      bulkNote =
        result.skipped.length > 0
          ? `${result.started} started. Could not start: ${result.skipped.join(', ')}`
          : `${result.started} downloads started.`;
    } finally {
      bulkRunning = false;
    }
  };

  const packageBytes = $derived(
    (shell?.files ?? []).reduce((sum, file) => sum + (file.size ?? 0), 0)
  );

  /* ------------------------------ Request ------------------------------ */

  type SendItem = {
    file: File;
    relativePath: string;
    status: 'waiting' | 'sending' | 'sent' | 'failed';
    bytes: number;
    rate: number;
    sessionId: string | null;
    error: string;
  };

  let queue = $state<SendItem[]>([]);
  let sending = $state(false);
  let dragOver = $state(false);
  let picker = $state<HTMLInputElement | null>(null);

  const capacityLeft = $derived.by(() => {
    const transfer = shell?.transfer;
    if (!transfer || transfer.byte_cap === null) return null;
    const queued = queue.reduce(
      (sum, item) => sum + (item.status === 'sent' ? 0 : item.file.size),
      0
    );
    return transfer.byte_cap - transfer.received_bytes - queued;
  });

  const enqueue = (found: PendingFile[]): void => {
    for (const pending of found)
      queue.push({
        file: pending.file,
        relativePath: pending.relativePath,
        status: 'waiting',
        bytes: 0,
        rate: 0,
        sessionId: null,
        error: ''
      });
    void pump();
  };

  const sendOne = async (item: SendItem): Promise<void> => {
    item.status = 'sending';
    item.error = '';
    try {
      const sessionId = await uploadFile({
        transferSlug: slug,
        file: item.file,
        relativePath: item.relativePath,
        sessionId: item.sessionId,
        onSession: (session) => {
          item.sessionId = session;
        },
        onProgress: (progress) => {
          item.bytes = progress.bytes;
          item.rate = progress.rate;
        }
      });
      item.sessionId = sessionId;
      item.rate = 0;
      item.status = 'sent';
      /* The cap meter and received bytes come from the server's ledger. */
      try {
        shell = await api<Shell>(`/api/v1/t/${slug}`);
      } catch {
        /* The finished upload stands either way. */
      }
    } catch (caught) {
      item.rate = 0;
      item.status = 'failed';
      item.error = messageFrom(caught, 'This file could not be sent.');
    }
  };

  const pump = async (): Promise<void> => {
    if (sending) return;
    sending = true;
    try {
      for (;;) {
        const next = queue.find((item) => item.status === 'waiting');
        if (!next) break;
        await sendOne(next);
      }
    } finally {
      sending = false;
    }
  };

  const retry = (item: SendItem): void => {
    item.status = 'waiting';
    void pump();
  };

  const drop = async (event: DragEvent): Promise<void> => {
    event.preventDefault();
    dragOver = false;
    if (!event.dataTransfer) return;
    enqueue(await filesFromDataTransfer(event.dataTransfer));
  };

  const picked = (event: Event): void => {
    const input = event.currentTarget as HTMLInputElement;
    if (input.files) enqueue(filesFromInput(input.files));
    input.value = '';
  };

  const progressOf = (item: SendItem): number =>
    item.file.size > 0 ? Math.min(1, item.bytes / item.file.size) : 0;
</script>

<svelte:head>
  <title>{shell?.transfer.title ?? 'Transfer'} - Onelight</title>
</svelte:head>

{#if error && !shell}
  <main class="shell" style={`background-image: ${wash};`}>
    <div class="inner"><p role="alert">{error}</p></div>
  </main>
{:else if shell && !shell.authorized}
  <main class="shell access" style={`background-image: ${wash};`}>
    <div class="inner">
      <h1>{shell.transfer.title}</h1>
      {#if shell.transfer.kind === 'request'}
        <p class="lede">You have been asked to send files here.</p>
      {/if}
      <form onsubmit={access}>
        {#if shell.transfer.requires_passphrase}
          <label>Passphrase <input type="password" bind:value={passphrase} required /></label>
        {/if}
        <label>Your name <input bind:value={name} required /></label>
        {#if gateError}<p class="error" role="alert">{gateError}</p>{/if}
        <button type="submit">Continue</button>
      </form>
    </div>
  </main>
{:else if shell}
  <main class="shell room" style={`background-image: ${wash};`}>
    <div class="inner">
      <header>
        <h1>{shell.transfer.title}</h1>
        {#if shell.transfer.message}<p class="message">{shell.transfer.message}</p>{/if}
      </header>

      {#if shell.transfer.kind === 'package'}
        {#if shell.files.length === 0}
          <p class="empty">Nothing here yet.</p>
        {:else}
          <div class="actions">
            <a class="primary" href={`/api/v1/t/${slug}/zip`} download>
              Download everything
              <small>{shell.files.length} {shell.files.length === 1 ? 'file' : 'files'} / {formatBytes(packageBytes)} / .zip</small>
            </a>
            {#if shell.files.length > 1}
              <button
                type="button"
                class="onebyone"
                disabled={bulkRunning}
                onclick={() => void downloadAllFiles()}
              >
                {bulkRunning ? bulkNote || 'Starting downloads' : 'Download one at a time'}
              </button>
            {/if}
            {#if !bulkRunning && bulkNote}<span class="bulknote">{bulkNote}</span>{/if}
          </div>
          <ul class="files" aria-label="Files">
            {#each shell.files as file (file.asset_id)}
              <li>
                <span class="filename">{file.name}</span>
                <span class="meta">{file.size !== null ? formatBytes(file.size) : ''}</span>
                <button
                  type="button"
                  class="get"
                  disabled={downloadBusy === file.asset_id}
                  onclick={() => void downloadOne(file)}
                >Download</button>
              </li>
            {/each}
          </ul>
          {#if error}<p class="error" role="alert">{error}</p>{/if}
        {/if}
      {:else}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="dropzone"
          class:over={dragOver}
          ondragover={(event) => {
            event.preventDefault();
            dragOver = true;
          }}
          ondragleave={() => (dragOver = false)}
          ondrop={drop}
        >
          <p>Drop files or folders here</p>
          <button type="button" onclick={() => picker?.click()}>Choose files</button>
          <input bind:this={picker} type="file" multiple onchange={picked} hidden />
        </div>
        {#if shell.transfer.byte_cap !== null}
          <p class="cap">
            {formatBytes(shell.transfer.received_bytes)} of {formatBytes(shell.transfer.byte_cap)} used
            {#if capacityLeft !== null && capacityLeft < 0}<span class="error">The next files will not fit.</span>{/if}
          </p>
        {/if}
        {#if queue.length}
          <ul class="files sendlist" aria-label="Files being sent">
            {#each queue as item (item)}
              <li>
                <span class="filename">{item.relativePath || item.file.name}</span>
                <span class="meta">
                  {#if item.status === 'sending'}
                    {formatBytes(item.bytes)} of {formatBytes(item.file.size)}{item.rate > 0 ? ` / ${formatRate(item.rate)}` : ''}
                  {:else if item.status === 'sent'}
                    Sent, {formatBytes(item.file.size)}
                  {:else if item.status === 'failed'}
                    <span class="error">{item.error}</span>
                  {:else}
                    Waiting
                  {/if}
                </span>
                {#if item.status === 'failed'}
                  <button type="button" class="get" onclick={() => retry(item)}>Try again</button>
                {:else if item.status === 'sending'}
                  <span class="bar" aria-hidden="true"><span style={`width: ${progressOf(item) * 100}%;`}></span></span>
                {:else if item.status === 'sent'}
                  <span class="done">Received</span>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
    </div>
  </main>
{:else}
  <main class="shell" style={`background-image: ${wash};`}>
    <div class="inner"><p class="empty">Loading.</p></div>
  </main>
{/if}

<style>
  .shell {
    min-height: 100vh;
    padding: 48px clamp(24px, 5vw, 96px);
    color: var(--ink-text);
    background-color: var(--ink-000);
    background-repeat: repeat, no-repeat;
  }
  .inner { width: min(760px, 100%); margin: 0 auto; }
  .access { display: grid; align-content: center; }
  .access .lede { margin: 0 0 18px; color: rgba(240, 236, 226, 0.78); }
  .access form {
    padding: 26px;
    border-radius: var(--radius-lg);
    background: rgba(10, 13, 18, 0.6);
    backdrop-filter: blur(18px);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08);
    display: grid;
    gap: 16px;
    max-width: 420px;
  }
  .access label { display: grid; gap: 8px; color: rgba(240, 236, 226, 0.86); font-size: var(--text-13); font-weight: 500; }
  .access input { border: 0; border-radius: var(--radius); background: rgba(13, 17, 23, 0.62); color: inherit; padding: 11px 12px; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.14); }
  .access input:focus-visible { outline: 2px solid var(--accent-bright); outline-offset: 2px; }
  .access form button { border: 0; border-radius: var(--radius); background: #e7dfc8; color: #202832; padding: 12px 16px; text-align: left; font-weight: 500; cursor: pointer; }

  .room h1 { margin: 0 0 6px; font-family: var(--font-display); font-size: clamp(26px, 4vw, 38px); letter-spacing: -0.01em; }
  .room header { margin: 8vh 0 26px; }
  .message { margin: 8px 0 0; max-width: 56ch; color: rgba(240, 236, 226, 0.82); white-space: pre-line; }

  .actions { margin: 0 0 14px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .onebyone { border: 0; border-radius: var(--radius); background: rgba(231, 223, 200, 0.16); color: var(--ink-text); padding: 11px 16px; font-size: var(--text-13); font-weight: 500; cursor: pointer; font-family: inherit; }
  .onebyone:hover { background: rgba(231, 223, 200, 0.26); }
  .onebyone:disabled { opacity: 0.7; cursor: default; }
  .bulknote { color: rgba(240, 236, 226, 0.72); font-size: var(--text-13); }
  .primary {
    display: inline-grid;
    gap: 2px;
    border-radius: var(--radius);
    background: #e7dfc8;
    color: #202832;
    padding: 13px 18px;
    font-weight: 500;
    text-decoration: none;
  }
  .primary small { font-weight: 400; font-size: var(--text-12); color: rgba(32, 40, 50, 0.72); }

  .files { list-style: none; margin: 0; padding: 0; display: grid; }
  .files li {
    display: grid;
    grid-template-columns: 1fr auto auto;
    align-items: center;
    gap: 14px;
    padding: 13px 16px;
    border-radius: var(--radius);
    background: rgba(10, 13, 18, 0.5);
  }
  .files li + li { margin-top: 6px; }
  .filename { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { color: rgba(240, 236, 226, 0.66); font-size: var(--text-13); }
  .get {
    border: 0;
    border-radius: var(--radius);
    background: rgba(231, 223, 200, 0.16);
    color: var(--ink-text);
    padding: 8px 14px;
    font-size: var(--text-13);
    font-weight: 500;
    cursor: pointer;
  }
  .get:hover { background: rgba(231, 223, 200, 0.26); }
  .get:disabled { opacity: 0.6; cursor: default; }
  .done { color: rgba(240, 236, 226, 0.66); font-size: var(--text-13); }

  .dropzone {
    display: grid;
    justify-items: center;
    gap: 12px;
    padding: 52px 24px;
    border-radius: var(--radius-lg);
    background: rgba(10, 13, 18, 0.5);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.1);
    text-align: center;
    margin-bottom: 16px;
  }
  .dropzone.over { box-shadow: inset 0 0 0 2px var(--accent-bright); }
  .dropzone p { margin: 0; color: rgba(240, 236, 226, 0.82); }
  .dropzone button {
    border: 0;
    border-radius: var(--radius);
    background: #e7dfc8;
    color: #202832;
    padding: 11px 18px;
    font-weight: 500;
    cursor: pointer;
  }

  .cap { margin: 0 0 12px; color: rgba(240, 236, 226, 0.72); font-size: var(--text-13); }
  .sendlist .bar {
    position: relative;
    width: 120px;
    height: 4px;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.14);
    overflow: hidden;
  }
  .sendlist .bar span { position: absolute; inset: 0 auto 0 0; background: var(--accent-bright); border-radius: 2px; }
  .error { color: #f2b8ab; }
  .empty { color: rgba(240, 236, 226, 0.7); }

  @keyframes rise {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: none; }
  }
  .inner h1 { animation: rise 560ms cubic-bezier(0.22, 1, 0.36, 1) both; }
  .shell form, .actions, .files, .dropzone { animation: rise 560ms cubic-bezier(0.22, 1, 0.36, 1) 90ms both; }
  @media (prefers-reduced-motion: reduce) {
    .inner h1, .shell form, .actions, .files, .dropzone { animation: none; }
  }
</style>
