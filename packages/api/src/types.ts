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
}

export type Variables = {
  user: User;
  authType: "session" | "token";
  requestId: string;
};
