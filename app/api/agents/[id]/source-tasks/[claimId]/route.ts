import { requireAgent } from "@/lib/auth";
import { sourceTaskClaimUpdateSchema } from "@/lib/schemas";
import { updateSourceTaskClaim } from "@/lib/source-rendezvous-tasks";

export async function PATCH(request: Request, context: { params: Promise<{ id: string; claimId: string }> }) {
  const agent = await requireAgent(request);
  if (agent instanceof Response) return agent;

  const { id, claimId } = await context.params;
  if (agent.id !== id) {
    return Response.json({ error: "agent id must match the API key owner." }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = sourceTaskClaimUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid source task claim update.", details: parsed.error.flatten() }, { status: 400 });
  }

  const result = await updateSourceTaskClaim({
    agentId: id,
    claimId,
    status: parsed.data.status,
    resultSummary: parsed.data.result_summary,
    evidenceUrls: parsed.data.evidence_urls,
    reviewConclusion: parsed.data.review_conclusion,
    extendMinutes: parsed.data.extend_minutes,
  });

  if (!result) {
    return Response.json({ error: "Source task claim not found." }, { status: 404 });
  }
  if ("error" in result) {
    return Response.json({ error: result.error }, { status: result.status });
  }

  return Response.json(result);
}
