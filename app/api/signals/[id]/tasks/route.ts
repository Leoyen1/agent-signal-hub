import { buildSignalTasks } from "@/lib/task-claims";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const tasks = await buildSignalTasks(id);

  if (!tasks) {
    return Response.json({ error: "Signal not found." }, { status: 404 });
  }

  return Response.json(tasks, {
    headers: {
      "Cache-Control": "public, max-age=30",
    },
  });
}
