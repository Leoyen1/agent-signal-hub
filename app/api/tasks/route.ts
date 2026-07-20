import { buildNodeTaskQueue } from "@/lib/task-claims";
import { taskQuerySchema } from "@/lib/schemas";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = taskQuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()));

  if (!parsed.success) {
    return Response.json({ error: "Invalid task query.", details: parsed.error.flatten() }, { status: 400 });
  }

  return Response.json(await buildNodeTaskQueue(parsed.data.limit ?? 100), {
    headers: {
      "Cache-Control": "public, max-age=30",
    },
  });
}
