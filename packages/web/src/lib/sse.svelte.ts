// Shared project event stream client. The API serves SSE at
// GET /api/v1/projects/:id/events, emitting named events (the SSE "event:"
// field carries the type, "data:" carries the payload JSON, "id:" the event
// id). Named events do not fire EventSource.onmessage, so subscribers must
// list the types they want and we attach one listener per type. The browser
// replays Last-Event-ID on reconnect automatically.

export interface ProjectEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

export type ProjectEventHandler = (event: ProjectEvent) => void;

// Subscribes to a project's event stream for the given event types
// (e.g. "asset.created", "comment.created"). Returns an unsubscribe function.
export function projectEvents(
  projectId: string,
  types: readonly string[],
  onEvent: ProjectEventHandler,
): () => void {
  const source = new EventSource(
    `/api/v1/projects/${encodeURIComponent(projectId)}/events`,
  );
  for (const type of types) {
    source.addEventListener(type, (message: MessageEvent<string>) => {
      let payload: unknown;
      try {
        payload = JSON.parse(message.data);
      } catch {
        return;
      }
      onEvent({
        id: message.lastEventId,
        type,
        payload:
          payload && typeof payload === "object"
            ? (payload as Record<string, unknown>)
            : {},
      });
    });
  }
  return () => source.close();
}
