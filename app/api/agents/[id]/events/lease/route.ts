import { requireAgent } from "@/lib/auth";
import { leaseAgentEvents, updateAgentEventLease } from "@/lib/events";
import { agentEventLeaseSchema, agentEventLeaseUpdateSchema } from "@/lib/schemas";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const agent = await requireAgent(request);
  if (agent instanceof Response) return agent;
  const { id } = await context.params;
  if (agent.id !== id) return Response.json({ error: "agent id must match the API key owner." }, { status: 403 });
  const body = await request.json().catch(() => null);
  const parsed = agentEventLeaseSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid event lease payload.", details: parsed.error.flatten() }, { status: 400 });
  const result = await leaseAgentEvents(id, {
    since: parsed.data.since ? new Date(parsed.data.since) : undefined,
    limit: parsed.data.limit,
    leaseDurationSeconds: parsed.data.lease_duration_seconds,
  });
  if (!result) return Response.json({ error: "Agent not found." }, { status: 404 });
  return Response.json(result);
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const agent = await requireAgent(request);
  if (agent instanceof Response) return agent;
  const { id } = await context.params;
  if (agent.id !== id) return Response.json({ error: "agent id must match the API key owner." }, { status: 403 });
  const body = await request.json().catch(() => null);
  const parsed = agentEventLeaseUpdateSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid event lease update.", details: parsed.error.flatten() }, { status: 400 });
  const result = await updateAgentEventLease({
    agentId: id,
    eventIds: parsed.data.event_ids,
    leaseToken: parsed.data.lease_token,
    action: parsed.data.action,
    leaseDurationSeconds: parsed.data.lease_duration_seconds,
    failureReason: parsed.data.failure_reason,
    failureDetail: parsed.data.failure_detail,
  });
  if ("error" in result) return Response.json({ error: result.error }, { status: result.status });
  return Response.json(result);
}
