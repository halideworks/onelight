import { api } from "./api.js";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
  avatar_url?: string | null;
  totp_enabled?: boolean;
};

type SessionPayload = { user: SessionUser; auth: string };

const state = $state<{ user: SessionUser | null; ready: boolean }>({
  user: null,
  ready: false,
});

export const auth = {
  get user(): SessionUser | null {
    return state.user;
  },
  get ready(): boolean {
    return state.ready;
  },
  get signedIn(): boolean {
    return state.user !== null;
  },
  /* Hydrate from GET /auth/session. A 401 here means signed out, never a
     redirect: public pages call this too. */
  async hydrate(): Promise<void> {
    try {
      const payload = await api<SessionPayload>("/api/v1/auth/session", {
        redirectOn401: false,
      });
      state.user = payload.user;
    } catch {
      state.user = null;
    }
    state.ready = true;
  },
  clear(): void {
    state.user = null;
  },
};
