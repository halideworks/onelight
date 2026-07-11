import { createApp } from "@onelight/api";
import {
  loadConfig,
  Pbkdf2PasswordHasher,
  UlidGenerator,
} from "@onelight/core";
import { applyD1Migrations, createD1Db } from "@onelight/db/cf";

interface Env {
  DB: D1Database;
  PUBLIC_URL: string;
  SECRET_KEY: string;
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  OIDC_AUTO_PROVISION?: string;
  OIDC_ALLOWED_DOMAINS?: string;
  ASSETS?: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    await applyD1Migrations(env.DB);
    const config = loadConfig({
      PUBLIC_URL: env.PUBLIC_URL,
      SECRET_KEY: env.SECRET_KEY,
      OIDC_ISSUER: env.OIDC_ISSUER,
      OIDC_CLIENT_ID: env.OIDC_CLIENT_ID,
      OIDC_CLIENT_SECRET: env.OIDC_CLIENT_SECRET,
      OIDC_AUTO_PROVISION: env.OIDC_AUTO_PROVISION,
      OIDC_ALLOWED_DOMAINS: env.OIDC_ALLOWED_DOMAINS,
      PORT: "8787",
      HOST: "0.0.0.0",
      DATABASE_PATH: ":d1:",
    });
    const app = createApp({
      db: createD1Db(env.DB),
      hasher: new Pbkdf2PasswordHasher(),
      clock: { now: () => Date.now() },
      ids: new UlidGenerator(),
      config,
      version: "0.1.0-cf",
    });
    const pathname = new URL(request.url).pathname;
    if (
      env.ASSETS &&
      pathname.startsWith("/s/") &&
      (request.headers.get("accept") ?? "").includes("text/html")
    ) {
      return env.ASSETS.fetch(
        new Request(new URL("/index.html", request.url), request),
      );
    }
    if (
      env.ASSETS &&
      !pathname.startsWith("/api/") &&
      !pathname.startsWith("/s/") &&
      pathname !== "/healthz"
    ) {
      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.status !== 404) return assetResponse;
    }
    return app.fetch(request);
  },
};
