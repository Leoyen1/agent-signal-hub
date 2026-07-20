import { requireAgent } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createSignalIntentSchema } from "@/lib/schemas";
import { formatSignalIntent, signalIntentPolicy } from "@/lib/signal-intents";
import { toJsonArray } from "@/lib/serializers";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const signal = await prisma.signal.findUnique({
    where: { id },
    select: { id: true, title: true, category: true, status: true },
  });

  if (!signal) {
    return Response.json({ error: "Signal not found." }, { status: 404 });
  }

  const intents = await prisma.signalIntent.findMany({
    where: { signalId: id },
    include: { agent: { select: { id: true, name: true, agentType: true, reputationScore: true, trustLevel: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return Response.json({
    signal,
    policy: signalIntentPolicy(),
    intents: intents.map(formatSignalIntent),
  });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const agent = await requireAgent(request);
  if (agent instanceof Response) return agent;

  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = createSignalIntentSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid intent payload.", details: parsed.error.flatten() }, { status: 400 });
  }
  if (parsed.data.agent_id !== agent.id) {
    return Response.json({ error: "agent_id must match the API key owner." }, { status: 403 });
  }

  const signal = await prisma.signal.findUnique({ where: { id } });
  if (!signal) {
    return Response.json({ error: "Signal not found." }, { status: 404 });
  }
  if (parsed.data.intent_type === "claim_validation" && signal.submittedByAgentId === agent.id) {
    return Response.json({ error: "Submitting agent should not claim validation for its own signal." }, { status: 422 });
  }
  if (parsed.data.target_agent_id) {
    const target = await prisma.agent.findUnique({ where: { id: parsed.data.target_agent_id }, select: { id: true } });
    if (!target) {
      return Response.json({ error: "target_agent_id does not match a registered agent." }, { status: 422 });
    }
  }

  const intent = await prisma.signalIntent.create({
    data: {
      signalId: id,
      agentId: agent.id,
      intentType: parsed.data.intent_type,
      status: parsed.data.status,
      summary: parsed.data.summary,
      evidenceUrls: toJsonArray(parsed.data.evidence_urls),
      targetAgentId: parsed.data.target_agent_id,
      expiresAt: parsed.data.expires_at ? new Date(parsed.data.expires_at) : undefined,
    },
    include: { agent: { select: { id: true, name: true, agentType: true, reputationScore: true, trustLevel: true } } },
  });

  return Response.json({ intent: formatSignalIntent(intent), policy: signalIntentPolicy() }, { status: 201 });
}
