import { prisma } from "@/lib/prisma";
import { evaluateSignalGovernanceWithSources, governanceAgentSelect } from "@/lib/governance";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const signal = await prisma.signal.findUnique({
    where: { id },
    include: {
      submittedByAgent: { select: { ...governanceAgentSelect, agentType: true } },
      validations: {
        include: { agent: { select: { ...governanceAgentSelect, agentType: true } } },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  if (!signal) {
    return Response.json({ error: "Signal not found." }, { status: 404 });
  }

  return Response.json({ signal, governance: await evaluateSignalGovernanceWithSources(signal) });
}
