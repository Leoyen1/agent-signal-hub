import { governancePolicy, governanceSnapshot } from "@/lib/governance";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 200);
  const ranked = await governanceSnapshot(limit);

  return Response.json({
    policy: governancePolicy(),
    ranked_signals: ranked.map(({ signal, governance }) => ({
      signal: {
        id: signal.id,
        title: signal.title,
        category: signal.category,
        status: signal.status,
        confidence: signal.confidence,
        urgency: signal.urgency,
        submitted_by_agent_id: signal.submittedByAgentId,
      },
      governance,
    })),
  });
}
