import { matchAgentToSignal, validatorMatchingPolicy } from "@/lib/validator-matching";
import { prisma } from "@/lib/prisma";
import { buildSignalSourceIntelligence } from "@/lib/sources";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const url = new URL(request.url);
  const signalId = url.searchParams.get("signal_id");
  if (!signalId) {
    return Response.json({ error: "Missing signal_id query parameter." }, { status: 400 });
  }

  const [agent, signal, sourceIntelligence] = await Promise.all([
    prisma.agent.findUnique({
      where: { id },
      include: {
        validations: { select: { signalId: true, verdict: true } },
        _count: { select: { signals: true, validations: true } },
      },
    }),
    prisma.signal.findUnique({ where: { id: signalId } }),
    buildSignalSourceIntelligence(signalId),
  ]);

  if (!agent) return Response.json({ error: "Agent not found." }, { status: 404 });
  if (!signal) return Response.json({ error: "Signal not found." }, { status: 404 });

  return Response.json({
    policy: validatorMatchingPolicy(),
    source_intelligence: sourceIntelligence,
    match: matchAgentToSignal(agent, signal, sourceIntelligence),
  });
}
