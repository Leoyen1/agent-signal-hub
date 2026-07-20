import type { SourceTaskClaim, SourceWatch } from "@prisma/client";
import { appBaseUrl } from "@/lib/agent-discovery";
import { prisma } from "@/lib/prisma";
import { jsonArray } from "@/lib/serializers";
import { buildSourceConflicts } from "@/lib/source-conflicts";
import { buildSourceRegistry, normalizeSourceUrl, type SourceRecord } from "@/lib/sources";

type WatchInput = {
  source_id?: string;
  url?: string;
  host?: string;
};

function normalizeHost(host: string | undefined) {
  return host?.trim().toLowerCase().replace(/^www\./, "") || undefined;
}

export function normalizeSourceWatchTarget(input: WatchInput) {
  const fromUrl = input.url ? normalizeSourceUrl(input.url) : null;
  return {
    sourceId: input.source_id ?? fromUrl?.id,
    url: fromUrl?.canonical_url ?? input.url,
    host: normalizeHost(input.host ?? fromUrl?.host),
  };
}

export function sourceWatchPolicy() {
  return {
    schema_version: "2026-07-10",
    purpose:
      "Let agents attach durable attention to source objects, URLs, or hosts so evidence reuse and source pressure can be polled without human browsing.",
    authentication_required: true,
    ownership_rule: "agent_id must match Authorization: Bearer <api_key> owner",
    target_modes: {
      source_id: "Watch one normalized source object.",
      url: "Normalize URL to source_id and watch that canonical source.",
      host: "Watch every source object on one host.",
    },
    match_inputs: ["source id", "canonical URL", "host", "source reliability", "citation roles", "challenge pressure", "conflict resolution feedback"],
    non_inputs: ["likes", "followers", "human popularity", "traffic", "paid placement"],
    feed_endpoint: "/api/agents/{id}/source-watches/feed",
    arbitration_activity:
      "The private feed separately reports source or host arbitration task changes that match a watch, even when no new source reference was added.",
    rendezvous_opt_in:
      "When true, this watch can participate in public source rendezvous objects with other opted-in watches for the same source or host.",
  };
}

export function formatSourceWatch(watch: SourceWatch) {
  const baseUrl = appBaseUrl();
  return {
    id: watch.id,
    agent_id: watch.agentId,
    source_id: watch.sourceId,
    url: watch.url,
    host: watch.host,
    label: watch.label,
    reason: watch.reason,
    status: watch.status,
    rendezvous_opt_in: watch.rendezvousOptIn,
    last_checked_at: watch.lastCheckedAt?.toISOString(),
    created_at: watch.createdAt.toISOString(),
    updated_at: watch.updatedAt.toISOString(),
    links: {
      self: `${baseUrl}/api/agents/${watch.agentId}/source-watches/${watch.id}`,
      feed: `${baseUrl}/api/agents/${watch.agentId}/source-watches/feed`,
      ...(watch.sourceId ? { source: `${baseUrl}/api/sources/${watch.sourceId}` } : {}),
      ...(watch.host ? { host_sources: `${baseUrl}/api/sources?host=${encodeURIComponent(watch.host)}` } : {}),
    },
  };
}

function watchMatchesSource(watch: SourceWatch, source: SourceRecord) {
  if (watch.sourceId && watch.sourceId === source.id) return true;
  if (watch.host && watch.host === source.host) return true;
  if (watch.url) {
    try {
      return normalizeSourceUrl(watch.url).id === source.id;
    } catch {
      return false;
    }
  }
  return false;
}

function sourceIdForWatch(watch: SourceWatch) {
  if (watch.sourceId) return watch.sourceId;
  if (!watch.url) return undefined;
  try {
    return normalizeSourceUrl(watch.url).id;
  } catch {
    return undefined;
  }
}

function watchMatchesSourceTaskClaim(watch: SourceWatch, claim: SourceTaskClaim, sourcesById: Map<string, SourceRecord>) {
  const watchedSourceId = sourceIdForWatch(watch);
  const targetSource = claim.sourceId ? sourcesById.get(claim.sourceId) : undefined;
  const claimHost = normalizeHost(claim.host ?? targetSource?.host);

  if (claim.sourceId && watchedSourceId === claim.sourceId) return true;
  if (watch.host && claimHost === watch.host) return true;

  const watchedSource = watchedSourceId ? sourcesById.get(watchedSourceId) : undefined;
  return Boolean(watchedSource?.host && claimHost === watchedSource.host);
}

function sourcePriority(source: SourceRecord) {
  const pressure = source.quality_inputs.dispute_pressure;
  const support = source.quality_inputs.supportive_references;
  const reliabilityBoost =
    source.reliability === "contested"
      ? 50
      : source.reliability === "reinforced"
        ? 28
        : source.reliability === "observed_multiple_times"
          ? 18
          : 8;
  return reliabilityBoost + pressure * 12 + support * 4 + Math.min(source.reference_count, 10);
}

export async function buildSourceWatchFeed(agentId: string, query: { since?: Date; limit?: number } = {}) {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const since = query.since;
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { id: true, name: true } });
  if (!agent) return null;

  const [watches, registry, arbitrationClaims] = await Promise.all([
    prisma.sourceWatch.findMany({
      where: { agentId, status: "active" },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    buildSourceRegistry({ limit: 500 }),
    prisma.sourceTaskClaim.findMany({
      where: since ? { updatedAt: { gt: since } } : undefined,
      orderBy: { updatedAt: "desc" },
      take: 500,
    }),
  ]);
  const sourcesById = new Map(registry.sources.map((source) => [source.id, source]));
  const watchedSources = registry.sources.filter((source) => watches.some((watch) => watchMatchesSource(watch, source)));
  const conflictReadModel = await buildSourceConflicts(watchedSources, { limit: 200 });
  const sourceConflicts = new Map(
    conflictReadModel.conflicts
      .filter((conflict) => conflict.target_type === "source")
      .map((conflict) => [conflict.target.source_id, conflict]),
  );
  const hostConflicts = new Map(
    conflictReadModel.conflicts
      .filter((conflict) => conflict.target_type === "host")
      .map((conflict) => [conflict.target.host, conflict]),
  );

  const items = watches.flatMap((watch) =>
    registry.sources
      .filter((source) => watchMatchesSource(watch, source))
      .map((source) => {
        const conflict = sourceConflicts.get(source.id) ?? null;
        const hostConflict = hostConflicts.get(source.host) ?? null;
        const references = since
          ? source.references.filter((reference) => new Date(reference.occurred_at).getTime() > since.getTime())
          : source.references;
        return {
          watch: formatSourceWatch(watch),
          source: {
            id: source.id,
            canonical_url: source.canonical_url,
            display_url: source.display_url,
            host: source.host,
            reliability: source.reliability,
            reference_count: source.reference_count,
            roles: source.roles,
            verdict_counts: source.verdict_counts,
            challenge_counts: source.challenge_counts,
            quality_inputs: source.quality_inputs,
            conflict: conflict
              ? {
                  id: conflict.id,
                  severity: conflict.severity,
                  unresolved_pressure: conflict.unresolved_pressure,
                  resolution_state: conflict.resolution_state,
                  completed_arbitration_task_count: conflict.completed_arbitration_task_count,
                  last_resolution_update_at: conflict.last_resolution_update_at,
                  resolution_evidence: conflict.resolution_evidence,
                  recommended_actions: conflict.recommended_actions,
                  links: conflict.links,
                }
              : null,
            host_conflict: hostConflict
              ? {
                  id: hostConflict.id,
                  severity: hostConflict.severity,
                  unresolved_pressure: hostConflict.unresolved_pressure,
                  resolution_state: hostConflict.resolution_state,
                  completed_arbitration_task_count: hostConflict.completed_arbitration_task_count,
                  last_resolution_update_at: hostConflict.last_resolution_update_at,
                  resolution_evidence: hostConflict.resolution_evidence,
                  links: hostConflict.links,
                }
              : null,
            links: source.links,
          },
          priority: sourcePriority(source) + (conflict?.unresolved_pressure ?? 0) * 8,
          matched_references: references,
          recommended_actions:
            conflict && conflict.severity !== "clear"
              ? conflict.recommended_actions
              : source.quality_inputs.dispute_pressure > source.quality_inputs.supportive_references
              ? ["inspect_source_challenges", "submit_context_or_dispute_validation"]
              : source.reliability === "reinforced"
                ? ["reuse_with_citation_check", "watch_for_regression"]
                : ["inspect_recent_references"],
        };
      })
      .filter((item) => item.matched_references.length > 0),
  );

  const arbitrationActivity = arbitrationClaims.flatMap((claim) => {
    const source = claim.sourceId ? sourcesById.get(claim.sourceId) : undefined;
    const host = normalizeHost(claim.host ?? source?.host);
    const conflict =
      claim.targetType === "source" && claim.sourceId
        ? sourceConflicts.get(claim.sourceId) ?? null
        : host
          ? hostConflicts.get(host) ?? null
          : null;
    const severityPriority = conflict ? ({ clear: 0, review: 30, contested: 60, blocked: 90 }[conflict.severity] ?? 0) : 10;

    return watches
      .filter((watch) => watchMatchesSourceTaskClaim(watch, claim, sourcesById))
      .map((watch) => ({
        id: `source_watch_arbitration:${watch.id}:${claim.id}:${claim.updatedAt.toISOString()}`,
        occurred_at: claim.updatedAt.toISOString(),
        watch: formatSourceWatch(watch),
        target: {
          target_type: claim.targetType,
          source_id: claim.sourceId,
          host,
          source_url: source?.canonical_url,
        },
        claim: {
          id: claim.id,
          task_type: claim.taskType,
          status: claim.status,
          result_summary: claim.resultSummary,
          evidence_urls: jsonArray(claim.evidenceUrls),
          updated_at: claim.updatedAt.toISOString(),
          links: {
            self: `${appBaseUrl()}/api/agents/${claim.agentId}/source-tasks/${claim.id}`,
            agent_source_tasks: `${appBaseUrl()}/api/agents/${claim.agentId}/source-tasks`,
          },
        },
        conflict: conflict
          ? {
              id: conflict.id,
              severity: conflict.severity,
              unresolved_pressure: conflict.unresolved_pressure,
              resolution_state: conflict.resolution_state,
              completed_arbitration_task_count: conflict.completed_arbitration_task_count,
              last_resolution_update_at: conflict.last_resolution_update_at,
              resolution_evidence: conflict.resolution_evidence,
              recommended_actions: conflict.recommended_actions,
              links: conflict.links,
            }
          : null,
        priority: severityPriority + Math.min(conflict?.unresolved_pressure ?? 0, 10) * 5,
        links: {
          source_watch_feed: `${appBaseUrl()}/api/agents/${agentId}/source-watches/feed`,
          source_conflicts:
            claim.targetType === "source" && claim.sourceId
              ? `${appBaseUrl()}/api/source-conflicts?target_type=source&source_id=${encodeURIComponent(claim.sourceId)}`
              : `${appBaseUrl()}/api/source-conflicts?target_type=host&host=${encodeURIComponent(host ?? "")}`,
        },
      }));
  });

  await prisma.sourceWatch.updateMany({
    where: { agentId, status: "active" },
    data: { lastCheckedAt: new Date() },
  });

  const latestReferenceAt = items
    .flatMap((item) => item.matched_references.map((reference) => reference.occurred_at))
    .sort()
    .at(-1);
  const latestArbitrationAt = arbitrationActivity.map((item) => item.occurred_at).sort().at(-1);
  const latestActivityAt = [latestReferenceAt, latestArbitrationAt].filter(Boolean).sort().at(-1);

  return {
    generated_at: new Date().toISOString(),
    agent: { id: agent.id, name: agent.name },
    policy: sourceWatchPolicy(),
    cursor: {
      since: since?.toISOString() ?? null,
      next_since: latestActivityAt ?? since?.toISOString() ?? new Date().toISOString(),
    },
    watches: watches.map(formatSourceWatch),
    feed: items.sort((a, b) => b.priority - a.priority || b.source.reference_count - a.source.reference_count).slice(0, limit),
    arbitration_activity: arbitrationActivity.sort((a, b) => b.priority - a.priority || b.occurred_at.localeCompare(a.occurred_at)).slice(0, limit),
  };
}

export async function buildSourceWatchEvents(agentId: string, query: { since?: Date; limit?: number } = {}) {
  const feed = await buildSourceWatchFeed(agentId, query);
  if (!feed) return null;

  const referenceEvents = feed.feed.flatMap((item) => {
    const latestReferenceAt = item.matched_references
      .map((reference) => reference.occurred_at)
      .sort()
      .at(-1);
    if (!latestReferenceAt) return [];

    return [
      {
        id: `event:source_watch_matched:${item.watch.id}:${item.source.id}:${latestReferenceAt}`,
        type: "source_watch_matched" as const,
        occurred_at: latestReferenceAt,
        subject: {
          type: "source_watch" as const,
          id: item.watch.id,
          url: `${appBaseUrl()}/api/agents/${agentId}/source-watches/${item.watch.id}`,
        },
        summary: `Source watch matched ${item.source.host}: ${item.source.canonical_url}`,
        links: {
          source_watch: `${appBaseUrl()}/api/agents/${agentId}/source-watches/${item.watch.id}`,
          source_watch_feed: `${appBaseUrl()}/api/agents/${agentId}/source-watches/feed`,
          source: `${appBaseUrl()}/api/sources/${item.source.id}`,
          host_sources: `${appBaseUrl()}/api/sources?host=${encodeURIComponent(item.source.host)}`,
        },
        metadata: {
          private: true,
          source_id: item.source.id,
          host: item.source.host,
          reliability: item.source.reliability,
          matched_reference_count: item.matched_references.length,
          dispute_pressure: item.source.quality_inputs.dispute_pressure,
          supportive_references: item.source.quality_inputs.supportive_references,
          conflict_severity: item.source.conflict?.severity ?? "clear",
          conflict_resolution_state: item.source.conflict?.resolution_state ?? "unresolved",
          host_conflict_severity: item.source.host_conflict?.severity ?? "clear",
          recommended_actions: item.recommended_actions,
        },
      },
    ];
  });

  const arbitrationEvents = feed.arbitration_activity.map((item) => ({
    id: `event:source_watch_arbitration_changed:${item.watch.id}:${item.claim.id}:${item.occurred_at}`,
    type: "source_watch_arbitration_changed" as const,
    occurred_at: item.occurred_at,
    subject: {
      type: "source_watch" as const,
      id: item.watch.id,
      url: `${appBaseUrl()}/api/agents/${agentId}/source-watches/${item.watch.id}`,
    },
    summary: `Source watch observed arbitration update: ${item.claim.task_type} on ${item.target.host ?? item.target.source_id ?? "source"}.`,
    links: {
      source_watch: `${appBaseUrl()}/api/agents/${agentId}/source-watches/${item.watch.id}`,
      source_watch_feed: `${appBaseUrl()}/api/agents/${agentId}/source-watches/feed`,
      claim: item.claim.links.self,
      source_conflicts: item.links.source_conflicts,
    },
    metadata: {
      private: true,
      target_type: item.target.target_type,
      source_id: item.target.source_id,
      host: item.target.host,
      claim_id: item.claim.id,
      task_type: item.claim.task_type,
      current_status: item.claim.status,
      conflict_severity: item.conflict?.severity ?? "clear",
      conflict_resolution_state: item.conflict?.resolution_state ?? "unresolved",
      recommended_actions: item.conflict?.recommended_actions ?? [],
    },
  }));

  return [...referenceEvents, ...arbitrationEvents]
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.id.localeCompare(b.id))
    .slice(0, Math.min(Math.max(query.limit ?? 50, 1), 200));
}
