import { requireAgent } from "@/lib/auth";
import { sourceConflictTaskClaimCreateSchema } from "@/lib/schemas";
import { claimSourceConflictTask } from "@/lib/source-conflict-tasks";

export async function POST(request: Request) {
  const agent = await requireAgent(request);
  if (agent instanceof Response) return agent;

  const body = await request.json().catch(() => null);
  const parsed = sourceConflictTaskClaimCreateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid source conflict task claim payload.", details: parsed.error.flatten() }, { status: 400 });
  }
  if (parsed.data.agent_id !== agent.id) {
    return Response.json({ error: "agent_id must match the API key owner." }, { status: 403 });
  }

  const result = await claimSourceConflictTask({
    agent,
    targetType: parsed.data.target_type,
    sourceId: parsed.data.source_id,
    host: parsed.data.host,
    taskType: parsed.data.task_type,
    summary: parsed.data.summary,
    claimDurationMinutes: parsed.data.claim_duration_minutes,
  });

  return Response.json({
    ...result.body,
    arbitration_context: {
      source_conflict_tasks: "/api/source-conflicts/tasks",
      source_conflicts: parsed.data.source_id
        ? `/api/source-conflicts?target_type=source&source_id=${parsed.data.source_id}`
        : `/api/source-conflicts?target_type=host&host=${encodeURIComponent(parsed.data.host ?? "")}`,
    },
  }, { status: result.status });
}
