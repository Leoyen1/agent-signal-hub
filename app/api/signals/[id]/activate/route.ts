import { requireAgent } from "@/lib/auth";
import { emitOpsEvent, requestOperation } from "@/lib/ops-events";
import { prisma } from "@/lib/prisma";
import { checkSignalQuality } from "@/lib/quality";
import { jsonArray } from "@/lib/serializers";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const agent = await requireAgent(request);
  if (agent instanceof Response) return agent;

  const { id } = await context.params;
  const signal = await prisma.signal.findUnique({ where: { id } });
  if (!signal) return Response.json({ error: "Signal not found." }, { status: 404 });

  if (signal.submittedByAgentId !== agent.id) {
    await emitOpsEvent({
      severity: "warning",
      component: "signal-api",
      eventType: "signal_activation_unauthorized",
      outcome: "rejected",
      details: { ...requestOperation(request), signal_id: id, agent_id: agent.id },
    });
    return Response.json({ error: "Only the submitting agent can activate this signal." }, { status: 403 });
  }

  if (signal.status !== "draft") {
    return Response.json({ error: `Only draft signals can be activated. Current status: ${signal.status}.` }, { status: 409 });
  }

  if (signal.expiresAt.getTime() <= Date.now()) {
    return Response.json({ error: "Expired draft signals cannot be activated." }, { status: 422 });
  }

  const quality = await checkSignalQuality(
    {
      title: signal.title,
      source_urls: jsonArray(signal.sourceUrls),
      confidence: signal.confidence,
      submitted_by_agent_id: agent.id,
    },
    { enforceSubmissionRateLimit: false, excludeSignalId: signal.id },
  );
  if (quality.errors.length) {
    await emitOpsEvent({
      severity: "warning",
      component: "signal-api",
      eventType: "signal_activation_quality_rejected",
      outcome: "rejected",
      details: { ...requestOperation(request), signal_id: id, agent_id: agent.id, errors: quality.errors },
    });
    return Response.json({ error: "Signal failed publication quality checks.", details: quality.errors }, { status: 422 });
  }

  const updated = await prisma.signal.updateMany({
    where: { id, submittedByAgentId: agent.id, status: "draft", expiresAt: { gt: new Date() } },
    data: { status: "active" },
  });
  if (updated.count !== 1) {
    return Response.json({ error: "Signal state changed before activation; reload and retry if it is still a draft." }, { status: 409 });
  }

  const activatedSignal = await prisma.signal.findUniqueOrThrow({ where: { id } });
  await emitOpsEvent({
    severity: "info",
    component: "signal-api",
    eventType: "signal_activated",
    outcome: "success",
    details: { ...requestOperation(request), signal_id: id, agent_id: agent.id, previous_status: "draft", status: "active" },
  });
  return Response.json({ signal: activatedSignal, warnings: quality.warnings });
}
