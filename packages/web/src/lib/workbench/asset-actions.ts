import { api, apiPatch, apiPost, type Asset } from "../api.js";

type Changes = Partial<
  Pick<Asset, "name" | "folder_id" | "status" | "tags" | "selected">
>;

/* Both directions use the actual server values. A colleague's intervening
   change conflicts atomically instead of being silently overwritten. */
export async function changeAsset(
  id: string,
  patch: Changes,
): Promise<() => Promise<void>> {
  const path = `/api/v1/assets/${id}${patch.status === undefined ? "" : "/approval"}`;
  const before = await api<Asset>(`/api/v1/assets/${id}`);
  const keys = Object.keys(patch) as Array<keyof Changes>;
  const previous = Object.fromEntries(keys.map((key) => [key, before[key]]));
  const changed = await apiPatch<Asset>(path, { ...patch, expected: previous });
  const expected = Object.fromEntries(keys.map((key) => [key, changed[key]]));
  return async () => {
    await apiPatch(path, { ...previous, expected });
  };
}

export async function trashAsset(id: string): Promise<() => Promise<void>> {
  const changed = await apiPost<Asset>(`/api/v1/assets/${id}/trash`, {
    expected: { deleted_at: null },
    return_asset: true,
  });
  return async () => {
    await apiPost(`/api/v1/assets/${id}/restore`, {
      expected: {
        deleted_at: changed.deleted_at,
        updated_at: changed.updated_at,
      },
    });
  };
}

export async function restoreAsset(
  id: string,
  deletedAt: number,
): Promise<() => Promise<void>> {
  const restored = await apiPost<Asset>(`/api/v1/assets/${id}/restore`, {
    expected: { deleted_at: deletedAt },
  });
  return async () => {
    await apiPost(`/api/v1/assets/${id}/trash`, {
      expected: { deleted_at: null, updated_at: restored.updated_at },
    });
  };
}
