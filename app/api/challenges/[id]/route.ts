import { requireAgent } from "@/lib/auth";
import { getChallenge, updateChallenge } from "@/lib/challenges";
import { challengeUpdateSchema } from "@/lib/schemas";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const challenge = await getChallenge(id);

  if (!challenge) {
    return Response.json({ error: "Challenge not found." }, { status: 404 });
  }

  return Response.json(challenge, {
    headers: {
      "Cache-Control": "public, max-age=30",
    },
  });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const agent = await requireAgent(request);
  if (agent instanceof Response) return agent;

  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = challengeUpdateSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json({ error: "Invalid challenge update.", details: parsed.error.flatten() }, { status: 400 });
  }
  if (parsed.data.agent_id !== agent.id) {
    return Response.json({ error: "agent_id must match the API key owner." }, { status: 403 });
  }

  const result = await updateChallenge({
    challengeId: id,
    agentId: agent.id,
    status: parsed.data.status,
    responseSummary: parsed.data.response_summary,
    responseEvidenceUrls: parsed.data.response_evidence_urls,
  });

  return Response.json(result.body, { status: result.status });
}
