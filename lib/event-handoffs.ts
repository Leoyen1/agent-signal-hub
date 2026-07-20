import type { Agent, AgentEventHandoff } from "@prisma/client";
import { normalizeRelationshipDomain } from "@/lib/domain-relationships";
import { isBootstrapValidator } from "@/lib/bootstrap";
import { HANDOFF_POLICY_VERSION, classifyHandoffEventRisk, handoffPolicyDocument, handoffPolicyHash } from "@/lib/handoff-policy";
import { buildAgentEvents } from "@/lib/events";
import { prisma } from "@/lib/prisma";
import { jsonArray, toJsonArray } from "@/lib/serializers";

type HandoffWithAgents = AgentEventHandoff & {
  sourceAgent: Pick<Agent, "id" | "name" | "agentType">;
  targetAgent: Pick<Agent, "id" | "name" | "agentType">;
};

const agentSelect = { id: true, name: true, agentType: true } as const;

function trustScore(level: Agent["trustLevel"]) {
  return level === "trusted" ? 20 : level === "normal" ? 12 : 4;
}

function declaredInfrastructureDomains(agent: { homepageUrl: string | null; callbackUrl: string | null; infrastructureClaims: Array<{ status: string; expiresAt: Date | null; registrableDomain: string }> }) {
  const domains = new Set<string>();
  for (const claim of agent.infrastructureClaims) {
    if (claim.status === "verified" && (!claim.expiresAt || claim.expiresAt > new Date())) domains.add(claim.registrableDomain);
  }
  for (const value of [agent.homepageUrl, agent.callbackUrl]) {
    if (!value) continue;
    const domain = normalizeRelationshipDomain(value);
    if (domain) domains.add(domain);
  }
  return domains;
}

export async function recommendAgentEventHandoffCandidates(input: {
  sourceAgent: Agent;
  eventId: string;
  requestedCapabilities: string[];
  limit: number;
  excludeHandoffId?: string;
  excludeHandoffTargetAgentId?: string;
  riskTierOverride?: "high" | "standard" | "low";
}) {
  const [lease, receipt] = await Promise.all([
    prisma.agentEventLease.findUnique({ where: { agentId_eventId: { agentId: input.sourceAgent.id, eventId: input.eventId } } }),
    prisma.agentEventReceipt.findUnique({ where: { agentId_eventId: { agentId: input.sourceAgent.id, eventId: input.eventId } } }),
  ]);
  if (receipt) return { status: 409 as const, body: { error: "Acknowledged events cannot request handoff candidates." } };
  if (!lease?.needsReevaluation) return { status: 409 as const, body: { error: "Only events marked for reevaluation can request handoff candidates." } };
  const sourceEventStream = await buildAgentEvents(input.sourceAgent.id, { limit: 200 }, { includePrivateSourceWatchEvents: true, includeAcknowledgements: true });
  const sourceEventType = sourceEventStream?.events.find((event) => event.id === input.eventId)?.type ?? null;
  const riskTier = input.riskTierOverride ?? classifyHandoffEventRisk(sourceEventType);
  const agents = await prisma.agent.findMany({
    where: { id: { not: input.sourceAgent.id }, credentialsRevokedAt: null, handoffOptIn: true },
    include: {
      infrastructureClaims: { select: { status: true, expiresAt: true, registrableDomain: true } },
      _count: { select: { eventHandoffsIncoming: { where: { status: { in: ["offered", "accepted"] } } } } },
    },
    take: 500,
  });
  const sourceWithInfrastructure = await prisma.agent.findUnique({
    where: { id: input.sourceAgent.id },
    include: { infrastructureClaims: { select: { status: true, expiresAt: true, registrableDomain: true } } },
  });
  const recentHandoffs = await prisma.agentEventHandoff.findMany({
    where: { createdAt: { gt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
    select: { targetAgentId: true, status: true, eventSnapshot: true, createdAt: true, acceptedAt: true, completedAt: true },
    take: 10_000,
  });
  type MetricBucket = { completed: number; declined: number; durationsHours: number[] };
  const emptyMetricBucket = (): MetricBucket => ({ completed: 0, declined: 0, durationsHours: [] });
  const metricsByAgent = new Map<string, { overall: MetricBucket; byEventType: Map<string, MetricBucket> }>();
  for (const handoff of recentHandoffs) {
    const metrics = metricsByAgent.get(handoff.targetAgentId) ?? { overall: emptyMetricBucket(), byEventType: new Map<string, MetricBucket>() };
    let eventType = "unknown";
    try {
      const snapshot = JSON.parse(handoff.eventSnapshot);
      if (typeof snapshot?.type === "string") eventType = snapshot.type;
    } catch {}
    const typeMetrics = metrics.byEventType.get(eventType) ?? emptyMetricBucket();
    if (handoff.status === "completed") {
      metrics.overall.completed += 1;
      typeMetrics.completed += 1;
      if (handoff.completedAt) {
        const duration = (handoff.completedAt.getTime() - (handoff.acceptedAt ?? handoff.createdAt).getTime()) / 3_600_000;
        metrics.overall.durationsHours.push(duration);
        typeMetrics.durationsHours.push(duration);
      }
    }
    if (handoff.status === "declined") {
      metrics.overall.declined += 1;
      typeMetrics.declined += 1;
    }
    metrics.byEventType.set(eventType, typeMetrics);
    metricsByAgent.set(handoff.targetAgentId, metrics);
  }
  const sourceDomains = sourceWithInfrastructure ? declaredInfrastructureDomains(sourceWithInfrastructure) : new Set<string>();
  const requested = [...new Set(input.requestedCapabilities.map((value) => value.toLowerCase()))];
  const candidates = agents
    .map((agent) => {
      const activeHandoffLoad = Math.max(0, agent._count.eventHandoffsIncoming - (input.excludeHandoffId && agent.id === input.excludeHandoffTargetAgentId ? 1 : 0));
      if (activeHandoffLoad >= agent.handoffMaxConcurrent) return null;
      const capabilities = jsonArray(agent.capabilities);
      const capabilitySet = new Set(capabilities.map((value) => value.toLowerCase()));
      const matched = requested.filter((value) => capabilitySet.has(value));
      if (requested.length && !matched.length) return null;
      const targetDomains = declaredInfrastructureDomains(agent);
      const sharedInfrastructure = [...targetDomains].filter((domain) => sourceDomains.has(domain));
      const hasVerifiedInfrastructure = agent.infrastructureClaims.some((claim) => claim.status === "verified" && (!claim.expiresAt || claim.expiresAt > new Date()));
      const bootstrapAuthority = Boolean(agent.publicKey && isBootstrapValidator(agent.publicKey));
      if (riskTier === "high" && (agent.trustLevel !== "trusted" || (!hasVerifiedInfrastructure && !bootstrapAuthority) || sharedInfrastructure.length)) return null;
      const capabilityScore = requested.length ? (matched.length / requested.length) * 40 : 20;
      const reputationScore = Math.min(20, Math.max(0, agent.reputationScore / 5));
      const loadPenalty = Math.min(20, activeHandoffLoad * 4);
      const infrastructurePenalty = sharedInfrastructure.length ? 30 : 0;
      const preferredEventTypes = jsonArray(agent.handoffPreferredEventTypes);
      const preferenceScore = !preferredEventTypes.length || !sourceEventType ? 0 : preferredEventTypes.includes(sourceEventType) ? 10 : -5;
      const agentMetrics = metricsByAgent.get(agent.id) ?? { overall: emptyMetricBucket(), byEventType: new Map<string, MetricBucket>() };
      const metrics = sourceEventType ? agentMetrics.byEventType.get(sourceEventType) ?? emptyMetricBucket() : agentMetrics.overall;
      const resolved = metrics.completed + metrics.declined;
      const smoothedCompletionRate = (metrics.completed + 2) / (resolved + 4);
      const reliabilityScore = Math.max(-6, Math.min(6, (smoothedCompletionRate - 0.5) * 12));
      const averageCompletionHours = metrics.durationsHours.length ? metrics.durationsHours.reduce((sum, value) => sum + value, 0) / metrics.durationsHours.length : null;
      const speedScore = averageCompletionHours === null ? 0 : Math.max(0, Math.min(2, 2 - averageCompletionHours / 12));
      const explorationScore = riskTier === "high" ? 0 : riskTier === "standard" ? (resolved < 3 ? 2 : resolved < 10 ? 1 : 0) : resolved < 3 ? 4 : resolved < 10 ? 2 : 0;
      const volumeSaturationPenalty = Math.max(0, Math.min(5, (resolved - 20) / 10));
      const score = capabilityScore + trustScore(agent.trustLevel) + reputationScore + (20 - loadPenalty) + preferenceScore + reliabilityScore + speedScore + explorationScore - infrastructurePenalty - volumeSaturationPenalty;
      return {
        agent: { id: agent.id, name: agent.name, type: agent.agentType, card: `/api/agents/${agent.id}/card` },
        score: Number(score.toFixed(2)),
        matched_capabilities: matched,
        advertised_capabilities: capabilities,
        active_handoff_load: activeHandoffLoad,
        max_concurrent_handoffs: agent.handoffMaxConcurrent,
        handoff_opt_in: agent.handoffOptIn,
        preferred_event_types: preferredEventTypes,
        event_type_preferred: sourceEventType ? preferredEventTypes.includes(sourceEventType) : null,
        reliability: {
          window_days: 30,
          event_type: sourceEventType,
          completed_count: metrics.completed,
          declined_count: metrics.declined,
          smoothed_completion_rate: Number(smoothedCompletionRate.toFixed(4)),
          average_completion_hours: averageCompletionHours === null ? null : Number(averageCompletionHours.toFixed(2)),
          reliability_score: Number(reliabilityScore.toFixed(2)),
          speed_score: Number(speedScore.toFixed(2)),
          exploration_score: explorationScore,
          volume_saturation_penalty: Number(volumeSaturationPenalty.toFixed(2)),
          overall_completed_count: agentMetrics.overall.completed,
          overall_declined_count: agentMetrics.overall.declined,
          cross_type_transfer: "disabled_for_scoring",
        },
        trust_level: agent.trustLevel,
        reputation_score: agent.reputationScore,
        infrastructure_independent: sharedInfrastructure.length === 0,
        verified_infrastructure_or_bootstrap: hasVerifiedInfrastructure || bootstrapAuthority,
        shared_infrastructure_domains: sharedInfrastructure,
        risk_policy: { event_risk_tier: riskTier, high_risk_requires_trusted: riskTier === "high", high_risk_requires_verified_infrastructure_or_bootstrap: riskTier === "high", high_risk_requires_source_infrastructure_independence: riskTier === "high" },
        selection_basis: ["capability_coverage", "trust", "reputation", "declared_availability", "active_handoff_load", "event_type_preference", "bounded_smoothed_reliability", "exploration_bonus", "volume_saturation", "declared_infrastructure_independence"],
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((a, b) => b.score - a.score || a.agent.id.localeCompare(b.agent.id))
    .slice(0, input.limit);
  return {
    status: 200 as const,
    body: {
      event_id: input.eventId,
      event_type: sourceEventType,
      event_risk_tier: riskTier,
      requested_capabilities: input.requestedCapabilities,
      policy: handoffPolicyDocument(),
      candidates,
    },
  };
}

function formatHandoff(handoff: HandoffWithAgents) {
  return {
    id: handoff.id,
    event_id: handoff.eventId,
    event_risk_tier: handoff.eventRiskTier,
    offered_policy: handoff.offeredPolicyVersion && handoff.offeredPolicyHash ? { version: handoff.offeredPolicyVersion, document_hash: handoff.offeredPolicyHash } : null,
    status: handoff.status,
    reason: handoff.reason,
    requested_capabilities: jsonArray(handoff.requestedCapabilities),
    event_snapshot: JSON.parse(handoff.eventSnapshot),
    result_summary: handoff.resultSummary,
    evidence_urls: jsonArray(handoff.evidenceUrls),
    accepted_policy: handoff.acceptedPolicyVersion && handoff.acceptedPolicyHash ? { version: handoff.acceptedPolicyVersion, document_hash: handoff.acceptedPolicyHash } : null,
    created_at: handoff.createdAt.toISOString(),
    updated_at: handoff.updatedAt.toISOString(),
    accepted_at: handoff.acceptedAt?.toISOString() ?? null,
    completed_at: handoff.completedAt?.toISOString() ?? null,
    declined_at: handoff.declinedAt?.toISOString() ?? null,
    cancelled_at: handoff.cancelledAt?.toISOString() ?? null,
    source_agent: handoff.sourceAgent,
    target_agent: handoff.targetAgent,
    ownership: {
      event_acknowledgement_agent_id: handoff.sourceAgentId,
      delegated_processing_agent_id: handoff.targetAgentId,
      transfer_effect: "processing_only",
    },
    links: {
      self: `/api/agents/${handoff.sourceAgentId}/events/handoffs/${handoff.id}`,
      source_events: `/api/agents/${handoff.sourceAgentId}/events`,
      target_inbox: `/api/agents/${handoff.targetAgentId}/inbox`,
    },
  };
}

export async function createAgentEventHandoff(input: {
  sourceAgent: Agent;
  targetAgentId?: string;
  eventId: string;
  reason: string;
  requestedCapabilities: string[];
}) {
  let targetAgentId = input.targetAgentId;
  if (!targetAgentId) {
    const recommendation = await recommendAgentEventHandoffCandidates({ sourceAgent: input.sourceAgent, eventId: input.eventId, requestedCapabilities: input.requestedCapabilities, limit: 1 });
    if (recommendation.status !== 200 || !recommendation.body.candidates.length) return { status: 409 as const, body: { error: "No eligible event handoff candidate is currently available." } };
    targetAgentId = recommendation.body.candidates[0].agent.id;
  }
  if (input.sourceAgent.id === targetAgentId) return { status: 422 as const, body: { error: "Event handoff target must be a different agent." } };
  const eligibleCandidates = await recommendAgentEventHandoffCandidates({ sourceAgent: input.sourceAgent, eventId: input.eventId, requestedCapabilities: input.requestedCapabilities, limit: 500 });
  if (eligibleCandidates.status !== 200 || !eligibleCandidates.body.candidates.some((candidate) => candidate.agent.id === targetAgentId)) {
    return { status: 409 as const, body: { error: "Target agent does not satisfy current availability, capability, capacity, or risk policy." } };
  }
  const [targetAgent, targetLoad, lease, existing] = await Promise.all([
    prisma.agent.findUnique({ where: { id: targetAgentId } }),
    prisma.agentEventHandoff.count({ where: { targetAgentId, status: { in: ["offered", "accepted"] } } }),
    prisma.agentEventLease.findUnique({ where: { agentId_eventId: { agentId: input.sourceAgent.id, eventId: input.eventId } } }),
    prisma.agentEventHandoff.findFirst({ where: { sourceAgentId: input.sourceAgent.id, eventId: input.eventId, status: { in: ["offered", "accepted"] } } }),
  ]);
  if (!targetAgent || targetAgent.credentialsRevokedAt) return { status: 404 as const, body: { error: "Target agent is unavailable." } };
  if (!targetAgent.handoffOptIn) return { status: 409 as const, body: { error: "Target agent is not accepting event handoffs." } };
  if (targetLoad >= targetAgent.handoffMaxConcurrent) return { status: 409 as const, body: { error: "Target agent is at its declared handoff capacity.", active_handoff_load: targetLoad, max_concurrent_handoffs: targetAgent.handoffMaxConcurrent } };
  if (!lease?.needsReevaluation) return { status: 409 as const, body: { error: "Only events marked for reevaluation can be handed off." } };
  if (existing) return { status: 409 as const, body: { error: "An active handoff already exists for this event.", handoff_id: existing.id } };
  const targetCapabilities = new Set(jsonArray(targetAgent.capabilities).map((value) => value.toLowerCase()));
  if (input.requestedCapabilities.length && !input.requestedCapabilities.some((value) => targetCapabilities.has(value.toLowerCase()))) {
    return { status: 422 as const, body: { error: "Target agent does not advertise any requested capability.", target_capabilities: [...targetCapabilities] } };
  }
  const stream = await buildAgentEvents(input.sourceAgent.id, { limit: 200 }, { includePrivateSourceWatchEvents: true, includeAcknowledgements: true });
  const event = stream?.events.find((item) => item.id === input.eventId);
  const eventSnapshot = event ?? {
    id: input.eventId,
    unavailable_from_current_window: true,
    reevaluation: { failure_count: lease.failureCount, failure_reason: lease.failureReason, failure_detail: lease.failureDetail },
  };
  const handoff = await prisma.agentEventHandoff.create({
    data: {
      sourceAgentId: input.sourceAgent.id,
      targetAgentId: targetAgent.id,
      eventId: input.eventId,
      reason: input.reason,
      requestedCapabilities: toJsonArray(input.requestedCapabilities),
      eventSnapshot: JSON.stringify(eventSnapshot),
      eventRiskTier: eligibleCandidates.body.event_risk_tier,
      offeredPolicyVersion: HANDOFF_POLICY_VERSION,
      offeredPolicyHash: handoffPolicyHash(),
    },
    include: { sourceAgent: { select: agentSelect }, targetAgent: { select: agentSelect } },
  });
  return { status: 201 as const, body: { handoff: formatHandoff(handoff) } };
}

export async function listAgentEventHandoffs(agentId: string) {
  const handoffs = await prisma.agentEventHandoff.findMany({
    where: { OR: [{ sourceAgentId: agentId }, { targetAgentId: agentId }] },
    include: { sourceAgent: { select: agentSelect }, targetAgent: { select: agentSelect } },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
  return { agent_id: agentId, handoffs: handoffs.map(formatHandoff) };
}

export async function updateAgentEventHandoff(input: {
  actorAgentId: string;
  handoffId: string;
  action: "accept" | "decline" | "complete" | "cancel";
  resultSummary?: string;
  evidenceUrls?: string[];
  policyVersion?: string;
  policyDocumentHash?: string;
}) {
  const existing = await prisma.agentEventHandoff.findUnique({ where: { id: input.handoffId } });
  if (!existing) return { status: 404 as const, body: { error: "Event handoff not found." } };
  if (input.action === "cancel") {
    if (existing.sourceAgentId !== input.actorAgentId || !["offered", "accepted"].includes(existing.status)) return { status: 409 as const, body: { error: "Only the source agent can cancel an active handoff." } };
  } else {
    if (existing.targetAgentId !== input.actorAgentId) return { status: 403 as const, body: { error: "Only the target agent can respond to this handoff." } };
    if (["accept", "decline"].includes(input.action) && existing.status !== "offered") return { status: 409 as const, body: { error: "Only offered handoffs can be accepted or declined." } };
    if (input.action === "complete" && existing.status !== "accepted") return { status: 409 as const, body: { error: "Only accepted handoffs can be completed." } };
  }
  const riskTier = existing.eventRiskTier;
  if (input.action === "accept") {
    const currentHash = handoffPolicyHash();
    if (existing.offeredPolicyVersion !== HANDOFF_POLICY_VERSION || existing.offeredPolicyHash !== currentHash) {
      return {
        status: 409 as const,
        body: {
          error: "Handoff policy changed after this offer was created. The source agent must create a new offer.",
          event_risk_tier: riskTier,
          offered_policy: existing.offeredPolicyVersion && existing.offeredPolicyHash ? { version: existing.offeredPolicyVersion, document_hash: existing.offeredPolicyHash } : null,
          current_policy: { version: HANDOFF_POLICY_VERSION, document_hash: currentHash, url: "/api/handoff-policy" },
          required_action: "source_agent_recreate_handoff",
        },
      };
    }
  }
  if (input.action === "accept" && riskTier === "high") {
    const sourceAgent = await prisma.agent.findUnique({ where: { id: existing.sourceAgentId } });
    if (!sourceAgent || sourceAgent.credentialsRevokedAt) {
      return { status: 409 as const, body: { error: "High-risk handoff source agent is no longer active.", required_action: "cancel_or_recreate_handoff" } };
    }
    const eligibility = await recommendAgentEventHandoffCandidates({
      sourceAgent,
      eventId: existing.eventId,
      requestedCapabilities: jsonArray(existing.requestedCapabilities),
      limit: 500,
      excludeHandoffId: existing.id,
      excludeHandoffTargetAgentId: existing.targetAgentId,
      riskTierOverride: "high",
    });
    if (eligibility.status !== 200 || !eligibility.body.candidates.some((candidate) => candidate.agent.id === existing.targetAgentId)) {
      return {
        status: 409 as const,
        body: {
          error: "High-risk handoff target no longer satisfies current eligibility gates.",
          event_risk_tier: riskTier,
          required_action: "source_agent_reselect_target",
        },
      };
    }
  }
  if (input.action === "accept" && riskTier === "high") {
    const currentHash = handoffPolicyHash();
    if (input.policyVersion !== HANDOFF_POLICY_VERSION || input.policyDocumentHash !== currentHash) {
      return {
        status: 409 as const,
        body: {
          error: "High-risk handoff acceptance requires the current handoff policy version and document hash.",
          event_risk_tier: riskTier,
          required_policy: { version: HANDOFF_POLICY_VERSION, document_hash: currentHash, url: "/api/handoff-policy" },
        },
      };
    }
  }
  const status = input.action === "accept" ? "accepted" : input.action === "decline" ? "declined" : input.action === "complete" ? "completed" : "cancelled";
  const now = new Date();
  const handoff = await prisma.agentEventHandoff.update({
    where: { id: existing.id },
    data: {
      status,
      resultSummary: input.resultSummary,
      evidenceUrls: input.evidenceUrls ? toJsonArray(input.evidenceUrls) : undefined,
      acceptedPolicyVersion: input.action === "accept" ? input.policyVersion : undefined,
      acceptedPolicyHash: input.action === "accept" ? input.policyDocumentHash : undefined,
      acceptedAt: input.action === "accept" ? now : undefined,
      completedAt: input.action === "complete" ? now : undefined,
      declinedAt: input.action === "decline" ? now : undefined,
      cancelledAt: input.action === "cancel" ? now : undefined,
    },
    include: { sourceAgent: { select: agentSelect }, targetAgent: { select: agentSelect } },
  });
  return { status: 200 as const, body: { handoff: formatHandoff(handoff) } };
}
