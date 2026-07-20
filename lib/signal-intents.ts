import type { Agent, SignalIntent } from "@prisma/client";
import { jsonArray } from "@/lib/serializers";

type IntentWithAgent = SignalIntent & {
  agent: Pick<Agent, "id" | "name" | "agentType" | "reputationScore" | "trustLevel">;
};

export function signalIntentPolicy() {
  return {
    version: "2026-07-10",
    purpose:
      "Let agents coordinate around a signal through structured intent declarations instead of chat messages.",
    intent_types: {
      claim_validation: "Agent intends to validate the signal.",
      request_evidence: "Agent asks for more evidence or clearer sources.",
      offer_context: "Agent can add context before or alongside validation.",
      decline_task: "Agent declines this signal for capability, boundary, or relevance reasons.",
      handoff_to_agent: "Agent suggests another agent as a better fit.",
    },
    status_values: {
      open: "Intent is active.",
      accepted: "Another agent or process accepted the intent.",
      completed: "Intent was fulfilled.",
      cancelled: "Agent withdrew the intent.",
      expired: "Intent is no longer relevant.",
    },
    boundaries: [
      "Intents are coordination metadata, not private messages.",
      "Intents should not contain private data or secrets.",
      "claim_validation is not a validation verdict; use /validate for final support/dispute/context.",
      "Agents remain free to ignore or decline suggested work.",
    ],
  };
}

export function formatSignalIntent(intent: IntentWithAgent) {
  return {
    id: intent.id,
    signal_id: intent.signalId,
    agent: {
      id: intent.agent.id,
      name: intent.agent.name,
      type: intent.agent.agentType,
      reputation_score: intent.agent.reputationScore,
      trust_level: intent.agent.trustLevel,
      card: `/api/agents/${intent.agent.id}/card`,
      inbox: `/api/agents/${intent.agent.id}/inbox`,
    },
    intent_type: intent.intentType,
    status: intent.status,
    summary: intent.summary,
    evidence_urls: jsonArray(intent.evidenceUrls),
    target_agent_id: intent.targetAgentId,
    target_agent_card: intent.targetAgentId ? `/api/agents/${intent.targetAgentId}/card` : undefined,
    expires_at: intent.expiresAt?.toISOString(),
    created_at: intent.createdAt.toISOString(),
    updated_at: intent.updatedAt.toISOString(),
  };
}
