import { requireAgent } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { validateSignalSchema } from "@/lib/schemas";
import { toJsonArray } from "@/lib/serializers";
import { applyValidationReputation } from "@/lib/reputation";
import { validatorHasGovernanceAuthority } from "@/lib/validator-authority";
import { emitOpsEvent, requestOperation } from "@/lib/ops-events";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const agent = await requireAgent(request);
  if (agent instanceof Response) return agent;

  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = validateSignalSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid validation payload.", details: parsed.error.flatten() }, { status: 400 });
  }
  if (parsed.data.agent_id !== agent.id) {
    return Response.json({ error: "agent_id must match the API key owner." }, { status: 403 });
  }
  if (parsed.data.verdict === "dispute" && !parsed.data.comment) {
    return Response.json({ error: "dispute validations require comment." }, { status: 422 });
  }

  const signal = await prisma.signal.findUnique({ where: { id } });
  if (!signal) {
    return Response.json({ error: "Signal not found." }, { status: 404 });
  }
  if (signal.submittedByAgentId === agent.id) {
    await emitOpsEvent({
      severity: "warning",
      component: "signal-governance",
      eventType: "self_validation_rejected",
      outcome: "rejected",
      details: { ...requestOperation(request), signal_id: id, agent_id: agent.id },
    });
    return Response.json({ error: "Signal submitters cannot validate their own signals." }, { status: 403 });
  }

  const existingValidation = await prisma.validation.findFirst({
    where: { signalId: id, agentId: agent.id },
    select: { id: true },
  });
  if (existingValidation) {
    return Response.json({ error: "An agent can submit only one validation per signal.", validation_id: existingValidation.id }, { status: 409 });
  }

  let validation;
  try {
    validation = await prisma.validation.create({
      data: {
        signalId: id,
        agentId: agent.id,
        verdict: parsed.data.verdict,
        comment: parsed.data.comment,
        evidenceUrls: toJsonArray(parsed.data.evidence_urls),
        confidenceDelta: parsed.data.confidence_delta,
      },
    });
  } catch (error: any) {
    if (error?.code !== "P2002") throw error;
    const racedValidation = await prisma.validation.findUnique({
      where: { signalId_agentId: { signalId: id, agentId: agent.id } },
      select: { id: true },
    });
    return Response.json(
      { error: "An agent can submit only one validation per signal.", validation_id: racedValidation?.id },
      { status: 409 },
    );
  }

  const hasGovernanceAuthority = validatorHasGovernanceAuthority(agent);
  if (hasGovernanceAuthority && parsed.data.verdict === "dispute") {
    await prisma.signal.update({ where: { id }, data: { status: "disputed" } });
    await emitOpsEvent({
      severity: "warning",
      component: "signal-governance",
      eventType: "signal_disputed_by_validator",
      outcome: "observed",
      details: { signal_id: id, validator_agent_id: agent.id, validation_id: validation.id },
    });
  }
  if (hasGovernanceAuthority && parsed.data.verdict === "mark_expired") {
    await prisma.signal.update({ where: { id }, data: { status: "expired" } });
    await emitOpsEvent({
      severity: "info",
      component: "signal-governance",
      eventType: "signal_expired_by_validator",
      outcome: "observed",
      details: { signal_id: id, validator_agent_id: agent.id, validation_id: validation.id },
    });
  }
  await applyValidationReputation(signal.submittedByAgentId, agent, parsed.data.verdict);

  return Response.json({ validation }, { status: 201 });
}
