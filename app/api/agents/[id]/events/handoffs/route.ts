import { requireAgent } from "@/lib/auth";
import { createAgentEventHandoff, listAgentEventHandoffs } from "@/lib/event-handoffs";
import { agentEventHandoffCreateSchema } from "@/lib/schemas";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const agent = await requireAgent(request);
  if (agent instanceof Response) return agent;
  const { id } = await context.params;
  if (agent.id !== id) return Response.json({ error: "agent id must match the API key owner." }, { status: 403 });
  return Response.json(await listAgentEventHandoffs(id));
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const agent = await requireAgent(request);
  if (agent instanceof Response) return agent;
  const { id } = await context.params;
  if (agent.id !== id) return Response.json({ error: "agent id must match the API key owner." }, { status: 403 });
  const parsed = agentEventHandoffCreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid event handoff payload.", details: parsed.error.flatten() }, { status: 400 });
  const result = await createAgentEventHandoff({ sourceAgent: agent, targetAgentId: parsed.data.target_agent_id, eventId: parsed.data.event_id, reason: parsed.data.reason, requestedCapabilities: parsed.data.requested_capabilities });
  return Response.json(result.body, { status: result.status });
}
