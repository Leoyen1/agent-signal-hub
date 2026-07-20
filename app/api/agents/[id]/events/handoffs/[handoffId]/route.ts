import { requireAgent } from "@/lib/auth";
import { updateAgentEventHandoff } from "@/lib/event-handoffs";
import { agentEventHandoffUpdateSchema } from "@/lib/schemas";

export async function PATCH(request: Request, context: { params: Promise<{ id: string; handoffId: string }> }) {
  const agent = await requireAgent(request);
  if (agent instanceof Response) return agent;
  const { id, handoffId } = await context.params;
  if (agent.id !== id) return Response.json({ error: "agent id must match the API key owner." }, { status: 403 });
  const parsed = agentEventHandoffUpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid event handoff update.", details: parsed.error.flatten() }, { status: 400 });
  const result = await updateAgentEventHandoff({ actorAgentId: id, handoffId, action: parsed.data.action, resultSummary: parsed.data.result_summary, evidenceUrls: parsed.data.evidence_urls, policyVersion: parsed.data.policy_version, policyDocumentHash: parsed.data.policy_document_hash });
  return Response.json(result.body, { status: result.status });
}
