import type { Agent, AgentInfrastructureClaim, Prisma, Signal, Validation } from "@prisma/client";
import { independentSourceCount, sourceRegistrableDomains } from "@/lib/quality";
import { prisma } from "@/lib/prisma";
import { jsonArray } from "@/lib/serializers";
import { validatorHasGovernanceAuthority } from "@/lib/validator-authority";
import { isBootstrapValidator } from "@/lib/bootstrap";
import { infrastructureClaimIsActive } from "@/lib/infrastructure-proof";
import { buildSourceIntelligenceIndex, buildSignalSourceIntelligence } from "@/lib/sources";
import type { SignalSourceIntelligence } from "@/lib/sources";
import { buildDomainControllerIndex } from "@/lib/domain-relationships";
import type { DomainControllerIndex } from "@/lib/domain-relationships";

export const governanceAgentSelect = {
  id: true,
  name: true,
  reputationScore: true,
  trustLevel: true,
  createdAt: true,
  publicKey: true,
  credentialsRevokedAt: true,
  homepageUrl: true,
  callbackUrl: true,
  infrastructureClaims: {
    select: {
      id: true,
      target: true,
      registrableDomain: true,
      publicKeyFingerprint: true,
      status: true,
      verifiedAt: true,
      expiresAt: true,
    },
  },
} satisfies Prisma.AgentSelect;

type GovernanceInfrastructureClaim = Pick<
  AgentInfrastructureClaim,
  "id" | "target" | "registrableDomain" | "publicKeyFingerprint" | "status" | "verifiedAt" | "expiresAt"
>;

type ValidationWithAgent = Validation & {
  agent?: (Pick<Agent, "id" | "name" | "reputationScore" | "trustLevel"> &
    Partial<Pick<Agent, "createdAt" | "publicKey" | "credentialsRevokedAt" | "homepageUrl" | "callbackUrl">> & {
      infrastructureClaims?: GovernanceInfrastructureClaim[];
    }) | null;
};

export type GovernedSignal = Signal & {
  submittedByAgent?: Pick<Agent, "id" | "name" | "reputationScore" | "trustLevel"> | null;
  validations: ValidationWithAgent[];
};

export type GovernanceState = "digest_candidate" | "observable" | "suppressed" | "excluded";

const urgencyWeight = {
  high: 10,
  medium: 5,
  low: 2,
};

function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function validatorWeight(validation: ValidationWithAgent) {
  const reputation = validation.agent?.reputationScore ?? 0;
  const trust = validation.agent?.trustLevel ?? "low";
  const trustWeight = trust === "trusted" ? 1.25 : trust === "low" ? 0.65 : 1;
  return clamp(reputation / 50, 0.5, 1.5) * trustWeight;
}

function weightedCount(validations: ValidationWithAgent[], verdict: string) {
  return validations
    .filter((validation) => validation.verdict === verdict && validatorHasGovernanceAuthority(validation.agent))
    .reduce((total, validation) => total + validatorWeight(validation), 0);
}

function distinctAgentCount(validations: ValidationWithAgent[], verdict: string) {
  return new Set(validations.filter((validation) => validation.verdict === verdict && validatorHasGovernanceAuthority(validation.agent)).map((validation) => validation.agentId)).size;
}

function validatorIsMature(validation: ValidationWithAgent) {
  if (validatorHasGovernanceAuthority(validation.agent)) return true;
  const configuredCooldown = Number(process.env.DIGEST_VALIDATOR_COOLDOWN_MINUTES ?? 60);
  const cooldownMinutes = Number.isFinite(configuredCooldown) ? Math.max(0, configuredCooldown) : 60;
  return Boolean(validation.agent?.createdAt && Date.now() - validation.agent.createdAt.getTime() >= cooldownMinutes * 60_000);
}

function validatorIsEstablished(validation: ValidationWithAgent) {
  return validatorHasGovernanceAuthority(validation.agent);
}
function declaredInfrastructureDomains(validation: ValidationWithAgent) {
  return sourceRegistrableDomains(
    [validation.agent?.homepageUrl, validation.agent?.callbackUrl].filter((url): url is string => Boolean(url)),
  );
}

function verifiedInfrastructureDomains(validation: ValidationWithAgent) {
  return new Set(
    (validation.agent?.infrastructureClaims ?? [])
      .filter((claim) => infrastructureClaimIsActive(claim, validation.agent?.publicKey))
      .map((claim) => claim.registrableDomain),
  );
}

function verifiedInfrastructureRequired() {
  const configured = process.env.DIGEST_REQUIRE_VERIFIED_INFRASTRUCTURE;
  return configured ? configured === "true" : process.env.NODE_ENV === "production";
}

function validatorInfrastructureEligible(validation: ValidationWithAgent) {
  if (validation.agent?.publicKey && isBootstrapValidator(validation.agent.publicKey)) return true;
  return !verifiedInfrastructureRequired() || verifiedInfrastructureDomains(validation).size > 0;
}

function effectiveInfrastructureDomains(validation: ValidationWithAgent) {
  const verified = verifiedInfrastructureDomains(validation);
  return verified.size
    ? { domains: verified, basis: "verified_control" as const }
    : { domains: declaredInfrastructureDomains(validation), basis: "declared_overlap_fallback" as const };
}

function independentEvidenceBackedSupport(validations: ValidationWithAgent[], signalOwnerId: string, signalSourceUrls: string[], controllerIndex?: DomainControllerIndex) {
  const signalDomains = sourceRegistrableDomains(signalSourceUrls);
  const signalHosts = controllerIndex ? controllerIndex.collapseDomains(signalDomains) : signalDomains;
  const countedEvidenceHosts = new Set<string>();
  const countedAgents = new Set<string>();
  const countedValidators: { agentId: string; infrastructureDomains: Set<string>; controllerGroups: Set<string>; basis: "verified_control" | "declared_overlap_fallback" }[] = [];
  const unverifiedInfrastructureAgents = new Set<string>();
  const quarantinedEvidenceAgents = new Set<string>();
  const quarantinedInfrastructureAgents = new Set<string>();
  const infrastructureConflicts: { counted_agent_id: string; rejected_agent_id: string; shared_registrable_domains: string[]; shared_controller_groups: string[]; independence_basis: "verified_control" | "declared_overlap_fallback" }[] = [];

  for (const validation of [...validations].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))) {
    if (validation.verdict !== "support" || validation.agentId === signalOwnerId || !validatorIsMature(validation) || !validatorIsEstablished(validation)) continue;
    if (!validatorInfrastructureEligible(validation)) {
      unverifiedInfrastructureAgents.add(validation.agentId);
      continue;
    }
    const rawEvidenceHosts = sourceRegistrableDomains(jsonArray(validation.evidenceUrls));
    if (controllerIndex?.quarantinedDomainsFor(rawEvidenceHosts).length) {
      quarantinedEvidenceAgents.add(validation.agentId);
      continue;
    }
    const evidenceHosts = controllerIndex ? controllerIndex.collapseDomains(rawEvidenceHosts) : rawEvidenceHosts;
    const independentHosts = [...evidenceHosts].filter((host) => !signalHosts.has(host) && !countedEvidenceHosts.has(host));
    if (!independentHosts.length) continue;

    const infrastructure = effectiveInfrastructureDomains(validation);
    const infrastructureDomains = infrastructure.domains;
    if (controllerIndex?.quarantinedDomainsFor(infrastructureDomains).length) {
      quarantinedInfrastructureAgents.add(validation.agentId);
      continue;
    }
    const controllerGroups = controllerIndex ? controllerIndex.collapseDomains(infrastructureDomains) : infrastructureDomains;
    const conflicts = countedValidators
      .map((counted) => ({
        counted_agent_id: counted.agentId,
        rejected_agent_id: validation.agentId,
        shared_registrable_domains: [...infrastructureDomains].filter((domain) => counted.infrastructureDomains.has(domain)).sort(),
        shared_controller_groups: [...controllerGroups].filter((group) => counted.controllerGroups.has(group)).sort(),
        independence_basis: counted.basis === "verified_control" && infrastructure.basis === "verified_control" ? ("verified_control" as const) : ("declared_overlap_fallback" as const),
      }))
      .filter((conflict) => conflict.shared_controller_groups.length > 0);
    if (conflicts.length) {
      infrastructureConflicts.push(...conflicts);
      continue;
    }

    countedAgents.add(validation.agentId);
    countedValidators.push({ agentId: validation.agentId, infrastructureDomains, controllerGroups, basis: infrastructure.basis });
    for (const host of evidenceHosts) countedEvidenceHosts.add(host);
  }

  return {
    count: countedAgents.size,
    counted_validator_ids: [...countedAgents],
    counted_validator_infrastructure: countedValidators.map((validator) => ({
      agent_id: validator.agentId,
      registrable_domains: [...validator.infrastructureDomains].sort(),
      controller_groups: [...validator.controllerGroups].sort(),
      independence_basis: validator.basis,
    })),
    shared_declared_infrastructure_conflicts: infrastructureConflicts,
    unverified_infrastructure_validator_ids: [...unverifiedInfrastructureAgents],
    quarantined_evidence_validator_ids: [...quarantinedEvidenceAgents],
    quarantined_infrastructure_validator_ids: [...quarantinedInfrastructureAgents],
  };
}

export function evaluateSignalGovernance(signal: GovernedSignal, sourceIntelligence?: SignalSourceIntelligence | null, controllerIndex?: DomainControllerIndex) {
  const sources = jsonArray(signal.sourceUrls);
  const sourceDomains = sourceRegistrableDomains(sources);
  const quarantinedSourceDomains = controllerIndex?.quarantinedDomainsFor(sourceDomains) ?? [];
  const sourceHosts = independentSourceCount(sources, controllerIndex);
  const support = weightedCount(signal.validations, "support");
  const context = weightedCount(signal.validations, "add_context");
  const disputes = weightedCount(signal.validations, "dispute");
  const duplicates = weightedCount(signal.validations, "mark_duplicate");
  const expiredMarks = weightedCount(signal.validations, "mark_expired");
  const lowQuality = weightedCount(signal.validations, "mark_low_quality");
  const unestablishedValidationCount = signal.validations.filter((validation) => !validatorHasGovernanceAuthority(validation.agent)).length;
  const distinctLowQuality = new Set(signal.validations.filter((validation) => validation.verdict === "mark_low_quality" && validatorIsEstablished(validation)).map((validation) => validation.agentId)).size;
  const independentSupport = independentEvidenceBackedSupport(signal.validations, signal.submittedByAgentId, sources, controllerIndex);
  const independentSupportCount = independentSupport.count;
  const ownerReputation = signal.submittedByAgent?.reputationScore ?? 0;
  const isExpired = signal.expiresAt.getTime() <= Date.now() || signal.status === "expired";

  const sourceScore = Math.min(sources.length, 3) * 5 + Math.min(sourceHosts, 3) * 5;
  const validationScore = support * 8 + context * 4 - disputes * 10 - duplicates * 6 - expiredMarks * 16 - lowQuality * 18;
  const ownerScore = (ownerReputation - 50) / 4;
  const expiryPenalty = isExpired ? 30 : 0;
  const sourceIntelligenceDelta = sourceIntelligence?.score_delta ?? 0;
  const score = clamp(signal.confidence * 45 + sourceScore + urgencyWeight[signal.urgency] + validationScore + ownerScore + sourceIntelligenceDelta - expiryPenalty);

  const reasons: string[] = [
    `confidence=${signal.confidence.toFixed(2)}`,
    `sources=${sources.length}`,
    `registrable_source_domains=${sourceDomains.size}`,
    `independent_source_controller_groups=${sourceHosts}`,
    `submitter_reputation=${ownerReputation}`,
  ];

  if (support > 0) reasons.push(`support_weight=${support.toFixed(2)}`);
  reasons.push(`established_independent_evidence_backed_support=${independentSupportCount}`);
  if (independentSupport.shared_declared_infrastructure_conflicts.length > 0) {
    reasons.push(`shared_validator_infrastructure_conflicts=${independentSupport.shared_declared_infrastructure_conflicts.length}`);
  }
  if (independentSupport.unverified_infrastructure_validator_ids.length > 0) {
    reasons.push(`unverified_validator_infrastructure=${independentSupport.unverified_infrastructure_validator_ids.length}`);
  }
  if (unestablishedValidationCount > 0) reasons.push(`unestablished_validations_observable_only=${unestablishedValidationCount}`);
  if (context > 0) reasons.push(`context_weight=${context.toFixed(2)}`);
  if (disputes > 0) reasons.push(`dispute_weight=${disputes.toFixed(2)}`);
  if (duplicates > 0) reasons.push(`duplicate_weight=${duplicates.toFixed(2)}`);
  if (lowQuality > 0) reasons.push(`low_quality_weight=${lowQuality.toFixed(2)}`);
  if (sourceIntelligence) {
    reasons.push(`source_reliability_delta=${sourceIntelligence.score_delta}`);
    if (sourceIntelligence.reliability_counts.contested > 0) reasons.push(`contested_sources=${sourceIntelligence.reliability_counts.contested}`);
    if (sourceIntelligence.dispute_pressure > 0) reasons.push(`source_dispute_pressure=${sourceIntelligence.dispute_pressure}`);
    if (sourceIntelligence.source_conflict_count > 0) reasons.push(`source_conflicts=${sourceIntelligence.source_conflict_count}`);
    if (sourceIntelligence.source_conflict_pressure > 0) reasons.push(`source_conflict_pressure=${sourceIntelligence.source_conflict_pressure}`);
    if (sourceIntelligence.max_source_conflict_severity !== "clear") reasons.push(`max_source_conflict_severity=${sourceIntelligence.max_source_conflict_severity}`);
  }
  if (quarantinedSourceDomains.length) reasons.push(`quarantined_source_domains=${quarantinedSourceDomains.join(",")}`);
  if (independentSupport.quarantined_evidence_validator_ids.length) reasons.push(`quarantined_validation_evidence=${independentSupport.quarantined_evidence_validator_ids.length}`);
  if (independentSupport.quarantined_infrastructure_validator_ids.length) reasons.push(`quarantined_validator_infrastructure=${independentSupport.quarantined_infrastructure_validator_ids.length}`);
  if (isExpired) reasons.push("expired=true");

  let state: GovernanceState = "observable";
  let recommendedAction = "keep_observing";

  if (["archived", "spam", "expired"].includes(signal.status) || isExpired) {
    state = "excluded";
    recommendedAction = "exclude_from_digest";
  } else if (quarantinedSourceDomains.length) {
    state = "suppressed";
    recommendedAction = "resolve_domain_controller_quarantine_before_digest";
  } else if (sourceIntelligence?.digest_safety === "source_contested") {
    state = "suppressed";
    recommendedAction = "resolve_source_challenge_before_digest";
  } else if (distinctLowQuality >= 2 || score < 30) {
    state = "suppressed";
    recommendedAction = "request_more_evidence_or_counter_validation";
  } else if (sourceIntelligence?.digest_safety === "needs_source_review" && score >= 55) {
    state = "observable";
    recommendedAction = "seek_independent_source_review";
  } else if (signal.status === "active" && score >= 55 && independentSupportCount >= 2) {
    state = "digest_candidate";
    recommendedAction = "eligible_for_digest";
  } else if (signal.status === "active" && score >= 55) {
    state = "observable";
    recommendedAction = independentSupport.quarantined_evidence_validator_ids.length || independentSupport.quarantined_infrastructure_validator_ids.length
      ? "replace_quarantined_validation_or_infrastructure_evidence"
      : independentSupport.shared_declared_infrastructure_conflicts.length
      ? "seek_support_from_validator_with_independent_declared_infrastructure"
      : "seek_two_established_independent_evidence_backed_support_validations";
  } else if (signal.status === "disputed") {
    state = "observable";
    recommendedAction = "seek_independent_validation";
  }

  return {
    signal_id: signal.id,
    score: Number(score.toFixed(2)),
    state,
    recommended_action: recommendedAction,
    reasons,
    inputs: {
      confidence: signal.confidence,
      urgency: signal.urgency,
      status: signal.status,
      source_count: sources.length,
      independent_source_domains: sourceDomains.size,
      independent_source_controller_groups: sourceHosts,
      linked_source_domain_groups: controllerIndex?.linkedGroupsFor(sourceDomains) ?? [],
      quarantined_source_domains: quarantinedSourceDomains,
      validation_count: signal.validations.length,
      unestablished_validation_count: unestablishedValidationCount,
      established_independent_evidence_backed_support_count: independentSupportCount,
      counted_established_support_validator_ids: independentSupport.counted_validator_ids,
      counted_validator_declared_infrastructure: independentSupport.counted_validator_infrastructure,
      shared_validator_infrastructure_conflicts: independentSupport.shared_declared_infrastructure_conflicts,
      verified_infrastructure_required: verifiedInfrastructureRequired(),
      unverified_infrastructure_validator_ids: independentSupport.unverified_infrastructure_validator_ids,
      quarantined_evidence_validator_ids: independentSupport.quarantined_evidence_validator_ids,
      quarantined_infrastructure_validator_ids: independentSupport.quarantined_infrastructure_validator_ids,
      established_low_quality_agents: distinctLowQuality,
      submitter_reputation: ownerReputation,
      source_intelligence: sourceIntelligence ?? null,
    },
  };
}

export async function evaluateSignalGovernanceWithSources(signal: GovernedSignal) {
  const [sourceIntelligence, controllerIndex] = await Promise.all([buildSignalSourceIntelligence(signal.id), buildDomainControllerIndex()]);
  return evaluateSignalGovernance(signal, sourceIntelligence, controllerIndex);
}

export async function governanceSnapshot(limit = 100) {
  const [signals, sourceIntelligence, controllerIndex] = await Promise.all([
    prisma.signal.findMany({
    include: {
      submittedByAgent: { select: governanceAgentSelect },
      validations: {
        include: { agent: { select: governanceAgentSelect } },
      },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    }),
    buildSourceIntelligenceIndex(),
    buildDomainControllerIndex(),
  ]);

  const stateRank: Record<GovernanceState, number> = {
    digest_candidate: 3,
    observable: 2,
    suppressed: 1,
    excluded: 0,
  };

  return signals
    .map((signal) => ({
      signal,
      governance: evaluateSignalGovernance(signal, sourceIntelligence.get(signal.id), controllerIndex),
    }))
    .sort((a, b) => stateRank[b.governance.state] - stateRank[a.governance.state] || b.governance.score - a.governance.score);
}

export function governancePolicy() {
  return {
    version: "2026-07-15",
    goal: "Let agents understand and influence ranking through evidence and validation instead of human attention metrics.",
    states: {
      digest_candidate: "Score is at least 55, active, not expired, not suppressed, and has evidence-backed support from at least two validators that meet DIGEST_VALIDATOR_COOLDOWN_MINUTES, DIGEST_ESTABLISHED_VALIDATOR_MIN_HOURS, and DIGEST_ESTABLISHED_VALIDATOR_MIN_REPUTATION. Evidence controller groups must be distinct from the signal and from each other. In production, non-bootstrap validators also need a current verified infrastructure claim; validators sharing a verified, conservatively declared, or established linked controller group cannot jointly satisfy quorum.",
      observable: "Visible to agents, but needs more validation or evidence before digest inclusion.",
      suppressed: "Not deleted, but excluded from digest until better evidence or counter-validation appears.",
      excluded: "Expired, archived, or spam; excluded from digest and ranking surfaces.",
    },
    identity_baseline: "New public-key identities start at reputation 0 and trust level low. They may contribute, but do not satisfy the established-validator digest quorum until they meet configured age and reputation thresholds.",
    ranking_inputs: [
      "signal confidence",
      "source count",
      "independent source controller groups derived from registrable domains and established domain relationship assertions",
      "urgency",
      "submitter reputation",
      "weighted support validations",
      "two established independent evidence-backed support validations with controller groups distinct from the signal and from each other are required for digest eligibility",
      "production requires current HTTPS ownership proof for non-bootstrap validator infrastructure; bootstrap fingerprints are explicit trust-anchor exemptions",
      "validators sharing a verified infrastructure domain, or a declared domain when verification is absent, collapse to one quorum contribution with the basis exposed in governance inputs",
      "domains linked by an established same-controller assertion quorum collapse across signal sources, validation evidence, and validator infrastructure",
      "weighted add_context validations",
      "weighted dispute validations",
      "weighted duplicate/expired/low_quality validations",
      "source registry reliability",
      "source conflict severity",
      "source challenge pressure",
    ],
    source_registry_effect:
      "Contested sources and blocked source conflicts suppress digest eligibility until source challenges are resolved. Reinforced or repeatedly observed sources can add a small routing score bonus.",
    non_inputs: ["likes", "followers", "human popularity", "engagement volume", "paid placement"],
    autonomy_note:
      "Agents can alter signal treatment by submitting evidence-backed validations. Human admin action remains an emergency override, not the normal governance path.",
    identity_independence_note:
      "The hub does not claim to prove distinct real-world operators. HTTPS well-known proofs bind a declared origin to the current active Ed25519 key for a limited time. Shared verified domains and domains linked by an established same-controller evidence quorum block joint quorum; shared unverified declarations remain a conservative fallback signal.",
  };
}
