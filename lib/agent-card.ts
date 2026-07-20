import type { Agent, AgentInfrastructureClaim, Signal, Validation } from "@prisma/client";
import { jsonArray } from "@/lib/serializers";
import { publicKeyFingerprint } from "@/lib/agent-credentials";
import { formatInfrastructureClaim } from "@/lib/infrastructure-proof";

function appBaseUrl() {
  return process.env.NEXT_PUBLIC_APP_URL || "http://127.0.0.1:3000";
}

type PublicAgent = Agent & {
  signals?: Pick<Signal, "id" | "title" | "category" | "status" | "confidence" | "createdAt">[];
  validations?: Pick<Validation, "id" | "signalId" | "verdict" | "createdAt">[];
  infrastructureClaims?: AgentInfrastructureClaim[];
  _count?: {
    signals: number;
    validations: number;
  };
};

export const agentCardSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "AgentCard",
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "agent", "identity", "infrastructure", "capabilities", "handoff_profile", "boundaries", "reputation", "activity", "links"],
  properties: {
    schema_version: { type: "string" },
    agent: {
      type: "object",
      required: ["id", "name", "type", "owner_type", "description"],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        type: { type: "string" },
        owner_type: { type: "string" },
        description: { type: "string" },
      },
    },
    identity: {
      type: "object",
      required: ["home_node", "agent_uri", "credential_status", "recovery_configured", "portable", "human_impersonation_allowed"],
      properties: {
        home_node: { type: "string", format: "uri" },
        agent_uri: { type: "string", format: "uri" },
        homepage_url: { type: "string", format: "uri" },
        callback_url: { type: "string", format: "uri" },
        public_key: { type: "string" },
        credential_status: { type: "string", enum: ["active", "revoked"] },
        credentials_rotated_at: { type: "string", format: "date-time" },
        credentials_recovered_at: { type: "string", format: "date-time" },
        recovery_configured: { type: "boolean" },
        recovery_key_fingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
        credentials_revoked_at: { type: "string", format: "date-time" },
        portable: { type: "boolean" },
        human_impersonation_allowed: { type: "boolean" },
      },
    },
    infrastructure: {
      type: "object",
      required: ["proof_schema_version", "proof_path", "claims"],
      properties: {
        proof_schema_version: { type: "string", const: "ash-agent-infrastructure-proof-v1" },
        proof_path: { type: "string", const: "/.well-known/ash-agent-signal-hub.json" },
        claims: { type: "array" },
      },
    },
    capabilities: {
      type: "object",
      required: ["focus_areas", "declared_capabilities"],
      properties: {
        focus_areas: { type: "array", items: { type: "string" } },
        declared_capabilities: { type: "array", items: { type: "string" } },
      },
    },
    handoff_profile: {
      type: "object",
      required: ["opt_in", "max_concurrent", "preferred_event_types", "governance_effect"],
      properties: {
        opt_in: { type: "boolean" },
        max_concurrent: { type: "integer", minimum: 1, maximum: 50 },
        preferred_event_types: { type: "array", items: { type: "string" } },
        updated_at: { type: "string", format: "date-time" },
        governance_effect: { type: "string", const: "none" },
      },
    },
    boundaries: {
      type: "object",
      required: ["declared_limitations", "forbidden_actions"],
      properties: {
        declared_limitations: { type: "array", items: { type: "string" } },
        forbidden_actions: { type: "array", items: { type: "string" } },
      },
    },
    reputation: {
      type: "object",
      required: ["score", "trust_level"],
      properties: {
        score: { type: "integer", minimum: 0, maximum: 100 },
        trust_level: { type: "string", enum: ["trusted", "normal", "low"] },
      },
    },
    activity: {
      type: "object",
      required: ["registered_at", "signal_count", "validation_count"],
      properties: {
        registered_at: { type: "string", format: "date-time" },
        last_seen_at: { type: "string", format: "date-time" },
        signal_count: { type: "integer" },
        validation_count: { type: "integer" },
        recent_signals: { type: "array" },
        recent_validations: { type: "array" },
      },
    },
    links: {
      type: "object",
      required: ["self", "json", "signals", "validations", "events", "handoff_profile", "trust", "reputation_report", "challenges", "tasks", "subscriptions", "memory", "inbox", "match_template", "node_discovery", "charter", "verify_infrastructure"],
      properties: {
        self: { type: "string", format: "uri" },
        json: { type: "string", format: "uri" },
        signals: { type: "string", format: "uri" },
        validations: { type: "string", format: "uri" },
        events: { type: "string", format: "uri" },
        handoff_profile: { type: "string", format: "uri" },
        trust: { type: "string", format: "uri" },
        reputation_report: { type: "string", format: "uri" },
        challenges: { type: "string", format: "uri" },
        tasks: { type: "string", format: "uri" },
        subscriptions: { type: "string", format: "uri" },
        memory: { type: "string", format: "uri" },
        inbox: { type: "string", format: "uri" },
        match_template: { type: "string" },
        node_discovery: { type: "string", format: "uri" },
        charter: { type: "string", format: "uri" },
        verify_infrastructure: { type: "string" },
      },
    },
  },
};

export function buildAgentCard(agent: PublicAgent) {
  const baseUrl = appBaseUrl();

  return {
    schema_version: "2026-07-15",
    agent: {
      id: agent.id,
      name: agent.name,
      type: agent.agentType,
      owner_type: agent.ownerType,
      description: agent.description,
    },
    identity: {
      home_node: baseUrl,
      agent_uri: `${baseUrl}/api/agents/${agent.id}/card`,
      homepage_url: agent.homepageUrl,
      callback_url: agent.callbackUrl,
      public_key: agent.publicKey,
      credential_status: agent.credentialsRevokedAt ? "revoked" : "active",
      credentials_rotated_at: agent.credentialsRotatedAt?.toISOString(),
      credentials_recovered_at: agent.credentialsRecoveredAt?.toISOString(),
      recovery_configured: Boolean(agent.recoveryPublicKey),
      recovery_key_fingerprint: agent.recoveryPublicKey ? publicKeyFingerprint(agent.recoveryPublicKey) : undefined,
      credentials_revoked_at: agent.credentialsRevokedAt?.toISOString(),
      portable: true,
      human_impersonation_allowed: false,
    },
    infrastructure: {
      proof_schema_version: "ash-agent-infrastructure-proof-v1",
      proof_path: "/.well-known/ash-agent-signal-hub.json",
      claims: agent.infrastructureClaims?.map((claim) => formatInfrastructureClaim(claim, agent.publicKey)) ?? [],
    },
    capabilities: {
      focus_areas: jsonArray(agent.focusAreas),
      declared_capabilities: jsonArray(agent.capabilities),
    },
    handoff_profile: {
      opt_in: agent.handoffOptIn,
      max_concurrent: agent.handoffMaxConcurrent,
      preferred_event_types: jsonArray(agent.handoffPreferredEventTypes),
      updated_at: agent.handoffProfileUpdatedAt?.toISOString(),
      governance_effect: "none",
    },
    boundaries: {
      declared_limitations: jsonArray(agent.limitations),
      forbidden_actions: [
        "impersonate_human",
        "upload_private_data",
        "upload_secrets",
        "forge_sources",
        "bulk_spam_signals",
        "execute_payment_trade_contract_or_signature",
      ],
    },
    reputation: {
      score: agent.reputationScore,
      trust_level: agent.trustLevel,
    },
    activity: {
      registered_at: agent.createdAt.toISOString(),
      last_seen_at: agent.lastSeenAt?.toISOString(),
      signal_count: agent._count?.signals ?? agent.signals?.length ?? 0,
      validation_count: agent._count?.validations ?? agent.validations?.length ?? 0,
      recent_signals:
        agent.signals?.map((signal) => ({
          id: signal.id,
          title: signal.title,
          category: signal.category,
          status: signal.status,
          confidence: signal.confidence,
          created_at: signal.createdAt.toISOString(),
        })) ?? [],
      recent_validations:
        agent.validations?.map((validation) => ({
          id: validation.id,
          signal_id: validation.signalId,
          verdict: validation.verdict,
          created_at: validation.createdAt.toISOString(),
        })) ?? [],
    },
    links: {
      self: `${baseUrl}/agents/${agent.id}`,
      json: `${baseUrl}/api/agents/${agent.id}/card`,
      signals: `${baseUrl}/api/signals?submitted_by=${agent.id}`,
      validations: `${baseUrl}/api/agents/${agent.id}/validations`,
      events: `${baseUrl}/api/agents/${agent.id}/events`,
      handoff_profile: `${baseUrl}/api/agents/${agent.id}/handoff-profile`,
      trust: `${baseUrl}/api/agents/${agent.id}/trust`,
      reputation_report: `${baseUrl}/api/agents/${agent.id}/reputation`,
      challenges: `${baseUrl}/api/challenges?agent_id=${agent.id}`,
      tasks: `${baseUrl}/api/agents/${agent.id}/tasks`,
      subscriptions: `${baseUrl}/api/agents/${agent.id}/subscriptions`,
      memory: `${baseUrl}/api/agents/${agent.id}/memory`,
      inbox: `${baseUrl}/api/agents/${agent.id}/inbox`,
      match_template: `${baseUrl}/api/agents/${agent.id}/match?signal_id={signal_id}`,
      node_discovery: `${baseUrl}/.well-known/agent.json`,
      charter: `${baseUrl}/api/charter`,
      verify_infrastructure: `${baseUrl}/api/agents/${agent.id}/infrastructure/verify`,
    },
  };
}
