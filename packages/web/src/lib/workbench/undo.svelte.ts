import { ApiError, messageFrom } from "../api.js";
import { auth } from "../auth.svelte.js";

type UndoEntry = {
  label: string;
  steps: Array<() => Promise<void>>;
};

const state = $state<{
  owner: string | null;
  entries: UndoEntry[];
  busy: boolean;
  message: string;
  error: boolean;
  revision: number;
}>({
  owner: null,
  entries: [],
  busy: false,
  message: "",
  error: false,
  revision: 0,
});

let generation = 0;

const clear = (): void => {
  generation += 1;
  state.owner = auth.user?.id ?? null;
  state.entries = [];
  state.busy = false;
  state.message = "";
  state.error = false;
  state.revision = 0;
};

export const undo = {
  get canUndo(): boolean {
    return (
      state.owner === auth.user?.id && state.entries.length > 0 && !state.busy
    );
  },
  get busy(): boolean {
    return state.owner === auth.user?.id && state.busy;
  },
  get label(): string {
    return state.owner === auth.user?.id
      ? (state.entries.at(-1)?.label ?? "")
      : "";
  },
  get message(): string {
    return state.owner === auth.user?.id ? state.message : "";
  },
  get error(): boolean {
    return state.error;
  },
  get revision(): number {
    return state.owner === auth.user?.id ? state.revision : 0;
  },
  clear,
  dismiss(): void {
    state.message = "";
  },
  push(entry: UndoEntry): void {
    const owner = auth.user?.id;
    if (!owner || entry.steps.length === 0) return;
    if (state.owner !== owner) clear();
    state.entries = [
      ...state.entries.slice(-19),
      { ...entry, steps: [...entry.steps] },
    ];
    state.message = entry.label;
    state.error = false;
  },
  async run(): Promise<void> {
    if (!this.canUndo) return;
    const entry = state.entries.at(-1)!;
    const owner = state.owner;
    const currentGeneration = generation;
    const current = (): boolean =>
      generation === currentGeneration && auth.user?.id === owner;
    state.busy = true;
    const retry: UndoEntry["steps"] = [];
    let succeeded = 0;
    let unavailable = 0;
    let failure = "";
    for (const step of entry.steps) {
      if (!current()) return;
      try {
        await step();
        succeeded += 1;
      } catch (caught) {
        failure = messageFrom(caught, "The change could not be undone.");
        if (
          caught instanceof ApiError &&
          caught.status >= 400 &&
          caught.status < 500 &&
          caught.status !== 408 &&
          caught.status !== 429
        )
          unavailable += 1;
        else retry.push(step);
      }
    }
    if (!current()) return;
    state.entries = state.entries.flatMap((item) =>
      item === entry
        ? retry.length
          ? [{ ...entry, steps: retry }]
          : []
        : [item],
    );
    state.busy = false;
    state.revision += 1;
    state.error = unavailable > 0 || retry.length > 0;
    state.message = state.error
      ? [
          `${succeeded} ${succeeded === 1 ? "change" : "changes"} undone.`,
          unavailable
            ? `${unavailable} could not be undone safely. ${failure}`
            : "",
          retry.length
            ? `${retry.length} failed. You can retry Undo. ${failure}`
            : "",
        ]
          .filter(Boolean)
          .join(" ")
      : `Undid ${entry.label.charAt(0).toLowerCase()}${entry.label.slice(1)}.`;
  },
};
