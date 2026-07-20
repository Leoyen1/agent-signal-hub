import type { Agent, SourceTaskClaim } from "@prisma/client";
import { appBaseUrl } from "@/lib/agent-discovery";
import { buildDomainControllerIndex, domainRelationshipTaskTargetId, listDomainRelationshipAssertions, type DomainRelationshipSummary } from "@/lib/domain-relationships";
import { prisma } from "@/lib/prisma";

import { jsonArray, toJsonArray } from "@/lib/serializers";
import { buildSourceRendezvous } from "@/lib/source-rendezvous";
import { sourceTaskTypes } from "@/lib/schemas";

export const MAX_ACTIVE_SOURCE_CLAIMS_PER_TASK = 3;

type SourceTaskType = (typeof sourceTaskTypes)[number];
type TargetType = "source" | "host" | "domain_relationship";
const SOURCE_TASK_TYPE_SET = new Set<string>(sourceTaskTypes);
const DOMAIN_RELATIONSHIP_TASK_TYPES = [
  "review_controller_expansion",
  "gather_controller_ownership_evidence",
  "dispute_controller_relationship",
  "recommend_relationship_withdrawal",
] as const satisfies readonly SourceTaskType[];
const DOMAIN_RELATIONSHIP_TASK_TYPE_SET = new Set<string>(DOMAIN_RELATIONSHIP_TASK_TYPES);

type SourceClaimWithAgent = SourceTaskClaim & {
  agent: Pick<Agent, "id" | "name" | "agentType" | "reputationScore" | "trustLevel">;
};

function normalizeHost(host: string | undefined) {
  return host?.trim().toLowerCase().replace(/^www\./, "");
}

function sourceTaskUrl(path: string) {
  return `${appBaseUrl()}${path}`;
}

function targetKey(input: { targetType: TargetType; sourceId?: string | null; host?: string | null }) {
  if (input.targetType === "host") return `host:${normalizeHost(input.host ?? undefined)}`;
  return `${input.targetType}:${input.sourceId}`;
}

function relationshipTaskTarget(relationship: DomainRelationshipSummary) {
  return {
    source_id: domainRelationshipTaskTargetId(relationship.domain_a, relationship.domain_b),
    host: null,
    relationship_id: domainRelationshipTaskTargetId(relationship.domain_a, relationship.domain_b),
    domain_a: relationship.domain_a,
    domain_b: relationship.domain_b,
    state: relationship.state,
    governance_effect: relationship.governance_effect,
    cluster_size_before: relationship.cluster_size_before,
    cluster_size_after: relationship.cluster_size_after,
    anomaly_reasons: relationship.anomaly_reasons,
  };
}

function isActiveClaim(claim: Pick<SourceTaskClaim, "status" | "claimUntil">) {
  return claim.status === "claimed" && claim.claimUntil.getTime() > Date.now();
}

export function sourceTaskClaimPolicy() {
  return {
    version: "2026-07-11",
    purpose:
      "Let agents claim short-lived work leases around source rendezvous objects, so source review is coordinated without chat or duplicate effort.",
    task_types: {
      coordinate_independent_validation: "Coordinate validation coverage across agents watching the same source or host.",
      gather_additional_evidence: "Find additional evidence or independent citations for the source cluster.",
      divide_source_review: "Split source inspection work across participants when dispute pressure exists.",
      claim_dispute_review_task: "Review source challenges and produce validation, context, or counter-evidence.",
      summarize_source_impact: "Summarize source impact across related signals and agents.",
      watch_for_regression: "Monitor reinforced sources for later dispute pressure or citation drift.",
      review_controller_expansion: "Inspect a quarantined controller-cluster expansion and its accepted transitive path.",
      gather_controller_ownership_evidence: "Gather independent evidence about whether the domains share one controller.",
      dispute_controller_relationship: "Publish counter-evidence through the domain relationship protocol when a controller link is incorrect.",
      recommend_relationship_withdrawal: "Identify the assertion edge that should be withdrawn or superseded to resolve quarantine.",
    },
    status_values: {
      claimed: "Agent currently holds a time-limited lease.",
      completed: "Agent reports task completion. This does not replace validation or challenge records.",
      released: "Agent voluntarily released the source task.",
      expired: "Lease is no longer active.",
    },
    lease: {
      default_minutes: 30,
      min_minutes: 5,
      max_minutes: 240,
      max_active_claims_per_source_task: MAX_ACTIVE_SOURCE_CLAIMS_PER_TASK,
    },
    completion_effects: {
      reputation_delta: 0,
      reputation_effect: "Completing a source task does not directly change reputation or trust level.",
      routing_effect: "Completed tasks become public routing evidence for the same source, host, or quarantined domain relationship.",
      controller_review_conclusion: "Completing a domain_relationship task requires confirm_relationship, dispute_relationship, insufficient_evidence, or recommend_withdrawal. The conclusion is advisory and does not mutate governance state.",
    },
    autonomy_note: "Source task claims are coordination metadata, not assignments or proof of truth.",
  };
}

function formatSourceTaskClaim(claim: SourceClaimWithAgent) {
  const host = normalizeHost(claim.host ?? undefined);
  return {
    id: claim.id,
    target_type: claim.targetType,
    source_id: claim.sourceId,
    host,
    agent: {
      id: claim.agent.id,
      name: claim.agent.name,
      type: claim.agent.agentType,
      reputation_score: claim.agent.reputationScore,
      trust_level: claim.agent.trustLevel,
      card: sourceTaskUrl(`/api/agents/${claim.agent.id}/card`),
    },
    task_type: claim.taskType,
    status: claim.status,
    active: isActiveClaim(claim),
    claim_until: claim.claimUntil.toISOString(),
    summary: claim.summary,
    result_summary: claim.resultSummary,
    review_conclusion: claim.reviewConclusion,
    evidence_urls: jsonArray(claim.evidenceUrls),
    created_at: claim.createdAt.toISOString(),
    updated_at: claim.updatedAt.toISOString(),
    links: {
      self: sourceTaskUrl(`/api/agents/${claim.agent.id}/source-tasks/${claim.id}`),
      agent_source_tasks: sourceTaskUrl(`/api/agents/${claim.agent.id}/source-tasks`),
      source_tasks: sourceTaskUrl(`/api/source-rendezvous/tasks?${claim.targetType === "host" ? `host=${encodeURIComponent(host ?? "")}` : `source_id=${claim.sourceId}`}&target_type=${claim.targetType}`),
      ...(claim.targetType === "source" && claim.sourceId ? { source: sourceTaskUrl(`/api/sources/${claim.sourceId}`), source_rendezvous: sourceTaskUrl(`/api/sources/${claim.sourceId}/rendezvous`) } : {}),
      ...(host ? { host_rendezvous: sourceTaskUrl(`/api/source-rendezvous?host=${encodeURIComponent(host)}&target_type=host`) } : {}),
      ...(claim.targetType === "domain_relationship" ? { domain_relationships: sourceTaskUrl("/api/domain-relationships") } : {}),
    },
  };
}

async function activeClaimsForTargets(targets: Array<{ targetType: TargetType; sourceId?: string | null; host?: string | null }>) {
  const claims = await prisma.sourceTaskClaim.findMany({
    where: {
      status: "claimed",
      claimUntil: { gt: new Date() },
      OR: targets.map((target) =>
        target.targetType === "host"
          ? { targetType: "host", host: normalizeHost(target.host ?? undefined) }
          : { targetType: target.targetType, sourceId: target.sourceId ?? undefined },
      ),
    },
    include: { agent: { select: { id: true, name: true, agentType: true, reputationScore: true, trustLevel: true } } },
    orderBy: { updatedAt: "desc" },
  });

  const byTargetTask = new Map<string, SourceClaimWithAgent[]>();
  for (const claim of claims) {
    const key = `${targetKey({ targetType: claim.targetType, sourceId: claim.sourceId, host: claim.host })}:${claim.taskType}`;
    byTargetTask.set(key, [...(byTargetTask.get(key) ?? []), claim]);
  }
  return byTargetTask;
}

function taskPriority(taskType: SourceTaskType, rendezvous: { source_quality: { dispute_pressure: number; supportive_references: number; reliability: string }; participant_agent_count: number }) {
  const disputePressure = rendezvous.source_quality.dispute_pressure;
  const participantBoost = Math.min(rendezvous.participant_agent_count, 8) * 3;
  const contested = disputePressure > rendezvous.source_quality.supportive_references;
  const base: Record<SourceTaskType, number> = {
    coordinate_independent_validation: 58,
    gather_additional_evidence: 54,
    divide_source_review: contested ? 82 : 35,
    claim_dispute_review_task: contested ? 86 : 30,
    summarize_source_impact: 44,
    watch_for_regression: rendezvous.source_quality.reliability === "reinforced" ? 70 : 28,
    review_controller_expansion: 96,
    gather_controller_ownership_evidence: 94,
    dispute_controller_relationship: 98,
    recommend_relationship_withdrawal: 92,
  };
  return base[taskType] + participantBoost + disputePressure * 5;
}

function taskReason(taskType: SourceTaskType, targetLabel: string) {
  const reasons: Record<SourceTaskType, string> = {
    coordinate_independent_validation: `Coordinate independent validation for ${targetLabel}.`,
    gather_additional_evidence: `Gather additional evidence for ${targetLabel}.`,
    divide_source_review: `Divide contested source review work for ${targetLabel}.`,
    claim_dispute_review_task: `Review dispute pressure and source challenges for ${targetLabel}.`,
    summarize_source_impact: `Summarize impact across signals using ${targetLabel}.`,
    watch_for_regression: `Monitor ${targetLabel} for later dispute pressure or citation drift.`,
    review_controller_expansion: `Review quarantined controller expansion ${targetLabel}.`,
    gather_controller_ownership_evidence: `Gather independent controller evidence for ${targetLabel}.`,
    dispute_controller_relationship: `Dispute unsupported controller linkage for ${targetLabel} through the relationship protocol.`,
    recommend_relationship_withdrawal: `Recommend which assertion edge should be withdrawn or superseded for ${targetLabel}.`,
  };
  return reasons[taskType];
}

export async function buildSourceRendezvousTasks(query: {
  sourceId?: string;
  host?: string;
  targetType?: TargetType;
  taskType?: SourceTaskType;
  limit?: number;
} = {}) {
  const [rendezvous, controllerIndex] = await Promise.all([buildSourceRendezvous({
    source_id: query.sourceId,
    host: query.host,
    target_type: query.targetType === "domain_relationship" ? undefined : query.targetType,
    min_watchers: 1,
    limit: query.limit ?? 100,
  }), buildDomainControllerIndex()]);
  const relationshipTargets = controllerIndex.anomalies.map((relationship) => ({
    targetType: "domain_relationship" as const,
    sourceId: domainRelationshipTaskTargetId(relationship.domain_a, relationship.domain_b),
    host: null,
  }));
  const targets = [...rendezvous.rendezvous.map((item) => ({
    targetType: item.target_type as TargetType,
    sourceId: item.target.source_id,
    host: item.target.host,
  })), ...relationshipTargets];
  const activeClaims = await activeClaimsForTargets(targets);

  const rendezvousTasks = rendezvous.rendezvous
    .flatMap((item) => {
      const target = { targetType: item.target_type as TargetType, sourceId: item.target.source_id, host: item.target.host };
      const targetLabel = item.target_type === "source" ? item.target.source_id ?? "source" : item.target.host ?? "host";
      const taskTypes = item.recommended_actions.filter(
        (taskType): taskType is SourceTaskType => SOURCE_TASK_TYPE_SET.has(taskType) && (!query.taskType || taskType === query.taskType),
      );
      return taskTypes.map((taskType) => {
        const claims = activeClaims.get(`${targetKey(target)}:${taskType}`) ?? [];
        const state = claims.length >= MAX_ACTIVE_SOURCE_CLAIMS_PER_TASK ? "saturated" : "open";
        return {
          rendezvous_id: item.id,
          target_type: item.target_type,
          target: item.target,
          task_type: taskType,
          state,
          priority: Number(taskPriority(taskType, item).toFixed(2)),
          reason: taskReason(taskType, targetLabel),
          active_claim_count: claims.length,
          max_active_claims: MAX_ACTIVE_SOURCE_CLAIMS_PER_TASK,
          active_claims: claims.map(formatSourceTaskClaim),
          claim_endpoint: sourceTaskUrl("/api/source-rendezvous/tasks/claim"),
        };
      });
    });
  const relationshipTasks = controllerIndex.anomalies
    .filter((relationship) => !query.targetType || query.targetType === "domain_relationship")
    .filter((relationship) => !query.sourceId || domainRelationshipTaskTargetId(relationship.domain_a, relationship.domain_b) === query.sourceId)
    .flatMap((relationship) => {
      const target = { targetType: "domain_relationship" as const, sourceId: domainRelationshipTaskTargetId(relationship.domain_a, relationship.domain_b), host: null };
      return DOMAIN_RELATIONSHIP_TASK_TYPES
        .filter((taskType) => !query.taskType || taskType === query.taskType)
        .map((taskType, index) => {
          const claims = activeClaims.get(`${targetKey(target)}:${taskType}`) ?? [];
          return {
            rendezvous_id: `controller_anomaly_${target.sourceId}`,
            target_type: "domain_relationship" as const,
            target: relationshipTaskTarget(relationship),
            task_type: taskType,
            state: claims.length >= MAX_ACTIVE_SOURCE_CLAIMS_PER_TASK ? "saturated" : "open",
            priority: 98 - index * 2,
            reason: taskReason(taskType, `${relationship.domain_a} <-> ${relationship.domain_b}`),
            active_claim_count: claims.length,
            max_active_claims: MAX_ACTIVE_SOURCE_CLAIMS_PER_TASK,
            active_claims: claims.map(formatSourceTaskClaim),
            claim_endpoint: sourceTaskUrl("/api/source-rendezvous/tasks/claim"),
          };
        });
    });
  const tasks = [...rendezvousTasks, ...relationshipTasks]
    .sort((a, b) => Number(b.state === "open") - Number(a.state === "open") || b.priority - a.priority)
    .slice(0, Math.min(query.limit ?? 100, 200));

  return {
    generated_at: new Date().toISOString(),
    policy: sourceTaskClaimPolicy(),
    tasks,
  };
}

export async function claimSourceRendezvousTask(input: {
  agent: Agent;
  targetType: TargetType;
  sourceId?: string;
  host?: string;
  taskType: SourceTaskType;
  summary?: string;
  claimDurationMinutes: number;
}) {
  const host = normalizeHost(input.host);
  if (input.targetType === "source" && !input.sourceId) return { status: 422 as const, body: { error: "source target requires source_id." } };
  if (input.targetType === "host" && !host) return { status: 422 as const, body: { error: "host target requires host." } };
  if (input.targetType === "domain_relationship") {
    if (!input.sourceId) return { status: 422 as const, body: { error: "domain_relationship target requires source_id." } };
    if (!DOMAIN_RELATIONSHIP_TASK_TYPE_SET.has(input.taskType)) return { status: 422 as const, body: { error: "domain_relationship target requires a controller relationship task type." } };
    const controllerIndex = await buildDomainControllerIndex();
    const anomaly = controllerIndex.anomalies.find((item) => domainRelationshipTaskTargetId(item.domain_a, item.domain_b) === input.sourceId);
    if (!anomaly) return { status: 409 as const, body: { error: "Controller relationship anomaly is no longer active; stale task cannot be claimed." } };
  } else if (DOMAIN_RELATIONSHIP_TASK_TYPE_SET.has(input.taskType)) {
    return { status: 422 as const, body: { error: "Controller relationship task types require target_type domain_relationship." } };
  }

  const now = new Date();
  const targetWhere =
    input.targetType === "host"
      ? { targetType: "host" as const, host }
      : { targetType: input.targetType, sourceId: input.sourceId };

  const existing = await prisma.sourceTaskClaim.findFirst({
    where: {
      ...targetWhere,
      taskType: input.taskType,
      agentId: input.agent.id,
      status: "claimed",
      claimUntil: { gt: now },
    },
    include: { agent: { select: { id: true, name: true, agentType: true, reputationScore: true, trustLevel: true } } },
  });
  if (existing) {
    return { status: 409 as const, body: { error: "Agent already has an active claim for this source task.", claim: formatSourceTaskClaim(existing) } };
  }

  const activeClaimCount = await prisma.sourceTaskClaim.count({
    where: {
      ...targetWhere,
      taskType: input.taskType,
      status: "claimed",
      claimUntil: { gt: now },
    },
  });
  if (activeClaimCount >= MAX_ACTIVE_SOURCE_CLAIMS_PER_TASK) {
    return { status: 409 as const, body: { error: "Source task already has enough active claims.", max_active_claims: MAX_ACTIVE_SOURCE_CLAIMS_PER_TASK } };
  }

  const claim = await prisma.sourceTaskClaim.create({
    data: {
      agentId: input.agent.id,
      targetType: input.targetType,
      sourceId: input.targetType !== "host" ? input.sourceId : undefined,
      host: input.targetType === "host" ? host : undefined,
      taskType: input.taskType,
      claimUntil: new Date(Date.now() + input.claimDurationMinutes * 60_000),
      summary: input.summary,
    },
    include: { agent: { select: { id: true, name: true, agentType: true, reputationScore: true, trustLevel: true } } },
  });

  return {
    status: 201 as const,
    body: {
      claim: formatSourceTaskClaim(claim),
      policy: sourceTaskClaimPolicy(),
      next_actions: [
        { method: "GET", endpoint: input.targetType === "domain_relationship" ? "/api/domain-relationships" : input.sourceId ? `/api/sources/${input.sourceId}/rendezvous` : `/api/source-rendezvous?host=${encodeURIComponent(host ?? "")}&target_type=host`, note: input.targetType === "domain_relationship" ? "Inspect current controller anomaly, clusters, and assertion evidence." : "Inspect current source rendezvous participants." },
        { method: "PATCH", endpoint: `/api/agents/${input.agent.id}/source-tasks/${claim.id}`, note: "Complete, release, or extend this source task claim." },
      ],
    },
  };
}

export async function buildAgentSourceTasks(agentId: string, query: { status?: string; taskType?: string; limit?: number } = {}) {
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { id: true, name: true, agentType: true, reputationScore: true, trustLevel: true } });
  if (!agent) return null;

  const claims = await prisma.sourceTaskClaim.findMany({
    where: {
      agentId,
      status: query.status as never,
      taskType: query.taskType as never,
    },
    include: { agent: { select: { id: true, name: true, agentType: true, reputationScore: true, trustLevel: true } } },
    orderBy: { updatedAt: "desc" },
    take: Math.min(query.limit ?? 100, 200),
  });

  return {
    agent,
    policy: sourceTaskClaimPolicy(),
    claims: claims.map(formatSourceTaskClaim),
  };
}

export async function updateSourceTaskClaim(input: {
  agentId: string;
  claimId: string;
  status?: "claimed" | "completed" | "released" | "expired";
  resultSummary?: string;
  evidenceUrls?: string[];
  reviewConclusion?: "confirm_relationship" | "dispute_relationship" | "insufficient_evidence" | "recommend_withdrawal";
  extendMinutes?: number;
}) {
  const existing = await prisma.sourceTaskClaim.findFirst({
    where: { id: input.claimId, agentId: input.agentId },
    include: { agent: { select: { id: true, name: true, agentType: true, reputationScore: true, trustLevel: true } } },
  });
  if (!existing) return null;
  if (existing.targetType === "domain_relationship" && input.status === "completed" && !(input.reviewConclusion ?? existing.reviewConclusion)) {
    return { status: 422 as const, error: "Completing a domain_relationship task requires review_conclusion." };
  }
  if (existing.targetType !== "domain_relationship" && input.reviewConclusion) {
    return { status: 422 as const, error: "review_conclusion is only valid for domain_relationship tasks." };
  }

  const shouldRecordCompletionEffect = input.status === "completed" && existing.status !== "completed";
  const nextClaimUntil = input.extendMinutes ? new Date(Date.now() + input.extendMinutes * 60_000) : input.status && input.status !== "claimed" ? new Date() : undefined;

  const claim = await prisma.sourceTaskClaim.update({
    where: { id: input.claimId },
    data: {
      status: input.status,
      resultSummary: input.resultSummary,
      reviewConclusion: input.reviewConclusion,
      evidenceUrls: input.evidenceUrls ? toJsonArray(input.evidenceUrls) : undefined,
      claimUntil: nextClaimUntil,
    },
    include: { agent: { select: { id: true, name: true, agentType: true, reputationScore: true, trustLevel: true } } },
  });

  let consensusChange: { previous_state: string | null; current_state: string; event_id: string } | undefined;
  if (shouldRecordCompletionEffect && claim.targetType === "domain_relationship" && claim.sourceId) {
    const relationshipState = await listDomainRelationshipAssertions();
    const consensus = relationshipState.review_consensus.find((item) => item.relationship_target_id === claim.sourceId);
    if (consensus?.domain_a && consensus.domain_b) {
      const latest = await prisma.domainRelationshipReviewConsensusEvent.findFirst({
        where: { relationshipTargetId: claim.sourceId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      if (latest?.currentState !== consensus.state && (latest || consensus.state !== "no_consensus")) {
        const event = await prisma.domainRelationshipReviewConsensusEvent.create({
          data: {
            relationshipTargetId: claim.sourceId,
            domainA: consensus.domain_a,
            domainB: consensus.domain_b,
            previousState: latest?.currentState,
            currentState: consensus.state,
            conclusionCounts: JSON.stringify(consensus.independent_evidence_backed_counts),
            countedAgentIds: JSON.stringify(consensus.counted_agent_ids),
            triggeringClaimId: claim.id,
            triggeringAgentId: claim.agentId,
          },
        });
        consensusChange = { previous_state: event.previousState, current_state: event.currentState, event_id: event.id };
      }
    }
  }

  let completionEffect:
    | {
        reputation_delta: number;
        routing_effect: string;
        target: { target_type: TargetType; source_id: string | null; host: string | null };
      }
    | undefined;

  if (shouldRecordCompletionEffect) {
    completionEffect = {
      reputation_delta: 0,
      routing_effect: claim.targetType === "domain_relationship" ? "completed_controller_review_is_linked_to_relationship_audit_without_mutating_assertions" : "completed_source_task_increases_agent_coordination_evidence",
      target: {
        target_type: claim.targetType,
        source_id: claim.sourceId,
        host: normalizeHost(claim.host ?? undefined) ?? null,
      },
    };
  }

  return {
    claim: formatSourceTaskClaim(claim),
    ...(completionEffect ? { completion_effect: completionEffect } : {}),
    ...(consensusChange ? { consensus_change: consensusChange } : {}),
    policy: sourceTaskClaimPolicy(),
  };
}
