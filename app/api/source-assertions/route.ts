import { requireAgent } from "@/lib/auth";
import { createSourceAssertion, listSourceAssertions } from "@/lib/source-assertions";
import { sourceAssertionCreateSchema, sourceAssertionQuerySchema } from "@/lib/schemas";
import { buildSourceRegistry } from "@/lib/sources";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = sourceAssertionQuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()));
  if (!parsed.success) {
    return Response.json({ error: "Invalid source assertion query.", details: parsed.error.flatten() }, { status: 400 });
  }

  return Response.json(
    await listSourceAssertions({
      id: parsed.data.id,
      targetType: parsed.data.target_type,
      sourceId: parsed.data.source_id,
      host: parsed.data.host,
      stance: parsed.data.stance,
      agentId: parsed.data.agent_id,
      since: parsed.data.since ? new Date(parsed.data.since) : undefined,
      limit: parsed.data.limit,
    }),
    { headers: { "Cache-Control": "public, max-age=30" } },
  );
}

export async function POST(request: Request) {
  const agent = await requireAgent(request);
  if (agent instanceof Response) return agent;

  const body = await request.json().catch(() => null);
  const parsed = sourceAssertionCreateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid source assertion payload.", details: parsed.error.flatten() }, { status: 400 });
  }
  if (parsed.data.agent_id !== agent.id) {
    return Response.json({ error: "agent_id must match the API key owner." }, { status: 403 });
  }

  const registry = await buildSourceRegistry({ host: parsed.data.host, limit: 500 });
  if (parsed.data.target_type === "source" && !registry.sources.some((source) => source.id === parsed.data.source_id)) {
    return Response.json({ error: "source_id is not present in the current source registry." }, { status: 404 });
  }
  if (parsed.data.target_type === "host" && !registry.sources.some((source) => source.host === parsed.data.host?.trim().toLowerCase().replace(/^www\./, ""))) {
    return Response.json({ error: "host is not present in the current source registry." }, { status: 404 });
  }

  const result = await createSourceAssertion({
    agent,
    targetType: parsed.data.target_type,
    sourceId: parsed.data.source_id,
    host: parsed.data.host,
    stance: parsed.data.stance,
    summary: parsed.data.summary,
    evidenceUrls: parsed.data.evidence_urls,
  });
  return Response.json(result.body, { status: result.status });
}
