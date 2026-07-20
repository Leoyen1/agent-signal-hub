import crypto from "node:crypto";
import { appBaseUrl } from "@/lib/agent-discovery";
import { prisma } from "@/lib/prisma";
import { jsonArray } from "@/lib/serializers";
import { sourceConflictSeverityRank, summarizeSourceConflictInputs } from "@/lib/source-conflicts";
import type { SourceConflictSeverity } from "@/lib/source-conflicts";
import { buildDomainControllerIndex } from "@/lib/domain-relationships";
import type { DomainControllerIndex } from "@/lib/domain-relationships";
import { registrableDomain } from "@/lib/quality";

type SourceRole =
  | "signal_source"
  | "validation_evidence"
  | "challenge_evidence"
  | "challenge_response_evidence"
  | "intent_evidence"
  | "task_claim_evidence";

type SourceReference = {
  role: SourceRole;
  url: string;
  occurred_at: string;
  signal_id?: string;
  signal_title?: string;
  agent_id?: string;
  agent_name?: string;
  validation_id?: string;
  validation_verdict?: string;
  challenge_id?: string;
  challenge_type?: string;
  challenge_status?: string;
  intent_id?: string;
  intent_type?: string;
  task_claim_id?: string;
  task_type?: string;
  links: Record<string, string>;
};

type SourceAggregate = {
  id: string;
  canonical_url: string;
  display_url: string;
  host: string;
  scheme: string;
  path: string;
  first_seen_at: string;
  last_seen_at: string;
  references: SourceReference[];
};

export type SourceReliability = "contested" | "reinforced" | "observed_multiple_times" | "observed";

export type SourceRecord = ReturnType<typeof formatSource>;

export type SignalSourceIntelligence = {
  source_count: number;
  source_ids: string[];
  reliability_counts: Record<SourceReliability, number>;
  supportive_references: number;
  dispute_pressure: number;
  distinct_source_agents: number;
  score_delta: number;
  source_conflict_count: number;
  source_conflict_pressure: number;
  max_source_conflict_severity: SourceConflictSeverity;
  digest_safety: "eligible" | "needs_source_review" | "source_contested";
  recommended_action: "none" | "inspect_contested_sources" | "request_independent_source_review";
};

function stableSourceId(canonicalUrl: string) {
  return `src_${crypto.createHash("sha256").update(canonicalUrl).digest("hex").slice(0, 24)}`;
}

export function normalizeSourceUrl(value: string) {
  const url = new URL(value);
  url.hash = "";
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");

  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }

  const sortedParams = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  url.search = "";
  for (const [key, paramValue] of sortedParams) {
    url.searchParams.append(key, paramValue);
  }

  return {
    id: stableSourceId(url.toString()),
    canonical_url: url.toString(),
    host: url.hostname,
    scheme: url.protocol.replace(":", ""),
    path: url.pathname || "/",
  };
}

export function sourceRegistryPolicy() {
  return {
    version: "2026-07-10",
    purpose: "Expose reusable source objects derived from URLs cited by signals, validations, challenges, intents, and task claims.",
    registry_model: "derived_from_public_records",
    source_id: "src_<sha256(normalized_url)[0..24]>",
    normalization: [
      "lowercase protocol and host",
      "strip leading www from host",
      "remove URL fragment",
      "trim trailing slash except root",
      "sort query parameters by key",
    ],
    reliability_note:
      "Source quality is a routing and audit signal, not a truth label. Agents should inspect references and linked records before relying on a source.",
    controller_model:
      "Sources expose a controller_key derived from registrable-domain relationships established by independent agent evidence. Different domains linked to one controller do not count as independent governance inputs.",
    non_inputs: ["human popularity", "traffic", "likes", "paid placement"],
  };
}

function sourceUrl(path: string) {
  return `${appBaseUrl()}${path}`;
}

function referenceLinks(reference: Omit<SourceReference, "links">) {
  return {
    ...(reference.signal_id ? { signal: sourceUrl(`/api/signals/${reference.signal_id}`), signal_sources: sourceUrl(`/api/signals/${reference.signal_id}/sources`) } : {}),
    ...(reference.agent_id ? { agent: sourceUrl(`/api/agents/${reference.agent_id}/card`) } : {}),
    ...(reference.challenge_id ? { challenge: sourceUrl(`/api/challenges/${reference.challenge_id}`) } : {}),
    ...(reference.intent_id && reference.signal_id ? { intents: sourceUrl(`/api/signals/${reference.signal_id}/intents`) } : {}),
    ...(reference.task_claim_id && reference.agent_id ? { agent_tasks: sourceUrl(`/api/agents/${reference.agent_id}/tasks`) } : {}),
  };
}

function addReference(sources: Map<string, SourceAggregate>, reference: Omit<SourceReference, "links">) {
  let normalized: ReturnType<typeof normalizeSourceUrl>;
  try {
    normalized = normalizeSourceUrl(reference.url);
  } catch {
    return;
  }

  const withLinks: SourceReference = {
    ...reference,
    links: referenceLinks(reference),
  };
  const existing = sources.get(normalized.id);

  if (existing) {
    existing.references.push(withLinks);
    if (reference.occurred_at < existing.first_seen_at) existing.first_seen_at = reference.occurred_at;
    if (reference.occurred_at > existing.last_seen_at) existing.last_seen_at = reference.occurred_at;
    return;
  }

  sources.set(normalized.id, {
    id: normalized.id,
    canonical_url: normalized.canonical_url,
    display_url: reference.url,
    host: normalized.host,
    scheme: normalized.scheme,
    path: normalized.path,
    first_seen_at: reference.occurred_at,
    last_seen_at: reference.occurred_at,
    references: [withLinks],
  });
}

function verdictCounts(references: SourceReference[]) {
  return references.reduce<Record<string, number>>((acc, reference) => {
    if (reference.validation_verdict) acc[reference.validation_verdict] = (acc[reference.validation_verdict] ?? 0) + 1;
    return acc;
  }, {});
}

function challengeCounts(references: SourceReference[]) {
  return references.reduce<Record<string, number>>((acc, reference) => {
    if (reference.challenge_type) acc[reference.challenge_type] = (acc[reference.challenge_type] ?? 0) + 1;
    return acc;
  }, {});
}

function formatSource(source: SourceAggregate, controllerIndex?: DomainControllerIndex) {
  const roles = [...new Set(source.references.map((reference) => reference.role))];
  const verdicts = verdictCounts(source.references);
  const challenges = challengeCounts(source.references);
  const openChallenges = source.references.filter((reference) => reference.challenge_status === "open").length;
  const acceptedChallenges = source.references.filter((reference) => reference.challenge_status === "accepted").length;
  const rejectedChallenges = source.references.filter((reference) => reference.challenge_status === "rejected").length;
  const supportSignals = (verdicts.support ?? 0) + (verdicts.add_context ?? 0);
  const disputeSignals =
    (verdicts.dispute ?? 0) +
    (verdicts.mark_low_quality ?? 0) +
    (challenges.source_dispute ?? 0) +
    (challenges.confidence_dispute ?? 0) +
    (challenges.retraction_request ?? 0);

  const reliability: SourceReliability =
    disputeSignals >= 2 && disputeSignals > supportSignals
      ? "contested"
      : supportSignals >= 2 && disputeSignals === 0
        ? "reinforced"
        : source.references.length >= 3
          ? "observed_multiple_times"
          : "observed";
  const qualityInputs = {
    supportive_references: supportSignals,
    dispute_pressure: disputeSignals,
    distinct_signals: new Set(source.references.map((reference) => reference.signal_id).filter(Boolean)).size,
    distinct_agents: new Set(source.references.map((reference) => reference.agent_id).filter(Boolean)).size,
  };
  const conflictSummary = summarizeSourceConflictInputs({
    supportiveReferences: supportSignals,
    disputePressure: disputeSignals,
    openChallenges,
    acceptedChallenges,
    rejectedChallenges,
  });
  const domain = registrableDomain(source.host);
  const controllerKey = controllerIndex?.controllerKey(domain) ?? domain;
  const controllerDomains = controllerIndex?.controllerMembers(domain) ?? [domain];
  const controllerQuarantined = controllerIndex?.isQuarantined(domain) ?? false;

  return {
    id: source.id,
    canonical_url: source.canonical_url,
    display_url: source.display_url,
    host: source.host,
    registrable_domain: domain,
    controller_key: controllerKey,
    controller_domains: controllerDomains,
    controller_quarantined: controllerQuarantined,
    scheme: source.scheme,
    path: source.path,
    first_seen_at: source.first_seen_at,
    last_seen_at: source.last_seen_at,
    reference_count: source.references.length,
    roles,
    verdict_counts: verdicts,
    challenge_counts: challenges,
    reliability,
    quality_inputs: qualityInputs,
    conflict_summary: conflictSummary,
    links: {
      self: sourceUrl(`/api/sources/${source.id}`),
      host_sources: sourceUrl(`/api/sources?host=${encodeURIComponent(source.host)}`),
      conflicts: sourceUrl(`/api/source-conflicts?target_type=source&source_id=${source.id}`),
      domain_relationships: sourceUrl(`/api/domain-relationships?domain=${encodeURIComponent(domain)}`),
    },
    references: source.references.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at)),
  };
}

export async function buildSourceRegistry(query: { host?: string; url?: string; role?: SourceRole; limit?: number } = {}) {
  const sources = new Map<string, SourceAggregate>();
  const [signals, validations, challenges, intents, taskClaims, controllerIndex] = await Promise.all([
    prisma.signal.findMany({
      include: { submittedByAgent: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
      take: 1000,
    }),
    prisma.validation.findMany({
      include: {
        agent: { select: { id: true, name: true } },
        signal: { select: { id: true, title: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 1000,
    }),
    prisma.challenge.findMany({
      include: {
        challengerAgent: { select: { id: true, name: true } },
        signal: { select: { id: true, title: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 1000,
    }),
    prisma.signalIntent.findMany({
      include: {
        agent: { select: { id: true, name: true } },
        signal: { select: { id: true, title: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 1000,
    }),
    prisma.taskClaim.findMany({
      include: {
        agent: { select: { id: true, name: true } },
        signal: { select: { id: true, title: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 1000,
    }),
    buildDomainControllerIndex(),
  ]);

  for (const signal of signals) {
    for (const url of jsonArray(signal.sourceUrls)) {
      addReference(sources, {
        role: "signal_source",
        url,
        occurred_at: signal.createdAt.toISOString(),
        signal_id: signal.id,
        signal_title: signal.title,
        agent_id: signal.submittedByAgentId,
        agent_name: signal.submittedByAgent.name,
      });
    }
  }

  for (const validation of validations) {
    for (const url of jsonArray(validation.evidenceUrls)) {
      addReference(sources, {
        role: "validation_evidence",
        url,
        occurred_at: validation.createdAt.toISOString(),
        signal_id: validation.signalId,
        signal_title: validation.signal.title,
        agent_id: validation.agentId,
        agent_name: validation.agent.name,
        validation_id: validation.id,
        validation_verdict: validation.verdict,
      });
    }
  }

  for (const challenge of challenges) {
    for (const url of jsonArray(challenge.evidenceUrls)) {
      addReference(sources, {
        role: "challenge_evidence",
        url,
        occurred_at: challenge.createdAt.toISOString(),
        signal_id: challenge.signalId,
        signal_title: challenge.signal.title,
        agent_id: challenge.challengerAgentId,
        agent_name: challenge.challengerAgent.name,
        challenge_id: challenge.id,
        challenge_type: challenge.challengeType,
        challenge_status: challenge.status,
      });
    }
    for (const url of jsonArray(challenge.responseEvidenceUrls)) {
      addReference(sources, {
        role: "challenge_response_evidence",
        url,
        occurred_at: challenge.updatedAt.toISOString(),
        signal_id: challenge.signalId,
        signal_title: challenge.signal.title,
        agent_id: challenge.targetAgentId ?? undefined,
        challenge_id: challenge.id,
        challenge_type: challenge.challengeType,
        challenge_status: challenge.status,
      });
    }
  }

  for (const intent of intents) {
    for (const url of jsonArray(intent.evidenceUrls)) {
      addReference(sources, {
        role: "intent_evidence",
        url,
        occurred_at: intent.createdAt.toISOString(),
        signal_id: intent.signalId,
        signal_title: intent.signal.title,
        agent_id: intent.agentId,
        agent_name: intent.agent.name,
        intent_id: intent.id,
        intent_type: intent.intentType,
      });
    }
  }

  for (const claim of taskClaims) {
    for (const url of jsonArray(claim.evidenceUrls)) {
      addReference(sources, {
        role: "task_claim_evidence",
        url,
        occurred_at: claim.updatedAt.toISOString(),
        signal_id: claim.signalId,
        signal_title: claim.signal.title,
        agent_id: claim.agentId,
        agent_name: claim.agent.name,
        task_claim_id: claim.id,
        task_type: claim.taskType,
      });
    }
  }

  let items = [...sources.values()].map((source) => formatSource(source, controllerIndex));
  const host = query.host;
  const role = query.role;
  if (host) items = items.filter((source) => source.host === host.toLowerCase().replace(/^www\./, ""));
  if (role) items = items.filter((source) => source.roles.includes(role));
  if (query.url) {
    const normalized = normalizeSourceUrl(query.url);
    items = items.filter((source) => source.id === normalized.id);
  }

  items = items.sort((a, b) => b.reference_count - a.reference_count || b.last_seen_at.localeCompare(a.last_seen_at)).slice(0, Math.min(query.limit ?? 100, 500));

  return {
    generated_at: new Date().toISOString(),
    policy: sourceRegistryPolicy(),
    sources: items,
  };
}

export function sourceIntelligenceFromSources(sources: SourceRecord[]): SignalSourceIntelligence {
  const reliabilityCounts: Record<SourceReliability, number> = {
    contested: 0,
    reinforced: 0,
    observed_multiple_times: 0,
    observed: 0,
  };
  let supportiveReferences = 0;
  let disputePressure = 0;
  let conflictPressure = 0;
  let sourceConflictCount = 0;
  let maxConflictSeverity: SourceConflictSeverity = "clear";
  const sourceAgents = new Set<string>();

  for (const source of sources) {
    reliabilityCounts[source.reliability] += 1;
    supportiveReferences += source.quality_inputs.supportive_references;
    disputePressure += source.quality_inputs.dispute_pressure;
    conflictPressure += source.conflict_summary.unresolved_pressure;
    if (source.conflict_summary.severity !== "clear") sourceConflictCount += 1;
    if (sourceConflictSeverityRank[source.conflict_summary.severity] > sourceConflictSeverityRank[maxConflictSeverity]) {
      maxConflictSeverity = source.conflict_summary.severity;
    }
    for (const reference of source.references) {
      if (reference.agent_id) sourceAgents.add(reference.agent_id);
    }
  }
  const conflictPenalty = Math.min(18, Math.round(conflictPressure * 3) + sourceConflictSeverityRank[maxConflictSeverity] * 4);

  const scoreDelta = Math.max(
    -30,
    Math.min(
      18,
      reliabilityCounts.reinforced * 7 +
        reliabilityCounts.observed_multiple_times * 3 -
        reliabilityCounts.contested * 16 +
        Math.min(supportiveReferences, 5) * 2 -
        Math.min(disputePressure, 6) * 3 -
        conflictPenalty,
    ),
  );
  const digestSafety =
    maxConflictSeverity === "blocked" || (reliabilityCounts.contested > 0 && disputePressure > supportiveReferences)
      ? "source_contested"
      : maxConflictSeverity === "contested" || maxConflictSeverity === "review" || disputePressure > 0
        ? "needs_source_review"
        : "eligible";

  return {
    source_count: sources.length,
    source_ids: sources.map((source) => source.id),
    reliability_counts: reliabilityCounts,
    supportive_references: supportiveReferences,
    dispute_pressure: disputePressure,
    distinct_source_agents: sourceAgents.size,
    score_delta: scoreDelta,
    source_conflict_count: sourceConflictCount,
    source_conflict_pressure: Number(conflictPressure.toFixed(2)),
    max_source_conflict_severity: maxConflictSeverity,
    digest_safety: digestSafety,
    recommended_action:
      digestSafety === "source_contested"
        ? "inspect_contested_sources"
        : digestSafety === "needs_source_review"
          ? "request_independent_source_review"
          : "none",
  };
}

export async function buildSourceIntelligenceIndex() {
  const registry = await buildSourceRegistry({ limit: 500 });
  const bySignal = new Map<string, Map<string, SourceRecord>>();

  for (const source of registry.sources) {
    for (const reference of source.references) {
      if (!reference.signal_id) continue;
      const existing = bySignal.get(reference.signal_id) ?? new Map<string, SourceRecord>();
      existing.set(source.id, {
        ...source,
        references: source.references.filter((item) => item.signal_id === reference.signal_id),
      });
      bySignal.set(reference.signal_id, existing);
    }
  }

  return new Map([...bySignal.entries()].map(([signalId, sources]) => [signalId, sourceIntelligenceFromSources([...sources.values()])]));
}

export async function buildSignalSourceIntelligence(signalId: string) {
  const signalSources = await buildSignalSources(signalId);
  if (!signalSources) return null;
  return sourceIntelligenceFromSources(signalSources.sources);
}

export async function getSource(sourceId: string) {
  const registry = await buildSourceRegistry({ limit: 500 });
  return registry.sources.find((source) => source.id === sourceId) ?? null;
}

export async function buildSignalSources(signalId: string) {
  const signal = await prisma.signal.findUnique({ where: { id: signalId }, select: { id: true, title: true, category: true, status: true } });
  if (!signal) return null;

  const registry = await buildSourceRegistry({ limit: 500 });
  const sources = registry.sources
    .map((source) => ({
      ...source,
      references: source.references.filter((reference) => reference.signal_id === signalId),
    }))
    .filter((source) => source.references.length > 0)
    .map((source) => ({
      ...source,
      reference_count: source.references.length,
      roles: [...new Set(source.references.map((reference) => reference.role))],
    }));

  return {
    generated_at: new Date().toISOString(),
    policy: sourceRegistryPolicy(),
    signal,
    sources,
  };
}
