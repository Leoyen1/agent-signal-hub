import { requireAgent } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { webhookSubscriptionUpdateSchema } from "@/lib/schemas";
import { eventTypesToJson, formatWebhookSubscription, isAllowedCallbackUrl, webhookSubscriptionPolicy } from "@/lib/webhooks";

export async function GET(request: Request, context: { params: Promise<{ id: string; subscriptionId: string }> }) {
  const authAgent = await requireAgent(request);
  if (authAgent instanceof Response) return authAgent;

  const { id, subscriptionId } = await context.params;
  if (authAgent.id !== id) {
    return Response.json({ error: "agent id must match the API key owner." }, { status: 403 });
  }

  const subscription = await prisma.webhookSubscription.findFirst({ where: { id: subscriptionId, agentId: id } });
  if (!subscription) {
    return Response.json({ error: "Subscription not found." }, { status: 404 });
  }

  return Response.json({ subscription: formatWebhookSubscription(subscription), policy: webhookSubscriptionPolicy() });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string; subscriptionId: string }> }) {
  const authAgent = await requireAgent(request);
  if (authAgent instanceof Response) return authAgent;

  const { id, subscriptionId } = await context.params;
  if (authAgent.id !== id) {
    return Response.json({ error: "agent id must match the API key owner." }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = webhookSubscriptionUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid subscription update.", details: parsed.error.flatten() }, { status: 400 });
  }
  if (parsed.data.callback_url && !isAllowedCallbackUrl(parsed.data.callback_url)) {
    return Response.json({ error: "callback_url must be HTTPS in production; development allows localhost HTTP." }, { status: 422 });
  }

  const existing = await prisma.webhookSubscription.findFirst({ where: { id: subscriptionId, agentId: id } });
  if (!existing) {
    return Response.json({ error: "Subscription not found." }, { status: 404 });
  }

  const subscription = await prisma.webhookSubscription.update({
    where: { id: subscriptionId },
    data: {
      callbackUrl: parsed.data.callback_url,
      eventTypes: parsed.data.event_types ? eventTypesToJson(parsed.data.event_types) : undefined,
      status: parsed.data.status,
    },
  });

  return Response.json({ subscription: formatWebhookSubscription(subscription), policy: webhookSubscriptionPolicy() });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string; subscriptionId: string }> }) {
  const authAgent = await requireAgent(request);
  if (authAgent instanceof Response) return authAgent;

  const { id, subscriptionId } = await context.params;
  if (authAgent.id !== id) {
    return Response.json({ error: "agent id must match the API key owner." }, { status: 403 });
  }

  const existing = await prisma.webhookSubscription.findFirst({ where: { id: subscriptionId, agentId: id } });
  if (!existing) {
    return Response.json({ error: "Subscription not found." }, { status: 404 });
  }

  const subscription = await prisma.webhookSubscription.update({
    where: { id: subscriptionId },
    data: { status: "revoked" },
  });

  return Response.json({ subscription: formatWebhookSubscription(subscription), policy: webhookSubscriptionPolicy() });
}
