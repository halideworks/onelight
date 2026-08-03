/* Webhook delivery that cannot be pointed at the private network by DNS.
 *
 * The URL guard in packages/api rejects literal private addresses and local
 * names, and it runs again at delivery time. What it cannot do is judge a
 * public NAME: only the resolver knows what hooks.example.com currently
 * answers with, and that answer can change between registering a webhook and
 * delivering to it, between two deliveries, or between the check and the
 * connection. The last gap is the rebinding one, and it is why checking and
 * connecting have to be the same act.
 *
 * So: resolve every A and AAAA record immediately before connecting, refuse
 * unless all of them are public, then connect to an address that was actually
 * validated instead of resolving a second time. The hostname still travels
 * with the request, so SNI and certificate verification are unaffected.
 *
 * This uses node:http(s) rather than fetch because the pin is a socket-level
 * concern: `lookup` is an option these accept natively. It also means
 * redirects are not followed because nothing follows them, rather than because
 * a flag asked for that.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { privateAddress } from "@onelight/api";
import type { WebhookFetch } from "@onelight/api";

const isIpLiteral = (host: string): boolean =>
  /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");

/** Body kept small: it is only ever stored as a preview of what came back. */
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface ResolvedTarget {
  address: string;
  family: 4 | 6;
}

/**
 * Every address a hostname answers with, or a reason not to connect at all.
 *
 * One private answer condemns the whole name. Picking a public address out of
 * a mixed set would be a race worth losing: the resolver is saying this name
 * points inside, and connecting anyway trusts whichever record was read first.
 */
export const resolveWebhookHost = async (
  host: string,
): Promise<{ addresses: ResolvedTarget[] } | { problem: string }> => {
  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await dnsLookup(host, { all: true, verbatim: true });
  } catch {
    return { problem: `Webhook host ${host} could not be resolved.` };
  }
  if (!answers.length)
    return { problem: `Webhook host ${host} resolved to no addresses.` };
  const offender = answers.find((answer) => privateAddress(answer.address));
  if (offender)
    return {
      problem: `Webhook host ${host} resolves to the private address ${offender.address}.`,
    };
  return {
    addresses: answers.map((answer) => ({
      address: answer.address,
      family: answer.family === 6 ? 6 : 4,
    })),
  };
};

const headerRecord = (init: RequestInit): Record<string, string> => {
  const out: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
};

/**
 * A delivery that connects only to an address it has just validated.
 *
 * The pin is the point. Resolving, checking, and then letting the socket
 * resolve again would leave exactly the window this closes: a name that
 * answered publicly for the check can answer privately a moment later for the
 * connection.
 */
export const pinnedWebhookFetch: WebhookFetch = async (url, init) => {
  const target = new URL(url);
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  /* A literal was already judged by the URL guard: there is no name here to
     resolve, so there is nothing to pin against either. */
  let pinned: ResolvedTarget | undefined;
  if (!isIpLiteral(host)) {
    const resolved = await resolveWebhookHost(host);
    if ("problem" in resolved) throw new Error(resolved.problem);
    pinned = resolved.addresses[0];
  }

  const transport = target.protocol === "https:" ? https : http;
  const body = typeof init.body === "string" ? init.body : undefined;

  return new Promise<Response>((resolve, reject) => {
    const request = transport.request(
      {
        protocol: target.protocol,
        /* The NAME, not the address: TLS must verify the certificate against
           what the operator registered. */
        host,
        servername: target.protocol === "https:" ? host : undefined,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: init.method ?? "GET",
        headers: headerRecord(init),
        ...(pinned
          ? {
              /* Hand the socket the address we validated rather than letting
                 it ask the resolver again. */
              lookup: (
                _hostname: string,
                _options: unknown,
                callback: (
                  error: Error | null,
                  address: string,
                  family: number,
                ) => void,
              ) => {
                callback(null, pinned.address, pinned.family);
              },
            }
          : {}),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk);
        });
        response.once("end", () => {
          const status = response.statusCode ?? 502;
          /* 204, 205 and 304 may not carry a body: constructing a Response
             with one throws, and a webhook answering 204 is the most ordinary
             thing in the world. */
          const empty = status === 204 || status === 205 || status === 304;
          resolve(
            new Response(
              empty ? null : Buffer.concat(chunks).toString("utf8"),
              { status },
            ),
          );
        });
        response.once("error", reject);
      },
    );
    request.once("error", reject);
    /* The caller's AbortController still governs the deadline. Checked as
       well as listened for: a signal already aborted never fires again. */
    const abort = (): void => {
      request.destroy(new Error("Webhook delivery timed out."));
    };
    if (init.signal?.aborted) abort();
    else init.signal?.addEventListener("abort", abort);
    if (body !== undefined) request.write(body);
    request.end();
  });
};
