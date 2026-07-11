<script lang="ts">
  import {
    frameAtCurrentTime,
    frameAtMediaTime,
    frameDuration,
    mediaTimeForFrameMiddle
  } from './frame-clock.js';
  import {
    SUPPORTED_RATES,
    formatTimecode,
    isDropFrameRate,
    timecodeFromFrames
  } from '@onelight/core';
  import AnnotationOverlay from './AnnotationOverlay.svelte';
  import type { FrameAnnotation } from './annotations.js';

  let {
    src,
    rate = { num: 24, den: 1 },
    dropFrame = false,
    captionsSrc = undefined,
    annotations = [],
    onframechange = undefined
  }: {
    src: string;
    rate?: { num: number; den: number };
    dropFrame?: boolean;
    captionsSrc?: string | undefined;
    annotations?: FrameAnnotation[];
    onframechange?: ((frame: number) => void) | undefined;
  } = $props();

  let video: HTMLVideoElement | undefined = $state();
  let videoWidth = $state(0);
  let videoHeight = $state(0);
  let frame = $state(0);
  let inFrame = $state<number | null>(null);
  let outFrame = $state<number | null>(null);
  let loop = $state(false);
  let hasRvfc = $state(false);
  let forwardSpeed = $state(0);
  let reverseSpeed = $state(0);
  let reverseTimer: ReturnType<typeof setInterval> | null = null;
  let rvfcStarted = false;

  const rateSupported = $derived(
    SUPPORTED_RATES.some((candidate) => candidate.num === rate.num && candidate.den === rate.den)
  );
  const timecode = $derived(
    rateSupported ? formatTimecode(timecodeFromFrames(frame, rate, dropFrame && isDropFrameRate(rate))) : null
  );
  const rateLabel = $derived(rate.den === 1 ? String(rate.num) : (rate.num / rate.den).toFixed(3));
  const activeStrokes = $derived(
    annotations.filter((annotation) => annotation.frame === frame).flatMap((annotation) => annotation.strokes)
  );

  const setFrame = (next: number): void => {
    if (next !== frame) {
      frame = next;
      onframechange?.(next);
    }
    if (loop && video && inFrame !== null && outFrame !== null && inFrame < outFrame && next >= outFrame) {
      video.currentTime = mediaTimeForFrameMiddle(inFrame, rate);
    }
  };

  /* rVFC chain: when requestVideoFrameCallback exists it is the only frame
     source. Frame identity comes from the presented mediaTime, never from
     currentTime. */
  const rvfcLoop = (_now: number, metadata: VideoFrameCallbackMetadata): void => {
    setFrame(frameAtMediaTime(metadata.mediaTime, rate));
    video?.requestVideoFrameCallback(rvfcLoop);
  };

  /* Non-rVFC fallback only. */
  const handleTimeUpdate = (): void => {
    if (!video) return;
    setFrame(frameAtCurrentTime(video.currentTime, rate));
  };

  const handleLoadedMetadata = (): void => {
    if (!video) return;
    hasRvfc = 'requestVideoFrameCallback' in video;
    if (hasRvfc && !rvfcStarted) {
      rvfcStarted = true;
      video.requestVideoFrameCallback(rvfcLoop);
    }
    if (!hasRvfc) handleTimeUpdate();
  };

  /* Seek to frame middle. With rVFC, verify the presented mediaTime maps to
     the target frame and re-seek once if it does not. */
  const seekFrame = (targetFrame: number): void => {
    if (!video) return;
    const next = Math.max(0, Math.round(targetFrame));
    video.currentTime = mediaTimeForFrameMiddle(next, rate);
    if (hasRvfc) {
      let retried = false;
      const verify = (_now: number, metadata: VideoFrameCallbackMetadata): void => {
        if (!video || retried) return;
        if (frameAtMediaTime(metadata.mediaTime, rate) !== next) {
          retried = true;
          video.currentTime = mediaTimeForFrameMiddle(next, rate);
        }
      };
      video.requestVideoFrameCallback(verify);
    } else {
      setFrame(next);
    }
  };

  const stopReverse = (): void => {
    if (reverseTimer !== null) {
      clearInterval(reverseTimer);
      reverseTimer = null;
    }
    reverseSpeed = 0;
  };

  const step = (amount: number): void => {
    if (!video) return;
    stopReverse();
    forwardSpeed = 0;
    video.pause();
    seekFrame(frame + amount);
  };

  const pausePlayback = (): void => {
    if (!video) return;
    stopReverse();
    forwardSpeed = 0;
    video.pause();
  };

  const playForward = (): void => {
    if (!video) return;
    const wasPlayingForward = !video.paused && forwardSpeed > 0 && reverseTimer === null;
    stopReverse();
    forwardSpeed = wasPlayingForward ? Math.min(4, forwardSpeed * 2) : 1;
    video.playbackRate = forwardSpeed;
    void video.play();
  };

  /* HTMLMediaElement cannot play backward: reverse shuttle is emulated by a
     stepping timer that seeks back speed frames per frame-duration tick. */
  const playReverse = (): void => {
    if (!video) return;
    video.pause();
    forwardSpeed = 0;
    reverseSpeed = reverseSpeed > 0 ? Math.min(4, reverseSpeed * 2) : 1;
    if (reverseTimer === null) {
      reverseTimer = setInterval(
        () => {
          if (!video) return;
          const nextTime = video.currentTime - reverseSpeed * frameDuration(rate);
          if (nextTime <= 0) {
            video.currentTime = mediaTimeForFrameMiddle(0, rate);
            stopReverse();
          } else {
            video.currentTime = nextTime;
          }
          if (!hasRvfc) handleTimeUpdate();
        },
        Math.max(16, Math.round(1000 * frameDuration(rate)))
      );
    }
  };

  export function seekToFrame(targetFrame: number): void {
    if (!video) return;
    stopReverse();
    forwardSpeed = 0;
    video.pause();
    seekFrame(targetFrame);
  }

  const handleKeydown = (event: KeyboardEvent): void => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target.isContentEditable)
    )
      return;
    const key = event.key.toLowerCase();
    if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); step(1); }
    if (key === 'j') { event.preventDefault(); playReverse(); }
    if (key === 'k') { event.preventDefault(); pausePlayback(); }
    if (key === 'l') { event.preventDefault(); playForward(); }
    if (key === 'i') inFrame = frame;
    if (key === 'o') outFrame = frame;
  };

  /* Window resize does not fire the video element's resize event (that event
     is for intrinsic size changes), so track layout size with a ResizeObserver. */
  $effect(() => {
    if (!video) return;
    const element = video;
    const measure = (): void => {
      videoWidth = element.clientWidth;
      videoHeight = element.clientHeight;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  });

  $effect(() => {
    return () => {
      if (reverseTimer !== null) clearInterval(reverseTimer);
    };
  });
</script>

<svelte:window onkeydown={handleKeydown} />
<section class="player" aria-label="Review player">
  <div class="screen">
    <video bind:this={video} {src} controls playsinline ontimeupdate={hasRvfc ? undefined : handleTimeUpdate} onloadedmetadata={handleLoadedMetadata}>
      <track kind="captions" srclang="en" label="English captions" src={captionsSrc ?? 'data:text/vtt;charset=utf-8,WEBVTT'} />
    </video>
    <AnnotationOverlay strokes={activeStrokes} width={videoWidth} height={videoHeight} />
  </div>
  <div class="transport">
    <button type="button" onclick={() => step(-1)} aria-label="Previous frame">Previous frame</button>
    <button type="button" onclick={() => step(1)} aria-label="Next frame">Next frame</button>
    <span class="readout">
      {#if timecode}<span class="tc tc-main">{timecode}</span>{/if}
      <span class="tc tc-sub">{frame} fr&nbsp; {rateLabel}{dropFrame && isDropFrameRate(rate) ? ' DF' : ''}</span>
    </span>
    <button type="button" onclick={() => { inFrame = frame; }} aria-label="Set loop in">Set in</button>
    <button type="button" onclick={() => { outFrame = frame; }} aria-label="Set loop out">Set out</button>
    <button type="button" aria-pressed={loop} onclick={() => { loop = !loop; }}>Loop</button>
  </div>
  <p class="range tc">{inFrame === null ? 'In not set' : `In ${inFrame}`}, {outFrame === null ? 'Out not set' : `Out ${outFrame}`}</p>
</section>

<style>
  .player { background: var(--n-050, #101010); color: var(--n-800, #c4c4c4); padding: 16px; }
  .screen { position: relative; }
  video { display: block; width: 100%; background: var(--n-000, #0a0a0a); }
  .transport { display: flex; align-items: center; justify-content: center; gap: 16px; padding-top: 12px; font-family: var(--font-ui, system-ui); }
  .readout { display: grid; text-align: center; gap: 2px; }
  .tc { font-variant-numeric: tabular-nums; letter-spacing: 0.02em; }
  .tc-main { font-size: 16px; color: var(--n-900, #e9e9e9); }
  .tc-sub { font-size: 12px; color: var(--n-600, #767676); }
  button { border: 0; border-radius: 3px; background: var(--n-200, #232323); color: var(--n-800, #c4c4c4); padding: 8px 12px; font-size: 13px; }
  button:hover { background: var(--n-300, #2e2e2e); color: var(--n-900, #e9e9e9); }
  button[aria-pressed='true'] { background: var(--n-400, #3d3d3d); color: var(--n-900, #e9e9e9); }
  button:focus-visible { outline: 1px solid var(--n-800, #c4c4c4); outline-offset: 2px; }
  .range { margin: 10px 0 0; text-align: center; color: var(--n-600, #767676); font-size: 13px; }
</style>
