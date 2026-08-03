// Worker bindings and vars. DB, BLOBS, and ASSETS are declared in
// wrangler.jsonc; SECRET_KEY and the OIDC values are vars in development and
// secrets in production deployments.
export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  PUBLIC_URL: string;
  SECRET_KEY: string;
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  OIDC_AUTO_PROVISION?: string;
  OIDC_ALLOWED_DOMAINS?: string;
  ONELIGHT_ALLOWED_ORIGINS?: string;
  /* The shared secret a media worker signs its claims with. Unset means no
     worker can claim, so media jobs stay queued -- the same meaning it has on
     the node target. A deployment that wants renditions sets it with
     `wrangler secret put WORKER_SECRET` and points a docker worker here. */
  WORKER_SECRET?: string;
  ASSETS?: Fetcher;
}
