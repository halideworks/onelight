import { describe, expect, it } from "vitest";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { loadConfig } from "@onelight/core";
import { createApp } from "../../app.js";
import { cookieFrom, json, req } from "../harness.js";
import type { ContractHarness } from "../harness.js";
import { createUser, uniqueEmail, uniqueIp } from "../seed.js";
import type { SuiteContext } from "../context.js";

const ISSUER = "https://idp.contract.test";
const CLIENT_ID = "onelight-contract-client";

/**
 * OIDC flow coverage (phase-0 section 5 and T12) against a stubbed issuer:
 * global fetch is patched to serve the discovery document, token endpoint,
 * and JWKS, and ID tokens are signed with a locally generated RS256 key.
 * The app under test is a second createApp() over the same database with
 * OIDC configured, since the main harness app intentionally runs without
 * OIDC to cover the 404 contract.
 */
interface Idp {
  app: ReturnType<typeof createApp>;
  signIdToken: (claims: {
    subject: string;
    email: string;
    nonce: string;
    emailVerified?: boolean;
    name?: string;
  }) => Promise<string>;
  run: <T>(fn: () => Promise<T>) => Promise<T>;
  setIdToken: (token: string) => void;
}

const makeIdp = async (
  h: ContractHarness,
  options: { autoProvision?: boolean; allowedDomains?: string } = {},
): Promise<Idp> => {
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  jwk.alg = "RS256";
  jwk.use = "sig";
  const config = loadConfig({
    PUBLIC_URL: h.config.PUBLIC_URL,
    SECRET_KEY: h.config.SECRET_KEY,
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENT_ID: CLIENT_ID,
    OIDC_CLIENT_SECRET: "an-oidc-client-secret",
    OIDC_AUTO_PROVISION: options.autoProvision === false ? "false" : "true",
    ...(options.allowedDomains
      ? { OIDC_ALLOWED_DOMAINS: options.allowedDomains }
      : {}),
  });
  const app = createApp({
    db: h.db,
    hasher: h.hasher,
    clock: h.clock,
    ids: h.ids,
    config,
    version: "contract-oidc",
  });
  let idToken = "";
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    const original = globalThis.fetch;
    const stub = (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.startsWith(`${ISSUER}/.well-known/openid-configuration`))
        return Promise.resolve(
          Response.json({
            authorization_endpoint: `${ISSUER}/authorize`,
            token_endpoint: `${ISSUER}/token`,
            jwks_uri: `${ISSUER}/jwks`,
          }),
        );
      if (url.startsWith(`${ISSUER}/token`))
        return Promise.resolve(Response.json({ id_token: idToken }));
      if (url.startsWith(`${ISSUER}/jwks`))
        return Promise.resolve(Response.json({ keys: [jwk] }));
      return original(input, init);
    };
    globalThis.fetch = stub;
    try {
      return await fn();
    } finally {
      globalThis.fetch = original;
    }
  };
  const signIdToken = (claims: {
    subject: string;
    email: string;
    nonce: string;
    emailVerified?: boolean;
    name?: string;
  }): Promise<string> =>
    new SignJWT({
      email: claims.email,
      email_verified: claims.emailVerified ?? true,
      nonce: claims.nonce,
      ...(claims.name ? { name: claims.name } : {}),
    })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setSubject(claims.subject)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  return {
    app,
    signIdToken,
    run,
    setIdToken: (token) => {
      idToken = token;
    },
  };
};

interface FlowResult {
  status: number;
  sessionCookie: string;
}

const runFlow = async (
  idp: Idp,
  options: {
    subject: string;
    email: string;
    tamperState?: boolean;
    wrongNonce?: boolean;
    dropCookie?: boolean;
    emailVerified?: boolean;
  },
): Promise<FlowResult> =>
  idp.run(async () => {
    const ip = uniqueIp();
    const start = await idp.app.request("/api/v1/auth/oidc/start", {
      headers: { "x-forwarded-for": ip },
    });
    if (start.status !== 302)
      throw new Error(`OIDC start failed: ${String(start.status)}`);
    const location = new URL(start.headers.get("location") ?? "");
    const state = location.searchParams.get("state") ?? "";
    const nonce = location.searchParams.get("nonce") ?? "";
    const oidcCookie = cookieFrom(start);
    idp.setIdToken(
      await idp.signIdToken({
        subject: options.subject,
        email: options.email,
        nonce: options.wrongNonce ? "not-the-real-nonce" : nonce,
        ...(options.emailVerified === undefined
          ? {}
          : { emailVerified: options.emailVerified }),
      }),
    );
    const callbackState = options.tamperState ? "tampered-state" : state;
    const callback = await idp.app.request(
      `/api/v1/auth/oidc/callback?code=fake-code&state=${encodeURIComponent(callbackState)}`,
      {
        headers: {
          ...(options.dropCookie ? {} : { cookie: oidcCookie }),
          "x-forwarded-for": ip,
        },
      },
    );
    return { status: callback.status, sessionCookie: cookieFrom(callback) };
  });

export const registerOidcDomain = (ctx: SuiteContext): void => {
  describe("oidc", () => {
    it("issues the start redirect with PKCE, state, and nonce", async () => {
      const h = ctx.h();
      const idp = await makeIdp(h);
      await idp.run(async () => {
        const start = await idp.app.request("/api/v1/auth/oidc/start");
        expect(start.status).toBe(302);
        const location = new URL(start.headers.get("location") ?? "");
        expect(location.origin).toBe(ISSUER);
        expect(location.searchParams.get("client_id")).toBe(CLIENT_ID);
        expect(location.searchParams.get("response_type")).toBe("code");
        expect(location.searchParams.get("code_challenge_method")).toBe("S256");
        expect(location.searchParams.get("state")).toBeTruthy();
        expect(location.searchParams.get("nonce")).toBeTruthy();
        expect(location.searchParams.get("scope")).toBe("openid email profile");
        const cookie = start.headers.get("set-cookie") ?? "";
        expect(cookie).toContain("ol_oidc=");
        expect(cookie).toContain("HttpOnly");
      });
    });

    it("auto-provisions on first login and reuses the identity after", async () => {
      const h = ctx.h();
      const idp = await makeIdp(h);
      const email = uniqueEmail();
      const subject = `sub-${email}`;
      const first = await runFlow(idp, { subject, email });
      expect(first.status).toBe(302);
      expect(first.sessionCookie).toContain("ol_session=");
      const me = await req(h, "/api/v1/users/me", {
        cookie: first.sessionCookie,
      });
      expect(me.status).toBe(200);
      const firstUser = await json<{ id: string; email: string; role: string }>(
        me,
      );
      expect(firstUser.email).toBe(email);
      expect(firstUser.role).toBe("member");
      const second = await runFlow(idp, { subject, email });
      expect(second.status).toBe(302);
      const meAgain = await json<{ id: string }>(
        await req(h, "/api/v1/users/me", { cookie: second.sessionCookie }),
      );
      expect(meAgain.id).toBe(firstUser.id);
    });

    it("links to an existing user by verified email", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const idp = await makeIdp(h, { autoProvision: false });
      const existing = await createUser(h, {
        workspaceId: seed.workspaceId,
        passwordHash: null,
        session: false,
      });
      const result = await runFlow(idp, {
        subject: `link-${existing.email}`,
        email: existing.email,
      });
      expect(result.status).toBe(302);
      const me = await json<{ id: string }>(
        await req(h, "/api/v1/users/me", { cookie: result.sessionCookie }),
      );
      expect(me.id).toBe(existing.id);
    });

    it("rejects unverified email before linking or provisioning", async () => {
      const h = ctx.h();
      const idp = await makeIdp(h);
      const email = uniqueEmail();
      const result = await runFlow(idp, {
        subject: `unverified-${email}`,
        email,
        emailVerified: false,
      });
      expect(result.status).toBe(403);
      expect(result.sessionCookie).not.toContain("ol_session=");
    });

    it("rejects tampered state, wrong nonce, and missing cookie state", async () => {
      const h = ctx.h();
      const idp = await makeIdp(h);
      const email = uniqueEmail();
      const tampered = await runFlow(idp, {
        subject: `s-${email}`,
        email,
        tamperState: true,
      });
      expect(tampered.status).toBe(403);
      const wrongNonce = await runFlow(idp, {
        subject: `s2-${email}`,
        email,
        wrongNonce: true,
      });
      expect(wrongNonce.status).toBe(403);
      const noCookie = await runFlow(idp, {
        subject: `s3-${email}`,
        email,
        dropCookie: true,
      });
      expect(noCookie.status).toBe(403);
    });

    it("enforces the allowed-domain list and the no-provision default", async () => {
      const h = ctx.h();
      const restricted = await makeIdp(h, {
        allowedDomains: "allowed.example",
      });
      const denied = await runFlow(restricted, {
        subject: "domain-denied",
        email: uniqueEmail(),
      });
      expect(denied.status).toBe(403);
      const allowed = await runFlow(restricted, {
        subject: "domain-allowed",
        email: `person-${Date.now().toString(36)}@allowed.example`,
      });
      expect(allowed.status).toBe(302);
      const noProvision = await makeIdp(h, { autoProvision: false });
      const unknown = await runFlow(noProvision, {
        subject: "unknown-subject",
        email: uniqueEmail(),
      });
      expect(unknown.status).toBe(403);
    });
  });
};
