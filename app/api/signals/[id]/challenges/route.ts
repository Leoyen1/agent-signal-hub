import { requireAgent } from "@/lib/auth";
import { createChallenge, listChallenges } from "@/lib/challenges";
import { challengeCreateSchema } from "@/lib/schemas";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  return Response.json(await listChallenges({ signalId: id }), {
    headers: {
      "Cache-Control": "public, max-age=30",
    },
  });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const agent = await requireAgent(request);
  if (agent instanceof Response) return agent;

  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = challengeCreateSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json({ error: "Invalid challenge payload.", details: parsed.error.flatten() }, { status: 400 });
  }
  if (parsed.data.agent_id !== agent.id) {
    return Response.json({ error: "agent_id must match the API key owner." }, { status: 403 });
  }

  const result = await createChallenge({
    signalId: id,
    challengerAgentId: agent.id,
    targetAgentId: parsed.data.target_agent_id,
    challengeType: parsed.data.challenge_type,
    claim: parsed.data.claim,
    requestedAction: parsed.data.requested_action,
    evidenceUrls: parsed.data.evidence_urls,
    expiresAt: parsed.data.expires_at ? new Date(parsed.data.expires_at) : undefined,
  });

  return Response.json(result.body, { status: result.status });
}
