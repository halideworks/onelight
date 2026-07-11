declare module "cloudflare:test" {
  /**
   * Bindings from apps/cf/wrangler.jsonc as exposed by
   * @cloudflare/vitest-pool-workers. BLOBS is optional: the contract suite
   * capability-gates blob-dependent tests on its presence.
   */
  export const env: {
    DB: D1Database;
    BLOBS?: R2Bucket;
    PUBLIC_URL?: string;
    SECRET_KEY?: string;
  };
  export const SELF: Fetcher;
}
