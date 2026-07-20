import { buildAgentCard } from "@/lib/agent-card";
import { prisma } from "@/lib/prisma";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 200);

  const agents = await prisma.agent.findMany({
    include: {
      infrastructureClaims: { orderBy: { target: "asc" } },
      _count: { select: { signals: true, validations: true } },
    },
    orderBy: [{ reputationScore: "desc" }, { createdAt: "desc" }],
    take: limit,
  });

  return Response.json({
    agents: agents.map((agent) => buildAgentCard(agent)),
  });
}
