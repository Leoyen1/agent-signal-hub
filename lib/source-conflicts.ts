import type { Agent, SourceAssertion, SourceTaskClaim } from "@prisma/client";
import { appBaseUrl } from "@/lib/agent-discovery";
import { prisma } from "@/lib/prisma";
import { jsonArray } from "@/lib/serializers";
import type { SourceRecord } from "@/lib/sources";

export type SourceConflictSeverity = "clear" | "review" | "contested" | "blocked";
export type SourceConflictResolutionState = "unresolved" | "partially_mitigated" | "mitigated" | "regressed";

type CompletedClaim = SourceTaskClaim & {
  agent: Pick<Agent, "id" | "name" | "agentType" | "reputationScore" | "trustLevel">;
};

type SourceAssertionWithAgent = SourceAssertion & {
  agent: Pick<Agent, "id" | "name" | "agentType" | "reputationScore" | "trustLevel">;
};

export const sourceConflictSeverityRank: Record<SourceConflictSeverity, number> = {
  clear: 0,
  review: 1,
  contested: 2,
  blocked: 3,
};

function conflictUrl(path: string) {
  return `${appBaseUrl()}${path}`;
}

function normalizeHost(host: string | undefined) {
  return host?.trim().toLowerCase().replace(/^www\./, "");
}

function conflictIdForTarget(target: { targetType: "source" | "host"; sourceId?: string | null; host?: string | null }) {
  return target.targetType === "source"
    ? `cf_src_${target.sourceId?.replace(/^src_/, "")}`
    : `cf_host_${normalizeHost(target.host ?? undefined)?.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "")}`;
}

function completedClaimShape(claim: CompletedClaim) {
  return {
    id: claim.id,
    task_type: claim.taskType,
    result_summary: claim.resultSummary,
    evidence_urls: jsonArray(claim.evidenceUrls),
    completed_at: claim.updatedAt.toISOString(),
    agent: {
      id: claim.agent.id,
      name: claim.agent.name,
      type: claim.agent.agentType,
      reputation_score: claim.agent.reputationScore,
      trust_level: claim.agent.trustLevel,
      card: conflictUrl(`/api/agents/${claim.agent.id}/card`),
    },
    link: conflictUrl(`/api/agents/${claim.agent.id}/source-tasks/${claim.id}`),
  };
}

function sourceAssertionShape(assertion: SourceAssertionWithAgent) {
  return {
    id: assertion.id,
    stance: assertion.stance,
    summary: assertion.summary,
    evidence_urls: jsonArray(assertion.evidenceUrls),
    created_at: assertion.createdAt.toISOString(),
    agent: {
      id: assertion.agent.id,
      name: assertion.agent.name,
      type: assertion.agent.agentType,
      reputation_score: assertion.agent.reputationScore,
      trust_level: assertion.agent.trustLevel,
      card: conflictUrl(`/api/agents/${assertion.agent.id}/card`),
    },
    link: conflictUrl(`/api/source-assertions?id=${assertion.id}`),
  };
}

function sourceAssertionCounts(assertions: SourceAssertionWithAgent[]) {
  return assertions.reduce(
    (counts, assertion) => {
      counts[assertion.stance] += 1;
      counts.agent_ids.add(assertion.agentId);
      return counts;
    },
    { support: 0, dispute: 0, context: 0, agent_ids: new Set<string>() },
  );
}

function isArbitrationTask(claim: Pick<SourceTaskClaim, "taskType">) {
  return ["coordinate_independent_validation", "gather_additional_evidence", "divide_source_review", "claim_dispute_review_task"].includes(claim.taskType);
}

function isReviewTask(claim: Pick<SourceTaskClaim, "taskType">) {
  return claim.taskType === "claim_dispute_review_task" || claim.taskType === "divide_source_review";
}

function isEvidenceTask(claim: Pick<SourceTaskClaim, "taskType">) {
  return claim.taskType === "gather_additional_evidence" || claim.taskType === "coordinate_independent_validation";
}

function hasUsefulCompletionOutput(claim: Pick<SourceTaskClaim, "resultSummary" | "evidenceUrls">) {
  return Boolean(claim.resultSummary?.trim() || jsonArray(claim.evidenceUrls).length);
}

function isAdverseReference(reference: SourceRecord["references"][number]) {
  return (
    reference.validation_verdict === "dispute" ||
    reference.validation_verdict === "mark_low_quality" ||
    reference.challenge_type === "source_dispute" ||
    reference.challenge_type === "confidence_dispute" ||
    reference.challenge_type === "retraction_request"
  );
}

function isAdverseAssertion(assertion: SourceAssertionWithAgent) {
  return assertion.stance === "dispute";
}

export function summarizeSourceConflictInputs(input: {
  supportiveReferences: number;
  disputePressure: number;
  openChallenges: number;
  acceptedChallenges: number;
  rejectedChallenges: number;
  completedDisputeReviews?: number;
  completedEvidenceTasks?: number;
}) {
  const completedDisputeReviews = input.completedDisputeReviews ?? 0;
  const completedEvidenceTasks = input.completedEvidenceTasks ?? 0;
  const unresolvedPressure = Math.max(
    0,
    input.disputePressure +
      input.openChallenges +
      input.acceptedChallenges -
      input.supportiveReferences -
      completedDisputeReviews * 0.25 -
      completedEvidenceTasks * 0.5,
  );
  const severity: SourceConflictSeverity =
    unresolvedPressure >= 4 || (input.openChallenges >= 2 && input.disputePressure > input.supportiveReferences)
      ? "blocked"
      : unresolvedPressure >= 2 || input.disputePressure > input.supportiveReferences
        ? "contested"
        : unresolvedPressure > 0
          ? "review"
          : "clear";

  const reasons = [
    input.disputePressure ? `dispute_pressure=${input.disputePressure}` : null,
    input.supportiveReferences ? `supportive_references=${input.supportiveReferences}` : null,
    input.openChallenges ? `open_challenges=${input.openChallenges}` : null,
    input.acceptedChallenges ? `accepted_challenges=${input.acceptedChallenges}` : null,
    input.rejectedChallenges ? `rejected_challenges=${input.rejectedChallenges}` : null,
    completedDisputeReviews ? `completed_dispute_reviews=${completedDisputeReviews}` : null,
    completedEvidenceTasks ? `completed_evidence_tasks=${completedEvidenceTasks}` : null,
  ].filter(Boolean) as string[];

  return {
    severity,
    unresolved_pressure: Number(unresolvedPressure.toFixed(2)),
    digest_effect:
      severity === "blocked"
        ? "suppress_until_independent_review_or_counter_evidence"
        : severity === "contested"
          ? "strong_negative_governance_delta"
          : severity === "review"
            ? "request_independent_source_review"
            : "none",
    reasons,
  };
}

function buildSourceResolutionFeedback(
  source: SourceRecord,
  summary: ReturnType<typeof summarizeSourceConflictInputs>,
  baseline: ReturnType<typeof summarizeSourceConflictInputs>,
  completedClaims: CompletedClaim[],
  assertions: SourceAssertionWithAgent[],
) {
  const arbitrationClaims = completedClaims.filter(isArbitrationTask);
  const usefulClaims = arbitrationClaims.filter(hasUsefulCompletionOutput);
  const positiveAssertions = assertions.filter((assertion) => assertion.stance === "support" || assertion.stance === "context");
  const evidenceUrls = [...new Set([...usefulClaims.flatMap((claim) => jsonArray(claim.evidenceUrls)), ...positiveAssertions.flatMap((assertion) => jsonArray(assertion.evidenceUrls))])];
  const latestCompletedAt = arbitrationClaims[0]?.updatedAt;
  const resolutionInputs = source.references.filter(
    (reference) =>
      reference.validation_verdict === "support" ||
      reference.validation_verdict === "add_context" ||
      reference.role === "challenge_response_evidence",
  );
  const latestResolutionEvidenceAt = [
    latestCompletedAt?.getTime() ?? 0,
    ...resolutionInputs.map((reference) => new Date(reference.occurred_at).getTime()),
    ...positiveAssertions.map((assertion) => assertion.createdAt.getTime()),
  ].reduce((latest, value) => Math.max(latest, value), 0);
  const adverseInputsAfterResolution = latestResolutionEvidenceAt
    ? [
        ...source.references.filter((reference) => isAdverseReference(reference) && new Date(reference.occurred_at).getTime() > latestResolutionEvidenceAt),
        ...assertions.filter((assertion) => isAdverseAssertion(assertion) && assertion.createdAt.getTime() > latestResolutionEvidenceAt),
      ]
    : [];
  const pressureDelta = Number((baseline.unresolved_pressure - summary.unresolved_pressure).toFixed(2));
  const resolutionAgents = new Set([
    ...arbitrationClaims.map((claim) => claim.agentId),
    ...positiveAssertions.map((assertion) => assertion.agentId),
    ...resolutionInputs.map((reference) => reference.agent_id).filter((agentId): agentId is string => Boolean(agentId)),
  ]);
  const hasIndependentResolutionEvidence = (resolutionInputs.length > 0 || positiveAssertions.length > 0) && evidenceUrls.length > 0 && resolutionAgents.size >= 2;

  const resolutionState: SourceConflictResolutionState =
    adverseInputsAfterResolution.length > 0
      ? "regressed"
      : summary.severity === "clear" && hasIndependentResolutionEvidence
        ? "mitigated"
        : pressureDelta > 0 && evidenceUrls.length > 0
          ? "partially_mitigated"
          : "unresolved";

  const lastResolutionUpdateAt = latestResolutionEvidenceAt;

  return {
    resolution_state: resolutionState,
    completed_arbitration_task_count: arbitrationClaims.length,
    last_resolution_update_at: lastResolutionUpdateAt ? new Date(lastResolutionUpdateAt).toISOString() : null,
    resolution_evidence: {
      baseline_unresolved_pressure: baseline.unresolved_pressure,
      current_unresolved_pressure: summary.unresolved_pressure,
      pressure_delta_from_completed_work: pressureDelta,
      completed_review_task_count: arbitrationClaims.filter(isReviewTask).length,
      completed_evidence_task_count: arbitrationClaims.filter(isEvidenceTask).length,
      completed_useful_task_count: usefulClaims.length,
      completed_arbitration_agent_count: new Set(arbitrationClaims.map((claim) => claim.agentId)).size,
      positive_assertion_count: positiveAssertions.length,
      independent_resolution_agent_count: resolutionAgents.size,
      evidence_url_count: evidenceUrls.length,
      validation_or_counter_evidence_count: resolutionInputs.length + positiveAssertions.length,
      adverse_input_count_after_latest_resolution_evidence: adverseInputsAfterResolution.length,
      completion_alone_is_not_resolution: true,
    },
  };
}

export function summarizeSourceRecordConflict(source: Pick<SourceRecord, "quality_inputs" | "challenge_counts" | "references">) {
  const openChallenges = source.references.filter((reference) => reference.challenge_status === "open").length;
  const acceptedChallenges = source.references.filter((reference) => reference.challenge_status === "accepted").length;
  const rejectedChallenges = source.references.filter((reference) => reference.challenge_status === "rejected").length;

  return summarizeSourceConflictInputs({
    supportiveReferences: source.quality_inputs.supportive_references,
    disputePressure: source.quality_inputs.dispute_pressure,
    openChallenges,
    acceptedChallenges,
    rejectedChallenges,
  });
}

function recommendedActions(severity: SourceConflictSeverity) {
  if (severity === "blocked") {
    return ["claim_dispute_review_task", "submit_context_or_dispute_validation", "request_correction_or_retraction"];
  }
  if (severity === "contested") {
    return ["divide_source_review", "gather_additional_evidence", "submit_context_or_dispute_validation"];
  }
  if (severity === "review") {
    return ["coordinate_independent_validation", "gather_additional_evidence"];
  }
  return ["reuse_with_citation_check"];
}

function targetTaskWhere(target: { targetType: "source" | "host"; sourceId?: string | null; host?: string | null }) {
  return target.targetType === "source"
    ? { targetType: "source" as const, sourceId: target.sourceId ?? undefined }
    : { targetType: "host" as const, host: normalizeHost(target.host ?? undefined) };
}

async function completedClaimsForTargets(targets: Array<{ targetType: "source" | "host"; sourceId?: string | null; host?: string | null }>) {
  if (!targets.length) return new Map<string, CompletedClaim[]>();
  const claims = await prisma.sourceTaskClaim.findMany({
    where: {
      status: "completed",
      OR: targets.map(targetTaskWhere),
    },
    include: { agent: { select: { id: true, name: true, agentType: true, reputationScore: true, trustLevel: true } } },
    orderBy: { updatedAt: "desc" },
    take: 500,
  });

  const byTarget = new Map<string, CompletedClaim[]>();
  for (const claim of claims) {
    const key = conflictIdForTarget({ targetType: claim.targetType as "source" | "host", sourceId: claim.sourceId, host: claim.host });
    byTarget.set(key, [...(byTarget.get(key) ?? []), claim]);
  }
  return byTarget;
}

async function assertionsForTargets(targets: Array<{ targetType: "source" | "host"; sourceId?: string | null; host?: string | null }>) {
  if (!targets.length) return new Map<string, SourceAssertionWithAgent[]>();
  const assertions = await prisma.sourceAssertion.findMany({
    where: { OR: targets.map(targetTaskWhere) },
    include: { agent: { select: { id: true, name: true, agentType: true, reputationScore: true, trustLevel: true } } },
    orderBy: { createdAt: "desc" },
    take: 500,
  });

  const byTarget = new Map<string, SourceAssertionWithAgent[]>();
  for (const assertion of assertions) {
    const key = conflictIdForTarget({ targetType: assertion.targetType as "source" | "host", sourceId: assertion.sourceId, host: assertion.host });
    byTarget.set(key, [...(byTarget.get(key) ?? []), assertion]);
  }
  return byTarget;
}

function buildSourceConflict(source: SourceRecord, completedClaims: CompletedClaim[] = [], assertions: SourceAssertionWithAgent[] = []) {
  const completedDisputeReviews = completedClaims.filter((claim) => isReviewTask(claim) && hasUsefulCompletionOutput(claim)).length;
  const completedEvidenceTasks = completedClaims.filter((claim) => isEvidenceTask(claim) && hasUsefulCompletionOutput(claim)).length;
  const assertionCounts = sourceAssertionCounts(assertions);
  const openChallenges = source.references.filter((reference) => reference.challenge_status === "open").length;
  const acceptedChallenges = source.references.filter((reference) => reference.challenge_status === "accepted").length;
  const rejectedChallenges = source.references.filter((reference) => reference.challenge_status === "rejected").length;
  const summary = summarizeSourceConflictInputs({
    supportiveReferences: source.quality_inputs.supportive_references + assertionCounts.support * 0.5,
    disputePressure: source.quality_inputs.dispute_pressure + assertionCounts.dispute,
    openChallenges,
    acceptedChallenges,
    rejectedChallenges,
    completedDisputeReviews,
    completedEvidenceTasks,
  });
  const baseline = summarizeSourceConflictInputs({
    supportiveReferences: source.quality_inputs.supportive_references,
    disputePressure: source.quality_inputs.dispute_pressure,
    openChallenges,
    acceptedChallenges,
    rejectedChallenges,
  });
  const resolutionFeedback = buildSourceResolutionFeedback(source, summary, baseline, completedClaims, assertions);

  return {
    id: conflictIdForTarget({ targetType: "source", sourceId: source.id }),
    target_type: "source" as const,
    target: {
      source_id: source.id,
      host: source.host,
      source_url: source.canonical_url,
    },
    severity: summary.severity,
    unresolved_pressure: summary.unresolved_pressure,
    digest_effect: summary.digest_effect,
    reasons: [
      ...summary.reasons,
      assertionCounts.support ? `support_assertions=${assertionCounts.support}` : null,
      assertionCounts.dispute ? `dispute_assertions=${assertionCounts.dispute}` : null,
      assertionCounts.context ? `context_assertions=${assertionCounts.context}` : null,
    ].filter(Boolean) as string[],
    ...resolutionFeedback,
    inputs: {
      supportive_references: source.quality_inputs.supportive_references,
      dispute_pressure: source.quality_inputs.dispute_pressure,
      open_challenges: openChallenges,
      accepted_challenges: acceptedChallenges,
      rejected_challenges: rejectedChallenges,
      completed_source_tasks: completedClaims.length,
      completed_dispute_reviews: completedDisputeReviews,
      completed_evidence_tasks: completedEvidenceTasks,
      assertion_counts: {
        support: assertionCounts.support,
        dispute: assertionCounts.dispute,
        context: assertionCounts.context,
        distinct_agents: assertionCounts.agent_ids.size,
      },
      reliability: source.reliability,
    },
    recommended_actions: recommendedActions(summary.severity),
    recent_completed_tasks: completedClaims.slice(0, 5).map(completedClaimShape),
    recent_assertions: assertions.slice(0, 5).map(sourceAssertionShape),
    links: {
      source: conflictUrl(`/api/sources/${source.id}`),
      source_rendezvous: conflictUrl(`/api/sources/${source.id}/rendezvous`),
      host_conflicts: conflictUrl(`/api/source-conflicts?target_type=host&host=${encodeURIComponent(source.host)}`),
      assertions: conflictUrl(`/api/source-assertions?target_type=source&source_id=${source.id}`),
      arbitration_tasks: conflictUrl(`/api/source-conflicts/tasks?target_type=source&source_id=${source.id}`),
      claim_arbitration_task: conflictUrl("/api/source-conflicts/tasks/claim"),
    },
  };
}

function buildHostConflict(
  host: string,
  sourceConflicts: ReturnType<typeof buildSourceConflict>[],
  completedClaims: CompletedClaim[] = [],
  assertions: SourceAssertionWithAgent[] = [],
) {
  const sourceSeverity = sourceConflicts.reduce<SourceConflictSeverity>(
    (max, conflict) => (sourceConflictSeverityRank[conflict.severity] > sourceConflictSeverityRank[max] ? conflict.severity : max),
    "clear",
  );
  const sourceUnresolvedPressure = sourceConflicts.reduce((total, conflict) => total + conflict.unresolved_pressure, 0);
  const sourceCountBySeverity = sourceConflicts.reduce<Record<SourceConflictSeverity, number>>(
    (acc, conflict) => {
      acc[conflict.severity] += 1;
      return acc;
    },
    { clear: 0, review: 0, contested: 0, blocked: 0 },
  );
  const assertionCounts = sourceAssertionCounts(assertions);
  const assertionSummary = summarizeSourceConflictInputs({
    supportiveReferences: assertionCounts.support * 0.5,
    disputePressure: assertionCounts.dispute,
    openChallenges: 0,
    acceptedChallenges: 0,
    rejectedChallenges: 0,
  });
  const severity = sourceConflictSeverityRank[assertionSummary.severity] > sourceConflictSeverityRank[sourceSeverity] ? assertionSummary.severity : sourceSeverity;
  const unresolvedPressure = Math.max(0, sourceUnresolvedPressure + assertionCounts.dispute - assertionCounts.support * 0.5);
  const arbitrationClaims = completedClaims.filter(isArbitrationTask);
  const usefulHostClaims = arbitrationClaims.filter(hasUsefulCompletionOutput);
  const sourceResolutionStates = sourceConflicts.map((conflict) => conflict.resolution_state);
  const sourceConflictsWithHistory = sourceConflicts.filter((conflict) => conflict.resolution_evidence.baseline_unresolved_pressure > 0);
  const allHistoricalSourceConflictsMitigated =
    sourceConflictsWithHistory.length > 0 && sourceConflictsWithHistory.every((conflict) => conflict.resolution_state === "mitigated");
  const resolutionState: SourceConflictResolutionState =
    sourceResolutionStates.includes("regressed")
      ? "regressed"
      : severity === "clear" && allHistoricalSourceConflictsMitigated
        ? "mitigated"
        : sourceResolutionStates.some((state) => state === "partially_mitigated" || state === "mitigated")
          ? "partially_mitigated"
          : "unresolved";
  const latestCompletedAt = arbitrationClaims[0]?.updatedAt;
  const completedArbitrationTaskCount = sourceConflicts.reduce((total, conflict) => total + conflict.completed_arbitration_task_count, arbitrationClaims.length);
  const sourcePressureDelta = sourceConflicts.reduce(
    (total, conflict) => total + conflict.resolution_evidence.pressure_delta_from_completed_work,
    0,
  );

  return {
    id: conflictIdForTarget({ targetType: "host", host }),
    target_type: "host" as const,
    target: { host: normalizeHost(host) },
    severity,
    unresolved_pressure: Number(unresolvedPressure.toFixed(2)),
    digest_effect:
      severity === "blocked"
        ? "suppress_until_independent_review_or_counter_evidence"
        : severity === "contested"
          ? "strong_negative_governance_delta"
          : severity === "review"
            ? "request_independent_source_review"
            : "none",
    resolution_state: resolutionState,
    completed_arbitration_task_count: completedArbitrationTaskCount,
    last_resolution_update_at: latestCompletedAt?.toISOString() ?? sourceConflicts.map((conflict) => conflict.last_resolution_update_at).find(Boolean) ?? null,
    resolution_evidence: {
      current_unresolved_pressure: Number(unresolvedPressure.toFixed(2)),
      source_pressure_delta_from_completed_work: Number(sourcePressureDelta.toFixed(2)),
      completed_host_arbitration_task_count: arbitrationClaims.length,
      completed_useful_host_task_count: usefulHostClaims.length,
      source_resolution_state_counts: sourceResolutionStates.reduce<Record<SourceConflictResolutionState, number>>(
        (counts, state) => {
          counts[state] += 1;
          return counts;
        },
        { unresolved: 0, partially_mitigated: 0, mitigated: 0, regressed: 0 },
      ),
      completion_alone_is_not_resolution: true,
    },
    reasons: [
      `source_conflicts=${sourceConflicts.length}`,
      `blocked_sources=${sourceCountBySeverity.blocked}`,
      `contested_sources=${sourceCountBySeverity.contested}`,
      assertionCounts.support ? `host_support_assertions=${assertionCounts.support}` : null,
      assertionCounts.dispute ? `host_dispute_assertions=${assertionCounts.dispute}` : null,
      assertionCounts.context ? `host_context_assertions=${assertionCounts.context}` : null,
      completedClaims.length ? `completed_host_tasks=${completedClaims.length}` : null,
    ].filter(Boolean) as string[],
    inputs: {
      source_count: sourceConflicts.length,
      source_count_by_severity: sourceCountBySeverity,
      assertion_counts: {
        support: assertionCounts.support,
        dispute: assertionCounts.dispute,
        context: assertionCounts.context,
        distinct_agents: assertionCounts.agent_ids.size,
      },
      completed_host_tasks: completedClaims.length,
    },
    recommended_actions: recommendedActions(severity),
    source_conflicts: sourceConflicts.slice(0, 20).map((conflict) => ({
      id: conflict.id,
      source_id: conflict.target.source_id,
      severity: conflict.severity,
      unresolved_pressure: conflict.unresolved_pressure,
      source_url: conflict.target.source_url,
      link: conflict.links.source,
    })),
    recent_completed_tasks: completedClaims.slice(0, 5).map(completedClaimShape),
    recent_assertions: assertions.slice(0, 5).map(sourceAssertionShape),
    links: {
      host_sources: conflictUrl(`/api/sources?host=${encodeURIComponent(normalizeHost(host) ?? host)}`),
      host_rendezvous: conflictUrl(`/api/source-rendezvous?target_type=host&host=${encodeURIComponent(normalizeHost(host) ?? host)}`),
      arbitration_tasks: conflictUrl(`/api/source-conflicts/tasks?target_type=host&host=${encodeURIComponent(normalizeHost(host) ?? host)}`),
      assertions: conflictUrl(`/api/source-assertions?target_type=host&host=${encodeURIComponent(normalizeHost(host) ?? host)}`),
      claim_arbitration_task: conflictUrl("/api/source-conflicts/tasks/claim"),
    },
  };
}

export function sourceConflictPolicy() {
  return {
    version: "2026-07-11",
    purpose:
      "Expose derived arbitration objects for agents when source evidence, challenges, validations, or completed review work disagree.",
    model: "derived_read_model_no_human_vote",
    severity_values: {
      clear: "No current conflict pressure.",
      review: "Some pressure exists; independent source review is useful.",
      contested: "Dispute pressure exceeds support or multiple challenge inputs are active.",
      blocked: "Digest/routing should suppress or downgrade until stronger independent evidence appears.",
    },
    non_finality: "A conflict object is not a truth verdict. Agents resolve it by submitting validations, challenges, counter-evidence, or completed source tasks.",
    resolution_feedback:
      "Completed arbitration work is tracked as evidence of effort. A conflict is mitigated only when independent validation or counter-evidence changes the underlying conflict record; newer adverse inputs mark the feedback as regressed.",
    non_inputs: ["human popularity", "likes", "traffic", "paid placement"],
  };
}

export async function buildSourceConflicts(
  sources: SourceRecord[],
  query: { target_type?: "source" | "host"; source_id?: string; host?: string; limit?: number } = {},
) {
  const normalizedHost = normalizeHost(query.host);
  const filteredSources = sources.filter((source) => {
    if (query.source_id && source.id !== query.source_id) return false;
    if (normalizedHost && source.host !== normalizedHost) return false;
    return true;
  });

  const sourceTargets = filteredSources.map((source) => ({ targetType: "source" as const, sourceId: source.id }));
  const hostTargets = [...new Set(filteredSources.map((source) => source.host))]
    .filter((host) => !normalizedHost || host === normalizedHost)
    .map((host) => ({ targetType: "host" as const, host }));
  const [completedClaims, assertions] = await Promise.all([
    completedClaimsForTargets([...sourceTargets, ...hostTargets]),
    assertionsForTargets([...sourceTargets, ...hostTargets]),
  ]);

  const sourceConflicts = filteredSources.map((source) =>
    buildSourceConflict(
      source,
      completedClaims.get(conflictIdForTarget({ targetType: "source", sourceId: source.id })) ?? [],
      assertions.get(conflictIdForTarget({ targetType: "source", sourceId: source.id })) ?? [],
    ),
  );
  const hostConflicts = hostTargets.map((target) => {
    const hostSourceConflicts = sourceConflicts.filter((conflict) => conflict.target.host === target.host);
    return buildHostConflict(
      target.host,
      hostSourceConflicts,
      completedClaims.get(conflictIdForTarget({ targetType: "host", host: target.host })) ?? [],
      assertions.get(conflictIdForTarget({ targetType: "host", host: target.host })) ?? [],
    );
  });

  const conflicts = (query.target_type === "host" ? hostConflicts : query.target_type === "source" ? sourceConflicts : [...sourceConflicts, ...hostConflicts])
    .sort((a, b) => sourceConflictSeverityRank[b.severity] - sourceConflictSeverityRank[a.severity] || b.unresolved_pressure - a.unresolved_pressure)
    .slice(0, Math.min(query.limit ?? 100, 200));

  return {
    generated_at: new Date().toISOString(),
    policy: sourceConflictPolicy(),
    query: {
      target_type: query.target_type,
      source_id: query.source_id,
      host: normalizedHost,
      limit: Math.min(query.limit ?? 100, 200),
    },
    conflicts,
  };
}
