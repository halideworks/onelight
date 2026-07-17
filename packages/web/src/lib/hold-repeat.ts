/* Svelte action: press-and-hold auto-repeat for stepper buttons. One step
   on press, then after a beat the steps run while held, quickening once.
   Keyboard activation keeps the native repeat: held Enter fires repeated
   clicks on its own, which flow through the same callback. */
export function holdRepeat(
  node: HTMLElement,
  step: () => void,
): { destroy: () => void } {
  let delay: ReturnType<typeof setTimeout> | null = null;
  let repeat: ReturnType<typeof setInterval> | null = null;
  let fromPointer = false;

  const clear = (): void => {
    if (delay) clearTimeout(delay);
    if (repeat) clearInterval(repeat);
    delay = null;
    repeat = null;
  };
  const down = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    fromPointer = true;
    node.setPointerCapture(event.pointerId);
    step();
    delay = setTimeout(() => {
      let ticks = 0;
      repeat = setInterval(() => {
        ticks += 1;
        step();
        /* Quicken after a second of held stepping. */
        if (ticks === 12 && repeat) {
          clearInterval(repeat);
          repeat = setInterval(step, 33);
        }
      }, 80);
    }, 350);
  };
  const up = (): void => {
    clear();
    /* The click that follows this pointerup is ours; swallow it once. */
    setTimeout(() => {
      fromPointer = false;
    }, 0);
  };
  const click = (event: MouseEvent): void => {
    if (fromPointer) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    step();
  };

  node.addEventListener("pointerdown", down);
  node.addEventListener("pointerup", up);
  node.addEventListener("pointercancel", up);
  node.addEventListener("click", click);
  return {
    destroy(): void {
      clear();
      node.removeEventListener("pointerdown", down);
      node.removeEventListener("pointerup", up);
      node.removeEventListener("pointercancel", up);
      node.removeEventListener("click", click);
    },
  };
}
