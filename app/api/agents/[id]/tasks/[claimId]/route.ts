import { requireAgent } from "@/lib/auth";
import { taskClaimUpdateSchema } from "@/lib/schemas";
import { updateTaskClaim } from "@/lib/task-claims";

export async function PATCH(request: Request, context: { params: Promise<{ id: string; claimId: string }> }) {
  const agent = await requireAgent(request);
  if (agent instanceof Response) return agent;

  const { id, claimId } = await context.params;
  if (agent.id !== id) {
    return Response.json({ error: "agent id must match the API key owner." }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = taskClaimUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid task claim update.", details: parsed.error.flatten() }, { status: 400 });
  }

  const result = await updateTaskClaim({
    agentId: id,
    claimId,
    status: parsed.data.status,
    resultSummary: parsed.data.result_summary,
    evidenceUrls: parsed.data.evidence_urls,
    extendMinutes: parsed.data.extend_minutes,
  });

  if (!result) {
    return Response.json({ error: "Task claim not found." }, { status: 404 });
  }

  return Response.json(result);
}
