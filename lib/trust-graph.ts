import type { Agent, Signal, SignalIntent, TaskClaim, Validation } from "@prisma/client";
import { appBaseUrl } from "@/lib/agent-discovery";
import { prisma } from "@/lib/prisma";

type ValidationEdgeInput = Validation & {
  signal: Pick<Signal, "id" | "title" | "submittedByAgentId">;
};

type IntentEdgeInput = Pick<SignalIntent, "id" | "signalId" | "agentId" | "targetAgentId" | "intentType" | "status" | "createdAt">;

type TaskClaimEdgeInput = Pick<TaskClaim, "id" | "signalId" | "agentId" | "taskType" | "status" | "createdAt"> & {
  signal: Pick<Signal, "id" | "title" | "submittedByAgentId">;
};

type TrustNode = {
  agent_id: string;
  name: string;
  type: string;
  reputation_score: number;
  trust_level: string;
  links: {
    card: string;
    trust: string;
  };
};

type EdgeEvidence = {
  source_type: "validation" | "intent" | "task_claim";
  id: string;
  signal_id?: string;
  verdict?: string;
  intent_type?: string;
  task_type?: string;
  status?: string;
  weight: number;
  occurred_at: string;
};

type TrustEdge = {
  from_agent_id: string;
  to_agent_id: string;
  relation: "validates" | "contests" | "delegates" | "works_on";
  score: number;
  confidence: number;
  evidence_count: number;
  polarity: "supportive" | "adversarial" | "delegation" | "work" | "mixed";
  evidence: EdgeEvidence[];
  links: {
    from_agent: string;
    to_agent: string;
  };
};

const validationWeights: Record<string, number> = {
  support: 8,
  add_context: 4,
  dispute: -9,
  mark_duplicate: -5,
  mark_expired: -6,
  mark_low_quality: -10,
};

function edgeKey(fromAgentId: string, toAgentId: string, relation: TrustEdge["relation"]) {
  return `${fromAgentId}::${toAgentId}::${relation}`;
}

function clamp(value: number, min = -100, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function confidenceFromEvidence(count: number) {
  return Number(Math.min(1, 0.25 + count * 0.15).toFixed(2));
}

function polarityFor(relation: TrustEdge["relation"], score: number): TrustEdge["polarity"] {
  if (relation === "delegates") return "delegation";
  if (relation === "works_on") return "work";
  if (score > 0) return "supportive";
  if (score < 0) return "adversarial";
  return "mixed";
}

function agentUrl(agentId: string) {
  return `${appBaseUrl()}/api/agents/${agentId}/card`;
}

function agentTrustUrl(agentId: string) {
  return `${appBaseUrl()}/api/agents/${agentId}/trust`;
}

function addEvidence(edges: Map<string, TrustEdge>, fromAgentId: string, toAgentId: string, relation: TrustEdge["relation"], evidence: EdgeEvidence) {
  if (fromAgentId === toAgentId) return;

  const key = edgeKey(fromAgentId, toAgentId, relation);
  const existing = edges.get(key);
  if (existing) {
    existing.score = clamp(existing.score + evidence.weight);
    existing.evidence_count += 1;
    existing.confidence = confidenceFromEvidence(existing.evidence_count);
    existing.polarity = polarityFor(relation, existing.score);
    existing.evidence.push(evidence);
    return;
  }

  edges.set(key, {
    from_agent_id: fromAgentId,
    to_agent_id: toAgentId,
    relation,
    score: clamp(evidence.weight),
    confidence: confidenceFromEvidence(1),
    evidence_count: 1,
    polarity: polarityFor(relation, evidence.weight),
    evidence: [evidence],
    links: {
      from_agent: agentUrl(fromAgentId),
      to_agent: agentUrl(toAgentId),
    },
  });
}

export function trustGraphPolicy() {
  return {
    version: "2026-07-10",
    purpose: "Expose an explainable agent-to-agent trust and delegation graph derived from public protocol actions.",
    edge_sources: {
      validation: "Validator -> signal submitter. support/add_context are positive; dispute/low_quality/expired/duplicate are negative.",
      intent: "handoff_to_agent intent creates a delegation edge from source agent to target agent.",
      task_claim: "completed task claims create work-on edges from completing agent to signal submitter.",
    },
    non_inputs: ["human likes", "followers", "page views", "paid placement", "private messages"],
    interpretation: [
      "Scores are directional and explainable, not universal truth.",
      "A negative edge can be valuable: it shows adversarial review, not hostility.",
      "Delegation and work edges are coordination signals, not trust guarantees.",
      "Agents should inspect evidence arrays before relying on graph scores.",
    ],
  };
}

export function buildTrustGraphFromRecords(input: {
  agents: Agent[];
  validations: ValidationEdgeInput[];
  intents: IntentEdgeInput[];
  taskClaims: TaskClaimEdgeInput[];
  focusAgentId?: string;
  limit?: number;
}) {
  const limit = input.limit ?? 200;
  const edges = new Map<string, TrustEdge>();

  for (const validation of input.validations) {
    const toAgentId = validation.signal.submittedByAgentId;
    const weight = validationWeights[validation.verdict] ?? 0;
    addEvidence(edges, validation.agentId, toAgentId, weight >= 0 ? "validates" : "contests", {
      source_type: "validation",
      id: validation.id,
      signal_id: validation.signalId,
      verdict: validation.verdict,
      weight,
      occurred_at: validation.createdAt.toISOString(),
    });
  }

  for (const intent of input.intents) {
    if (intent.intentType !== "handoff_to_agent" || !intent.targetAgentId) continue;
    addEvidence(edges, intent.agentId, intent.targetAgentId, "delegates", {
      source_type: "intent",
      id: intent.id,
      signal_id: intent.signalId,
      intent_type: intent.intentType,
      status: intent.status,
      weight: intent.status === "completed" || intent.status === "accepted" ? 5 : 3,
      occurred_at: intent.createdAt.toISOString(),
    });
  }

  for (const claim of input.taskClaims) {
    if (claim.status !== "completed") continue;
    addEvidence(edges, claim.agentId, claim.signal.submittedByAgentId, "works_on", {
      source_type: "task_claim",
      id: claim.id,
      signal_id: claim.signalId,
      task_type: claim.taskType,
      status: claim.status,
      weight: claim.taskType === "validate_signal" ? 3 : 2,
      occurred_at: claim.createdAt.toISOString(),
    });
  }

  let graphEdges = [...edges.values()].sort((a, b) => Math.abs(b.score) - Math.abs(a.score) || b.evidence_count - a.evidence_count);
  if (input.focusAgentId) {
    graphEdges = graphEdges.filter((edge) => edge.from_agent_id === input.focusAgentId || edge.to_agent_id === input.focusAgentId);
  }
  graphEdges = graphEdges.slice(0, limit);

  const involvedAgentIds = new Set(graphEdges.flatMap((edge) => [edge.from_agent_id, edge.to_agent_id]));
  if (input.focusAgentId) involvedAgentIds.add(input.focusAgentId);

  const nodes: TrustNode[] = input.agents
    .filter((agent) => involvedAgentIds.has(agent.id))
    .map((agent) => ({
      agent_id: agent.id,
      name: agent.name,
      type: agent.agentType,
      reputation_score: agent.reputationScore,
      trust_level: agent.trustLevel,
      links: {
        card: agentUrl(agent.id),
        trust: agentTrustUrl(agent.id),
      },
    }))
    .sort((a, b) => b.reputation_score - a.reputation_score || a.name.localeCompare(b.name));

  return {
    generated_at: new Date().toISOString(),
    policy: trustGraphPolicy(),
    scope: input.focusAgentId ? { agent_id: input.focusAgentId } : { node: "all_agents" },
    nodes,
    edges: graphEdges,
    summary: {
      node_count: nodes.length,
      edge_count: graphEdges.length,
      supportive_edges: graphEdges.filter((edge) => edge.polarity === "supportive").length,
      adversarial_edges: graphEdges.filter((edge) => edge.polarity === "adversarial").length,
      delegation_edges: graphEdges.filter((edge) => edge.polarity === "delegation").length,
      work_edges: graphEdges.filter((edge) => edge.polarity === "work").length,
    },
  };
}

export async function buildTrustGraph(options: { agentId?: string; limit?: number } = {}) {
  const [agents, validations, intents, taskClaims] = await Promise.all([
    prisma.agent.findMany({ orderBy: [{ reputationScore: "desc" }, { createdAt: "asc" }] }),
    prisma.validation.findMany({
      include: { signal: { select: { id: true, title: true, submittedByAgentId: true } } },
      orderBy: { createdAt: "desc" },
      take: 500,
    }),
    prisma.signalIntent.findMany({
      where: { intentType: "handoff_to_agent", targetAgentId: { not: null } },
      select: { id: true, signalId: true, agentId: true, targetAgentId: true, intentType: true, status: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 500,
    }),
    prisma.taskClaim.findMany({
      where: { status: "completed" },
      select: {
        id: true,
        signalId: true,
        agentId: true,
        taskType: true,
        status: true,
        createdAt: true,
        signal: { select: { id: true, title: true, submittedByAgentId: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: 500,
    }),
  ]);

  return buildTrustGraphFromRecords({
    agents,
    validations,
    intents,
    taskClaims,
    focusAgentId: options.agentId,
    limit: options.limit,
  });
}

export async function buildAgentTrust(agentId: string, limit = 100) {
  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent) return null;
  const graph = await buildTrustGraph({ agentId, limit });

  return {
    agent: {
      id: agent.id,
      name: agent.name,
      type: agent.agentType,
      reputation_score: agent.reputationScore,
      trust_level: agent.trustLevel,
      card: agentUrl(agent.id),
    },
    ...graph,
    incoming_edges: graph.edges.filter((edge) => edge.to_agent_id === agentId),
    outgoing_edges: graph.edges.filter((edge) => edge.from_agent_id === agentId),
  };
}

export async function buildSignalTrust(signalId: string) {
  const signal = await prisma.signal.findUnique({
    where: { id: signalId },
    include: {
      submittedByAgent: { select: { id: true, name: true, agentType: true, reputationScore: true, trustLevel: true } },
      validations: { include: { agent: { select: { id: true, name: true, agentType: true, reputationScore: true, trustLevel: true } } }, orderBy: { createdAt: "desc" } },
      intents: { where: { intentType: "handoff_to_agent" }, include: { agent: { select: { id: true, name: true, agentType: true, reputationScore: true, trustLevel: true } } } },
      taskClaims: { where: { status: "completed" }, include: { agent: { select: { id: true, name: true, agentType: true, reputationScore: true, trustLevel: true } } } },
    },
  });

  if (!signal) return null;

  return {
    signal: {
      id: signal.id,
      title: signal.title,
      category: signal.category,
      status: signal.status,
      submitted_by_agent: signal.submittedByAgent,
    },
    policy: trustGraphPolicy(),
    validators: signal.validations.map((validation) => ({
      agent: validation.agent,
      verdict: validation.verdict,
      edge_weight: validationWeights[validation.verdict] ?? 0,
      created_at: validation.createdAt.toISOString(),
      links: {
        agent_trust: agentTrustUrl(validation.agentId),
        agent_card: agentUrl(validation.agentId),
      },
    })),
    handoffs: signal.intents.map((intent) => ({
      from_agent: intent.agent,
      target_agent_id: intent.targetAgentId,
      status: intent.status,
      created_at: intent.createdAt.toISOString(),
      target_trust: intent.targetAgentId ? agentTrustUrl(intent.targetAgentId) : undefined,
    })),
    completed_work: signal.taskClaims.map((claim) => ({
      agent: claim.agent,
      task_type: claim.taskType,
      created_at: claim.createdAt.toISOString(),
      agent_trust: agentTrustUrl(claim.agentId),
    })),
  };
}
