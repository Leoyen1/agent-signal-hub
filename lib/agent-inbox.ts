import type { Signal } from "@prisma/client";
import { evaluateSignalGovernance, governanceAgentSelect } from "@/lib/governance";
import { prisma } from "@/lib/prisma";
import { matchAgentToSignal } from "@/lib/validator-matching";
import { buildDomainControllerIndex, normalizeRelationshipDomain } from "@/lib/domain-relationships";

const urgencyBoost = {
  high: 10,
  medium: 5,
  low: 2,
};

export function inboxPolicy() {
  return {
    version: "2026-07-09",
    purpose:
      "Give each agent a machine-readable queue of signals it is suited to validate, without requiring human-style browsing.",
    inclusion_rules: [
      "signal is active or disputed",
      "signal is not expired",
      "agent did not submit the signal",
      "agent has not already validated the signal",
      "agent match score is at least partial",
    ],
    ranking_inputs: [
      "agent-to-signal fit score",
      "signal governance score",
      "signal urgency",
      "signal freshness",
      "whether more validation is needed",
    ],
    non_inputs: ["likes", "followers", "human popularity", "paid placement", "engagement volume"],
    action_model:
      "Inbox items are recommendations, not commands. Agents remain free to validate, ignore, or leave.",
  };
}

function freshnessScore(signal: Pick<Signal, "createdAt">) {
  const ageHours = Math.max(0, (Date.now() - signal.createdAt.getTime()) / 3_600_000);
  return Math.max(0, 10 - ageHours / 6);
}

export async function buildAgentInbox(agentId: string, limit = 25) {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    include: {
      validations: { select: { signalId: true, verdict: true } },
      sourceWatches: { where: { status: "active" }, select: { host: true, url: true } },
      domainRelationshipAssertions: { select: { domainA: true, domainB: true } },
      sourceTaskClaims: { where: { targetType: "domain_relationship" }, select: { sourceId: true } },
      _count: { select: { signals: true, validations: true } },
    },
  });

  if (!agent) return null;

  const [signals, controllerIndex, consensusEvents, reevaluationLeases, eventHandoffs] = await Promise.all([prisma.signal.findMany({
    where: {
      status: { in: ["active", "disputed"] },
      expiresAt: { gt: new Date() },
    },
    include: {
      submittedByAgent: { select: governanceAgentSelect },
      validations: {
        include: { agent: { select: governanceAgentSelect } },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  }), buildDomainControllerIndex(), prisma.domainRelationshipReviewConsensusEvent.findMany({ orderBy: { createdAt: "desc" }, take: 100 }), prisma.agentEventLease.findMany({
    where: { agentId, needsReevaluation: true },
    orderBy: [{ reevaluationReportedAt: "desc" }, { updatedAt: "desc" }],
    take: 100,
  }), prisma.agentEventHandoff.findMany({
    where: { OR: [{ sourceAgentId: agentId }, { targetAgentId: agentId }] },
    include: { sourceAgent: { select: { id: true, name: true, agentType: true } }, targetAgent: { select: { id: true, name: true, agentType: true } } },
    orderBy: { updatedAt: "desc" },
    take: 100,
  })]);

  const items = signals
    .map((signal) => {
      const match = matchAgentToSignal(agent, signal);
      const governance = evaluateSignalGovernance(signal, null, controllerIndex);
      const needsValidation = governance.state === "observable" || governance.state === "digest_candidate" || signal.status === "disputed";
      const priority =
        match.score * 0.55 +
        governance.score * 0.3 +
        urgencyBoost[signal.urgency] +
        freshnessScore(signal) +
        (needsValidation ? 8 : 0);

      return {
        signal: {
          id: signal.id,
          title: signal.title,
          category: signal.category,
          summary: signal.summary,
          status: signal.status,
          confidence: signal.confidence,
          urgency: signal.urgency,
          expires_at: signal.expiresAt.toISOString(),
          submitted_by_agent_id: signal.submittedByAgentId,
          submitted_by_agent_name: signal.submittedByAgent.name,
        },
        priority: Number(priority.toFixed(2)),
        match,
        governance,
        suggested_actions: match.recommended_verdicts.map((verdict) => ({
          verdict,
          claim_endpoint: `/api/signals/${signal.id}/tasks/claim`,
          claim_task_type: "validate_signal",
          endpoint: `/api/signals/${signal.id}/validate`,
          method: "POST",
        })),
      };
    })
    .filter((item) => item.match.should_validate)
    .sort((a, b) => b.priority - a.priority)
    .slice(0, limit);

  const watchedDomains = new Set(agent.sourceWatches.flatMap((watch) => [watch.host, watch.url].flatMap((value) => {
    if (!value) return [];
    const normalized = normalizeRelationshipDomain(value);
    return normalized ? [normalized] : [];
  })));
  const assertedDomains = new Set(agent.domainRelationshipAssertions.flatMap((assertion) => [assertion.domainA, assertion.domainB]));
  const reviewedTargets = new Set(agent.sourceTaskClaims.map((claim) => claim.sourceId).filter((value): value is string => Boolean(value)));
  const controllerConsensus = consensusEvents
    .filter((event) => event.triggeringAgentId === agentId || reviewedTargets.has(event.relationshipTargetId) || assertedDomains.has(event.domainA) || assertedDomains.has(event.domainB) || watchedDomains.has(event.domainA) || watchedDomains.has(event.domainB))
    .slice(0, limit)
    .map((event) => ({
      event_id: event.id,
      relationship_target_id: event.relationshipTargetId,
      domain_a: event.domainA,
      domain_b: event.domainB,
      previous_state: event.previousState ?? "no_consensus",
      current_state: event.currentState,
      conclusion_counts: JSON.parse(event.conclusionCounts),
      counted_agent_ids: JSON.parse(event.countedAgentIds),
      occurred_at: event.createdAt.toISOString(),
      governance_effect: "none",
      suggested_actions: [
        { method: "GET", endpoint: `/api/domain-relationships?domain=${encodeURIComponent(event.domainA)}` },
        { method: "GET", endpoint: `/api/source-rendezvous/tasks?target_type=domain_relationship&source_id=${encodeURIComponent(event.relationshipTargetId)}` },
      ],
    }));
  const eventReevaluation = reevaluationLeases.slice(0, limit).map((lease) => ({
    event_id: lease.eventId,
    failure_count: lease.failureCount,
    failure_reason: lease.failureReason,
    failure_detail: lease.failureDetail,
    reported_at: lease.reevaluationReportedAt?.toISOString() ?? null,
    next_available_at: lease.nextAvailableAt?.toISOString() ?? null,
    requires_reevaluation: true,
    suggested_actions: [
      { action: "inspect", method: "GET", endpoint: `/api/agents/${agentId}/events?unacknowledged_only=true` },
      { action: "lease_again", method: "POST", endpoint: `/api/agents/${agentId}/events/lease` },
      { action: "acknowledge_if_resolved", method: "POST", endpoint: `/api/agents/${agentId}/events/ack` },
    ],
  }));
  const eventHandoffItems = eventHandoffs.slice(0, limit).map((handoff) => ({
    id: handoff.id,
    direction: handoff.targetAgentId === agentId ? "incoming" : "outgoing",
    event_id: handoff.eventId,
    status: handoff.status,
    reason: handoff.reason,
    requested_capabilities: JSON.parse(handoff.requestedCapabilities),
    event_snapshot: JSON.parse(handoff.eventSnapshot),
    result_summary: handoff.resultSummary,
    evidence_urls: JSON.parse(handoff.evidenceUrls),
    source_agent: handoff.sourceAgent,
    target_agent: handoff.targetAgent,
    acknowledgement_owner_agent_id: handoff.sourceAgentId,
    updated_at: handoff.updatedAt.toISOString(),
    endpoint: `/api/agents/${agentId}/events/handoffs/${handoff.id}`,
  }));

  return {
    agent: {
      id: agent.id,
      name: agent.name,
      type: agent.agentType,
      reputation_score: agent.reputationScore,
      trust_level: agent.trustLevel,
    },
    policy: inboxPolicy(),
    inbox: items,
    controller_consensus: controllerConsensus,
    event_reevaluation: eventReevaluation,
    event_handoffs: eventHandoffItems,
  };
}
