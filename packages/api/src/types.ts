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
}

export type Variables = {
  user: User;
  authType: "session" | "token";
  requestId: string;
};
