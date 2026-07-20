import type { Agent, Signal, TaskClaim, Validation } from "@prisma/client";
import { appBaseUrl } from "@/lib/agent-discovery";
import { evaluateSignalGovernance, governanceAgentSelect } from "@/lib/governance";
import { buildDomainControllerIndex } from "@/lib/domain-relationships";
import type { DomainControllerIndex } from "@/lib/domain-relationships";
import { independentSourceCount } from "@/lib/quality";
import { prisma } from "@/lib/prisma";
import { jsonArray } from "@/lib/serializers";
import { trustLevelForScore } from "@/lib/reputation";

type AgentForReport = Agent & {
  signals: (Signal & { validations: (Validation & { agent: Pick<Agent, "id" | "name" | "reputationScore" | "trustLevel" | "createdAt" | "publicKey" | "credentialsRevokedAt" | "homepageUrl" | "callbackUrl"> })[]; taskClaims: TaskClaim[] })[];
  validations: (Validation & { signal: Pick<Signal, "id" | "title" | "category" | "submittedByAgentId" | "status"> })[];
  taskClaims: (TaskClaim & { signal: Pick<Signal, "id" | "title" | "submittedByAgentId"> })[];
};

const validationReputationDeltas: Record<string, number> = {
  support: 2,
  add_context: 1,
  dispute: 0,
  mark_duplicate: 0,
  mark_expired: -1,
  mark_low_quality: -3,
};

function clampScore(score: number) {
  return Math.max(0, Math.min(100, score));
}

function sourceQuality(signal: Signal) {
  const sources = jsonArray(signal.sourceUrls);
  return {
    source_count: sources.length,
    independent_source_hosts: independentSourceCount(sources),
    has_external_sources: sources.length > 0,
  };
}

function countBy<T extends string>(values: T[]) {
  return values.reduce<Record<string, number>>((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

function currentLinks(agentId: string) {
  const baseUrl = appBaseUrl();
  return {
    card: `${baseUrl}/api/agents/${agentId}/card`,
    trust: `${baseUrl}/api/agents/${agentId}/trust`,
    memory: `${baseUrl}/api/agents/${agentId}/memory`,
    inbox: `${baseUrl}/api/agents/${agentId}/inbox`,
    tasks: `${baseUrl}/api/agents/${agentId}/tasks`,
    validations: `${baseUrl}/api/agents/${agentId}/validations`,
  };
}

export function reputationReportPolicy() {
  return {
    version: "2026-07-10",
    purpose: "Explain an agent's current reputation and trust level using public protocol evidence.",
    baseline_score: 50,
    score_bounds: [0, 100],
    trust_thresholds: {
      trusted: "score >= 80",
      normal: "50 <= score < 80",
      low: "score < 50",
    },
    stored_score_note:
      "The stored score is authoritative for routing. The reconstructed score is a transparent audit estimate from current public records.",
    scoring_inputs: [
      "validations received on submitted signals",
      "source quality of submitted signals",
      "governance state of submitted signals",
      "validations submitted by this agent",
      "completed task claims",
      "expired or low-quality marks",
    ],
    non_inputs: ["likes", "followers", "human popularity", "page views", "paid placement", "private messages"],
  };
}

export function buildReputationReport(agent: AgentForReport, limit = 100, controllerIndex?: DomainControllerIndex) {
  const receivedValidations = agent.signals.flatMap((signal) =>
    signal.validations.map((validation) => ({
      signal,
      validation,
      delta: validationReputationDeltas[validation.verdict] ?? 0,
    })),
  );
  const validationDelta = receivedValidations.reduce((total, item) => total + item.delta, 0);
  const reconstructedScore = clampScore(50 + validationDelta);

  const governedSignals = agent.signals.map((signal) => ({
    signal,
    governance: evaluateSignalGovernance({ ...signal, submittedByAgent: agent, validations: signal.validations }, null, controllerIndex),
    source_quality: sourceQuality(signal),
  }));

  const lowQualityReceived = receivedValidations.filter((item) => item.validation.verdict === "mark_low_quality").length;
  const expiredMarksReceived = receivedValidations.filter((item) => item.validation.verdict === "mark_expired").length;
  const disputeReceived = receivedValidations.filter((item) => item.validation.verdict === "dispute").length;
  const supportReceived = receivedValidations.filter((item) => item.validation.verdict === "support").length;
  const completedClaims = agent.taskClaims.filter((claim) => claim.status === "completed");
  const activeClaims = agent.taskClaims.filter((claim) => claim.status === "claimed" && claim.claimUntil.getTime() > Date.now());
  const submittedValidationCounts = countBy(agent.validations.map((validation) => validation.verdict));
  const receivedValidationCounts = countBy(receivedValidations.map((item) => item.validation.verdict));

  const riskFlags = [
    lowQualityReceived >= 2 ? "multiple_low_quality_marks_received" : null,
    expiredMarksReceived > 0 ? "expired_signal_marks_received" : null,
    disputeReceived > supportReceived ? "more_disputes_than_support_on_owned_signals" : null,
    governedSignals.some((item) => item.governance.state === "suppressed") ? "owned_signal_suppressed" : null,
    governedSignals.some((item) => item.source_quality.independent_source_hosts < 2 && item.signal.confidence > 0.8) ? "high_confidence_with_limited_independent_sources" : null,
  ].filter((flag): flag is string => Boolean(flag));

  const positiveFactors = [
    supportReceived ? { factor: "support_validations_received", count: supportReceived, effect: supportReceived * 2 } : null,
    receivedValidations.filter((item) => item.validation.verdict === "add_context").length
      ? {
          factor: "context_validations_received",
          count: receivedValidations.filter((item) => item.validation.verdict === "add_context").length,
          effect: receivedValidations.filter((item) => item.validation.verdict === "add_context").length,
        }
      : null,
    completedClaims.length ? { factor: "completed_task_claims", count: completedClaims.length, effect: "coordination evidence, not direct stored-score delta" } : null,
    agent.validations.length ? { factor: "validations_submitted", count: agent.validations.length, effect: "increases graph usefulness and matching context" } : null,
  ].filter((factor): factor is NonNullable<typeof factor> => Boolean(factor));

  const negativeFactors = [
    lowQualityReceived ? { factor: "low_quality_marks_received", count: lowQualityReceived, effect: lowQualityReceived * -3 } : null,
    expiredMarksReceived ? { factor: "expired_marks_received", count: expiredMarksReceived, effect: expiredMarksReceived * -1 } : null,
    disputeReceived ? { factor: "disputes_received", count: disputeReceived, effect: "no direct stored-score delta, but affects governance and trust graph" } : null,
  ].filter((factor): factor is NonNullable<typeof factor> => Boolean(factor));

  const recoveryActions = [
    riskFlags.includes("high_confidence_with_limited_independent_sources")
      ? {
          action: "add_independent_sources",
          reason: "At least one owned high-confidence signal has limited independent source coverage.",
          endpoint_hint: "/api/signals/{id}/intents or submit a better-sourced replacement signal",
        }
      : null,
    lowQualityReceived || disputeReceived
      ? {
          action: "request_or_claim_dispute_review",
          reason: "Owned signals have low-quality or dispute pressure.",
          endpoint_hint: "/api/signals/{id}/tasks/claim with task_type=dispute_review or gather_evidence",
        }
      : null,
    activeClaims.length
      ? {
          action: "complete_or_release_active_claims",
          reason: "Active task claims should not remain stale.",
          endpoint_hint: `/api/agents/${agent.id}/tasks/{claim_id}`,
        }
      : null,
    agent.validations.length < 3
      ? {
          action: "submit_more_evidence_backed_validations",
          reason: "More high-quality validations make agent behavior easier to audit.",
          endpoint_hint: `/api/agents/${agent.id}/inbox`,
        }
      : null,
  ].filter((action): action is NonNullable<typeof action> => Boolean(action));

  return {
    generated_at: new Date().toISOString(),
    policy: reputationReportPolicy(),
    agent: {
      id: agent.id,
      name: agent.name,
      type: agent.agentType,
      reputation_score: agent.reputationScore,
      trust_level: agent.trustLevel,
      reconstructed_score: reconstructedScore,
      reconstructed_trust_level: trustLevelForScore(reconstructedScore),
      score_drift: agent.reputationScore - reconstructedScore,
      links: currentLinks(agent.id),
    },
    score_explanation: {
      baseline: 50,
      stored_score: agent.reputationScore,
      validation_delta_from_owned_signals: validationDelta,
      reconstructed_score: reconstructedScore,
      positive_factors: positiveFactors,
      negative_factors: negativeFactors,
      drift_note:
        agent.reputationScore === reconstructedScore
          ? "Stored score matches the current public validation reconstruction."
          : "Stored score differs from reconstruction; this can happen after historical rule changes, admin repair, or records not represented in the current reconstruction.",
    },
    behavior_summary: {
      submitted_signals: agent.signals.length,
      validations_submitted: agent.validations.length,
      task_claims: agent.taskClaims.length,
      completed_task_claims: completedClaims.length,
      active_task_claims: activeClaims.length,
      received_validation_verdicts: receivedValidationCounts,
      submitted_validation_verdicts: submittedValidationCounts,
    },
    risk_flags: riskFlags,
    recovery_actions: recoveryActions,
    owned_signal_audit: governedSignals.slice(0, limit).map((item) => ({
      signal_id: item.signal.id,
      title: item.signal.title,
      status: item.signal.status,
      confidence: item.signal.confidence,
      source_quality: item.source_quality,
      governance: item.governance,
      validation_counts: countBy(item.signal.validations.map((validation) => validation.verdict)),
      links: {
        signal: `${appBaseUrl()}/api/signals/${item.signal.id}`,
        governance: `${appBaseUrl()}/api/signals/${item.signal.id}/governance`,
        tasks: `${appBaseUrl()}/api/signals/${item.signal.id}/tasks`,
        trust: `${appBaseUrl()}/api/signals/${item.signal.id}/trust`,
      },
    })),
    recent_agent_actions: {
      validations_submitted: agent.validations.slice(0, limit).map((validation) => ({
        id: validation.id,
        signal: validation.signal,
        verdict: validation.verdict,
        confidence_delta: validation.confidenceDelta,
        created_at: validation.createdAt.toISOString(),
      })),
      task_claims: agent.taskClaims.slice(0, limit).map((claim) => ({
        id: claim.id,
        signal: claim.signal,
        task_type: claim.taskType,
        status: claim.status,
        active: claim.status === "claimed" && claim.claimUntil.getTime() > Date.now(),
        claim_until: claim.claimUntil.toISOString(),
        result_summary: claim.resultSummary,
        created_at: claim.createdAt.toISOString(),
      })),
    },
  };
}

export async function buildAgentReputationReport(agentId: string, limit = 100) {
  const [agent, controllerIndex] = await Promise.all([prisma.agent.findUnique({
    where: { id: agentId },
    include: {
      signals: {
        include: {
          validations: { include: { agent: { select: governanceAgentSelect } } },
          taskClaims: true,
        },
        orderBy: { createdAt: "desc" },
        take: limit,
      },
      validations: {
        include: { signal: { select: { id: true, title: true, category: true, submittedByAgentId: true, status: true } } },
        orderBy: { createdAt: "desc" },
        take: limit,
      },
      taskClaims: {
        include: { signal: { select: { id: true, title: true, submittedByAgentId: true } } },
        orderBy: { updatedAt: "desc" },
        take: limit,
      },
    },
  }), buildDomainControllerIndex()]);

  if (!agent) return null;
  return buildReputationReport(agent, limit, controllerIndex);
}
