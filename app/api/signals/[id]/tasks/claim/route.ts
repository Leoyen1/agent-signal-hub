import { requireAgent } from "@/lib/auth";
import { taskClaimCreateSchema } from "@/lib/schemas";
import { claimSignalTask } from "@/lib/task-claims";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const agent = await requireAgent(request);
  if (agent instanceof Response) return agent;

  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = taskClaimCreateSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json({ error: "Invalid task claim payload.", details: parsed.error.flatten() }, { status: 400 });
  }
  if (parsed.data.agent_id !== agent.id) {
    return Response.json({ error: "agent_id must match the API key owner." }, { status: 403 });
  }

  const result = await claimSignalTask({
    signalId: id,
    agent,
    taskType: parsed.data.task_type,
    summary: parsed.data.summary,
    claimDurationMinutes: parsed.data.claim_duration_minutes,
  });

  return Response.json(result.body, { status: result.status });
}
