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
  ASSETS?: Fetcher;
}
