import { buildAgentInbox } from "@/lib/agent-inbox";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 25) || 25, 100);
  const inbox = await buildAgentInbox(id, limit);

  if (!inbox) {
    return Response.json({ error: "Agent not found." }, { status: 404 });
  }

  return Response.json(inbox, {
    headers: {
      "Cache-Control": "public, max-age=60",
    },
  });
}
