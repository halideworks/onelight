export const columns = [
  "status",
  "kind",
  "runtime",
  "size",
  "format",
  "versions",
  "created",
  "updated",
] as const;
export type Column = (typeof columns)[number];
export type LibraryView = {
  view: "grid" | "list";
  sort: "name" | "status" | "created_at" | "updated_at";
  direction: "asc" | "desc";
  status: string;
  kind: string;
  selects: boolean;
  folder: string | null;
  cardSize: number;
  density: "comfortable" | "compact";
  columns: Column[];
};
export type SavedView = { id: string; name: string; view: LibraryView };
export type LibraryState = {
  view: LibraryView;
  saved: SavedView[];
  activeView: string | null;
  pins: Array<{ id: string; name: string }>;
  railOpen: boolean;
  railWidth: number;
  inspectorOpen: boolean;
  inspectorWidth: number;
  inspectorId: string | null;
  selection: string[];
  scroll: number;
  loaded: number;
};
export const defaultView = (): LibraryView => ({
  view: "grid",
  sort: "created_at",
  direction: "desc",
  status: "",
  kind: "",
  selects: false,
  folder: null,
  cardSize: 200,
  density: "comfortable",
  columns: [...columns],
});
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const bounded = (
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.round(Math.max(min, Math.min(max, value)))
    : fallback;
const choice = <T extends string>(
  value: unknown,
  options: readonly T[],
  fallback: T,
): T => (options.includes(value as T) ? (value as T) : fallback);
const id = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 128;
export function parseView(value: unknown): LibraryView {
  const v = object(value);
  return {
    view: choice(v.view, ["grid", "list"], "grid"),
    sort: choice(
      v.sort,
      ["name", "status", "created_at", "updated_at"],
      "created_at",
    ),
    direction: choice(v.direction, ["asc", "desc"], "desc"),
    status: choice(
      v.status,
      ["", "none", "in_review", "approved", "changes_requested"],
      "",
    ),
    kind: choice(v.kind, ["", "video", "audio", "image", "pdf", "file"], ""),
    selects: v.selects === true,
    folder: id(v.folder) ? v.folder : null,
    cardSize: bounded(v.cardSize, 120, 400, 200),
    density: choice(v.density, ["comfortable", "compact"], "comfortable"),
    columns: Array.isArray(v.columns)
      ? columns.filter((c) => (v.columns as unknown[]).includes(c))
      : [...columns],
  };
}
export function parseLibrary(value: unknown): LibraryState {
  const v = object(value);
  const saved = Array.isArray(v.saved)
    ? v.saved.slice(0, 20).flatMap((raw) => {
        const row = object(raw);
        return id(row.id) && typeof row.name === "string" && row.name.trim()
          ? [
              {
                id: row.id,
                name: row.name.trim().slice(0, 80),
                view: parseView(row.view),
              },
            ]
          : [];
      })
    : [
        {
          id: "unreviewed",
          name: "Unreviewed",
          view: { ...defaultView(), status: "none" },
        },
        {
          id: "approved",
          name: "Approved",
          view: { ...defaultView(), status: "approved" },
        },
        { id: "newest", name: "Newest uploads", view: defaultView() },
      ];
  const pins = Array.isArray(v.pins)
    ? v.pins.slice(0, 20).flatMap((raw) => {
        const row = object(raw);
        return id(row.id) && typeof row.name === "string"
          ? [{ id: row.id, name: row.name.slice(0, 200) }]
          : [];
      })
    : [];
  return {
    view: parseView(v.view),
    saved: [...new Map(saved.map((x) => [x.id, x])).values()],
    activeView:
      id(v.activeView) && saved.some((entry) => entry.id === v.activeView)
        ? v.activeView
        : null,
    pins: [...new Map(pins.map((x) => [x.id, x])).values()],
    railOpen: v.railOpen !== false,
    railWidth: bounded(v.railWidth, 180, 360, 240),
    inspectorOpen: v.inspectorOpen === true,
    inspectorWidth: bounded(v.inspectorWidth, 280, 480, 340),
    inspectorId: id(v.inspectorId) ? v.inspectorId : null,
    selection: Array.isArray(v.selection)
      ? v.selection.filter(id).slice(0, 500)
      : [],
    scroll: bounded(v.scroll, 0, 10_000_000, 0),
    loaded: bounded(v.loaded, 100, 2000, 100),
  };
}
