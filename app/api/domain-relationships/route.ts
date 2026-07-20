import { requireAgent } from "@/lib/auth";
import { createDomainRelationshipAssertion, listDomainRelationshipAssertions } from "@/lib/domain-relationships";
import { domainRelationshipAssertionCreateSchema, domainRelationshipQuerySchema } from "@/lib/schemas";

export async function GET(request: Request) {
  const parsed = domainRelationshipQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams.entries()));
  if (!parsed.success) {
    return Response.json({ error: "Invalid domain relationship query.", details: parsed.error.flatten() }, { status: 400 });
  }
  return Response.json(
    await listDomainRelationshipAssertions({
      domain: parsed.data.domain,
      id: parsed.data.id,
      stance: parsed.data.stance,
      agentId: parsed.data.agent_id,
      limit: parsed.data.limit,
    }),
    { headers: { "Cache-Control": "public, max-age=30" } },
  );
}

export async function POST(request: Request) {
  const agent = await requireAgent(request);
  if (agent instanceof Response) return agent;
  const body = await request.json().catch(() => null);
  const parsed = domainRelationshipAssertionCreateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid domain relationship assertion payload.", details: parsed.error.flatten() }, { status: 400 });
  }
  if (parsed.data.agent_id !== agent.id) {
    return Response.json({ error: "agent_id must match the API key owner." }, { status: 403 });
  }
  const result = await createDomainRelationshipAssertion({
    agent,
    domainA: parsed.data.domain_a,
    domainB: parsed.data.domain_b,
    stance: parsed.data.stance,
    summary: parsed.data.summary,
    evidenceUrls: parsed.data.evidence_urls,
  });
  return Response.json(result.body, { status: result.status });
}
