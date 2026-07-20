import { sourceTaskQuerySchema } from "@/lib/schemas";
import { buildSourceRendezvousTasks } from "@/lib/source-rendezvous-tasks";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = sourceTaskQuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()));
  if (!parsed.success) {
    return Response.json({ error: "Invalid source task query.", details: parsed.error.flatten() }, { status: 400 });
  }

  return Response.json(
    await buildSourceRendezvousTasks({
      sourceId: parsed.data.source_id,
      host: parsed.data.host,
      targetType: parsed.data.target_type,
      taskType: parsed.data.task_type,
      limit: parsed.data.limit,
    }),
    {
      headers: {
        "Cache-Control": "public, max-age=30",
      },
    },
  );
}
