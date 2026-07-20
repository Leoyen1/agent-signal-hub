import crypto from "node:crypto";
import { isIP } from "node:net";
import type { WebhookSubscription } from "@prisma/client";
import { appBaseUrl } from "@/lib/agent-discovery";
import { buildAgentEvents, eventsPolicy, type NodeEvent } from "@/lib/events";
import { prisma } from "@/lib/prisma";
import { isLocalhost, PublicNetworkPolicyError, publicOutboundRequestPolicy, requestPublicHttps } from "@/lib/public-network";
import { jsonArray, toJsonArray } from "@/lib/serializers";

const MAX_RESPONSE_CHARS = 500;

export function callbackUrlPolicy() {
  return {
    allowed_protocols: process.env.NODE_ENV === "production" ? ["https:"] : ["https:", "http: localhost only"],
    production_requires_https: true,
    redirects_followed: false,
    timeout_ms: 5000,
    public_https_transport: publicOutboundRequestPolicy(),
    payload_mode: "webhook_hint",
    payload_contains: ["event ids", "event summaries", "resource links", "pull cursors"],
    payload_omits: ["api keys", "private data", "full trust decisions beyond public event metadata"],
    receiver_expectation: "Treat callback delivery as a hint; verify by polling /api/events or linked resources.",
  };
}

export function isAllowedCallbackUrl(callbackUrl: string) {
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    return false;
  }

  if (url.protocol === "https:") return !isLocalhost(url.hostname);
  return process.env.NODE_ENV !== "production" && url.protocol === "http:" && isLocalhost(url.hostname);
}

export function webhookSubscriptionPolicy() {
  return {
    schema_version: "2026-07-10",
    purpose: "Let agents declare callback endpoints for event-hint delivery while keeping pull endpoints authoritative.",
    authentication_required: true,
    ownership_rule: "agent_id must match Authorization: Bearer <api_key> owner",
    event_policy: eventsPolicy(),
    callback_url_policy: callbackUrlPolicy(),
    empty_event_types: "subscribe to all event types",
    delivery_endpoint: "/api/agents/{id}/subscriptions/{subscription_id}/deliver",
  };
}

export function formatWebhookSubscription(subscription: WebhookSubscription) {
  const baseUrl = appBaseUrl();

  return {
    id: subscription.id,
    agent_id: subscription.agentId,
    callback_url: subscription.callbackUrl,
    event_types: jsonArray(subscription.eventTypes),
    status: subscription.status,
    last_cursor_at: subscription.lastCursorAt?.toISOString(),
    last_delivery_at: subscription.lastDeliveryAt?.toISOString(),
    last_delivery_status: subscription.lastDeliveryStatus,
    last_delivery_response: subscription.lastDeliveryResponse,
    created_at: subscription.createdAt.toISOString(),
    updated_at: subscription.updatedAt.toISOString(),
    links: {
      self: `${baseUrl}/api/agents/${subscription.agentId}/subscriptions/${subscription.id}`,
      deliver: `${baseUrl}/api/agents/${subscription.agentId}/subscriptions/${subscription.id}/deliver`,
      agent_events: `${baseUrl}/api/agents/${subscription.agentId}/events`,
    },
  };
}

export function eventTypesToJson(eventTypes: readonly string[] | undefined) {
  return toJsonArray([...(eventTypes ?? [])]);
}

function filterEvents(events: NodeEvent[], eventTypes: string[]) {
  if (!eventTypes.length) return events;
  const allowed = new Set(eventTypes);
  return events.filter((event) => allowed.has(event.type));
}

export async function buildWebhookDeliveryPayload(subscription: WebhookSubscription, options: { since?: Date; limit?: number } = {}) {
  const since = options.since ?? subscription.lastCursorAt ?? undefined;
  const stream = await buildAgentEvents(subscription.agentId, { since, limit: options.limit }, { includePrivateSourceWatchEvents: true });
  if (!stream) return null;

  const events = filterEvents(stream.events, jsonArray(subscription.eventTypes));
  const deliveryId = `delivery_${crypto.randomUUID()}`;

  return {
    schema_version: "2026-07-10",
    delivery_id: deliveryId,
    mode: "webhook_hint",
    subscription_id: subscription.id,
    agent_id: subscription.agentId,
    callback_url: subscription.callbackUrl,
    generated_at: new Date().toISOString(),
    cursor: {
      since: stream.cursor.since,
      next_since: events.length ? events[events.length - 1].occurred_at : stream.cursor.next_since,
    },
    policy: webhookSubscriptionPolicy(),
    events,
    links: {
      subscription: `${appBaseUrl()}/api/agents/${subscription.agentId}/subscriptions/${subscription.id}`,
      agent_events: `${appBaseUrl()}/api/agents/${subscription.agentId}/events`,
      source_watch_feed: `${appBaseUrl()}/api/agents/${subscription.agentId}/source-watches/feed`,
      node_events: `${appBaseUrl()}/api/events`,
    },
  };
}

export async function deliverWebhookSubscription(subscription: WebhookSubscription, options: { since?: Date; limit?: number; dryRun?: boolean } = {}) {
  const payload = await buildWebhookDeliveryPayload(subscription, options);
  if (!payload) {
    return { delivered: false, status: "agent_not_found", payload: null };
  }

  if (!payload.events.length) {
    await prisma.webhookSubscription.update({
      where: { id: subscription.id },
      data: {
        lastCursorAt: new Date(payload.cursor.next_since),
        lastDeliveryAt: new Date(),
        lastDeliveryStatus: "skipped_no_events",
        lastDeliveryResponse: null,
      },
    });
    return { delivered: false, status: "skipped_no_events", payload };
  }

  if (options.dryRun) {
    return { delivered: false, status: "dry_run", payload };
  }

  if (!isAllowedCallbackUrl(subscription.callbackUrl)) {
    await prisma.webhookSubscription.update({
      where: { id: subscription.id },
      data: {
        lastDeliveryAt: new Date(),
        lastDeliveryStatus: "blocked_callback_url",
        lastDeliveryResponse: "Callback URL violates the protocol or local-address policy; production requires HTTPS.",
      },
    });
    return { delivered: false, status: "blocked_callback_url", payload };
  }

  const callbackUrl = new URL(subscription.callbackUrl);
  const requestBody = JSON.stringify(payload);
  const headers = {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(requestBody, "utf8")),
    "User-Agent": "Agent-Signal-Hub/0.1 webhook-hint",
    "X-Agent-Signal-Hub-Delivery": payload.delivery_id,
    "X-Agent-Signal-Hub-Subscription": subscription.id,
    "X-Agent-Signal-Hub-Event-Count": String(payload.events.length),
  };

  let responseStatus: number;
  let responseStatusText: string;
  let responseText: string;
  try {
    if (callbackUrl.protocol === "https:") {
      const response = await requestPublicHttps(subscription.callbackUrl, {
        method: "POST",
        headers,
        body: requestBody,
        timeoutMs: 5000,
        maxResponseBytes: 4096,
      });
      responseStatus = response.status;
      responseStatusText = response.statusText;
      responseText = response.body.slice(0, MAX_RESPONSE_CHARS);
    } else {
      const response = await fetch(subscription.callbackUrl, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
        headers,
        body: requestBody,
      });
      responseStatus = response.status;
      responseStatusText = response.statusText;
      responseText = (await response.text().catch(() => "")).slice(0, MAX_RESPONSE_CHARS);
    }
  } catch (error) {
    const blocked = error instanceof PublicNetworkPolicyError;
    const status = blocked ? "blocked_callback_url" : "delivery_error";
    await prisma.webhookSubscription.update({
      where: { id: subscription.id },
      data: {
        lastDeliveryAt: new Date(),
        lastDeliveryStatus: status,
        lastDeliveryResponse: blocked ? error.message : "Callback delivery failed through the pinned HTTPS transport.",
      },
    });
    return { delivered: false, status, payload };
  }

  const status = `http_${responseStatus}`;
  await prisma.webhookSubscription.update({
    where: { id: subscription.id },
    data: {
      lastCursorAt: new Date(payload.cursor.next_since),
      lastDeliveryAt: new Date(),
      lastDeliveryStatus: status,
      lastDeliveryResponse: responseText || responseStatusText,
    },
  });

  return { delivered: responseStatus >= 200 && responseStatus < 300, status, payload };
}
