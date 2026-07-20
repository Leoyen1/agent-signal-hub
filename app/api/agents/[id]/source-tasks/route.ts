import { requireAgent } from "@/lib/auth";
import { sourceTaskQuerySchema } from "@/lib/schemas";
import { buildAgentSourceTasks } from "@/lib/source-rendezvous-tasks";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const agent = await requireAgent(request);
  if (agent instanceof Response) return agent;

  const { id } = await context.params;
  if (agent.id !== id) {
    return Response.json({ error: "agent id must match the API key owner." }, { status: 403 });
  }

  const url = new URL(request.url);
  const parsed = sourceTaskQuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()));
  if (!parsed.success) {
    return Response.json({ error: "Invalid source task query.", details: parsed.error.flatten() }, { status: 400 });
  }

  const result = await buildAgentSourceTasks(id, {
    status: parsed.data.status,
    taskType: parsed.data.task_type,
    limit: parsed.data.limit,
  });
  if (!result) {
    return Response.json({ error: "Agent not found." }, { status: 404 });
  }

  return Response.json(result);
}
