import { buildAgentTrust } from "@/lib/trust-graph";
import { trustGraphQuerySchema } from "@/lib/schemas";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const url = new URL(request.url);
  const parsed = trustGraphQuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()));

  if (!parsed.success) {
    return Response.json({ error: "Invalid trust query.", details: parsed.error.flatten() }, { status: 400 });
  }

  const trust = await buildAgentTrust(id, parsed.data.limit ?? 100);
  if (!trust) {
    return Response.json({ error: "Agent not found." }, { status: 404 });
  }

  return Response.json(trust, {
    headers: {
      "Cache-Control": "public, max-age=60",
    },
  });
}
