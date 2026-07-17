/* Svelte action: light dismissal for popover panels.

   Attach to the wrapper that contains BOTH the trigger and the panel, so a
   click on the trigger keeps its toggle semantics instead of closing and
   instantly reopening. A pointerdown anywhere outside the wrapper, or Escape
   anywhere, calls close(). Closing an already-closed popover assigns the same
   state value and is a no-op, so the listeners can stay attached for the
   wrapper's whole life. */
export function dismissable(
  node: HTMLElement,
  close: () => void,
): { destroy: () => void } {
  const onPointerDown = (event: PointerEvent): void => {
    if (!node.contains(event.target as Node)) close();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") close();
  };
  document.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("keydown", onKeyDown, true);
  return {
    destroy(): void {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    },
  };
}
