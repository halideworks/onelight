<script lang="ts">
  /* One slider for the whole application.
   *
   * Every range in Onelight was a native input painted with accent-color and a
   * local width rule: four different thumbs, no keyboard story beyond the
   * browser's, and a hit area a finger misses. This is the replacement.
   *
   * It is a fader, not a knob. The cap is a thin upright bar riding a hairline
   * track -- the vocabulary of a mixing desk and a film gate rather than the
   * operating system's default pill, and it obeys the house rules: flat value
   * steps, no gradient, no glow, no soft-3D.
   *
   * Two worlds, one control. 'neutral' is the review room (R=G=B at every
   * step, nothing tinted near the frame); 'ink' is everywhere else and is
   * allowed the single accent. The variant is the caller's decision because
   * only the caller knows which room it is standing in.
   *
   * Continuous by default. `step` snaps when a caller genuinely has discrete
   * positions; left undefined the value moves as smoothly as the pointer does,
   * which is what a size or a thickness actually wants. */

  let {
    value,
    min = 0,
    max = 1,
    step = undefined,
    label,
    variant = 'ink',
    orientation = 'horizontal',
    disabled = false,
    length = undefined,
    valueText = undefined,
    oninput = undefined,
    onchange = undefined
  }: {
    value: number;
    min?: number;
    max?: number;
    /* Snap increment. Undefined is continuous: the value is whatever the
       pointer position maps to, at full float precision. */
    step?: number | undefined;
    /* Required: this control is never unlabelled. */
    label: string;
    variant?: 'neutral' | 'ink';
    orientation?: 'horizontal' | 'vertical';
    disabled?: boolean;
    /* Track length along its own axis. Callers that live in a toolbar want a
       fixed one; a slider in a form should stretch, which is the default. */
    length?: string | undefined;
    /* What a screen reader should say instead of the bare number, when the
       number is not the thing (pixels, a timecode, a percentage). */
    valueText?: string | undefined;
    /* Fires continuously through a drag or a key. */
    oninput?: ((value: number) => void) | undefined;
    /* Fires once, when the gesture ends. For callers that persist. */
    onchange?: ((value: number) => void) | undefined;
  } = $props();

  const vertical = $derived(orientation === 'vertical');
  const span = $derived(max - min || 1);
  const clamp = (raw: number): number => Math.min(max, Math.max(min, raw));
  /* Snapping is measured from min, not from zero: a slider from 130 to 380 in
     steps of 10 has positions at 130, 140, ... and never at 0. */
  const snap = (raw: number): number => {
    if (!step || step <= 0) return clamp(raw);
    return clamp(min + Math.round((raw - min) / step) * step);
  };
  const fraction = $derived(Math.min(1, Math.max(0, (clamp(value) - min) / span)));

  let rail = $state<HTMLDivElement | null>(null);
  let dragging = $state(false);

  const emit = (next: number, done: boolean): void => {
    const settled = snap(next);
    /* An unchanged value still ends the gesture: a caller that persists on
       change must hear the release even when the pointer went nowhere. */
    if (settled !== value) oninput?.(settled);
    if (done) onchange?.(settled);
  };

  /* Where the pointer is on the rail, as a fraction of it. Vertical runs
     bottom-to-top, the way a fader does. */
  const fractionAt = (event: PointerEvent): number => {
    if (!rail) return fraction;
    const box = rail.getBoundingClientRect();
    const raw = vertical
      ? (box.bottom - event.clientY) / (box.height || 1)
      : (event.clientX - box.left) / (box.width || 1);
    return Math.min(1, Math.max(0, raw));
  };

  const pointerDown = (event: PointerEvent): void => {
    if (disabled || !event.isPrimary) return;
    event.preventDefault();
    rail?.focus();
    dragging = true;
    try {
      rail?.setPointerCapture(event.pointerId);
    } catch {
      /* An inactive pointer id cannot be captured; the press still lands. */
    }
    emit(min + fractionAt(event) * span, false);
  };

  const pointerMove = (event: PointerEvent): void => {
    if (!dragging) return;
    /* The release was missed (capture failed, or it happened off the rail):
       no button is down any more, so drop the latch rather than tracking a
       bare hover. */
    if (event.buttons === 0) {
      dragging = false;
      onchange?.(snap(value));
      return;
    }
    emit(min + fractionAt(event) * span, false);
  };

  const pointerUp = (event: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    try {
      rail?.releasePointerCapture(event.pointerId);
    } catch {
      /* Already released; nothing to do. */
    }
    emit(min + fractionAt(event) * span, true);
  };

  /* A key press moves by the step where there is one, and by a hundredth of
     the range where the slider is continuous -- so a hundred presses cross it
     whatever the units are. Shift takes ten of those at a time. */
  const keyStep = $derived(step && step > 0 ? step : span / 100);

  const nudge = (multiple: number): void => {
    emit(clamp(value + keyStep * multiple), true);
  };

  const keydown = (event: KeyboardEvent): void => {
    if (disabled) return;
    const big = event.shiftKey ? 10 : 1;
    const back = vertical ? 'ArrowDown' : 'ArrowLeft';
    const forward = vertical ? 'ArrowUp' : 'ArrowRight';
    /* Both axes answer both pairs: a vertical fader that ignores the left
       arrow is a puzzle, not a purity. */
    if (event.key === back || event.key === (vertical ? 'ArrowLeft' : 'ArrowDown')) {
      event.preventDefault();
      nudge(-big);
    } else if (event.key === forward || event.key === (vertical ? 'ArrowRight' : 'ArrowUp')) {
      event.preventDefault();
      nudge(big);
    } else if (event.key === 'PageDown') {
      event.preventDefault();
      nudge(-10);
    } else if (event.key === 'PageUp') {
      event.preventDefault();
      nudge(10);
    } else if (event.key === 'Home') {
      event.preventDefault();
      emit(min, true);
    } else if (event.key === 'End') {
      event.preventDefault();
      emit(max, true);
    }
  };
</script>

<!-- The rail is the control: it carries the role, the focus and the pointer.
     The padded box around it is only reach -- a coarse pointer gets a full tap
     target while the drawn line stays a hairline. -->
<div
  class="slider {variant}"
  class:vertical
  class:dragging
  class:disabled
  style:--fill={String(fraction)}
  style:--length={length ?? (vertical ? '96px' : '100%')}
>
  <div
    class="rail"
    bind:this={rail}
    role="slider"
    tabindex={disabled ? -1 : 0}
    aria-label={label}
    aria-orientation={orientation}
    aria-valuemin={min}
    aria-valuemax={max}
    aria-valuenow={clamp(value)}
    aria-valuetext={valueText}
    aria-disabled={disabled || undefined}
    onpointerdown={pointerDown}
    onpointermove={pointerMove}
    onpointerup={pointerUp}
    onpointercancel={pointerUp}
    onkeydown={keydown}
  >
    <div class="track"></div>
    <div class="fill"></div>
    <div class="cap"></div>
  </div>
</div>

<style>
  /* Colours arrive as variables so the two worlds differ by value only and the
     geometry below is written once. */
  .slider {
    --line: var(--n-300, #2e2e2e);
    --lit: var(--n-600, #767676);
    --knob: var(--n-800, #c4c4c4);
    --knob-live: var(--n-900, #e9e9e9);
    --ring: var(--n-800, #c4c4c4);
    display: flex;
    align-items: center;
    justify-content: center;
    touch-action: none;
    /* The LENGTH lives here, not on the rail. It used to sit on the rail as
       width: var(--length), which for the default of 100% asked the rail to be
       a percentage of a parent that was itself sizing to its content: circular,
       and it resolved to zero. Every caller passing an explicit pixel length
       was fine, so the one slider taking the default -- the A/B compare seek --
       was an invisible control that could not be grabbed. */
    width: var(--length);
  }
  .slider.vertical {
    width: auto;
    height: var(--length);
  }
  .slider.ink {
    --line: var(--ink-300, #263140);
    --lit: var(--accent, #48929b);
    --knob: var(--ink-text, #e8e4dc);
    --knob-live: #ffffff;
    --ring: var(--accent-bright, #5aa8b1);
  }
  .slider.disabled { opacity: 0.45; }

  /* The reach. Horizontal sliders take their height from the tap minimum and
     give it all back as padding; the drawn parts are 2px. */
  .rail {
    position: relative;
    width: 100%;
    height: 22px;
    outline: none;
    cursor: pointer;
  }
  .vertical .rail {
    width: 22px;
    height: 100%;
  }
  .disabled .rail { cursor: default; }
  @media (pointer: coarse) {
    .rail { height: var(--tap, 44px); }
    .vertical .rail { width: var(--tap, 44px); height: 100%; }
  }

  /* The unfilled run, and the filled run over it. Two elements rather than a
     gradient: the house forbids gradient fills, and two flat values is what
     this actually is. */
  .track,
  .fill {
    position: absolute;
    border-radius: 1px;
    pointer-events: none;
  }
  .track {
    left: 0;
    right: 0;
    top: 50%;
    height: 2px;
    margin-top: -1px;
    background: var(--line);
  }
  .fill {
    left: 0;
    top: 50%;
    height: 2px;
    margin-top: -1px;
    width: 100%;
    background: var(--lit);
    /* Scaled rather than sized: a width change relayouts, a transform does
       not, and this moves under a finger. */
    transform: scaleX(var(--fill));
    transform-origin: left center;
  }
  .vertical .track {
    top: 0;
    bottom: 0;
    left: 50%;
    width: 2px;
    height: auto;
    margin: 0 0 0 -1px;
  }
  .vertical .fill {
    top: 0;
    bottom: 0;
    left: 50%;
    width: 2px;
    height: 100%;
    margin: 0 0 0 -1px;
    transform: scaleY(var(--fill));
    transform-origin: center bottom;
  }

  /* The cap: an upright bar, the way a fader is marked. Positioned by
     calc so it stays inside the rail at both ends instead of hanging half
     off. */
  .cap {
    position: absolute;
    top: 50%;
    left: calc(var(--fill) * (100% - 3px));
    width: 3px;
    height: 14px;
    margin-top: -7px;
    border-radius: 1px;
    background: var(--knob);
    pointer-events: none;
    transition: height 90ms ease, background-color 90ms ease;
  }
  .vertical .cap {
    top: auto;
    left: 50%;
    bottom: calc(var(--fill) * (100% - 3px));
    width: 14px;
    height: 3px;
    margin: 0 0 0 -7px;
  }

  /* Live states are value steps and a taller cap, never a glow. */
  .slider:not(.disabled) .rail:hover .cap,
  .slider:not(.disabled) .rail:focus-visible .cap,
  .slider.dragging .cap {
    height: 18px;
    margin-top: -9px;
    background: var(--knob-live);
  }
  .slider.vertical:not(.disabled) .rail:hover .cap,
  .slider.vertical:not(.disabled) .rail:focus-visible .cap,
  .slider.vertical.dragging .cap {
    width: 18px;
    height: 3px;
    margin: 0 0 0 -9px;
  }

  .rail:focus-visible { outline: 1px solid var(--ring); outline-offset: 2px; border-radius: 2px; }

  @media (prefers-reduced-motion: reduce) {
    .cap { transition: none; }
  }
</style>
