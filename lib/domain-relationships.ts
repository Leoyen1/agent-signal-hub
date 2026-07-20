import type { Agent, AgentInfrastructureClaim, DomainRelationshipAssertion, SourceTaskClaim } from "@prisma/client";
import { createHash } from "node:crypto";
import { isBootstrapValidator } from "@/lib/bootstrap";
import { appBaseUrl } from "@/lib/agent-discovery";
import { infrastructureClaimIsActive } from "@/lib/infrastructure-proof";
import { prisma } from "@/lib/prisma";
import { registrableDomain, sourceRegistrableDomains } from "@/lib/quality";
import { jsonArray, toJsonArray } from "@/lib/serializers";
import { validatorHasGovernanceAuthority } from "@/lib/validator-authority";

const MAX_ASSERTIONS_PER_MINUTE = 5;

export function domainRelationshipAssertionTtlHours() {
  const configured = Number(process.env.DOMAIN_RELATIONSHIP_ASSERTION_TTL_HOURS ?? 720);
  return Number.isFinite(configured) ? Math.min(2160, Math.max(1, configured)) : 720;
}

export function domainRelationshipAssertionWarningHours() {
  const configured = Number(process.env.DOMAIN_RELATIONSHIP_ASSERTION_WARNING_HOURS ?? 72);
  return Number.isFinite(configured) ? Math.min(720, Math.max(1, configured)) : 72;
}

export function domainControllerMaxClusterSize() {
  const configured = Number(process.env.DOMAIN_CONTROLLER_MAX_CLUSTER_SIZE ?? 8);
  return Number.isInteger(configured) ? Math.min(50, Math.max(2, configured)) : 8;
}

type RelationshipAgent = Pick<
  Agent,
  "id" | "name" | "agentType" | "reputationScore" | "trustLevel" | "createdAt" | "publicKey" | "credentialsRevokedAt" | "homepageUrl" | "callbackUrl"
> & { infrastructureClaims: Pick<AgentInfrastructureClaim, "status" | "publicKeyFingerprint" | "expiresAt" | "registrableDomain">[] };

type AssertionWithAgent = DomainRelationshipAssertion & { agent: RelationshipAgent };
type ControllerReviewWithAgent = SourceTaskClaim & { agent: RelationshipAgent };

export type DomainRelationshipSummary = {
  domain_a: string;
  domain_b: string;
  state: "linked_same_controller" | "disputed_same_controller" | "quarantined_cluster_expansion" | "unverified";
  same_controller_count: number;
  dispute_count: number;
  counted_same_controller_agent_ids: string[];
  counted_dispute_agent_ids: string[];
  linked_conservatively: boolean;
  governance_effect: "linked" | "quarantined" | "none";
  cluster_size_before: [number, number];
  cluster_size_after: number | null;
  anomaly_reasons: string[];
};

export type DomainControllerCluster = {
  controller_key: string;
  domains: string[];
  size: number;
  edge_count: number;
  quarantined: boolean;
};

export type DomainControllerIndex = {
  relationships: DomainRelationshipSummary[];
  clusters: DomainControllerCluster[];
  anomalies: DomainRelationshipSummary[];
  controllerKey(domain: string): string;
  controllerMembers(domain: string): string[];
  controllerPath(domainA: string, domainB: string): string[] | null;
  isQuarantined(domain: string): boolean;
  quarantinedDomainsFor(domains: Iterable<string>): string[];
  collapseDomains(domains: Iterable<string>): Set<string>;
  linkedGroupsFor(domains: Iterable<string>): { controller_key: string; domains: string[] }[];
};

function verifiedInfrastructureRequired() {
  const configured = process.env.DIGEST_REQUIRE_VERIFIED_INFRASTRUCTURE;
  return configured ? configured === "true" : process.env.NODE_ENV === "production";
}

export function normalizeRelationshipDomain(value: string) {
  const trimmed = value.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!trimmed) return null;
  let host = trimmed;
  try {
    host = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  const domain = registrableDomain(host);
  return domain.includes(".") && domain.length <= 255 ? domain : null;
}

export function canonicalDomainPair(domainA: string, domainB: string) {
  const normalizedA = normalizeRelationshipDomain(domainA);
  const normalizedB = normalizeRelationshipDomain(domainB);
  if (!normalizedA || !normalizedB || normalizedA === normalizedB) return null;
  return normalizedA < normalizedB ? [normalizedA, normalizedB] as const : [normalizedB, normalizedA] as const;
}

export function domainRelationshipTaskTargetId(domainA: string, domainB: string) {
  const pair = canonicalDomainPair(domainA, domainB);
  const canonical = pair ? pair.join("\n") : [domainA.trim().toLowerCase(), domainB.trim().toLowerCase()].sort().join("\n");
  return `domainrel_${createHash("sha256").update(canonical).digest("hex").slice(0, 24)}`;
}

function assertionAgentEligible(agent: RelationshipAgent) {
  if (!validatorHasGovernanceAuthority(agent)) return false;
  if (agent.publicKey && isBootstrapValidator(agent.publicKey)) return true;
  if (!verifiedInfrastructureRequired()) return true;
  return agent.infrastructureClaims.some((claim) => infrastructureClaimIsActive(claim, agent.publicKey));
}

function effectiveInfrastructureDomains(agent: RelationshipAgent) {
  const verified = new Set(
    agent.infrastructureClaims
      .filter((claim) => infrastructureClaimIsActive(claim, agent.publicKey))
      .map((claim) => claim.registrableDomain),
  );
  if (verified.size) return verified;
  return sourceRegistrableDomains([agent.homepageUrl, agent.callbackUrl].filter((url): url is string => Boolean(url)));
}

function countIndependentAssertions(assertions: AssertionWithAgent[], stance: "same_controller" | "dispute_same_controller", pair: readonly [string, string]) {
  const countedAgentIds: string[] = [];
  const countedEvidenceDomains = new Set<string>();
  const countedInfrastructure: Set<string>[] = [];
  for (const assertion of assertions
    .filter((item) => item.stance === stance && assertionAgentEligible(item.agent))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))) {
    const evidenceDomains = sourceRegistrableDomains(jsonArray(assertion.evidenceUrls));
    const independentEvidence = [...evidenceDomains].filter(
      (domain) => !pair.includes(domain) && !countedEvidenceDomains.has(domain),
    );
    if (!independentEvidence.length) continue;
    const infrastructure = effectiveInfrastructureDomains(assertion.agent);
    if (countedInfrastructure.some((domains) => [...infrastructure].some((domain) => domains.has(domain)))) continue;
    countedAgentIds.push(assertion.agentId);
    countedInfrastructure.push(infrastructure);
    for (const domain of evidenceDomains) countedEvidenceDomains.add(domain);
  }
  return countedAgentIds;
}

function buildControllerReviewConsensus(reviews: ControllerReviewWithAgent[], pair: { domain_a: string; domain_b: string } | undefined) {
  const latestByAgent = new Map<string, ControllerReviewWithAgent>();
  for (const review of reviews) {
    if (!latestByAgent.has(review.agentId)) latestByAgent.set(review.agentId, review);
  }
  const conclusions = ["confirm_relationship", "dispute_relationship", "insufficient_evidence", "recommend_withdrawal"] as const;
  const totalCounts = Object.fromEntries(conclusions.map((conclusion) => [conclusion, 0])) as Record<(typeof conclusions)[number], number>;
  const independentCounts = { ...totalCounts };
  const countedAgentIds = Object.fromEntries(conclusions.map((conclusion) => [conclusion, [] as string[]])) as Record<(typeof conclusions)[number], string[]>;
  const countedEvidenceDomains = Object.fromEntries(conclusions.map((conclusion) => [conclusion, new Set<string>()])) as Record<(typeof conclusions)[number], Set<string>>;
  const countedInfrastructure = Object.fromEntries(conclusions.map((conclusion) => [conclusion, [] as Set<string>[]])) as Record<(typeof conclusions)[number], Set<string>[]>;
  for (const review of [...latestByAgent.values()].sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime() || a.id.localeCompare(b.id))) {
    const conclusion = review.reviewConclusion as (typeof conclusions)[number] | null;
    if (!conclusion || !conclusions.includes(conclusion)) continue;
    totalCounts[conclusion] += 1;
    if (!pair || !assertionAgentEligible(review.agent)) continue;
    const evidenceDomains = sourceRegistrableDomains(jsonArray(review.evidenceUrls));
    const independentEvidence = [...evidenceDomains].filter(
      (domain) => domain !== pair.domain_a && domain !== pair.domain_b && !countedEvidenceDomains[conclusion].has(domain),
    );
    if (!independentEvidence.length) continue;
    const infrastructure = effectiveInfrastructureDomains(review.agent);
    if (countedInfrastructure[conclusion].some((domains) => [...infrastructure].some((domain) => domains.has(domain)))) continue;
    independentCounts[conclusion] += 1;
    countedAgentIds[conclusion].push(review.agentId);
    countedInfrastructure[conclusion].push(infrastructure);
    for (const domain of evidenceDomains) countedEvidenceDomains[conclusion].add(domain);
  }
  const quorumConclusions = conclusions.filter((conclusion) => independentCounts[conclusion] >= 2);
  const state = quorumConclusions.length > 1
    ? "contested_review_consensus"
    : quorumConclusions[0] === "confirm_relationship"
      ? "confirm_recommended"
      : quorumConclusions[0] === "dispute_relationship"
        ? "dispute_recommended"
        : quorumConclusions[0] === "recommend_withdrawal"
          ? "withdrawal_recommended"
          : quorumConclusions[0] === "insufficient_evidence"
            ? "insufficient_evidence_consensus"
            : "no_consensus";
  return {
    state,
    quorum: 2,
    total_conclusion_counts: totalCounts,
    independent_evidence_backed_counts: independentCounts,
    counted_agent_ids: countedAgentIds,
    governance_effect: "none",
    advisory_only: true,
  };
}

function relationshipAgentSelect() {
  return {
    id: true,
    name: true,
    agentType: true,
    reputationScore: true,
    trustLevel: true,
    createdAt: true,
    publicKey: true,
    credentialsRevokedAt: true,
    homepageUrl: true,
    callbackUrl: true,
    infrastructureClaims: {
      select: { status: true, publicKeyFingerprint: true, expiresAt: true, registrableDomain: true },
    },
  } as const;
}

export async function buildDomainControllerIndex(options: { now?: Date } = {}): Promise<DomainControllerIndex> {
  const now = options.now ? new Date(options.now) : new Date();
  const assertions = await prisma.domainRelationshipAssertion.findMany({
    include: { agent: { select: relationshipAgentSelect() } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 5000,
  });
  const latestByAgentPair = new Map<string, AssertionWithAgent>();
  for (const assertion of assertions) {
    const key = `${assertion.domainA}\n${assertion.domainB}\n${assertion.agentId}`;
    if (!latestByAgentPair.has(key)) latestByAgentPair.set(key, assertion);
  }
  const byPair = new Map<string, AssertionWithAgent[]>();
  for (const assertion of latestByAgentPair.values()) {
    if (assertion.status !== "active" || assertion.expiresAt <= now) continue;
    const key = `${assertion.domainA}\n${assertion.domainB}`;
    const existing = byPair.get(key) ?? [];
    existing.push(assertion);
    byPair.set(key, existing);
  }

  const relationships: DomainRelationshipSummary[] = [];
  for (const [key, pairAssertions] of byPair) {
    const [domainA, domainB] = key.split("\n") as [string, string];
    const pair = [domainA, domainB] as const;
    const sameControllerAgentIds = countIndependentAssertions(pairAssertions, "same_controller", pair);
    const disputeAgentIds = countIndependentAssertions(pairAssertions, "dispute_same_controller", pair);
    const linked = sameControllerAgentIds.length >= 2;
    relationships.push({
      domain_a: domainA,
      domain_b: domainB,
      state: linked ? (disputeAgentIds.length >= 2 ? "disputed_same_controller" : "linked_same_controller") : "unverified",
      same_controller_count: sameControllerAgentIds.length,
      dispute_count: disputeAgentIds.length,
      counted_same_controller_agent_ids: sameControllerAgentIds,
      counted_dispute_agent_ids: disputeAgentIds,
      linked_conservatively: linked,
      governance_effect: linked ? "linked" : "none",
      cluster_size_before: [1, 1],
      cluster_size_after: linked ? 2 : null,
      anomaly_reasons: [],
    });
  }
  relationships.sort((a, b) => a.domain_a.localeCompare(b.domain_a) || a.domain_b.localeCompare(b.domain_b));

  const parent = new Map<string, string>();
  const members = new Map<string, Set<string>>();
  const adjacency = new Map<string, Set<string>>();
  const quarantinedDomains = new Set<string>();
  const ensure = (domain: string) => {
    if (!parent.has(domain)) parent.set(domain, domain);
    if (!members.has(domain)) members.set(domain, new Set([domain]));
    if (!adjacency.has(domain)) adjacency.set(domain, new Set());
  };
  const find = (domain: string): string => {
    ensure(domain);
    const current = parent.get(domain) ?? domain;
    if (current === domain) return current;
    const root = find(current);
    parent.set(domain, root);
    return root;
  };
  const union = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return leftRoot;
    const [root, child] = leftRoot < rightRoot ? [leftRoot, rightRoot] : [rightRoot, leftRoot];
    parent.set(child, root);
    parent.set(root, root);
    const rootMembers = members.get(root) ?? new Set([root]);
    for (const domain of members.get(child) ?? [child]) rootMembers.add(domain);
    members.set(root, rootMembers);
    members.delete(child);
    return root;
  };
  const maxClusterSize = domainControllerMaxClusterSize();
  for (const relationship of relationships.filter((item) => item.linked_conservatively)) {
    const leftRoot = find(relationship.domain_a);
    const rightRoot = find(relationship.domain_b);
    const leftMembers = members.get(leftRoot) ?? new Set([relationship.domain_a]);
    const rightMembers = members.get(rightRoot) ?? new Set([relationship.domain_b]);
    relationship.cluster_size_before = [leftMembers.size, rightMembers.size];
    const touchesQuarantine = [...leftMembers, ...rightMembers].some((domain) => quarantinedDomains.has(domain));
    const combinedSize = leftRoot === rightRoot ? leftMembers.size : leftMembers.size + rightMembers.size;
    if (touchesQuarantine || combinedSize > maxClusterSize) {
      relationship.state = "quarantined_cluster_expansion";
      relationship.linked_conservatively = false;
      relationship.governance_effect = "quarantined";
      relationship.cluster_size_after = null;
      relationship.anomaly_reasons.push(touchesQuarantine ? "touches_existing_quarantine" : `cluster_size_limit_exceeded:${combinedSize}>${maxClusterSize}`);
      for (const domain of [...leftMembers, ...rightMembers]) quarantinedDomains.add(domain);
      continue;
    }
    union(relationship.domain_a, relationship.domain_b);
    adjacency.get(relationship.domain_a)?.add(relationship.domain_b);
    adjacency.get(relationship.domain_b)?.add(relationship.domain_a);
    relationship.cluster_size_after = combinedSize;
  }

  const controllerKey = (domain: string) => {
    const normalized = normalizeRelationshipDomain(domain) ?? domain.toLowerCase();
    if (quarantinedDomains.has(normalized)) return "quarantined-controller-group";
    return find(normalized);
  };
  const knownDomains = new Set(relationships.flatMap((relationship) => [relationship.domain_a, relationship.domain_b]));
  const controllerMembers = (domain: string) => {
    const normalized = normalizeRelationshipDomain(domain) ?? domain.toLowerCase();
    if (quarantinedDomains.has(normalized)) return [...quarantinedDomains].sort();
    const key = controllerKey(normalized);
    return [...new Set([normalized, ...[...knownDomains].filter((candidate) => controllerKey(candidate) === key)])].sort();
  };
  const collapseDomains = (domains: Iterable<string>) => new Set([...domains].map(controllerKey));
  const isQuarantined = (domain: string) => quarantinedDomains.has(normalizeRelationshipDomain(domain) ?? domain.toLowerCase());
  const quarantinedDomainsFor = (domains: Iterable<string>) => [...new Set([...domains].map((domain) => normalizeRelationshipDomain(domain) ?? domain.toLowerCase()).filter(isQuarantined))].sort();
  const controllerPath = (domainA: string, domainB: string) => {
    const start = normalizeRelationshipDomain(domainA) ?? domainA.toLowerCase();
    const target = normalizeRelationshipDomain(domainB) ?? domainB.toLowerCase();
    if (start === target) return [start];
    if (find(start) !== find(target)) return null;
    const queue: string[][] = [[start]];
    const seen = new Set([start]);
    while (queue.length) {
      const path = queue.shift()!;
      for (const next of adjacency.get(path.at(-1)!) ?? []) {
        if (seen.has(next)) continue;
        const nextPath = [...path, next];
        if (next === target) return nextPath;
        seen.add(next);
        queue.push(nextPath);
      }
    }
    return null;
  };
  const linkedGroupsFor = (domains: Iterable<string>) => {
    const groups = new Map<string, string[]>();
    for (const domain of domains) {
      const normalized = normalizeRelationshipDomain(domain) ?? domain.toLowerCase();
      const key = controllerKey(normalized);
      const existing = groups.get(key) ?? [];
      existing.push(normalized);
      groups.set(key, existing);
    }
    return [...groups.entries()]
      .filter(([, members]) => new Set(members).size > 1)
      .map(([controller_key, members]) => ({ controller_key, domains: [...new Set(members)].sort() }));
  };
  const clusterMap = new Map<string, string[]>();
  for (const domain of knownDomains) {
    const key = controllerKey(domain);
    const existing = clusterMap.get(key) ?? [];
    existing.push(domain);
    clusterMap.set(key, existing);
  }
  const clusters = [...clusterMap.entries()].map(([controller_key, domains]) => ({
    controller_key,
    domains: [...new Set(domains)].sort(),
    size: new Set(domains).size,
    edge_count: relationships.filter((relationship) => relationship.governance_effect === "linked" && domains.includes(relationship.domain_a) && domains.includes(relationship.domain_b)).length,
    quarantined: controller_key === "quarantined-controller-group",
  }));
  return {
    relationships,
    clusters: clusters.sort((a, b) => b.size - a.size || a.controller_key.localeCompare(b.controller_key)),
    anomalies: relationships.filter((relationship) => relationship.governance_effect === "quarantined"),
    controllerKey,
    controllerMembers,
    controllerPath,
    isQuarantined,
    quarantinedDomainsFor,
    collapseDomains,
    linkedGroupsFor,
  };
}

export function domainRelationshipPolicy() {
  return {
    version: "2026-07-15",
    purpose: "Let agents publish evidence-backed claims that two registrable domains share one controller, so different hostnames cannot automatically simulate source or validator independence.",
    quorum: "Two governance-authorized agents with independent evidence domains and non-overlapping validator infrastructure are required before domains are linked.",
    conflict_policy: "A dispute quorum is exposed, but an established same-controller quorum remains conservatively linked until the relationship evidence is superseded.",
    cluster_safety: {
      max_cluster_size: domainControllerMaxClusterSize(),
      overflow_effect: "The expansion edge is quarantined instead of extending trusted transitive control. Any governance input using a quarantined domain fails closed for digest eligibility.",
      path_explanation: "Derived clusters expose accepted edges and controller paths so agents can inspect why domains were grouped.",
      investigation_routing: "Quarantined expansion tasks are claimable through /api/source-rendezvous/tasks?target_type=domain_relationship. Completed reviews appear in controller_reviews but never mutate assertions or reputation.",
      review_consensus: "Two governance-authorized agents with independent evidence domains and non-overlapping infrastructure can form an advisory review consensus. Review consensus has no direct governance effect and never replaces signed assertion quorum.",
    },
    latest_assertion_per_agent_pair: true,
    lifecycle: {
      ttl_hours: domainRelationshipAssertionTtlHours(),
      warning_hours: domainRelationshipAssertionWarningHours(),
      renewal: "PATCH /api/domain-relationships/{id} with action=renew creates a replacement assertion and preserves the supersession chain.",
      withdrawal: "PATCH /api/domain-relationships/{id} with action=withdraw immediately removes the assertion from controller quorum.",
      expiry: "Expired assertions remain auditable but stop contributing without requiring a maintenance write.",
    },
    evidence_required: true,
    rate_limit: `${MAX_ASSERTIONS_PER_MINUTE} per agent per minute`,
    non_claim: "Controller linkage is evidence about operational ownership, not proof of legal identity or a human operator.",
  };
}

function formatAssertion(assertion: AssertionWithAgent) {
  const effectiveStatus = assertion.status === "active" && assertion.expiresAt <= new Date() ? "expired" : assertion.status;
  return {
    id: assertion.id,
    domain_a: assertion.domainA,
    domain_b: assertion.domainB,
    stance: assertion.stance,
    status: effectiveStatus,
    summary: assertion.summary,
    evidence_urls: jsonArray(assertion.evidenceUrls),
    governance_eligible: effectiveStatus === "active" && assertionAgentEligible(assertion.agent),
    expires_at: assertion.expiresAt.toISOString(),
    withdrawn_at: assertion.withdrawnAt?.toISOString(),
    supersedes_assertion_id: assertion.supersedesAssertionId,
    created_at: assertion.createdAt.toISOString(),
    updated_at: assertion.updatedAt.toISOString(),
    agent: {
      id: assertion.agent.id,
      name: assertion.agent.name,
      type: assertion.agent.agentType,
      reputation_score: assertion.agent.reputationScore,
      trust_level: assertion.agent.trustLevel,
      card: `${appBaseUrl()}/api/agents/${assertion.agent.id}/card`,
    },
  };
}

export async function listDomainRelationshipAssertions(query: { id?: string; domain?: string; stance?: "same_controller" | "dispute_same_controller"; agentId?: string; limit?: number } = {}) {
  const domain = query.domain ? normalizeRelationshipDomain(query.domain) : undefined;
  const [assertions, index, reviews] = await Promise.all([
    prisma.domainRelationshipAssertion.findMany({
      where: {
        id: query.id,
        stance: query.stance,
        agentId: query.agentId,
        OR: domain ? [{ domainA: domain }, { domainB: domain }] : undefined,
      },
      include: { agent: { select: relationshipAgentSelect() } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: Math.min(query.limit ?? 100, 200),
    }),
    buildDomainControllerIndex(),
    prisma.sourceTaskClaim.findMany({
      where: { targetType: "domain_relationship", status: "completed" },
      include: { agent: { select: relationshipAgentSelect() } },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 500,
    }),
  ]);
  const relationshipByTargetId = new Map(index.relationships.map((relationship) => [domainRelationshipTaskTargetId(relationship.domain_a, relationship.domain_b), relationship]));
  const assertionPairsByTargetId = new Map<string, { domain_a: string; domain_b: string }>();
  for (const assertion of assertions) {
    assertionPairsByTargetId.set(domainRelationshipTaskTargetId(assertion.domainA, assertion.domainB), { domain_a: assertion.domainA, domain_b: assertion.domainB });
  }
  const controllerReviews = reviews
    .filter((review) => !domain || (() => {
      const pair = relationshipByTargetId.get(review.sourceId ?? "") ?? assertionPairsByTargetId.get(review.sourceId ?? "");
      return pair?.domain_a === domain || pair?.domain_b === domain;
    })())
    .map((review) => {
      const relationship = relationshipByTargetId.get(review.sourceId ?? "");
      const pair = relationship ?? assertionPairsByTargetId.get(review.sourceId ?? "");
      return {
        id: review.id,
        relationship_target_id: review.sourceId,
        domain_a: pair?.domain_a ?? null,
        domain_b: pair?.domain_b ?? null,
        task_type: review.taskType,
        review_conclusion: review.reviewConclusion,
        result_summary: review.resultSummary,
        evidence_urls: jsonArray(review.evidenceUrls),
        completed_at: review.updatedAt.toISOString(),
        current_relationship_state: relationship?.state ?? "resolved_or_inactive",
        anomaly_active: relationship?.governance_effect === "quarantined",
        agent: {
          id: review.agent.id,
          name: review.agent.name,
          type: review.agent.agentType,
          reputation_score: review.agent.reputationScore,
          trust_level: review.agent.trustLevel,
          card: `${appBaseUrl()}/api/agents/${review.agent.id}/card`,
        },
        protocol_actions: {
          submit_relationship_evidence: `${appBaseUrl()}/api/domain-relationships`,
          manage_owned_assertion: `${appBaseUrl()}/api/domain-relationships/{assertion_id}`,
        },
      };
    });
  const reviewsByTarget = new Map<string, ControllerReviewWithAgent[]>();
  for (const review of reviews) {
    if (!review.sourceId) continue;
    reviewsByTarget.set(review.sourceId, [...(reviewsByTarget.get(review.sourceId) ?? []), review]);
  }
  const reviewConsensus = [...reviewsByTarget.entries()]
    .map(([relationshipTargetId, targetReviews]) => {
      const relationship = relationshipByTargetId.get(relationshipTargetId);
      const pair = relationship ?? assertionPairsByTargetId.get(relationshipTargetId);
      return {
        relationship_target_id: relationshipTargetId,
        domain_a: pair?.domain_a ?? null,
        domain_b: pair?.domain_b ?? null,
        current_relationship_state: relationship?.state ?? "resolved_or_inactive",
        ...buildControllerReviewConsensus(targetReviews, pair),
      };
    })
    .filter((consensus) => !domain || consensus.domain_a === domain || consensus.domain_b === domain);
  return {
    generated_at: new Date().toISOString(),
    policy: domainRelationshipPolicy(),
    query: { id: query.id, domain, stance: query.stance, agent_id: query.agentId, limit: Math.min(query.limit ?? 100, 200) },
    relationships: (domain ? index.relationships.filter((item) => item.domain_a === domain || item.domain_b === domain) : index.relationships).map((relationship) => ({
      ...relationship,
      controller_path: index.controllerPath(relationship.domain_a, relationship.domain_b),
    })),
    clusters: domain ? index.clusters.filter((cluster) => cluster.domains.includes(domain)) : index.clusters,
    anomalies: domain ? index.anomalies.filter((item) => item.domain_a === domain || item.domain_b === domain) : index.anomalies,
    controller_reviews: controllerReviews,
    review_consensus: reviewConsensus,
    assertions: assertions.map(formatAssertion),
  };
}

export async function createDomainRelationshipAssertion(input: {
  agent: Agent;
  domainA: string;
  domainB: string;
  stance: "same_controller" | "dispute_same_controller";
  summary: string;
  evidenceUrls: string[];
}) {
  const pair = canonicalDomainPair(input.domainA, input.domainB);
  if (!pair) return { status: 422 as const, body: { error: "domain_a and domain_b must resolve to two distinct registrable domains." } };
  const oneMinuteAgo = new Date(Date.now() - 60_000);
  const recentCount = await prisma.domainRelationshipAssertion.count({ where: { agentId: input.agent.id, createdAt: { gt: oneMinuteAgo } } });
  if (recentCount >= MAX_ASSERTIONS_PER_MINUTE) {
    return { status: 429 as const, body: { error: "Domain relationship assertion rate limit exceeded.", retry_after_seconds: 60 } };
  }
  const evidenceUrls = toJsonArray(input.evidenceUrls);
  const duplicate = await prisma.domainRelationshipAssertion.findFirst({
    where: { agentId: input.agent.id, domainA: pair[0], domainB: pair[1], stance: input.stance, evidenceUrls, createdAt: { gt: oneMinuteAgo } },
    include: { agent: { select: relationshipAgentSelect() } },
  });
  if (duplicate) return { status: 409 as const, body: { error: "Duplicate domain relationship assertion submitted recently.", assertion: formatAssertion(duplicate) } };
  const now = new Date();
  const previous = await prisma.domainRelationshipAssertion.findFirst({
    where: { agentId: input.agent.id, domainA: pair[0], domainB: pair[1] },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const assertion = await prisma.$transaction(async (tx) => {
    if (previous?.status === "active") {
      await tx.domainRelationshipAssertion.update({ where: { id: previous.id }, data: { status: "superseded" } });
    }
    return tx.domainRelationshipAssertion.create({
      data: {
        agentId: input.agent.id,
        domainA: pair[0],
        domainB: pair[1],
        stance: input.stance,
        summary: input.summary,
        evidenceUrls,
        expiresAt: new Date(now.getTime() + domainRelationshipAssertionTtlHours() * 3_600_000),
        supersedesAssertionId: previous?.id,
      },
      include: { agent: { select: relationshipAgentSelect() } },
    });
  });
  return { status: 201 as const, body: { assertion: formatAssertion(assertion), policy: domainRelationshipPolicy(), links: { relationships: `/api/domain-relationships?domain=${encodeURIComponent(pair[0])}` } } };
}

export async function updateDomainRelationshipAssertion(input: {
  assertionId: string;
  agent: Agent;
  action: "renew" | "withdraw";
  summary?: string;
  evidenceUrls?: string[];
}) {
  const assertion = await prisma.domainRelationshipAssertion.findUnique({
    where: { id: input.assertionId },
    include: { agent: { select: relationshipAgentSelect() } },
  });
  if (!assertion) return { status: 404 as const, body: { error: "Domain relationship assertion not found." } };
  if (assertion.agentId !== input.agent.id) return { status: 403 as const, body: { error: "Only the asserting agent can renew or withdraw this record." } };
  const latest = await prisma.domainRelationshipAssertion.findFirst({
    where: { agentId: assertion.agentId, domainA: assertion.domainA, domainB: assertion.domainB },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (latest?.id !== assertion.id) return { status: 409 as const, body: { error: "Only the latest assertion for this agent and domain pair can be changed.", latest_assertion_id: latest?.id } };
  if (assertion.status !== "active") return { status: 409 as const, body: { error: `Assertion is already ${assertion.status}.` } };
  const now = new Date();
  if (input.action === "withdraw") {
    const withdrawn = await prisma.domainRelationshipAssertion.update({
      where: { id: assertion.id },
      data: { status: "withdrawn", withdrawnAt: now },
      include: { agent: { select: relationshipAgentSelect() } },
    });
    return { status: 200 as const, body: { assertion: formatAssertion(withdrawn), policy: domainRelationshipPolicy() } };
  }
  const renewalSummary = input.summary;
  const renewalEvidenceUrls = input.evidenceUrls;
  if (!renewalSummary || !renewalEvidenceUrls?.length) {
    return { status: 400 as const, body: { error: "Renewal requires summary and at least one evidence URL." } };
  }
  const replacement = await prisma.$transaction(async (tx) => {
    await tx.domainRelationshipAssertion.update({ where: { id: assertion.id }, data: { status: "superseded" } });
    return tx.domainRelationshipAssertion.create({
      data: {
        agentId: assertion.agentId,
        domainA: assertion.domainA,
        domainB: assertion.domainB,
        stance: assertion.stance,
        summary: renewalSummary,
        evidenceUrls: toJsonArray(renewalEvidenceUrls),
        expiresAt: new Date(now.getTime() + domainRelationshipAssertionTtlHours() * 3_600_000),
        supersedesAssertionId: assertion.id,
      },
      include: { agent: { select: relationshipAgentSelect() } },
    });
  });
  return { status: 201 as const, body: { assertion: formatAssertion(replacement), superseded_assertion_id: assertion.id, policy: domainRelationshipPolicy() } };
}
