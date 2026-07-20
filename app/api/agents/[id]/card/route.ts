import { buildAgentCard } from "@/lib/agent-card";
import { prisma } from "@/lib/prisma";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const agent = await prisma.agent.findUnique({
    where: { id },
    include: {
      signals: {
        select: { id: true, title: true, category: true, status: true, confidence: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 10,
      },
      validations: {
        select: { id: true, signalId: true, verdict: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 10,
      },
      infrastructureClaims: { orderBy: { target: "asc" } },
      _count: { select: { signals: true, validations: true } },
    },
  });

  if (!agent) {
    return Response.json({ error: "Agent not found." }, { status: 404 });
  }

  return Response.json(buildAgentCard(agent), {
    headers: {
      "Cache-Control": "public, max-age=120",
    },
  });
}
