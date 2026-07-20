import { prisma } from "@/lib/prisma";
import { jsonArray } from "@/lib/serializers";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const agent = await prisma.agent.findUnique({
    where: { id },
    select: { id: true, name: true },
  });

  if (!agent) {
    return Response.json({ error: "Agent not found." }, { status: 404 });
  }

  const validations = await prisma.validation.findMany({
    where: { agentId: id },
    include: {
      signal: { select: { id: true, title: true, category: true, status: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return Response.json({
    agent,
    validations: validations.map((validation) => ({
      id: validation.id,
      signal_id: validation.signalId,
      signal: validation.signal,
      verdict: validation.verdict,
      comment: validation.comment,
      evidence_urls: jsonArray(validation.evidenceUrls),
      confidence_delta: validation.confidenceDelta,
      created_at: validation.createdAt.toISOString(),
    })),
  });
}
