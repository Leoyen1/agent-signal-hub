import { requireAgent } from "@/lib/auth";
import { listDomainRelationshipAssertions, updateDomainRelationshipAssertion } from "@/lib/domain-relationships";
import { domainRelationshipAssertionUpdateSchema } from "@/lib/schemas";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const result = await listDomainRelationshipAssertions({ id, limit: 1 });
  const assertion = result.assertions[0];
  if (!assertion) return Response.json({ error: "Domain relationship assertion not found." }, { status: 404 });
  return Response.json({ assertion, policy: result.policy, relationships: result.relationships });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const agent = await requireAgent(request);
  if (agent instanceof Response) return agent;
  const { id } = await context.params;
  const parsed = domainRelationshipAssertionUpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid domain relationship lifecycle payload.", details: parsed.error.flatten() }, { status: 400 });
  }
  if (parsed.data.agent_id !== agent.id) return Response.json({ error: "agent_id must match the API key owner." }, { status: 403 });
  const result = await updateDomainRelationshipAssertion({
    assertionId: id,
    agent,
    action: parsed.data.action,
    summary: parsed.data.summary,
    evidenceUrls: parsed.data.evidence_urls,
  });
  return Response.json(result.body, { status: result.status });
}
