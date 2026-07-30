import { describeNotification as describe } from "@onelight/core";
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

type Badges = {
  total: number;
  projects: Array<{ project_id: string; unread: number }>;
};

const state = $state<{
  items: AppNotification[];
  nextCursor: string | null;
  loaded: boolean;
  /* Counted by the server, per project. Kept apart from `items` on purpose:
     the list is a page and the badge is a total, and conflating them is what
     made a project with old unread rows show no badge at all. */
  badges: Record<string, number>;
  badgeTotal: number;
}>({
  items: [],
  nextCursor: null,
  loaded: false,
  badges: {},
  badgeTotal: 0,
});

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
  /* The bell's own number. Unread rows in the newest page is the right count
     for a list you are about to read; the total from the server is the right
     count for a badge, so the bell prefers it and falls back to the page. */
  get unread(): number {
    const counted = state.badgeTotal;
    const inPage = state.items.filter((item) => item.read_at === null).length;
    return Math.max(counted, inPage);
  },
  /* Per project, counted by the server: not "unread in whatever the browser
     fetched", which showed nothing at all for a project whose unread rows had
     fallen past the first page. */
  get unreadByProject(): Record<string, number> {
    return state.badges;
  },
  /* Clearing a badge clears the project, server side. Clearing the ids the
     browser happened to hold left the rest unread, so the count came straight
     back on the next poll. */
  async markProjectRead(projectId: string): Promise<void> {
    if (!state.badges[projectId]) return;
    await apiPost("/api/v1/notifications/read", { project_id: projectId });
    const now = Date.now();
    state.items = state.items.map((item) =>
      item.read_at === null && item.payload.project_id === projectId
        ? { ...item, read_at: now }
        : item,
    );
    const { [projectId]: cleared, ...rest } = state.badges;
    state.badgeTotal = Math.max(0, state.badgeTotal - (cleared ?? 0));
    state.badges = rest;
  },
  /* The badges alone, which is all the projects list needs: it does not want
     fifty notification bodies to draw six numbers. */
  async refreshBadges(): Promise<void> {
    try {
      const badges = await api<Badges>("/api/v1/notifications/badges", {
        redirectOn401: false,
      });
      state.badges = Object.fromEntries(
        badges.projects.map((row) => [row.project_id, row.unread]),
      );
      state.badgeTotal = badges.total;
    } catch {
      /* Keep the last known counts; the next poll retries. */
    }
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
    await this.refreshBadges();
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
    /* Take the badges down by what was actually unread, so the numbers on the
       projects list agree with the list you just read without a round trip. */
    const byProject: Record<string, number> = {};
    for (const item of state.items) {
      if (!marked.has(item.id) || item.read_at !== null) continue;
      const project = item.payload.project_id;
      if (typeof project === "string" && project)
        byProject[project] = (byProject[project] ?? 0) + 1;
    }
    state.items = state.items.map((item) =>
      marked.has(item.id) && item.read_at === null
        ? { ...item, read_at: now }
        : item,
    );
    const next = { ...state.badges };
    let removed = 0;
    for (const [project, count] of Object.entries(byProject)) {
      const left = (next[project] ?? 0) - count;
      removed += Math.min(count, next[project] ?? 0);
      if (left > 0) next[project] = left;
      else delete next[project];
    }
    state.badges = next;
    state.badgeTotal = Math.max(0, state.badgeTotal - removed);
  },
  clear(): void {
    state.badges = {};
    state.badgeTotal = 0;
    state.items = [];
    state.nextCursor = null;
    state.loaded = false;
  },
};

/* One line per notification, in the SAME words the email uses.

   There used to be a second implementation here, and it had drifted twice
   over: it said "Approval updated on X" where the mail said "Dana approved X",
   and its detail line read body_text, body or excerpt when the server has
   always written `preview`. So the panel showed no comment text at all -- the
   words were in the payload and nothing rendered them. One vocabulary in core
   now, used by both. */
export const describeNotification = (
  item: AppNotification,
): { title: string; detail: string; tone: NotificationTone } => {
  const described = describe({ kind: item.kind, payload: item.payload });
  return {
    title: described.headline,
    detail: described.quote ?? "",
    tone: described.tone ?? "quiet",
  };
};

export type NotificationTone = "note" | "good" | "attention" | "quiet";

const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const frame = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;

export const notificationLink = (item: AppNotification): string | null => {
  const project = text(item.payload.project_id);
  const asset = text(item.payload.asset_id);
  if (project && asset) {
    /* Frame-anchored payloads (comments) deep link into the player's ?f=
       seek; positions are integer frames, never seconds. */
    const at = frame(item.payload.frame) ?? frame(item.payload.frame_in);
    return `/projects/${project}/assets/${asset}${at === null ? "" : `?f=${at}`}`;
  }
  if (project) return `/projects/${project}`;
  return null;
};
