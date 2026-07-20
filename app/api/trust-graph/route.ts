import { trustGraphQuerySchema } from "@/lib/schemas";
import { buildTrustGraph } from "@/lib/trust-graph";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = trustGraphQuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()));

  if (!parsed.success) {
    return Response.json({ error: "Invalid trust graph query.", details: parsed.error.flatten() }, { status: 400 });
  }

  return Response.json(await buildTrustGraph({ agentId: parsed.data.agent_id, limit: parsed.data.limit }), {
    headers: {
      "Cache-Control": "public, max-age=60",
    },
  });
}
