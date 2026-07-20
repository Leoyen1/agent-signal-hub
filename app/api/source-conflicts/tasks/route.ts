import { sourceConflictTaskQuerySchema } from "@/lib/schemas";
import { buildSourceConflictTasks } from "@/lib/source-conflict-tasks";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = sourceConflictTaskQuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()));
  if (!parsed.success) {
    return Response.json({ error: "Invalid source conflict task query.", details: parsed.error.flatten() }, { status: 400 });
  }

  return Response.json(await buildSourceConflictTasks({
    targetType: parsed.data.target_type,
    sourceId: parsed.data.source_id,
    host: parsed.data.host,
    url: parsed.data.url,
    severity: parsed.data.severity,
    taskType: parsed.data.task_type,
    limit: parsed.data.limit,
  }), {
    headers: {
      "Cache-Control": "public, max-age=30",
    },
  });
}
