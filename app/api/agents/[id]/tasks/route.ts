import { buildAgentTasks } from "@/lib/task-claims";
import { taskQuerySchema } from "@/lib/schemas";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const url = new URL(request.url);
  const parsed = taskQuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()));

  if (!parsed.success) {
    return Response.json({ error: "Invalid task query.", details: parsed.error.flatten() }, { status: 400 });
  }

  const tasks = await buildAgentTasks(id, {
    status: parsed.data.status,
    taskType: parsed.data.task_type,
    limit: parsed.data.limit,
  });

  if (!tasks) {
    return Response.json({ error: "Agent not found." }, { status: 404 });
  }

  return Response.json(tasks, {
    headers: {
      "Cache-Control": "public, max-age=30",
    },
  });
}
