import { requireAgent } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { agentHandoffProfileUpdateSchema } from "@/lib/schemas";
import { jsonArray, toJsonArray } from "@/lib/serializers";

async function handoffMetrics(agentId: string) {
  const handoffs = await prisma.agentEventHandoff.findMany({
    where: { targetAgentId: agentId, createdAt: { gt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
    select: { status: true, eventSnapshot: true, createdAt: true, acceptedAt: true, completedAt: true },
    take: 10_000,
  });
  const completed = handoffs.filter((handoff) => handoff.status === "completed");
  const declinedCount = handoffs.filter((handoff) => handoff.status === "declined").length;
  const durations = completed.flatMap((handoff) => handoff.completedAt ? [(handoff.completedAt.getTime() - (handoff.acceptedAt ?? handoff.createdAt).getTime()) / 3_600_000] : []);
  const resolved = completed.length + declinedCount;
  const eventTypes = new Map<string, { completed: number; declined: number; durations: number[] }>();
  for (const handoff of handoffs) {
    let eventType = "unknown";
    try {
      const snapshot = JSON.parse(handoff.eventSnapshot);
      if (typeof snapshot?.type === "string") eventType = snapshot.type;
    } catch {}
    const metrics = eventTypes.get(eventType) ?? { completed: 0, declined: 0, durations: [] };
    if (handoff.status === "completed") {
      metrics.completed += 1;
      if (handoff.completedAt) metrics.durations.push((handoff.completedAt.getTime() - (handoff.acceptedAt ?? handoff.createdAt).getTime()) / 3_600_000);
    }
    if (handoff.status === "declined") metrics.declined += 1;
    eventTypes.set(eventType, metrics);
  }
  return {
    window_days: 30,
    completed_count: completed.length,
    declined_count: declinedCount,
    active_count: handoffs.filter((handoff) => ["offered", "accepted"].includes(handoff.status)).length,
    smoothed_completion_rate: Number(((completed.length + 2) / (resolved + 4)).toFixed(4)),
    average_completion_hours: durations.length ? Number((durations.reduce((sum, value) => sum + value, 0) / durations.length).toFixed(2)) : null,
    by_event_type: Object.fromEntries([...eventTypes.entries()].map(([eventType, metrics]) => {
      const typeResolved = metrics.completed + metrics.declined;
      return [eventType, {
        completed_count: metrics.completed,
        declined_count: metrics.declined,
        smoothed_completion_rate: Number(((metrics.completed + 2) / (typeResolved + 4)).toFixed(4)),
        average_completion_hours: metrics.durations.length ? Number((metrics.durations.reduce((sum, value) => sum + value, 0) / metrics.durations.length).toFixed(2)) : null,
      }];
    })),
    note: "Metrics are bounded routing signals, not reputation or governance authority.",
  };
}

async function formatProfile(agent: { id: string; handoffOptIn: boolean; handoffMaxConcurrent: number; handoffPreferredEventTypes: string; handoffProfileUpdatedAt: Date | null }) {
  return {
    agent_id: agent.id,
    handoff_opt_in: agent.handoffOptIn,
    max_concurrent_handoffs: agent.handoffMaxConcurrent,
    preferred_event_types: jsonArray(agent.handoffPreferredEventTypes),
    updated_at: agent.handoffProfileUpdatedAt?.toISOString() ?? null,
    metrics: await handoffMetrics(agent.id),
    policy: { public: true, routing_only: true, governance_effect: "none" },
  };
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const agent = await prisma.agent.findUnique({ where: { id }, select: { id: true, handoffOptIn: true, handoffMaxConcurrent: true, handoffPreferredEventTypes: true, handoffProfileUpdatedAt: true } });
  if (!agent) return Response.json({ error: "Agent not found." }, { status: 404 });
  return Response.json(await formatProfile(agent), { headers: { "Cache-Control": "public, max-age=60" } });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const agent = await requireAgent(request);
  if (agent instanceof Response) return agent;
  const { id } = await context.params;
  if (agent.id !== id) return Response.json({ error: "agent id must match the API key owner." }, { status: 403 });
  const parsed = agentHandoffProfileUpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid handoff profile.", details: parsed.error.flatten() }, { status: 400 });
  const updated = await prisma.agent.update({
    where: { id },
    data: {
      handoffOptIn: parsed.data.handoff_opt_in,
      handoffMaxConcurrent: parsed.data.max_concurrent_handoffs,
      handoffPreferredEventTypes: toJsonArray(parsed.data.preferred_event_types),
      handoffProfileUpdatedAt: new Date(),
    },
    select: { id: true, handoffOptIn: true, handoffMaxConcurrent: true, handoffPreferredEventTypes: true, handoffProfileUpdatedAt: true },
  });
  return Response.json(await formatProfile(updated));
}
