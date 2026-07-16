/* One dialog for the whole app: asking a yes/no question, and asking for a
   line of text.

   Every destructive action used window.confirm() and every naming action used
   window.prompt(). Those are the browser's own modals: unstyled, unthemeable,
   differently shaped in every browser, and unable to say which of two buttons
   is the dangerous one. They also block the main thread, so nothing behind them
   can repaint while they are open.

   This is the same shape of API -- ask, await, get an answer -- so a call site
   reads the way confirm() and prompt() did, and no caller has to own dialog
   state. The host (`ConfirmHost.svelte`) is mounted once in the root layout. */

export interface ConfirmRequest {
  /* The question, as a question. */
  title: string;
  /* What will actually happen, in a sentence. Optional only because some
     actions really are self-evident. */
  body?: string;
  /* The affirmative button's words. "Delete" beats "OK": a person clicking it
     should not have to remember what they were asked. */
  confirmLabel?: string;
  cancelLabel?: string;
  /* Destructive actions get the red button and the extra beat of hesitation. */
  danger?: boolean;
}

export interface TextRequest extends ConfirmRequest {
  /* Present (even as "") means this asks for text rather than agreement. */
  initial?: string;
  placeholder?: string;
  /* Labels the field for anyone not looking at the title. */
  label?: string;
}

interface PendingConfirm extends TextRequest {
  prompt: boolean;
  resolve: (value: boolean | string | null) => void;
}

const state = $state<{ pending: PendingConfirm | null }>({ pending: null });

export const confirmState = {
  get pending(): PendingConfirm | null {
    return state.pending;
  },
};

/* A queued second question would stack dialogs; the first one loses, and loses
   safely -- it resolves to the negative, so nothing destructive proceeds. */
const supersede = (): void => {
  const pending = state.pending;
  state.pending = null;
  pending?.resolve(pending.prompt ? null : false);
};

/* Resolves true if the person confirmed, false for cancel, Escape, a click on
   the backdrop, or a second ask arriving while this one is open. */
export const askConfirm = (request: ConfirmRequest): Promise<boolean> => {
  supersede();
  return new Promise<boolean>((resolve) => {
    state.pending = {
      ...request,
      prompt: false,
      resolve: resolve as (value: boolean | string | null) => void,
    };
  });
};

/* Resolves the trimmed text, or null if the person backed out. Empty is treated
   as backing out: every caller wants a name, and "" is not one. */
export const askText = (request: TextRequest): Promise<string | null> => {
  supersede();
  return new Promise<string | null>((resolve) => {
    state.pending = {
      ...request,
      prompt: true,
      resolve: resolve as (value: boolean | string | null) => void,
    };
  });
};

export const settleConfirm = (value: boolean | string | null): void => {
  const pending = state.pending;
  state.pending = null;
  pending?.resolve(value);
};
