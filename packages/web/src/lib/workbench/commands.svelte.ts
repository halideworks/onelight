export type WorkbenchCommand = {
  id: string;
  label: string;
  detail?: string;
  keywords?: string;
  run: () => void | Promise<void>;
};

export const commandState = $state<{
  open: boolean;
  contextual: WorkbenchCommand[];
}>({ open: false, contextual: [] });

export const openCommands = (): void => {
  commandState.open = true;
};

export const closeCommands = (): void => {
  commandState.open = false;
};
