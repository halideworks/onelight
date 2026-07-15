import { z } from "zod";

// Strict string-to-boolean parser for env vars. z.coerce.boolean() treats any
// non-empty string as true, so "false" and "0" would enable the flag. Here
// "true"/"1" mean true, "false"/"0"/"" mean false, anything else is rejected.
const booleanEnv = z
  .string()
  .optional()
  .transform((value, ctx): boolean | undefined => {
    if (value === undefined) return undefined;
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0" || normalized === "")
      return false;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'Boolean env vars accept only "true", "1", "false", "0", or empty.',
    });
    return z.NEVER;
  });

const booleanEnvDefaultFalse = booleanEnv.transform(
  (value): boolean => value ?? false,
);

const configSchema = z
  .object({
    PUBLIC_URL: z.string().url(),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().default("0.0.0.0"),
    DATABASE_PATH: z.string().default("/data/onelight.db"),
    BLOB_ROOT: z.string().min(1).optional(),
    SECRET_KEY: z.string().min(32),
    ONELIGHT_ADMIN_EMAIL: z.string().email().optional(),
    ONELIGHT_ADMIN_PASSWORD: z.string().min(10).optional(),
    ONELIGHT_WORKSPACE_NAME: z.string().min(1).default("Onelight"),
    OIDC_ISSUER: z.string().url().optional(),
    OIDC_CLIENT_ID: z.string().min(1).optional(),
    OIDC_CLIENT_SECRET: z.string().min(1).optional(),
    OIDC_AUTO_PROVISION: booleanEnvDefaultFalse,
    OIDC_ALLOWED_DOMAINS: z.string().optional(),
    COOKIE_SECURE: booleanEnv,
    TRUST_PROXY: booleanEnvDefaultFalse,
    /* Extra origins the CSRF check accepts, comma separated. PUBLIC_URL's own
       origin is always allowed and never needs listing. This exists because
       PUBLIC_URL is one value doing two jobs: it is both the origin users are
       expected to arrive from and the base for every absolute URL the app
       mints. Reaching a deployment by any other name -- the LAN address while
       the public DNS is not up yet, a tailnet host, a second domain -- then
       fails every cookie-carrying POST with "The request origin is not
       allowed." while looking, from the browser, like a broken login. */
    ONELIGHT_ALLOWED_ORIGINS: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    const oidc = [
      value.OIDC_ISSUER,
      value.OIDC_CLIENT_ID,
      value.OIDC_CLIENT_SECRET,
    ];
    if (oidc.some(Boolean) && !oidc.every(Boolean)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "OIDC_ISSUER, OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET must be set together.",
      });
    }
    /* Fail at startup rather than at the first blocked request: a typo here is
       only ever discovered by someone unable to log in. */
    for (const origin of splitList(value.ONELIGHT_ALLOWED_ORIGINS)) {
      try {
        new URL(origin);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ONELIGHT_ALLOWED_ORIGINS"],
          message: `"${origin}" is not a valid origin. Use a full scheme and host, e.g. https://review.example.com or http://192.168.1.52:3000.`,
        });
      }
    }
  });

const splitList = (value: string | undefined): string[] =>
  value
    ? value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];

export type AppConfig = z.infer<typeof configSchema> & {
  cookieSecure: boolean;
  oidcAllowedDomains: string[];
  /* Every origin the CSRF check accepts: PUBLIC_URL's own, plus any extras. */
  allowedOrigins: string[];
};

export const loadConfig = (
  input: NodeJS.ProcessEnv | Record<string, string | undefined>,
): AppConfig => {
  const parsed = configSchema.parse(input);
  return {
    ...parsed,
    cookieSecure:
      parsed.COOKIE_SECURE ?? new URL(parsed.PUBLIC_URL).protocol === "https:",
    oidcAllowedDomains: parsed.OIDC_ALLOWED_DOMAINS
      ? parsed.OIDC_ALLOWED_DOMAINS.split(",")
          .map((domain) => domain.trim().toLowerCase())
          .filter(Boolean)
      : [],
    /* Normalised through URL so "https://x.com/" and "https://x.com" are the
       same entry, and so comparison is against an origin rather than a string
       the operator happened to type. */
    allowedOrigins: [
      new URL(parsed.PUBLIC_URL).origin,
      ...splitList(parsed.ONELIGHT_ALLOWED_ORIGINS).map(
        (origin) => new URL(origin).origin,
      ),
    ],
  };
};
