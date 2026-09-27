import { apiPost, type StackState, type VersionUnstacked } from "../api.js";
import { auth } from "../auth.svelte.js";

type StackedUpload = {
  version_id: string;
  stack_state: StackState;
  undo_token: string;
};

/* Keep dependent uploads together. A transient failure leaves the remaining
   chain retryable, instead of trying older snapshots against an unchanged stack. */
export function undoStackedUploads(
  uploads: StackedUpload[],
): Array<() => Promise<void>> {
  const owner = auth.user?.id;
  const groups = new Map<string, StackedUpload[]>();
  for (const upload of uploads) {
    const id = upload.stack_state.asset_id;
    const pending = groups.get(id) ?? [];
    pending.unshift(upload);
    groups.set(id, pending);
  }
  return [...groups.values()].map((pending) => async () => {
    while (pending.length && owner === auth.user?.id) {
      const upload = pending[0];
      await apiPost(`/api/v1/versions/${upload.version_id}/unstack`, {
        expected: upload.stack_state,
        undo_token: upload.undo_token,
      });
      pending.shift();
    }
  });
}

export async function unstackVersion(
  id: string,
  expected: StackState,
): Promise<() => Promise<void>> {
  const changed = await apiPost<VersionUnstacked>(
    `/api/v1/versions/${id}/unstack`,
    { expected },
  );
  return async () => {
    await apiPost(`/api/v1/versions/${id}/restack`, {
      expected: changed.source_stack,
      undo_token: changed.undo_token,
    });
  };
}
