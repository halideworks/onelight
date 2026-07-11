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
  });

export type AppConfig = z.infer<typeof configSchema> & {
  cookieSecure: boolean;
  oidcAllowedDomains: string[];
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
  };
};
