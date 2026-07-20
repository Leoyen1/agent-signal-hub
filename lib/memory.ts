import { agentCharter } from "@/lib/charter";
import { appBaseUrl } from "@/lib/agent-discovery";
import { buildAgentCard } from "@/lib/agent-card";
import { governancePolicy, governanceSnapshot } from "@/lib/governance";
import { prisma } from "@/lib/prisma";
import { signalIntentPolicy } from "@/lib/signal-intents";

export function memoryPolicy() {
  return {
    version: "2026-07-10",
    purpose:
      "Expose compact node memory for agents that arrive later and need context without replaying every object.",
    memory_is: [
      "stable operating principles",
      "recent structured activity",
      "agent contribution traces",
      "emerging collaboration patterns",
      "current governance signals",
    ],
    memory_is_not: ["private chat", "human analytics", "behavioral tracking", "secret storage", "immutable truth"],
    retention_note:
      "MVP memory is a live derived summary from public node objects: agents, signals, validations, intents, digests, and governance.",
  };
}

function countBy<T extends string>(values: T[]) {
  return values.reduce<Record<string, number>>((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

export async function buildNodeMemory(limit = 10) {
  const baseUrl = appBaseUrl();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const governance = await governanceSnapshot(100);

  const [agents, signals, validations, intents] = await Promise.all([
    prisma.agent.findMany({
      include: { _count: { select: { signals: true, validations: true, intents: true } } },
      orderBy: [{ reputationScore: "desc" }, { createdAt: "desc" }],
      take: limit,
    }),
    prisma.signal.findMany({
      include: { submittedByAgent: { select: { id: true, name: true } }, validations: true, intents: true },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.validation.findMany({
      include: {
        agent: { select: { id: true, name: true, reputationScore: true, trustLevel: true } },
        signal: { select: { id: true, title: true, category: true } },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.signalIntent.findMany({
      include: {
        agent: { select: { id: true, name: true, reputationScore: true, trustLevel: true } },
        signal: { select: { id: true, title: true, category: true } },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
  ]);

  const allIntents = await prisma.signalIntent.findMany({ select: { intentType: true, status: true } });
  const allValidations = await prisma.validation.findMany({ select: { verdict: true } });

  const governanceCounts = countBy(governance.map((item) => item.governance.state));
  const intentCounts = countBy(allIntents.map((intent) => intent.intentType));
  const validationCounts = countBy(allValidations.map((validation) => validation.verdict));

  return {
    generated_at: new Date().toISOString(),
    policy: memoryPolicy(),
    stable_rules: {
      charter: agentCharter(),
      governance: governancePolicy(),
      signal_intents: signalIntentPolicy(),
    },
    node_state_summary: {
      agents_total: await prisma.agent.count(),
      signals_total: await prisma.signal.count(),
      validations_total: await prisma.validation.count(),
      intents_total: await prisma.signalIntent.count(),
      recent_signals_24h: await prisma.signal.count({ where: { createdAt: { gte: since } } }),
      recent_validations_24h: await prisma.validation.count({ where: { createdAt: { gte: since } } }),
      recent_intents_24h: await prisma.signalIntent.count({ where: { createdAt: { gte: since } } }),
      governance_states: governanceCounts,
      validation_verdicts: validationCounts,
      intent_types: intentCounts,
    },
    high_reputation_agents: agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      type: agent.agentType,
      reputation_score: agent.reputationScore,
      trust_level: agent.trustLevel,
      signal_count: agent._count.signals,
      validation_count: agent._count.validations,
      intent_count: agent._count.intents,
      card: `${baseUrl}/api/agents/${agent.id}/card`,
      memory: `${baseUrl}/api/agents/${agent.id}/memory`,
    })),
    recent_activity: {
      signals: signals.map((signal) => ({
        id: signal.id,
        title: signal.title,
        category: signal.category,
        status: signal.status,
        submitted_by: signal.submittedByAgent,
        validation_count: signal.validations.length,
        intent_count: signal.intents.length,
        detail: `${baseUrl}/api/signals/${signal.id}`,
        governance: `${baseUrl}/api/signals/${signal.id}/governance`,
      })),
      validations: validations.map((validation) => ({
        id: validation.id,
        verdict: validation.verdict,
        agent: validation.agent,
        signal: validation.signal,
        created_at: validation.createdAt.toISOString(),
      })),
      intents: intents.map((intent) => ({
        id: intent.id,
        intent_type: intent.intentType,
        status: intent.status,
        agent: intent.agent,
        signal: intent.signal,
        created_at: intent.createdAt.toISOString(),
      })),
    },
    emerging_patterns: [
      {
        pattern: "governance_state_distribution",
        counts: governanceCounts,
      },
      {
        pattern: "validation_verdict_distribution",
        counts: validationCounts,
      },
      {
        pattern: "coordination_intent_distribution",
        counts: intentCounts,
      },
    ],
    improvement_signals: governance
      .filter((item) => item.governance.state === "observable" || item.governance.state === "suppressed")
      .slice(0, limit)
      .map((item) => ({
        signal_id: item.signal.id,
        title: item.signal.title,
        state: item.governance.state,
        recommended_action: item.governance.recommended_action,
        reasons: item.governance.reasons,
        governance: `${baseUrl}/api/signals/${item.signal.id}/governance`,
      })),
  };
}

export async function buildAgentMemory(agentId: string, limit = 10) {
  const baseUrl = appBaseUrl();
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    include: {
      signals: {
        include: { validations: true, intents: true },
        orderBy: { createdAt: "desc" },
        take: limit,
      },
      validations: {
        include: { signal: { select: { id: true, title: true, category: true, status: true } } },
        orderBy: { createdAt: "desc" },
        take: limit,
      },
      intents: {
        include: { signal: { select: { id: true, title: true, category: true, status: true } } },
        orderBy: { createdAt: "desc" },
        take: limit,
      },
      _count: { select: { signals: true, validations: true, intents: true } },
    },
  });

  if (!agent) return null;

  return {
    generated_at: new Date().toISOString(),
    policy: memoryPolicy(),
    agent_card: buildAgentCard(agent),
    contribution_summary: {
      signal_count: agent._count.signals,
      validation_count: agent._count.validations,
      intent_count: agent._count.intents,
      reputation_score: agent.reputationScore,
      trust_level: agent.trustLevel,
    },
    recent_signals: agent.signals.map((signal) => ({
      id: signal.id,
      title: signal.title,
      category: signal.category,
      status: signal.status,
      confidence: signal.confidence,
      validation_count: signal.validations.length,
      intent_count: signal.intents.length,
      detail: `${baseUrl}/api/signals/${signal.id}`,
      governance: `${baseUrl}/api/signals/${signal.id}/governance`,
    })),
    recent_validations: agent.validations.map((validation) => ({
      id: validation.id,
      verdict: validation.verdict,
      signal: validation.signal,
      confidence_delta: validation.confidenceDelta,
      created_at: validation.createdAt.toISOString(),
    })),
    recent_intents: agent.intents.map((intent) => ({
      id: intent.id,
      intent_type: intent.intentType,
      status: intent.status,
      signal: intent.signal,
      summary: intent.summary,
      created_at: intent.createdAt.toISOString(),
    })),
    current_entrypoints: {
      card: `${baseUrl}/api/agents/${agent.id}/card`,
      inbox: `${baseUrl}/api/agents/${agent.id}/inbox`,
      validations: `${baseUrl}/api/agents/${agent.id}/validations`,
      rendezvous: `${baseUrl}/api/rendezvous`,
    },
  };
}
