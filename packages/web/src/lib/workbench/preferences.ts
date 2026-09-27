/* Personal, bounded browser state. Storage denial must never interrupt work. */
const prefix = "onelight.workbench.v1.";
const MAX_ENTRIES = 60;

export function readPreference<T>(
  userId: string | null | undefined,
  key: string,
  validate: (value: unknown) => T,
  fallback: T,
): T {
  if (!userId || typeof window === "undefined") return fallback;
  try {
    if (key.startsWith("library:")) {
      const durable = localStorage.getItem(`${prefix}${userId}.${key}`);
      if (durable && durable.length <= 100_000)
        return validate((JSON.parse(durable) as { value: unknown }).value);
    }
    const raw = localStorage.getItem(prefix + userId);
    if (!raw || raw.length > 500_000) return fallback;
    const stored = JSON.parse(raw) as Record<string, { value: unknown }>;
    return stored[key] ? validate(stored[key].value) : fallback;
  } catch {
    return fallback;
  }
}

export function writePreference(
  userId: string | null | undefined,
  key: string,
  value: unknown,
): void {
  if (!userId || typeof window === "undefined") return;
  try {
    // Saved views are durable preferences, not entries in the recent-assets cache.
    if (key.startsWith("library:")) {
      const json = JSON.stringify({ value, at: Date.now() });
      if (json.length <= 100_000)
        localStorage.setItem(`${prefix}${userId}.${key}`, json);
      return;
    }
    const raw = localStorage.getItem(prefix + userId);
    let parsed: unknown = {};
    if (raw && raw.length < 500_000) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        /* Replace a damaged preference record. */
      }
    }
    const stored =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, { value: unknown; at: number }>)
        : {};
    stored[key] = { value, at: Date.now() };
    const entries = Object.entries(stored)
      .filter(([, entry]) => entry && typeof entry.at === "number")
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_ENTRIES);
    const json = JSON.stringify(Object.fromEntries(entries));
    if (json.length <= 500_000) localStorage.setItem(prefix + userId, json);
  } catch {
    /* The current visit still works without persistent storage. */
  }
}

export const isEditing = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  Boolean(
    target.closest(
      'input, textarea, select, [role="textbox"], [contenteditable]:not([contenteditable="false"])',
    ),
  );
