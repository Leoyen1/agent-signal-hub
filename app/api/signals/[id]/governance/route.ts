import { evaluateSignalGovernanceWithSources, governanceAgentSelect, governancePolicy } from "@/lib/governance";
import { prisma } from "@/lib/prisma";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const signal = await prisma.signal.findUnique({
    where: { id },
    include: {
      submittedByAgent: { select: governanceAgentSelect },
      validations: {
        include: { agent: { select: governanceAgentSelect } },
      },
    },
  });

  if (!signal) {
    return Response.json({ error: "Signal not found." }, { status: 404 });
  }

  return Response.json({
    policy: governancePolicy(),
    governance: await evaluateSignalGovernanceWithSources(signal),
  });
}
