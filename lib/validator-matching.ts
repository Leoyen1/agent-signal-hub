import type { Agent, Signal, Validation } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { jsonArray } from "@/lib/serializers";
import { buildSignalSourceIntelligence } from "@/lib/sources";
import type { SignalSourceIntelligence } from "@/lib/sources";

type AgentForMatch = Agent & {
  validations?: Pick<Validation, "signalId" | "verdict">[];
  _count?: {
    signals: number;
    validations: number;
  };
};

type SignalForMatch = Signal;

function normalizeTokens(values: Array<string | null | undefined>) {
  const stop = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "agent", "agents", "signal", "signals"]);
  return new Set(
    values
      .flatMap((value) => (value ?? "").toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/))
      .map((token) => token.trim())
      .filter((token) => token.length >= 2 && !stop.has(token)),
  );
}

function overlap(a: Set<string>, b: Set<string>) {
  let count = 0;
  for (const token of a) {
    if (b.has(token)) count += 1;
  }
  return count;
}

function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

export function matchAgentToSignal(agent: AgentForMatch, signal: SignalForMatch, sourceIntelligence?: SignalSourceIntelligence | null) {
  const focusAreas = jsonArray(agent.focusAreas);
  const capabilities = jsonArray(agent.capabilities);
  const limitations = jsonArray(agent.limitations);
  const whoCares = jsonArray(signal.whoCares);

  const signalTokens = normalizeTokens([
    signal.title,
    signal.category,
    signal.summary,
    signal.evidence,
    signal.whyItMatters,
    signal.opportunity,
    signal.risk,
    ...whoCares,
  ]);
  const focusTokens = normalizeTokens(focusAreas);
  const capabilityTokens = normalizeTokens([agent.name, agent.description, agent.agentType, ...capabilities]);
  const limitationTokens = normalizeTokens(limitations);

  const focusOverlap = overlap(signalTokens, focusTokens);
  const capabilityOverlap = overlap(signalTokens, capabilityTokens);
  const limitationOverlap = overlap(signalTokens, limitationTokens);
  const exactCategoryMatch = focusAreas.some((area) => area.toLowerCase() === signal.category.toLowerCase());
  const declaredVerifier = [...capabilities, agent.name, agent.description, agent.agentType].some((value) =>
    /validat|verif|source|audit|research|fact|evidence/i.test(value),
  );
  const researchOrTechnical = agent.agentType === "research" || agent.agentType === "technical";
  const alreadyValidated = Boolean(agent.validations?.some((validation) => validation.signalId === signal.id));
  const isSubmitter = agent.id === signal.submittedByAgentId;
  const sourceReviewPressure =
    sourceIntelligence?.digest_safety === "source_contested"
      ? 18
      : sourceIntelligence?.digest_safety === "needs_source_review"
        ? 10
        : 0;
  const sourceAuditBonus = sourceReviewPressure && declaredVerifier ? sourceReviewPressure : sourceReviewPressure && researchOrTechnical ? sourceReviewPressure * 0.6 : 0;

  const trustBonus = agent.trustLevel === "trusted" ? 12 : agent.trustLevel === "low" ? -10 : 0;
  const reputationBonus = (agent.reputationScore - 50) / 3;
  const validationExperience = Math.min(agent._count?.validations ?? agent.validations?.length ?? 0, 20) * 1.25;
  const signalExperience = Math.min(agent._count?.signals ?? 0, 20) * 0.5;
  const rawScore =
    25 +
    (exactCategoryMatch ? 18 : 0) +
    (declaredVerifier ? 16 : 0) +
    (researchOrTechnical ? 6 : 0) +
    Math.min(focusOverlap * 8, 24) +
    Math.min(capabilityOverlap * 5, 20) +
    validationExperience +
    signalExperience +
    sourceAuditBonus +
    trustBonus +
    reputationBonus -
    Math.min(limitationOverlap * 10, 25) -
    (alreadyValidated ? 20 : 0) -
    (isSubmitter ? 45 : 0);

  const reasons = [
    `trust_level=${agent.trustLevel}`,
    `reputation=${agent.reputationScore}`,
    `focus_overlap=${focusOverlap}`,
    `capability_overlap=${capabilityOverlap}`,
    `validation_count=${agent._count?.validations ?? agent.validations?.length ?? 0}`,
  ];
  if (exactCategoryMatch) reasons.push("exact_category_focus_match=true");
  if (declaredVerifier) reasons.push("declared_verification_capability=true");
  if (researchOrTechnical) reasons.push("research_or_technical_agent=true");
  if (limitationOverlap) reasons.push(`limitation_overlap=${limitationOverlap}`);
  if (alreadyValidated) reasons.push("already_validated=true");
  if (isSubmitter) reasons.push("is_submitter=true");
  if (sourceIntelligence) {
    reasons.push(`source_digest_safety=${sourceIntelligence.digest_safety}`);
    reasons.push(`source_dispute_pressure=${sourceIntelligence.dispute_pressure}`);
    if (sourceAuditBonus) reasons.push(`source_audit_bonus=${sourceAuditBonus}`);
  }

  const score = clamp(rawScore);
  const recommendedVerdicts =
    sourceIntelligence?.digest_safety === "source_contested" && score >= 45
      ? ["dispute", "add_context", "support"]
      : sourceIntelligence?.digest_safety === "needs_source_review" && score >= 45
        ? ["add_context", "support", "dispute"]
        : score >= 70
      ? ["support", "dispute", "add_context"]
      : score >= 45
        ? ["add_context", "mark_duplicate", "mark_expired"]
        : ["mark_low_quality_if_applicable"];

  return {
    agent_id: agent.id,
    agent_name: agent.name,
    score: Number(score.toFixed(2)),
    fit: score >= 70 ? "strong" : score >= 45 ? "partial" : "weak",
    should_validate: score >= 45 && !isSubmitter && !alreadyValidated,
    recommended_verdicts: recommendedVerdicts,
    reasons,
    links: {
      agent_card: `/api/agents/${agent.id}/card`,
      validations: `/api/agents/${agent.id}/validations`,
    },
  };
}

export async function recommendedValidatorsForSignal(signalId: string, limit = 10) {
  const signal = await prisma.signal.findUnique({ where: { id: signalId } });
  if (!signal) return null;

  const [agents, sourceIntelligence] = await Promise.all([
    prisma.agent.findMany({
    include: {
      validations: { select: { signalId: true, verdict: true } },
      _count: { select: { signals: true, validations: true } },
    },
    orderBy: [{ reputationScore: "desc" }, { createdAt: "asc" }],
    }),
    buildSignalSourceIntelligence(signalId),
  ]);

  const matches = agents
    .map((agent) => matchAgentToSignal(agent, signal, sourceIntelligence))
    .sort((a, b) => Number(b.should_validate) - Number(a.should_validate) || b.score - a.score)
    .slice(0, limit);

  return {
    signal: {
      id: signal.id,
      title: signal.title,
      category: signal.category,
      submitted_by_agent_id: signal.submittedByAgentId,
    },
    source_intelligence: sourceIntelligence,
    policy: validatorMatchingPolicy(),
    recommended_validators: matches,
  };
}

export function validatorMatchingPolicy() {
  return {
    version: "2026-07-10",
    purpose: "Recommend agents that are likely to validate a signal well, without using human popularity or engagement.",
    ranking_inputs: [
      "focus area overlap",
      "declared capability overlap",
      "signal category match",
      "agent reputation",
      "agent trust level",
      "validation experience",
      "declared limitation overlap",
      "whether the agent submitted the signal",
      "whether the agent already validated the signal",
      "source registry dispute pressure",
      "declared source/audit/research capability when sources are contested",
    ],
    non_inputs: ["likes", "followers", "human popularity", "paid placement"],
    submitter_policy: "The submitting agent is strongly penalized and should not validate its own signal.",
    already_validated_policy: "Agents that already validated the signal are deprioritized for additional validation.",
  };
}
