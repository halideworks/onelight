import type {
  AppConfig,
  BlobStore,
  Clock,
  IdGen,
  Mailer,
  PasswordHasher,
} from "@onelight/core";
import type { AppDb } from "@onelight/db";
import type { User } from "@onelight/db";
import type { WorkspaceRole } from "@onelight/core";

export interface AppEnv {
  db: AppDb;
  hasher: PasswordHasher;
  clock: Clock;
  ids: IdGen;
  config: AppConfig;
  version: string;
  blobStore?: BlobStore;
  mailer?: Mailer;
  /* Capacity of whatever holds the blobs, where the host can know it: the
     Node server reports its filesystem, object storage reports nothing. */
  diskInfo?: () => Promise<{ total_bytes: number; free_bytes: number } | null>;
  /* Host-side facts for the system status page that only the Node server can
     know: the database file's size and what sits in BACKUP_DIR. Absent on
     Workers, where both wire fields are null. */
  systemInfo?: () => Promise<{
    db_size_bytes: number | null;
    backups: { count: number; newest_at: number | null } | null;
  }>;
  /* Dynamic mail control (the Node server): status resolves the ACTIVE
     configuration, admin settings first, environment second, so a
     present-but-broken configuration reads as an error rather than as
     silence; send delivers through it; reload drops transport caches after
     the admin settings change. Platforms without it fall back to the
     static `mailer` above (the contract harness) or to disabled. */
  mail?: {
    status: () => Promise<{
      state: "ready" | "disabled" | "error";
      detail: string | null;
      source: "settings" | "env" | "none";
    }>;
    send: (message: {
      to: string;
      subject: string;
      text: string;
    }) => Promise<void>;
    reload: () => void;
  };
  /* Process start, for uptime on the status page. */
  startedAt?: number;
  /* Re-anchoring hook for carry-forward: given two version ids, returns a
     frame mapping from the source's timeline to the target's, or null when
     the versions cannot be compared. A mapped frame of null means "the
     pictures do not vouch for a match; keep the original frame". The Node
     server implements this over sprite-tile perceptual hashes; Workers
     leave it absent and carry-forward keeps frames as-is. */
  frameMatcher?: (
    sourceVersionId: string,
    targetVersionId: string,
  ) => Promise<((frame: number) => number | null) | null>;
}

/* The authenticated user as the routes see it: the row, with the guest
   flag already folded into the role. Storage keeps role in {admin,member}
   plus a guest flag (see the users schema); the auth boundary derives the
   three-tier role once so no route ever consults the flag. */
export type SessionUser = Omit<User, "role"> & { role: WorkspaceRole };

export type Variables = {
  user: SessionUser;
  authType: "session" | "token";
  requestId: string;
};
