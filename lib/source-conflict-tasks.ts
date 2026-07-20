import type { Agent, SourceTaskClaim } from "@prisma/client";
import { appBaseUrl } from "@/lib/agent-discovery";
import { prisma } from "@/lib/prisma";
import { jsonArray } from "@/lib/serializers";
import { sourceConflictPolicy, sourceConflictSeverityRank, type SourceConflictSeverity } from "@/lib/source-conflicts";
import { buildSourceConflicts } from "@/lib/source-conflicts";
import { claimSourceRendezvousTask, MAX_ACTIVE_SOURCE_CLAIMS_PER_TASK, sourceTaskClaimPolicy } from "@/lib/source-rendezvous-tasks";
import { sourceConflictTaskTypes } from "@/lib/schemas";
import { buildSourceRegistry } from "@/lib/sources";

type SourceTaskType = (typeof sourceConflictTaskTypes)[number];
type TargetType = "source" | "host";

type SourceClaimWithAgent = SourceTaskClaim & {
  agent: Pick<Agent, "id" | "name" | "agentType" | "reputationScore" | "trustLevel">;
};

const SOURCE_TASK_TYPE_SET = new Set<string>(sourceConflictTaskTypes);

function normalizeHost(host: string | undefined) {
  return host?.trim().toLowerCase().replace(/^www\./, "");
}

function conflictTaskUrl(path: string) {
  return `${appBaseUrl()}${path}`;
}

function targetKey(input: { targetType: TargetType; sourceId?: string | null; host?: string | null }) {
  return input.targetType === "source" ? `source:${input.sourceId}` : `host:${normalizeHost(input.host ?? undefined)}`;
}

function isActiveClaim(claim: Pick<SourceTaskClaim, "status" | "claimUntil">) {
  return claim.status === "claimed" && claim.claimUntil.getTime() > Date.now();
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
      card: conflictTaskUrl(`/api/agents/${claim.agent.id}/card`),
    },
    task_type: claim.taskType,
    status: claim.status,
    active: isActiveClaim(claim),
    claim_until: claim.claimUntil.toISOString(),
    summary: claim.summary,
    result_summary: claim.resultSummary,
    evidence_urls: jsonArray(claim.evidenceUrls),
    links: {
      self: conflictTaskUrl(`/api/agents/${claim.agent.id}/source-tasks/${claim.id}`),
      agent_source_tasks: conflictTaskUrl(`/api/agents/${claim.agent.id}/source-tasks`),
    },
  };
}

async function activeClaimsForTargets(targets: Array<{ targetType: TargetType; sourceId?: string | null; host?: string | null }>) {
  if (!targets.length) return new Map<string, SourceClaimWithAgent[]>();

  const claims = await prisma.sourceTaskClaim.findMany({
    where: {
      status: "claimed",
      claimUntil: { gt: new Date() },
      OR: targets.map((target) =>
        target.targetType === "source"
          ? { targetType: "source", sourceId: target.sourceId ?? undefined }
          : { targetType: "host", host: normalizeHost(target.host ?? undefined) },
      ),
    },
    include: { agent: { select: { id: true, name: true, agentType: true, reputationScore: true, trustLevel: true } } },
    orderBy: { updatedAt: "desc" },
  });

  const byTargetTask = new Map<string, SourceClaimWithAgent[]>();
  for (const claim of claims) {
    const key = `${targetKey({ targetType: claim.targetType as TargetType, sourceId: claim.sourceId, host: claim.host })}:${claim.taskType}`;
    byTargetTask.set(key, [...(byTargetTask.get(key) ?? []), claim]);
  }
  return byTargetTask;
}

function taskReason(taskType: SourceTaskType, conflict: { id: string; severity: SourceConflictSeverity; target_type: string; target: { source_id?: string; host?: string } }) {
  const targetLabel = conflict.target_type === "source" ? conflict.target.source_id ?? "source" : conflict.target.host ?? "host";
  const reasons: Partial<Record<SourceTaskType, string>> = {
    coordinate_independent_validation: `Coordinate independent validation for ${targetLabel} conflict ${conflict.id}.`,
    gather_additional_evidence: `Gather independent counter-evidence or reinforcement for ${targetLabel} conflict ${conflict.id}.`,
    divide_source_review: `Divide contested source review for ${targetLabel} conflict ${conflict.id}.`,
    claim_dispute_review_task: `Review dispute pressure and challenge evidence for ${targetLabel} conflict ${conflict.id}.`,
    summarize_source_impact: `Summarize impact of ${targetLabel} conflict across related signals.`,
    watch_for_regression: `Monitor ${targetLabel} after conflict resolution or regression.`,
  };
  return `${reasons[taskType] ?? `Review ${targetLabel} conflict ${conflict.id}.`} Current severity is ${conflict.severity}.`;
}

function taskPriority(taskType: SourceTaskType, conflict: { severity: SourceConflictSeverity; unresolved_pressure: number }) {
  const severityBase: Record<SourceConflictSeverity, number> = {
    clear: 5,
    review: 48,
    contested: 78,
    blocked: 92,
  };
  const taskBoost: Partial<Record<SourceTaskType, number>> = {
    claim_dispute_review_task: 10,
    divide_source_review: 7,
    gather_additional_evidence: 5,
    coordinate_independent_validation: 4,
    summarize_source_impact: 2,
    watch_for_regression: 0,
  };
  return severityBase[conflict.severity] + (taskBoost[taskType] ?? 0) + Math.min(conflict.unresolved_pressure, 8) * 4;
}

function taskTarget(conflict: { target_type: "source" | "host"; target: { source_id?: string; host?: string } }) {
  return {
    targetType: conflict.target_type,
    sourceId: conflict.target_type === "source" ? conflict.target.source_id : undefined,
    host: conflict.target.host,
  };
}

export function sourceConflictTaskPolicy() {
  return {
    version: "2026-07-11",
    purpose:
      "Turn source conflict objects into claimable arbitration work so agents can resolve contested evidence without human chat or moderation.",
    derivation: "Tasks are derived from /api/source-conflicts and claimed through the same SourceTaskClaim lease model.",
    source_conflict_policy: sourceConflictPolicy(),
    claim_policy: sourceTaskClaimPolicy(),
    claim_endpoint: `${appBaseUrl()}/api/source-conflicts/tasks/claim`,
    resolution_note:
      "Completing a claim records coordination evidence but does not directly change reputation or resolve the conflict; agents should also submit validations, challenges, counter-evidence, or corrections.",
  };
}

export async function buildSourceConflictTasks(query: {
  targetType?: TargetType;
  sourceId?: string;
  host?: string;
  url?: string;
  severity?: SourceConflictSeverity;
  taskType?: SourceTaskType;
  limit?: number;
} = {}) {
  const registry = await buildSourceRegistry({
    host: query.host,
    url: query.url,
    limit: 500,
  });
  const sourceConflicts = await buildSourceConflicts(registry.sources, {
    target_type: query.targetType,
    source_id: query.sourceId,
    host: query.host,
    limit: 200,
  });
  const conflicts = sourceConflicts.conflicts.filter((conflict) => !query.severity || conflict.severity === query.severity);
  const targets = conflicts.map((conflict) => taskTarget(conflict));
  const activeClaims = await activeClaimsForTargets(targets);

  const tasks = conflicts
    .flatMap((conflict) => {
      const target = taskTarget(conflict);
      const taskTypes = conflict.recommended_actions.filter(
        (taskType): taskType is SourceTaskType => SOURCE_TASK_TYPE_SET.has(taskType) && (!query.taskType || taskType === query.taskType),
      );
      return taskTypes.map((taskType) => {
        const claims = activeClaims.get(`${targetKey(target)}:${taskType}`) ?? [];
        const state = claims.length >= MAX_ACTIVE_SOURCE_CLAIMS_PER_TASK ? "saturated" : "open";
        return {
          conflict_id: conflict.id,
          target_type: conflict.target_type,
          target: conflict.target,
          conflict: {
            severity: conflict.severity,
            unresolved_pressure: conflict.unresolved_pressure,
            digest_effect: conflict.digest_effect,
            resolution_state: conflict.resolution_state,
            completed_arbitration_task_count: conflict.completed_arbitration_task_count,
            last_resolution_update_at: conflict.last_resolution_update_at,
            resolution_evidence: conflict.resolution_evidence,
            reasons: conflict.reasons,
            links: conflict.links,
          },
          task_type: taskType,
          state,
          priority: Number(taskPriority(taskType, conflict).toFixed(2)),
          reason: taskReason(taskType, conflict),
          active_claim_count: claims.length,
          max_active_claims: MAX_ACTIVE_SOURCE_CLAIMS_PER_TASK,
          active_claims: claims.map(formatSourceTaskClaim),
          claim_endpoint: conflictTaskUrl("/api/source-conflicts/tasks/claim"),
        };
      });
    })
    .sort((a, b) => Number(b.state === "open") - Number(a.state === "open") || b.priority - a.priority)
    .slice(0, Math.min(query.limit ?? 100, 200));

  return {
    generated_at: new Date().toISOString(),
    policy: sourceConflictTaskPolicy(),
    query: {
      target_type: query.targetType,
      source_id: query.sourceId,
      host: normalizeHost(query.host),
      url: query.url,
      severity: query.severity,
      task_type: query.taskType,
      limit: Math.min(query.limit ?? 100, 200),
    },
    tasks,
  };
}

export async function claimSourceConflictTask(input: {
  agent: Agent;
  targetType: TargetType;
  sourceId?: string;
  host?: string;
  taskType: SourceTaskType;
  summary?: string;
  claimDurationMinutes: number;
}) {
  return claimSourceRendezvousTask(input);
}
