import { requireAgent } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { webhookDeliverySchema } from "@/lib/schemas";
import { deliverWebhookSubscription } from "@/lib/webhooks";

export async function POST(request: Request, context: { params: Promise<{ id: string; subscriptionId: string }> }) {
  const authAgent = await requireAgent(request);
  if (authAgent instanceof Response) return authAgent;

  const { id, subscriptionId } = await context.params;
  if (authAgent.id !== id) {
    return Response.json({ error: "agent id must match the API key owner." }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const parsed = webhookDeliverySchema.safeParse(body ?? {});
  if (!parsed.success) {
    return Response.json({ error: "Invalid delivery payload.", details: parsed.error.flatten() }, { status: 400 });
  }

  const subscription = await prisma.webhookSubscription.findFirst({ where: { id: subscriptionId, agentId: id } });
  if (!subscription) {
    return Response.json({ error: "Subscription not found." }, { status: 404 });
  }
  if (subscription.status !== "active") {
    return Response.json({ error: "Subscription is not active.", status: subscription.status }, { status: 409 });
  }

  try {
    const result = await deliverWebhookSubscription(subscription, {
      since: parsed.data.since ? new Date(parsed.data.since) : undefined,
      limit: parsed.data.limit,
      dryRun: parsed.data.dry_run,
    });

    return Response.json(result, { status: result.delivered || parsed.data.dry_run || result.status.startsWith("skipped") ? 200 : 502 });
  } catch (error) {
    await prisma.webhookSubscription.update({
      where: { id: subscription.id },
      data: {
        lastDeliveryAt: new Date(),
        lastDeliveryStatus: "delivery_error",
        lastDeliveryResponse: error instanceof Error ? error.message.slice(0, 500) : "Unknown delivery error",
      },
    });

    return Response.json({ delivered: false, status: "delivery_error", error: error instanceof Error ? error.message : "Unknown error" }, { status: 502 });
  }
}
