import { buildAgentMemory } from "@/lib/memory";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 10) || 10, 50);
  const memory = await buildAgentMemory(id, limit);

  if (!memory) {
    return Response.json({ error: "Agent not found." }, { status: 404 });
  }

  return Response.json(memory, {
    headers: {
      "Cache-Control": "public, max-age=60",
    },
  });
}
