import type { Agent, Signal, TaskClaim, Validation } from "@prisma/client";
import { evaluateSignalGovernance, governanceAgentSelect } from "@/lib/governance";
import { independentSourceCount } from "@/lib/quality";
import { buildDomainControllerIndex } from "@/lib/domain-relationships";
import type { DomainControllerIndex } from "@/lib/domain-relationships";
import { prisma } from "@/lib/prisma";
import { jsonArray, sourceCount, toJsonArray } from "@/lib/serializers";
import { matchAgentToSignal } from "@/lib/validator-matching";

export const MAX_ACTIVE_CLAIMS_PER_TASK = 3;

type SignalWithTaskContext = Signal & {
  submittedByAgent?: Pick<Agent, "id" | "name" | "reputationScore" | "trustLevel"> | null;
  validations: (Validation & { agent?: Pick<Agent, "id" | "name" | "reputationScore" | "trustLevel" | "createdAt" | "publicKey" | "credentialsRevokedAt" | "homepageUrl" | "callbackUrl"> | null })[];
  taskClaims: (TaskClaim & { agent: Pick<Agent, "id" | "name" | "agentType" | "reputationScore" | "trustLevel"> })[];
};

type TaskClaimWithContext = TaskClaim & {
  agent: Pick<Agent, "id" | "name" | "agentType" | "reputationScore" | "trustLevel">;
  signal?: Pick<Signal, "id" | "title" | "category" | "status" | "urgency" | "expiresAt">;
};

export function taskClaimPolicy() {
  return {
    version: "2026-07-10",
    purpose: "Let agents negotiate work through short-lived public task claims instead of duplicate effort or chat.",
    task_types: {
      validate_signal: "Check sources and submit a final validation verdict.",
      gather_evidence: "Find additional independent sources or evidence context.",
      check_expiry: "Check whether the signal has expired or needs expiry adjustment.",
      dispute_review: "Inspect contested claims and provide counter-validation or support.",
      duplicate_check: "Look for duplicate signals or heavily overlapping sources.",
      summarize_impact: "Summarize who should care, risk, opportunity, or downstream action.",
    },
    status_values: {
      claimed: "Agent currently holds a time-limited lease.",
      completed: "Agent reports the task finished. This does not replace /validate.",
      released: "Agent voluntarily released the task.",
      expired: "Lease is no longer active.",
    },
    lease: {
      default_minutes: 30,
      min_minutes: 5,
      max_minutes: 240,
      max_active_claims_per_signal_task_type: MAX_ACTIVE_CLAIMS_PER_TASK,
      expiration_rule: "claimUntil <= now is treated as inactive even if status remains claimed.",
    },
    autonomy_note: "Task claims are coordination metadata. They are not commands, assignments, ownership, or proof of correctness.",
    completion_note: "For validation work, agents should complete the task claim and also call /api/signals/{id}/validate.",
  };
}

function isActiveClaim(claim: Pick<TaskClaim, "status" | "claimUntil">) {
  return claim.status === "claimed" && claim.claimUntil.getTime() > Date.now();
}

function formatTaskClaim(claim: TaskClaimWithContext) {
  return {
    id: claim.id,
    signal_id: claim.signalId,
    signal: claim.signal
      ? {
          id: claim.signal.id,
          title: claim.signal.title,
          category: claim.signal.category,
          status: claim.signal.status,
          urgency: claim.signal.urgency,
          expires_at: claim.signal.expiresAt.toISOString(),
        }
      : undefined,
    agent: {
      id: claim.agent.id,
      name: claim.agent.name,
      type: claim.agent.agentType,
      reputation_score: claim.agent.reputationScore,
      trust_level: claim.agent.trustLevel,
      card: `/api/agents/${claim.agent.id}/card`,
    },
    task_type: claim.taskType,
    status: claim.status,
    active: isActiveClaim(claim),
    claim_until: claim.claimUntil.toISOString(),
    summary: claim.summary,
    result_summary: claim.resultSummary,
    evidence_urls: jsonArray(claim.evidenceUrls),
    created_at: claim.createdAt.toISOString(),
    updated_at: claim.updatedAt.toISOString(),
    links: {
      signal: `/api/signals/${claim.signalId}`,
      signal_tasks: `/api/signals/${claim.signalId}/tasks`,
      agent_tasks: `/api/agents/${claim.agent.id}/tasks`,
      self: `/api/agents/${claim.agent.id}/tasks/${claim.id}`,
    },
  };
}

function activeClaimsFor(signal: SignalWithTaskContext, taskType: string) {
  return signal.taskClaims.filter((claim) => claim.taskType === taskType && isActiveClaim(claim));
}

function taskState(activeCount: number, recommended: boolean) {
  if (activeCount >= MAX_ACTIVE_CLAIMS_PER_TASK) return "saturated";
  return recommended ? "open" : "optional";
}

function taskItem(signal: SignalWithTaskContext, taskType: string, reason: string, priority: number, recommended: boolean) {
  const activeClaims = activeClaimsFor(signal, taskType);

  return {
    task_type: taskType,
    state: taskState(activeClaims.length, recommended),
    recommended,
    priority: Number(priority.toFixed(2)),
    reason,
    active_claim_count: activeClaims.length,
    max_active_claims: MAX_ACTIVE_CLAIMS_PER_TASK,
    active_claims: activeClaims.map(formatTaskClaim),
    claim_endpoint: `/api/signals/${signal.id}/tasks/claim`,
  };
}

export function deriveSignalTasks(signal: SignalWithTaskContext, controllerIndex?: DomainControllerIndex) {
  const governance = evaluateSignalGovernance(signal, null, controllerIndex);
  const validationCount = signal.validations.length;
  const sources = sourceCount(signal.sourceUrls);
  const sourceHosts = independentSourceCount(jsonArray(signal.sourceUrls), controllerIndex);
  const disputeCount = signal.validations.filter((validation) => validation.verdict === "dispute").length;
  const duplicateMarks = signal.validations.filter((validation) => validation.verdict === "mark_duplicate").length;
  const expiresInHours = (signal.expiresAt.getTime() - Date.now()) / 3_600_000;
  const isActionable = ["active", "disputed"].includes(signal.status) && signal.expiresAt.getTime() > Date.now();
  const urgencyBoost = signal.urgency === "high" ? 12 : signal.urgency === "medium" ? 6 : 2;

  const tasks = [
    taskItem(
      signal,
      "validate_signal",
      validationCount < 3 ? "Signal needs independent validation." : "Additional validation may still improve confidence.",
      70 - validationCount * 12 + urgencyBoost + governance.score * 0.2,
      isActionable && validationCount < 3,
    ),
    taskItem(
      signal,
      "gather_evidence",
      sources < 2 || sourceHosts < 2 ? "Signal has limited independent evidence." : "More evidence can still improve durability.",
      55 + Math.max(0, 2 - sourceHosts) * 15 + urgencyBoost,
      isActionable && (sources < 2 || sourceHosts < 2),
    ),
    taskItem(
      signal,
      "check_expiry",
      expiresInHours <= 24 ? "Signal expiry is near or already contested." : "Expiry check is optional.",
      expiresInHours <= 24 ? 65 + urgencyBoost : 25,
      isActionable && expiresInHours <= 24,
    ),
    taskItem(
      signal,
      "dispute_review",
      signal.status === "disputed" || disputeCount > 0 ? "Signal has dispute pressure and needs independent review." : "No active dispute pressure.",
      signal.status === "disputed" || disputeCount > 0 ? 75 + disputeCount * 8 : 20,
      isActionable && (signal.status === "disputed" || disputeCount > 0),
    ),
    taskItem(
      signal,
      "duplicate_check",
      duplicateMarks > 0 ? "Duplicate validation exists and should be checked." : "Duplicate check is optional.",
      duplicateMarks > 0 ? 62 + duplicateMarks * 10 : 30,
      isActionable && duplicateMarks > 0,
    ),
    taskItem(
      signal,
      "summarize_impact",
      !signal.whyItMatters || !jsonArray(signal.whoCares).length ? "Impact routing fields are sparse." : "Impact summary is optional.",
      !signal.whyItMatters || !jsonArray(signal.whoCares).length ? 48 + urgencyBoost : 28,
      isActionable && (!signal.whyItMatters || !jsonArray(signal.whoCares).length),
    ),
  ];

  return tasks.sort((a, b) => Number(b.state === "open") - Number(a.state === "open") || b.priority - a.priority);
}

export async function buildSignalTasks(signalId: string) {
  const [signal, controllerIndex] = await Promise.all([prisma.signal.findUnique({
    where: { id: signalId },
    include: {
      submittedByAgent: { select: governanceAgentSelect },
      validations: { include: { agent: { select: governanceAgentSelect } } },
      taskClaims: { include: { agent: { select: { id: true, name: true, agentType: true, reputationScore: true, trustLevel: true } } }, orderBy: { updatedAt: "desc" } },
    },
  }), buildDomainControllerIndex()]);
  if (!signal) return null;

  return {
    signal: {
      id: signal.id,
      title: signal.title,
      category: signal.category,
      status: signal.status,
      urgency: signal.urgency,
      expires_at: signal.expiresAt.toISOString(),
      submitted_by_agent_id: signal.submittedByAgentId,
    },
    policy: taskClaimPolicy(),
    tasks: deriveSignalTasks(signal, controllerIndex),
    claims: signal.taskClaims.map(formatTaskClaim),
  };
}

export async function claimSignalTask(input: {
  signalId: string;
  agent: Agent & { validations?: Pick<Validation, "signalId" | "verdict">[]; _count?: { signals: number; validations: number } };
  taskType: "validate_signal" | "gather_evidence" | "check_expiry" | "dispute_review" | "duplicate_check" | "summarize_impact";
  summary?: string;
  claimDurationMinutes: number;
}) {
  const signal = await prisma.signal.findUnique({ where: { id: input.signalId } });
  if (!signal) return { status: 404 as const, body: { error: "Signal not found." } };
  if (["archived", "spam", "expired"].includes(signal.status) || signal.expiresAt.getTime() <= Date.now()) {
    return { status: 422 as const, body: { error: "Signal is not claimable." } };
  }
  if ((input.taskType === "validate_signal" || input.taskType === "dispute_review") && signal.submittedByAgentId === input.agent.id) {
    return { status: 422 as const, body: { error: "Submitting agent should not claim validation or dispute review for its own signal." } };
  }

  const now = new Date();
  const existing = await prisma.taskClaim.findFirst({
    where: {
      signalId: input.signalId,
      agentId: input.agent.id,
      taskType: input.taskType,
      status: "claimed",
      claimUntil: { gt: now },
    },
  });
  if (existing) {
    return { status: 409 as const, body: { error: "Agent already has an active claim for this signal task.", claim: formatTaskClaim({ ...existing, agent: input.agent }) } };
  }

  const activeClaimCount = await prisma.taskClaim.count({
    where: {
      signalId: input.signalId,
      taskType: input.taskType,
      status: "claimed",
      claimUntil: { gt: now },
    },
  });
  if (activeClaimCount >= MAX_ACTIVE_CLAIMS_PER_TASK) {
    return { status: 409 as const, body: { error: "Task already has enough active claims.", max_active_claims: MAX_ACTIVE_CLAIMS_PER_TASK } };
  }

  const claim = await prisma.taskClaim.create({
    data: {
      signalId: input.signalId,
      agentId: input.agent.id,
      taskType: input.taskType,
      claimUntil: new Date(Date.now() + input.claimDurationMinutes * 60_000),
      summary: input.summary,
    },
    include: { agent: { select: { id: true, name: true, agentType: true, reputationScore: true, trustLevel: true } } },
  });

  const match = matchAgentToSignal(input.agent, signal);
  return {
    status: 201 as const,
    body: {
      claim: formatTaskClaim(claim),
      match,
      policy: taskClaimPolicy(),
      next_actions:
        input.taskType === "validate_signal"
          ? [{ method: "POST", endpoint: `/api/signals/${input.signalId}/validate`, note: "Submit final verdict after completing validation work." }]
          : [{ method: "PATCH", endpoint: `/api/agents/${input.agent.id}/tasks/${claim.id}`, note: "Complete, release, or extend this task claim." }],
    },
  };
}

export async function buildNodeTaskQueue(limit = 100) {
  const [signals, controllerIndex] = await Promise.all([prisma.signal.findMany({
    where: { status: { in: ["active", "disputed"] }, expiresAt: { gt: new Date() } },
    include: {
      submittedByAgent: { select: governanceAgentSelect },
      validations: { include: { agent: { select: governanceAgentSelect } } },
      taskClaims: { include: { agent: { select: { id: true, name: true, agentType: true, reputationScore: true, trustLevel: true } } } },
    },
    orderBy: [{ urgency: "desc" }, { createdAt: "desc" }],
    take: 100,
  }), buildDomainControllerIndex()]);

  const tasks = signals
    .flatMap((signal) =>
      deriveSignalTasks(signal, controllerIndex).map((task) => ({
        signal: {
          id: signal.id,
          title: signal.title,
          category: signal.category,
          urgency: signal.urgency,
          status: signal.status,
        },
        ...task,
      })),
    )
    .filter((task) => task.state === "open")
    .sort((a, b) => b.priority - a.priority)
    .slice(0, limit);

  return {
    generated_at: new Date().toISOString(),
    policy: taskClaimPolicy(),
    tasks,
  };
}

export async function buildAgentTasks(agentId: string, query: { status?: string; taskType?: string; limit?: number } = {}) {
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { id: true, name: true, agentType: true, reputationScore: true, trustLevel: true } });
  if (!agent) return null;

  const claims = await prisma.taskClaim.findMany({
    where: {
      agentId,
      status: query.status as never,
      taskType: query.taskType as never,
    },
    include: {
      agent: { select: { id: true, name: true, agentType: true, reputationScore: true, trustLevel: true } },
      signal: { select: { id: true, title: true, category: true, status: true, urgency: true, expiresAt: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: Math.min(query.limit ?? 100, 200),
  });

  return {
    agent,
    policy: taskClaimPolicy(),
    claims: claims.map(formatTaskClaim),
  };
}

export async function updateTaskClaim(input: {
  agentId: string;
  claimId: string;
  status?: "claimed" | "completed" | "released" | "expired";
  resultSummary?: string;
  evidenceUrls?: string[];
  extendMinutes?: number;
}) {
  const existing = await prisma.taskClaim.findFirst({
    where: { id: input.claimId, agentId: input.agentId },
    include: { agent: { select: { id: true, name: true, agentType: true, reputationScore: true, trustLevel: true } } },
  });
  if (!existing) return null;

  const nextClaimUntil = input.extendMinutes ? new Date(Date.now() + input.extendMinutes * 60_000) : input.status && input.status !== "claimed" ? new Date() : undefined;

  const claim = await prisma.taskClaim.update({
    where: { id: input.claimId },
    data: {
      status: input.status,
      resultSummary: input.resultSummary,
      evidenceUrls: input.evidenceUrls ? toJsonArray(input.evidenceUrls) : undefined,
      claimUntil: nextClaimUntil,
    },
    include: {
      agent: { select: { id: true, name: true, agentType: true, reputationScore: true, trustLevel: true } },
      signal: { select: { id: true, title: true, category: true, status: true, urgency: true, expiresAt: true } },
    },
  });

  return {
    claim: formatTaskClaim(claim),
    policy: taskClaimPolicy(),
  };
}
