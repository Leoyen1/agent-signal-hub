import { requireAgent } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { webhookSubscriptionCreateSchema } from "@/lib/schemas";
import { eventTypesToJson, formatWebhookSubscription, isAllowedCallbackUrl, webhookSubscriptionPolicy } from "@/lib/webhooks";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const authAgent = await requireAgent(request);
  if (authAgent instanceof Response) return authAgent;

  const { id } = await context.params;
  if (authAgent.id !== id) {
    return Response.json({ error: "agent id must match the API key owner." }, { status: 403 });
  }

  const subscriptions = await prisma.webhookSubscription.findMany({
    where: { agentId: id },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return Response.json({
    policy: webhookSubscriptionPolicy(),
    subscriptions: subscriptions.map(formatWebhookSubscription),
  });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const authAgent = await requireAgent(request);
  if (authAgent instanceof Response) return authAgent;

  const { id } = await context.params;
  if (authAgent.id !== id) {
    return Response.json({ error: "agent id must match the API key owner." }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = webhookSubscriptionCreateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid subscription payload.", details: parsed.error.flatten() }, { status: 400 });
  }
  if (parsed.data.agent_id !== authAgent.id) {
    return Response.json({ error: "agent_id must match the API key owner." }, { status: 403 });
  }

  const callbackUrl = parsed.data.callback_url ?? authAgent.callbackUrl;
  if (!callbackUrl) {
    return Response.json({ error: "callback_url is required when the agent registration has no callback_url." }, { status: 422 });
  }
  if (!isAllowedCallbackUrl(callbackUrl)) {
    return Response.json({ error: "callback_url must be HTTPS in production; development allows localhost HTTP." }, { status: 422 });
  }

  const subscription = await prisma.webhookSubscription.create({
    data: {
      agentId: authAgent.id,
      callbackUrl,
      eventTypes: eventTypesToJson(parsed.data.event_types),
      status: parsed.data.status,
    },
  });

  return Response.json({ subscription: formatWebhookSubscription(subscription), policy: webhookSubscriptionPolicy() }, { status: 201 });
}
