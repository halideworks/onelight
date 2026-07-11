import { api, apiPost } from "./api.js";

/* Notification state shared by the layout bell and the /notifications page.
   The server is the source of truth for read state: refresh() refetches the
   newest page, so the unread badge survives reloads. */

export type AppNotification = {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  read_at: number | null;
  created_at: number;
};

type NotificationPage = {
  items: AppNotification[];
  next_cursor: string | null;
};

const state = $state<{
  items: AppNotification[];
  nextCursor: string | null;
  loaded: boolean;
}>({ items: [], nextCursor: null, loaded: false });

export const notifications = {
  get items(): AppNotification[] {
    return state.items;
  },
  get nextCursor(): string | null {
    return state.nextCursor;
  },
  get loaded(): boolean {
    return state.loaded;
  },
  /* Unread within the newest page; the badge is a cheap signal, not a ledger. */
  get unread(): number {
    return state.items.filter((item) => item.read_at === null).length;
  },
  async refresh(): Promise<void> {
    try {
      const page = await api<NotificationPage>(
        "/api/v1/notifications?limit=50",
        {
          redirectOn401: false,
        },
      );
      state.items = page.items;
      state.nextCursor = page.next_cursor;
      state.loaded = true;
    } catch {
      /* Keep the last known state; the next poll retries. */
    }
  },
  async loadMore(): Promise<void> {
    if (!state.nextCursor) return;
    const page = await api<NotificationPage>(
      `/api/v1/notifications?limit=50&cursor=${encodeURIComponent(state.nextCursor)}`,
    );
    state.items = [...state.items, ...page.items];
    state.nextCursor = page.next_cursor;
  },
  async markRead(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await apiPost("/api/v1/notifications/read", { ids });
    const marked = new Set(ids);
    const now = Date.now();
    state.items = state.items.map((item) =>
      marked.has(item.id) && item.read_at === null
        ? { ...item, read_at: now }
        : item,
    );
  },
  clear(): void {
    state.items = [];
    state.nextCursor = null;
    state.loaded = false;
  },
};

const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/* One-line rendering per kind family. Kinds are matched loosely on purpose:
   the API forwards whatever the server writes, so unknown kinds still read
   as plain sentences instead of raw identifiers. */
export const describeNotification = (
  item: AppNotification,
): { title: string; detail: string } => {
  const payload = item.payload;
  const actor =
    text(payload.actor_name) ?? text(payload.user_name) ?? "Someone";
  const asset = text(payload.asset_name);
  const project = text(payload.project_name);
  const where = asset ? ` on ${asset}` : project ? ` in ${project}` : "";
  const detail =
    text(payload.body_text) ??
    text(payload.body) ??
    text(payload.excerpt) ??
    "";
  const kind = item.kind.toLowerCase();
  let title: string;
  if (kind.includes("mention")) title = `${actor} mentioned you${where}`;
  else if (kind.includes("reply")) title = `${actor} replied${where}`;
  else if (kind.includes("comment")) title = `${actor} commented${where}`;
  else if (kind.includes("approval") || kind.includes("status"))
    title = `Approval updated${where}`;
  else if (
    kind.includes("transcode") &&
    (kind.includes("fail") || kind.includes("error"))
  )
    title = `Transcode failed${where}`;
  else if (kind.includes("transcode")) title = `Transcode update${where}`;
  else title = `${item.kind.replace(/[._-]+/g, " ")}${where}`;
  return { title, detail };
};

export const notificationLink = (item: AppNotification): string | null => {
  const project = text(item.payload.project_id);
  const asset = text(item.payload.asset_id);
  if (project && asset) return `/projects/${project}/assets/${asset}`;
  if (project) return `/projects/${project}`;
  return null;
};
