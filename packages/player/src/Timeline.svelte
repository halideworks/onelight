<script lang="ts">
  import {
    SUPPORTED_RATES,
    formatTimecode,
    isDropFrameRate,
    timecodeFromFrames
  } from '@onelight/core';
  import { frameForX, spanForRange, xForFrame } from './timeline.js';
  import type { TimelineMarker } from './timeline.js';

  let {
    frame,
    durationFrames,
    rate = { num: 24, den: 1 },
    dropFrame = false,
    inFrame = null,
    outFrame = null,
    markers = [],
    onseek = undefined,
    onmarkerselect = undefined
  }: {
    frame: number;
    durationFrames: number;
    rate?: { num: number; den: number };
    dropFrame?: boolean;
    inFrame?: number | null;
    outFrame?: number | null;
    markers?: TimelineMarker[];
    onseek?: ((frame: number) => void) | undefined;
    onmarkerselect?: ((markerId: string, frame: number) => void) | undefined;
  } = $props();

  let track: HTMLDivElement | undefined = $state();
  let scrubbing = $state(false);
  let hovered = $state<TimelineMarker | null>(null);
  let hoveredPercent = $state(0);

  const lastFrame = $derived(Math.max(0, durationFrames - 1));
  const rateSupported = $derived(
    SUPPORTED_RATES.some((candidate) => candidate.num === rate.num && candidate.den === rate.den)
  );
  const percentFor = (target: number): number => xForFrame(target, durationFrames, 100);
  const timecodeFor = (target: number): string => {
    if (!rateSupported) return `${target} fr`;
    return formatTimecode(
      timecodeFromFrames(Math.min(Math.max(target, 0), lastFrame), rate, dropFrame && isDropFrameRate(rate))
    );
  };
  const firstLineOf = (text: string | null | undefined): string => {
    const line = (text ?? '').split('\n')[0]?.trim() ?? '';
    return line.length > 90 ? `${line.slice(0, 90)}...` : line;
  };
  const ioSpan = $derived(
    inFrame !== null && outFrame !== null && outFrame >= inFrame
      ? spanForRange(inFrame, outFrame, durationFrames)
      : null
  );

  const seekFromEvent = (event: PointerEvent): void => {
    if (!track) return;
    const rect = track.getBoundingClientRect();
    onseek?.(frameForX(event.clientX - rect.left, durationFrames, rect.width));
  };

  const handlePointerDown = (event: PointerEvent): void => {
    if (!event.isPrimary) return;
    event.preventDefault();
    try {
      track?.setPointerCapture(event.pointerId);
    } catch {
      /* An inactive pointer id cannot be captured; the click still seeks. */
    }
    scrubbing = true;
    seekFromEvent(event);
  };

  const handlePointerMove = (event: PointerEvent): void => {
    if (scrubbing) seekFromEvent(event);
  };

  const endScrub = (): void => {
    scrubbing = false;
  };

  const showTip = (marker: TimelineMarker): void => {
    hovered = marker;
    /* Clamp so the tooltip stays inside the strip near the edges. */
    hoveredPercent = Math.min(88, Math.max(12, percentFor(marker.frameIn)));
  };

  const hideTip = (marker: TimelineMarker): void => {
    if (hovered?.id === marker.id) hovered = null;
  };

  const selectMarker = (marker: TimelineMarker): void => {
    onseek?.(marker.frameIn);
    onmarkerselect?.(marker.id, marker.frameIn);
  };

  const markerLabel = (marker: TimelineMarker): string => {
    const who = marker.author ?? 'Reviewer';
    const where =
      marker.frameOut != null && marker.frameOut > marker.frameIn
        ? `${timecodeFor(marker.frameIn)} to ${timecodeFor(marker.frameOut)}`
        : timecodeFor(marker.frameIn);
    const line = firstLineOf(marker.text);
    return line ? `${who}, ${where}: ${line}` : `${who}, ${where}`;
  };
</script>

<div class="timeline">
  <!-- Keyboard operation comes from the player's global map (arrows step,
       Home/End jump); the track itself is a pointer scrubber. -->
  <div
    class="track"
    bind:this={track}
    role="slider"
    tabindex="0"
    aria-label="Timeline scrubber"
    aria-valuemin={0}
    aria-valuemax={lastFrame}
    aria-valuenow={Math.min(frame, lastFrame)}
    aria-valuetext={timecodeFor(frame)}
    onpointerdown={handlePointerDown}
    onpointermove={handlePointerMove}
    onpointerup={endScrub}
    onpointercancel={endScrub}
  >
    {#if ioSpan}
      <div
        class="io"
        style:left={`${ioSpan.left * 100}%`}
        style:width={`${ioSpan.width * 100}%`}
      ></div>
    {/if}
    <div class="playhead" style:left={`${percentFor(frame)}%`}></div>
  </div>
  <div class="lane">
    {#each markers as marker (marker.id)}
      {#if marker.frameOut != null && marker.frameOut > marker.frameIn}
        {@const span = spanForRange(marker.frameIn, marker.frameOut, durationFrames)}
        <button
          type="button"
          class="span"
          class:completed={marker.completed}
          style:left={`${span.left * 100}%`}
          style:width={`${Math.max(span.width * 100, 0.4)}%`}
          aria-label={markerLabel(marker)}
          onpointerdown={(event) => event.stopPropagation()}
          onclick={() => selectMarker(marker)}
          onpointerenter={() => showTip(marker)}
          onpointerleave={() => hideTip(marker)}
          onfocus={() => showTip(marker)}
          onblur={() => hideTip(marker)}
        ></button>
      {:else}
        <button
          type="button"
          class="mark"
          class:completed={marker.completed}
          style:left={`${percentFor(marker.frameIn)}%`}
          aria-label={markerLabel(marker)}
          onpointerdown={(event) => event.stopPropagation()}
          onclick={() => selectMarker(marker)}
          onpointerenter={() => showTip(marker)}
          onpointerleave={() => hideTip(marker)}
          onfocus={() => showTip(marker)}
          onblur={() => hideTip(marker)}
        ></button>
      {/if}
    {/each}
  </div>
  {#if hovered}
    <div class="tip" style:left={`${hoveredPercent}%`} role="status">
      <span class="tip-head">
        <strong>{hovered.author ?? 'Reviewer'}</strong>
        <span class="tc">{timecodeFor(hovered.frameIn)}</span>
      </span>
      {#if firstLineOf(hovered.text)}
        <span class="tip-body">{firstLineOf(hovered.text)}</span>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* Review-room chrome: neutral values only, separation by value step. */
  .timeline { position: relative; padding: 8px 0 2px; }
  .track {
    position: relative;
    height: 18px;
    background: var(--n-150, #1c1c1c);
    border-radius: 2px 2px 0 0;
    cursor: pointer;
    touch-action: none;
  }
  .track:focus-visible { outline: 1px solid var(--n-800, #c4c4c4); outline-offset: 2px; }
  .io {
    position: absolute;
    top: 0;
    bottom: 0;
    background: var(--n-300, #2e2e2e);
  }
  .playhead {
    position: absolute;
    top: 0;
    bottom: -17px;
    width: 1px;
    margin-left: -0.5px;
    background: var(--n-900, #e9e9e9);
    z-index: 2;
    pointer-events: none;
  }
  .playhead::before {
    content: '';
    position: absolute;
    top: 0;
    left: -3.5px;
    border: 4px solid transparent;
    border-top-color: var(--n-900, #e9e9e9);
  }
  .lane {
    position: relative;
    height: 16px;
    margin-top: 1px;
    background: var(--n-100, #161616);
    border-radius: 0 0 2px 2px;
  }
  .lane button {
    position: absolute;
    border: 0;
    padding: 0;
    cursor: pointer;
    background: var(--n-700, #9a9a9a);
  }
  .mark {
    top: 5px;
    width: 7px;
    height: 7px;
    margin-left: -3.5px;
    transform: rotate(45deg);
  }
  .mark:hover { background: var(--n-900, #e9e9e9); }
  .span {
    top: 5px;
    height: 7px;
    border-radius: 2px;
    background: var(--n-600, #767676);
  }
  .span:hover { background: var(--n-800, #c4c4c4); }
  .lane button.completed { background: var(--n-400, #3d3d3d); }
  .lane button:focus-visible { outline: 1px solid var(--n-800, #c4c4c4); outline-offset: 2px; }
  .tip {
    position: absolute;
    bottom: calc(100% + 2px);
    transform: translateX(-50%);
    display: grid;
    gap: 2px;
    max-width: 320px;
    padding: 7px 10px;
    background: var(--n-200, #232323);
    color: var(--n-800, #c4c4c4);
    border-radius: 3px;
    font-size: 13px;
    pointer-events: none;
    white-space: nowrap;
    z-index: 3;
  }
  .tip-head { display: flex; gap: 10px; align-items: baseline; }
  .tip-head strong { color: var(--n-900, #e9e9e9); font-weight: 600; }
  .tip .tc { font-variant-numeric: tabular-nums; color: var(--n-600, #767676); }
  .tip-body { overflow: hidden; text-overflow: ellipsis; }
</style>
