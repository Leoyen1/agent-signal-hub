import type { Agent, SourceTaskClaim, SourceWatch } from "@prisma/client";
import { appBaseUrl } from "@/lib/agent-discovery";
import { prisma } from "@/lib/prisma";
import { jsonArray } from "@/lib/serializers";
import { sourceConflictSeverityRank } from "@/lib/source-conflicts";
import type { SourceConflictSeverity } from "@/lib/source-conflicts";
import { buildSourceRegistry, normalizeSourceUrl, type SourceRecord } from "@/lib/sources";

type WatchWithAgent = SourceWatch & {
  agent: Pick<Agent, "id" | "name" | "agentType" | "focusAreas" | "capabilities" | "reputationScore" | "trustLevel" | "lastSeenAt">;
};

type SourceClaimWithAgent = SourceTaskClaim & {
  agent: Pick<Agent, "id" | "name" | "agentType" | "reputationScore" | "trustLevel">;
};

type RendezvousQuery = {
  source_id?: string;
  host?: string;
  target_type?: "source" | "host";
  min_watchers?: number;
  limit?: number;
};

type RendezvousBucket = {
  id: string;
  target_type: "source" | "host";
  source_id?: string;
  host?: string;
  source?: SourceRecord;
  sources?: SourceRecord[];
  watches: WatchWithAgent[];
};

function normalizeHost(host: string) {
  return host.trim().toLowerCase().replace(/^www\./, "");
}

function watchSourceId(watch: SourceWatch) {
  if (watch.sourceId) return watch.sourceId;
  if (!watch.url) return null;
  try {
    return normalizeSourceUrl(watch.url).id;
  } catch {
    return null;
  }
}

function rendezvousUrl(path: string) {
  return `${appBaseUrl()}${path}`;
}

function targetKey(input: { target_type: "source" | "host"; source_id?: string | null; host?: string | null }) {
  return input.target_type === "source" ? `source:${input.source_id}` : `host:${input.host ? normalizeHost(input.host) : ""}`;
}

export function sourceRendezvousPolicy() {
  return {
    schema_version: "2026-07-11",
    purpose:
      "Create derived agent-to-agent gathering objects around shared source attention. This is source-centered coordination, not a human chat room.",
    derivation: "Rendezvous objects are generated from active SourceWatch records with rendezvous_opt_in=true.",
    target_types: {
      source: "Agents opted in to the same normalized source_id or URL.",
      host: "Agents opted in to the same normalized host.",
    },
    privacy_boundary:
      "Only opted-in source watches participate. Private source_watch_matched events remain visible only to the owning agent.",
    coordination_model:
      "Agents should inspect sources, claim tasks, submit validations, create challenges, or hand off work through existing protocol endpoints.",
    non_inputs: ["human popularity", "likes", "followers", "traffic", "paid placement"],
  };
}

function sourceQuality(source: SourceRecord | undefined) {
  if (!source) {
    return {
      reliability: "unknown",
      dispute_pressure: 0,
      supportive_references: 0,
      reference_count: 0,
      conflict_severity: "clear",
      conflict_pressure: 0,
    };
  }

  return {
    reliability: source.reliability,
    dispute_pressure: source.quality_inputs.dispute_pressure,
    supportive_references: source.quality_inputs.supportive_references,
    reference_count: source.reference_count,
    conflict_severity: source.conflict_summary.severity,
    conflict_pressure: source.conflict_summary.unresolved_pressure,
  };
}

function bucketConflictSummary(bucket: RendezvousBucket) {
  const sources = bucket.sources ?? (bucket.source ? [bucket.source] : []);
  if (!sources.length) {
    return {
      max_severity: "clear" as SourceConflictSeverity,
      conflict_count: 0,
      conflict_pressure: 0,
      blocked_source_count: 0,
      contested_source_count: 0,
      links: bucket.host ? { host_conflicts: rendezvousUrl(`/api/source-conflicts?target_type=host&host=${encodeURIComponent(bucket.host)}`) } : {},
    };
  }

  const maxSeverity = sources.reduce<SourceConflictSeverity>(
    (max, source) => (sourceConflictSeverityRank[source.conflict_summary.severity] > sourceConflictSeverityRank[max] ? source.conflict_summary.severity : max),
    "clear",
  );

  return {
    max_severity: maxSeverity,
    conflict_count: sources.filter((source) => source.conflict_summary.severity !== "clear").length,
    conflict_pressure: Number(sources.reduce((total, source) => total + source.conflict_summary.unresolved_pressure, 0).toFixed(2)),
    blocked_source_count: sources.filter((source) => source.conflict_summary.severity === "blocked").length,
    contested_source_count: sources.filter((source) => source.conflict_summary.severity === "contested").length,
    links: {
      ...(bucket.source_id ? { source_conflicts: rendezvousUrl(`/api/source-conflicts?target_type=source&source_id=${bucket.source_id}`) } : {}),
      ...(bucket.host ? { host_conflicts: rendezvousUrl(`/api/source-conflicts?target_type=host&host=${encodeURIComponent(bucket.host)}`) } : {}),
    },
  };
}

function recommendedActions(bucket: RendezvousBucket) {
  const quality = sourceQuality(bucket.source);
  if (quality.dispute_pressure > quality.supportive_references) {
    return ["divide_source_review", "inspect_source_challenges", "submit_context_or_dispute_validation", "claim_dispute_review_task"];
  }
  if (quality.reliability === "reinforced") {
    return ["reuse_with_citation_check", "watch_for_regression", "summarize_source_impact"];
  }
  return ["coordinate_independent_validation", "gather_additional_evidence", "claim_validation_or_evidence_task"];
}

function formatParticipant(watch: WatchWithAgent) {
  return {
    agent: {
      id: watch.agent.id,
      name: watch.agent.name,
      type: watch.agent.agentType,
      reputation_score: watch.agent.reputationScore,
      trust_level: watch.agent.trustLevel,
      last_seen_at: watch.agent.lastSeenAt?.toISOString(),
      card: rendezvousUrl(`/api/agents/${watch.agent.id}/card`),
    },
    watch: {
      id: watch.id,
      label: watch.label,
      reason: watch.reason,
      target: {
        source_id: watch.sourceId,
        url: watch.url,
        host: watch.host,
      },
      created_at: watch.createdAt.toISOString(),
      updated_at: watch.updatedAt.toISOString(),
    },
  };
}

function formatCompletedTask(claim: SourceClaimWithAgent) {
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
      card: rendezvousUrl(`/api/agents/${claim.agent.id}/card`),
    },
    link: rendezvousUrl(`/api/agents/${claim.agent.id}/source-tasks/${claim.id}`),
  };
}

async function completedClaimsForTargets(targets: Array<{ target_type: "source" | "host"; source_id?: string | null; host?: string | null }>) {
  if (!targets.length) return new Map<string, SourceClaimWithAgent[]>();

  const claims = await prisma.sourceTaskClaim.findMany({
    where: {
      status: "completed",
      OR: targets.map((target) =>
        target.target_type === "source"
          ? { targetType: "source", sourceId: target.source_id ?? undefined }
          : { targetType: "host", host: target.host ? normalizeHost(target.host) : undefined },
      ),
    },
    include: { agent: { select: { id: true, name: true, agentType: true, reputationScore: true, trustLevel: true } } },
    orderBy: { updatedAt: "desc" },
    take: 500,
  });

  const byTarget = new Map<string, SourceClaimWithAgent[]>();
  for (const claim of claims) {
    const key = targetKey({ target_type: claim.targetType as "source" | "host", source_id: claim.sourceId, host: claim.host });
    byTarget.set(key, [...(byTarget.get(key) ?? []), claim]);
  }
  return byTarget;
}

function formatBucket(bucket: RendezvousBucket, completedClaims: SourceClaimWithAgent[] = []) {
  const participantAgents = new Set(bucket.watches.map((watch) => watch.agentId));
  const source = bucket.source;
  const recentCompletedTasks = completedClaims.slice(0, 5).map(formatCompletedTask);

  return {
    id: bucket.id,
    target_type: bucket.target_type,
    target: {
      source_id: bucket.source_id,
      host: bucket.host,
      source_url: source?.canonical_url,
    },
    watcher_count: bucket.watches.length,
    participant_agent_count: participantAgents.size,
    source_quality: sourceQuality(source),
    source_conflicts: bucketConflictSummary(bucket),
    completed_task_count: completedClaims.length,
    recent_completed_tasks: recentCompletedTasks,
    completion_effects: {
      routing_effect:
        completedClaims.length > 0
          ? "completed_source_task_increases_agent_coordination_evidence"
          : "no_completed_source_task_evidence",
      recent_completed_task_count: recentCompletedTasks.length,
      reputation_effect_note: "Completed source task records are coordination evidence only and do not directly change reputation or trust level.",
    },
    recommended_actions: recommendedActions(bucket),
    participants: bucket.watches.map(formatParticipant),
    links: {
      self:
        bucket.target_type === "source" && bucket.source_id
          ? rendezvousUrl(`/api/sources/${bucket.source_id}/rendezvous`)
          : rendezvousUrl(`/api/source-rendezvous?host=${encodeURIComponent(bucket.host ?? "")}&target_type=host`),
      ...(bucket.source_id ? { source: rendezvousUrl(`/api/sources/${bucket.source_id}`) } : {}),
      ...(bucket.host ? { host_sources: rendezvousUrl(`/api/sources?host=${encodeURIComponent(bucket.host)}`) } : {}),
      tasks: rendezvousUrl("/api/tasks"),
      challenges: rendezvousUrl("/api/challenges"),
      trust_graph: rendezvousUrl("/api/trust-graph"),
    },
  };
}

export async function buildSourceRendezvous(query: RendezvousQuery = {}) {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const minWatchers = Math.min(Math.max(query.min_watchers ?? 2, 1), 20);
  const [watches, registry] = await Promise.all([
    prisma.sourceWatch.findMany({
      where: {
        status: "active",
        rendezvousOptIn: true,
      },
      include: {
        agent: {
          select: {
            id: true,
            name: true,
            agentType: true,
            focusAreas: true,
            capabilities: true,
            reputationScore: true,
            trustLevel: true,
            lastSeenAt: true,
          },
        },
      },
      orderBy: { updatedAt: "desc" },
      take: 500,
    }),
    buildSourceRegistry({ limit: 500 }),
  ]);

  const sourceById = new Map(registry.sources.map((source) => [source.id, source]));
  const sourcesByHost = new Map<string, SourceRecord[]>();
  for (const source of registry.sources) {
    sourcesByHost.set(source.host, [...(sourcesByHost.get(source.host) ?? []), source]);
  }
  const buckets = new Map<string, RendezvousBucket>();

  for (const watch of watches) {
    const sourceId = watchSourceId(watch);
    const host = watch.host ? normalizeHost(watch.host) : sourceId ? sourceById.get(sourceId)?.host : undefined;

    if ((!query.target_type || query.target_type === "source") && sourceId && (!query.source_id || query.source_id === sourceId)) {
      const key = `source:${sourceId}`;
      const bucket =
        buckets.get(key) ??
        ({
          id: `rv_src_${sourceId.replace(/^src_/, "")}`,
          target_type: "source",
          source_id: sourceId,
          host,
          source: sourceById.get(sourceId),
          sources: sourceById.get(sourceId) ? [sourceById.get(sourceId)!] : [],
          watches: [],
        } satisfies RendezvousBucket);
      bucket.watches.push(watch);
      buckets.set(key, bucket);
    }

    if ((!query.target_type || query.target_type === "host") && host && (!query.host || normalizeHost(query.host) === host)) {
      const key = `host:${host}`;
      const bucket =
        buckets.get(key) ??
        ({
          id: `rv_host_${host.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "")}`,
          target_type: "host",
          host,
          sources: sourcesByHost.get(host) ?? [],
          watches: [],
        } satisfies RendezvousBucket);
      bucket.watches.push(watch);
      buckets.set(key, bucket);
    }
  }

  const filteredBuckets = [...buckets.values()].filter((bucket) => new Set(bucket.watches.map((watch) => watch.agentId)).size >= minWatchers);
  const completedClaims = await completedClaimsForTargets(
    filteredBuckets.map((bucket) => ({
      target_type: bucket.target_type,
      source_id: bucket.source_id,
      host: bucket.host,
    })),
  );

  const rendezvous = filteredBuckets
    .map((bucket) => formatBucket(bucket, completedClaims.get(targetKey({ target_type: bucket.target_type, source_id: bucket.source_id, host: bucket.host })) ?? []))
    .sort(
      (a, b) =>
        b.participant_agent_count - a.participant_agent_count ||
        b.completed_task_count - a.completed_task_count ||
        b.watcher_count - a.watcher_count,
    )
    .slice(0, limit);

  return {
    generated_at: new Date().toISOString(),
    policy: sourceRendezvousPolicy(),
    query: {
      source_id: query.source_id,
      host: query.host ? normalizeHost(query.host) : undefined,
      target_type: query.target_type,
      min_watchers: minWatchers,
      limit,
    },
    rendezvous,
  };
}

export async function buildSourceRendezvousForSource(sourceId: string, query: Omit<RendezvousQuery, "source_id" | "target_type"> = {}) {
  return buildSourceRendezvous({ ...query, source_id: sourceId, target_type: "source" });
}
