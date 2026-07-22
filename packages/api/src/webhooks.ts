import { and, asc, eq, lte, or } from "drizzle-orm";
import { errors, hmacSha256Hex, UlidGenerator } from "@onelight/core";
import { webhookDeliveries, webhooks } from "@onelight/db/schema";
import type { AppDb } from "@onelight/db";

const deliveryIds = new UlidGenerator();

const privateIpv4 = (host: string): boolean => {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const octets = match.slice(1, 5).map(Number);
  const [a, b] = octets as [number, number, number, number];
  if (octets.some((octet) => octet > 255)) return false;
  return (
    a === 0 ||
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
};

const privateIpv6 = (host: string): boolean => {
  const value = host.toLowerCase();
  if (value === "::1" || value === "::") return true;
  // fc00::/7 (unique local) and fe80::/10 (link local).
  if (/^f[cd]/.test(value)) return true;
  if (/^fe[89ab]/.test(value)) return true;
  if (value.startsWith("::ffff:")) {
    const rest = value.slice(7);
    if (rest.includes(".")) return privateIpv4(rest);
    const groups = rest.split(":");
    if (groups.length === 2) {
      const hi = Number.parseInt(groups[0] ?? "", 16);
      const lo = Number.parseInt(groups[1] ?? "", 16);
      if (Number.isFinite(hi) && Number.isFinite(lo))
        return privateIpv4(
          `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`,
        );
    }
  }
  return false;
};

// SSRF guard for webhook targets, applied at creation and again at delivery
// time. It rejects literal loopback, private, link-local, and ULA addresses
// plus localhost/.local/.internal names. DNS rebinding (a public name that
// resolves to a private address, or changes between checks) is out of scope
// for self-hosted v1; only literal hosts are validated here.
export const webhookUrlProblem = (raw: string): string | undefined => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Webhook URL is invalid.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return "Webhook URL must use http or https.";
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  )
    return "Webhook URL must not target a local hostname.";
  if (privateIpv4(host) || privateIpv6(host))
    return "Webhook URL must not target a private or loopback address.";
  return undefined;
};

export const assertWebhookUrlAllowed = (raw: string): void => {
  const problem = webhookUrlProblem(raw);
  if (problem) throw errors.validation(problem);
};

export const scheduleWebhookDeliveries = async (
  db: AppDb,
  workspaceId: string,
  eventId: string,
  eventType: string,
  payload: unknown,
  now: number,
): Promise<void> => {
  const hooks = await db
    .select()
    .from(webhooks)
    .where(
      and(eq(webhooks.workspaceId, workspaceId), eq(webhooks.active, true)),
    )
    .all();
  for (const hook of hooks as Array<typeof webhooks.$inferSelect>) {
    let events: string[] = [];
    try {
      events = JSON.parse(hook.eventsJson) as string[];
    } catch {
      events = [];
    }
    if (!events.includes("*") && !events.includes(eventType)) continue;
    await db
      .insert(webhookDeliveries)
      .values({
        id: deliveryIds.ulid(),
        webhookId: hook.id,
        eventId,
        eventType,
        payloadJson: JSON.stringify(payload),
        status: "queued",
        attempt: 0,
        nextAttemptAt: now,
        responseStatus: null,
        responseBody: null,
        createdAt: now,
        deliveredAt: null,
      })
      .onConflictDoNothing()
      .run();
  }
};

export const deliverDueWebhookDeliveries = async (
  db: AppDb,
  now: number,
  limit = 10,
): Promise<number> => {
  const rows = await db
    .select({ delivery: webhookDeliveries, webhook: webhooks })
    .from(webhookDeliveries)
    .innerJoin(webhooks, eq(webhookDeliveries.webhookId, webhooks.id))
    .where(
      and(
        eq(webhooks.active, true),
        or(
          eq(webhookDeliveries.status, "queued"),
          eq(webhookDeliveries.status, "failed"),
        ),
        lte(webhookDeliveries.nextAttemptAt, now),
      ),
    )
    .orderBy(asc(webhookDeliveries.nextAttemptAt), asc(webhookDeliveries.id))
    .limit(limit)
    .all();
  let delivered = 0;
  for (const row of rows as Array<{
    delivery: typeof webhookDeliveries.$inferSelect;
    webhook: typeof webhooks.$inferSelect;
  }>) {
    const delivery = row.delivery;
    const attempt = delivery.attempt + 1;
    await db
      .update(webhookDeliveries)
      .set({ status: "delivering", attempt })
      .where(
        and(
          eq(webhookDeliveries.id, delivery.id),
          or(
            eq(webhookDeliveries.status, "queued"),
            eq(webhookDeliveries.status, "failed"),
          ),
        ),
      )
      .run();
    const body = JSON.stringify({
      id: delivery.eventId,
      type: delivery.eventType,
      data: JSON.parse(delivery.payloadJson),
    });
    try {
      const guardProblem = webhookUrlProblem(row.webhook.url);
      if (guardProblem) throw new Error(guardProblem);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      const response = await fetch(row.webhook.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-onelight-event-id": delivery.eventId,
          "x-onelight-signature": await hmacSha256Hex(row.webhook.secret, body),
        },
        body,
        signal: controller.signal,
        /* Do not follow redirects. The SSRF guard above vets only the URL the
           user registered; a 3xx to http://169.254.169.254/… or a private
           address would sail past it and, since the response body is stored
           and readable by the workspace, exfiltrate internal metadata. A
           webhook endpoint is expected to answer 2xx directly. */
        redirect: "manual",
      });
      clearTimeout(timeout);
      if (response.status >= 300 && response.status < 400)
        throw new Error(
          "Webhook endpoint redirected; redirects are not followed.",
        );
      const responseBody = (await response.text()).slice(0, 4096);
      if (!response.ok) throw new Error(`Webhook returned ${response.status}.`);
      await db
        .update(webhookDeliveries)
        .set({
          status: "delivered",
          responseStatus: response.status,
          responseBody,
          deliveredAt: now,
        })
        .where(eq(webhookDeliveries.id, delivery.id))
        .run();
      delivered += 1;
    } catch (error) {
      const dead = attempt >= 8;
      await db
        .update(webhookDeliveries)
        .set({
          status: dead ? "dead" : "failed",
          responseBody:
            error instanceof Error ? error.message : "Webhook delivery failed.",
          nextAttemptAt:
            now + Math.min(3_600_000, 2 ** Math.min(attempt, 10) * 1000),
        })
        .where(eq(webhookDeliveries.id, delivery.id))
        .run();
    }
  }
  return delivered;
};
