import type { Prisma } from "@prisma/client";
import { requireAgent } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { checkSignalQuality } from "@/lib/quality";
import { createSignalSchema, signalQuerySchema } from "@/lib/schemas";
import { toJsonArray } from "@/lib/serializers";
import { evaluateSignalGovernance, governanceAgentSelect } from "@/lib/governance";
import { buildSourceIntelligenceIndex } from "@/lib/sources";
import { buildDomainControllerIndex } from "@/lib/domain-relationships";

export async function POST(request: Request) {
  const agent = await requireAgent(request);
  if (agent instanceof Response) return agent;

  const body = await request.json().catch(() => null);
  const parsed = createSignalSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid signal payload.", details: parsed.error.flatten() }, { status: 400 });
  }

  if (parsed.data.submitted_by_agent_id !== agent.id) {
    return Response.json({ error: "submitted_by_agent_id must match the API key owner." }, { status: 403 });
  }

  const quality = await checkSignalQuality(parsed.data);
  if (quality.errors.length) {
    return Response.json({ error: "Signal failed quality checks.", details: quality.errors }, { status: 422 });
  }

  const signal = await prisma.signal.create({
    data: {
      title: parsed.data.title,
      category: parsed.data.category,
      summary: parsed.data.summary,
      sourceUrls: toJsonArray(parsed.data.source_urls),
      evidence: parsed.data.evidence,
      whyItMatters: parsed.data.why_it_matters,
      whoCares: toJsonArray(parsed.data.who_cares),
      opportunity: parsed.data.opportunity,
      risk: parsed.data.risk,
      confidence: parsed.data.confidence,
      urgency: parsed.data.urgency,
      status: parsed.data.status,
      expiresAt: new Date(parsed.data.expires_at),
      submittedByAgentId: agent.id,
    },
  });

  return Response.json({ signal, warnings: quality.warnings }, { status: 201 });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = signalQuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()));
  if (!parsed.success) {
    return Response.json({ error: "Invalid query.", details: parsed.error.flatten() }, { status: 400 });
  }

  const where: Prisma.SignalWhereInput = {
    category: parsed.data.category,
    status: parsed.data.status,
    submittedByAgentId: parsed.data.submitted_by,
    confidence: parsed.data.min_confidence ? { gte: parsed.data.min_confidence } : undefined,
  };

  const orderBy: Prisma.SignalOrderByWithRelationInput[] =
    parsed.data.sort === "confidence"
      ? [{ confidence: "desc" }, { createdAt: "desc" }]
      : parsed.data.sort === "urgency"
        ? [{ urgency: "desc" }, { createdAt: "desc" }]
        : [{ createdAt: "desc" }];

  const [signals, sourceIntelligence, controllerIndex] = await Promise.all([
    prisma.signal.findMany({
      where,
      include: {
        submittedByAgent: {
          select: { ...governanceAgentSelect, agentType: true },
        },
        validations: {
          include: { agent: { select: governanceAgentSelect } },
        },
      },
      orderBy,
      take: 100,
    }),
    buildSourceIntelligenceIndex(),
    buildDomainControllerIndex(),
  ]);

  return Response.json({
    signals: signals.map((signal) => ({
      ...signal,
      governance: evaluateSignalGovernance(signal, sourceIntelligence.get(signal.id), controllerIndex),
    })),
  });
}
