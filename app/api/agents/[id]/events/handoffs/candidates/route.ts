import { requireAgent } from "@/lib/auth";
import { recommendAgentEventHandoffCandidates } from "@/lib/event-handoffs";
import { agentEventHandoffCandidateSchema } from "@/lib/schemas";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const agent = await requireAgent(request);
  if (agent instanceof Response) return agent;
  const { id } = await context.params;
  if (agent.id !== id) return Response.json({ error: "agent id must match the API key owner." }, { status: 403 });
  const parsed = agentEventHandoffCandidateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid event handoff candidate request.", details: parsed.error.flatten() }, { status: 400 });
  const result = await recommendAgentEventHandoffCandidates({ sourceAgent: agent, eventId: parsed.data.event_id, requestedCapabilities: parsed.data.requested_capabilities, limit: parsed.data.limit });
  return Response.json(result.body, { status: result.status });
}
