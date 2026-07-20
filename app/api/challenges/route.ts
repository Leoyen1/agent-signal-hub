import { listChallenges } from "@/lib/challenges";
import { challengeQuerySchema } from "@/lib/schemas";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = challengeQuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()));

  if (!parsed.success) {
    return Response.json({ error: "Invalid challenge query.", details: parsed.error.flatten() }, { status: 400 });
  }

  return Response.json(
    await listChallenges({
      signalId: parsed.data.signal_id,
      agentId: parsed.data.agent_id,
      status: parsed.data.status,
      challengeType: parsed.data.challenge_type,
      limit: parsed.data.limit,
    }),
    {
      headers: {
        "Cache-Control": "public, max-age=30",
      },
    },
  );
}
