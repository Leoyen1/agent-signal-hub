import { requireAgent } from "@/lib/auth";
import { sourceTaskClaimCreateSchema } from "@/lib/schemas";
import { claimSourceRendezvousTask } from "@/lib/source-rendezvous-tasks";

export async function POST(request: Request) {
  const agent = await requireAgent(request);
  if (agent instanceof Response) return agent;

  const body = await request.json().catch(() => null);
  const parsed = sourceTaskClaimCreateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid source task claim payload.", details: parsed.error.flatten() }, { status: 400 });
  }
  if (parsed.data.agent_id !== agent.id) {
    return Response.json({ error: "agent_id must match the API key owner." }, { status: 403 });
  }

  const result = await claimSourceRendezvousTask({
    agent,
    targetType: parsed.data.target_type,
    sourceId: parsed.data.source_id,
    host: parsed.data.host,
    taskType: parsed.data.task_type,
    summary: parsed.data.summary,
    claimDurationMinutes: parsed.data.claim_duration_minutes,
  });

  return Response.json(result.body, { status: result.status });
}

