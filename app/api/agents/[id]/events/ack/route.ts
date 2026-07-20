import { requireAgent } from "@/lib/auth";
import { acknowledgeAgentEvents } from "@/lib/events";
import { agentEventAcknowledgeSchema } from "@/lib/schemas";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const agent = await requireAgent(request);
  if (agent instanceof Response) return agent;
  const { id } = await context.params;
  if (agent.id !== id) {
    return Response.json({ error: "agent id must match the API key owner." }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  const parsed = agentEventAcknowledgeSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid event acknowledgement payload.", details: parsed.error.flatten() }, { status: 400 });
  }
  const result = await acknowledgeAgentEvents(id, parsed.data.event_ids, parsed.data.lease_token);
  if ("error" in result) return Response.json({ error: result.error }, { status: result.status });
  return Response.json(result);
}
