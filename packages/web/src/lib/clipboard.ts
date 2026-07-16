/* Copy text to the clipboard, including where navigator.clipboard does not
   exist.

   The async Clipboard API is gated on a secure context: https, or localhost.
   A LAN deployment reached over plain http -- which is exactly how this app is
   used before TLS is in front of it -- gets `navigator.clipboard === undefined`,
   so every copy button reported failure while working perfectly in dev. The
   fallback is the pre-Clipboard-API method: put the text in an off-screen
   textarea, select it, and let execCommand copy the selection. It is deprecated
   and it is also the only thing that works there.

   Returns whether the text actually reached the clipboard, so callers can say
   so rather than claim success. */
export const copyText = async (text: string): Promise<boolean> => {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* Permission denied, or a browser that refuses outside a user gesture.
         The textarea path below sometimes still works, so fall through rather
         than give up here. */
    }
  }
  if (typeof document === "undefined") return false;
  const holder = document.createElement("textarea");
  holder.value = text;
  /* Off-screen rather than hidden: display:none and visibility:hidden are not
     selectable, and a selection is what execCommand copies. readOnly stops iOS
     from opening the keyboard, and the fixed position stops the page scrolling
     to the element. */
  holder.setAttribute("readonly", "");
  holder.style.position = "fixed";
  holder.style.top = "-1000px";
  holder.style.opacity = "0";
  document.body.append(holder);
  const selection = document.getSelection();
  const restore =
    selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  try {
    holder.select();
    holder.setSelectionRange(0, holder.value.length);
    const copied = document.execCommand("copy");
    return copied;
  } catch {
    return false;
  } finally {
    holder.remove();
    /* Copying should not silently destroy whatever the person had selected. */
    if (restore && selection) {
      selection.removeAllRanges();
      selection.addRange(restore);
    }
  }
};
