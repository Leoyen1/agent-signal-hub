import type { Agent, AgentInfrastructureClaim, Challenge, Digest, DomainRelationshipAssertion, DomainRelationshipReviewConsensusEvent, HandoffPolicyVersionEvent, Signal, SignalIntent, SourceTaskClaim, TaskClaim, Validation } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { appBaseUrl } from "@/lib/agent-discovery";
import { hashToken } from "@/lib/crypto";
import { infrastructureClaimWarningHours } from "@/lib/infrastructure-proof";
import { domainRelationshipAssertionWarningHours, normalizeRelationshipDomain } from "@/lib/domain-relationships";
import { prisma } from "@/lib/prisma";
import { buildSourceWatchEvents } from "@/lib/source-watches";

export type EventQuery = {
  since?: Date;
  limit?: number;
};

type EventSubject = {
  type: "agent" | "signal" | "validation" | "intent" | "task_claim" | "source_task_claim" | "challenge" | "digest" | "inbox" | "source_watch" | "infrastructure_claim" | "domain_relationship_assertion" | "domain_relationship_review_consensus" | "handoff_policy";
  id: string;
  url: string;
};

export type NodeEvent = {
  id: string;
  type:
    | "agent_registered"
    | "agent_seen"
    | "signal_created"
    | "signal_updated"
    | "validation_created"
    | "intent_created"
    | "intent_updated"
    | "task_claim_created"
    | "task_claim_updated"
    | "source_task_claim_created"
    | "source_task_claim_updated"
    | "challenge_created"
    | "challenge_updated"
    | "digest_available"
    | "infrastructure_claim_verified"
    | "infrastructure_claim_expiring"
    | "infrastructure_claim_expired"
    | "infrastructure_claim_stale"
    | "infrastructure_claim_failed"
    | "domain_relationship_assertion_created"
    | "domain_relationship_assertion_renewed"
    | "domain_relationship_assertion_expiring"
    | "domain_relationship_assertion_expired"
    | "domain_relationship_assertion_withdrawn"
    | "domain_relationship_assertion_superseded"
    | "domain_relationship_review_consensus_changed"
    | "handoff_policy_version_changed"
    | "inbox_changed"
    | "source_watch_matched"
    | "source_watch_arbitration_changed";
  occurred_at: string;
  actor_agent_id?: string;
  subject: EventSubject;
  summary: string;
  links: Record<string, string>;
  metadata?: Record<string, unknown>;
  acknowledged?: boolean;
  acknowledged_at?: string | null;
};

const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const EVENT_LEASE_BACKOFF_BASE_SECONDS = 30;
const EVENT_LEASE_BACKOFF_MAX_SECONDS = 900;
const EVENT_LEASE_REEVALUATION_THRESHOLD = 3;

function eventLeaseBackoffSeconds(failureCount: number) {
  return Math.min(EVENT_LEASE_BACKOFF_MAX_SECONDS, EVENT_LEASE_BACKOFF_BASE_SECONDS * 2 ** Math.max(0, failureCount - 1));
}

function defaultSince() {
  return new Date(Date.now() - DEFAULT_LOOKBACK_MS);
}

function normalizeQuery(query: EventQuery) {
  return {
    since: query.since ?? defaultSince(),
    limit: Math.min(Math.max(query.limit ?? 100, 1), 200),
  };
}

function changedAfter(since: Date) {
  return { gt: since };
}

function isRealUpdate(createdAt: Date, updatedAt: Date) {
  return updatedAt.getTime() - createdAt.getTime() > 1000;
}

function eventUrl(path: string) {
  return `${appBaseUrl()}${path}`;
}

function toAgentRegisteredEvent(agent: Pick<Agent, "id" | "name" | "agentType" | "createdAt">): NodeEvent {
  return {
    id: `event:agent_registered:${agent.id}`,
    type: "agent_registered",
    occurred_at: agent.createdAt.toISOString(),
    actor_agent_id: agent.id,
    subject: { type: "agent", id: agent.id, url: eventUrl(`/api/agents/${agent.id}/card`) },
    summary: `${agent.name} registered as ${agent.agentType}.`,
    links: {
      agent_card: eventUrl(`/api/agents/${agent.id}/card`),
      agent_memory: eventUrl(`/api/agents/${agent.id}/memory`),
      agent_inbox: eventUrl(`/api/agents/${agent.id}/inbox`),
    },
    metadata: { agent_type: agent.agentType },
  };
}

function toAgentSeenEvent(agent: Pick<Agent, "id" | "name" | "lastSeenAt">): NodeEvent | null {
  if (!agent.lastSeenAt) return null;

  return {
    id: `event:agent_seen:${agent.id}:${agent.lastSeenAt.toISOString()}`,
    type: "agent_seen",
    occurred_at: agent.lastSeenAt.toISOString(),
    actor_agent_id: agent.id,
    subject: { type: "agent", id: agent.id, url: eventUrl(`/api/agents/${agent.id}/card`) },
    summary: `${agent.name} authenticated with this node.`,
    links: {
      agent_card: eventUrl(`/api/agents/${agent.id}/card`),
      agent_events: eventUrl(`/api/agents/${agent.id}/events`),
    },
  };
}

function toSignalEvent(signal: Pick<Signal, "id" | "title" | "category" | "status" | "confidence" | "urgency" | "submittedByAgentId" | "createdAt" | "updatedAt">, kind: "signal_created" | "signal_updated"): NodeEvent {
  const occurredAt = kind === "signal_created" ? signal.createdAt : signal.updatedAt;

  return {
    id: `event:${kind}:${signal.id}${kind === "signal_updated" ? `:${signal.updatedAt.toISOString()}` : ""}`,
    type: kind,
    occurred_at: occurredAt.toISOString(),
    actor_agent_id: signal.submittedByAgentId,
    subject: { type: "signal", id: signal.id, url: eventUrl(`/api/signals/${signal.id}`) },
    summary: `${kind === "signal_created" ? "Signal created" : "Signal updated"}: ${signal.title}`,
    links: {
      signal: eventUrl(`/api/signals/${signal.id}`),
      governance: eventUrl(`/api/signals/${signal.id}/governance`),
      intents: eventUrl(`/api/signals/${signal.id}/intents`),
      recommended_validators: eventUrl(`/api/signals/${signal.id}/recommended-validators`),
      submitting_agent: eventUrl(`/api/agents/${signal.submittedByAgentId}/card`),
    },
    metadata: {
      category: signal.category,
      status: signal.status,
      confidence: signal.confidence,
      urgency: signal.urgency,
    },
  };
}

function toValidationEvent(validation: Pick<Validation, "id" | "signalId" | "agentId" | "verdict" | "createdAt"> & { signal?: Pick<Signal, "title"> }): NodeEvent {
  return {
    id: `event:validation_created:${validation.id}`,
    type: "validation_created",
    occurred_at: validation.createdAt.toISOString(),
    actor_agent_id: validation.agentId,
    subject: { type: "validation", id: validation.id, url: eventUrl(`/api/signals/${validation.signalId}`) },
    summary: `Validation ${validation.verdict} on ${validation.signal?.title ?? validation.signalId}.`,
    links: {
      signal: eventUrl(`/api/signals/${validation.signalId}`),
      signal_governance: eventUrl(`/api/signals/${validation.signalId}/governance`),
      validating_agent: eventUrl(`/api/agents/${validation.agentId}/card`),
    },
    metadata: { verdict: validation.verdict, signal_id: validation.signalId },
  };
}

function toIntentEvent(intent: Pick<SignalIntent, "id" | "signalId" | "agentId" | "intentType" | "status" | "targetAgentId" | "summary" | "createdAt" | "updatedAt">, kind: "intent_created" | "intent_updated"): NodeEvent {
  const occurredAt = kind === "intent_created" ? intent.createdAt : intent.updatedAt;

  return {
    id: `event:${kind}:${intent.id}${kind === "intent_updated" ? `:${intent.updatedAt.toISOString()}` : ""}`,
    type: kind,
    occurred_at: occurredAt.toISOString(),
    actor_agent_id: intent.agentId,
    subject: { type: "intent", id: intent.id, url: eventUrl(`/api/signals/${intent.signalId}/intents`) },
    summary: `${kind === "intent_created" ? "Intent created" : "Intent updated"}: ${intent.intentType} - ${intent.summary}`,
    links: {
      signal: eventUrl(`/api/signals/${intent.signalId}`),
      intents: eventUrl(`/api/signals/${intent.signalId}/intents`),
      agent: eventUrl(`/api/agents/${intent.agentId}/card`),
      ...(intent.targetAgentId ? { target_agent: eventUrl(`/api/agents/${intent.targetAgentId}/card`) } : {}),
    },
    metadata: {
      signal_id: intent.signalId,
      intent_type: intent.intentType,
      status: intent.status,
      target_agent_id: intent.targetAgentId,
    },
  };
}

function toTaskClaimEvent(claim: Pick<TaskClaim, "id" | "signalId" | "agentId" | "taskType" | "status" | "claimUntil" | "createdAt" | "updatedAt">, kind: "task_claim_created" | "task_claim_updated"): NodeEvent {
  const occurredAt = kind === "task_claim_created" ? claim.createdAt : claim.updatedAt;

  return {
    id: `event:${kind}:${claim.id}${kind === "task_claim_updated" ? `:${claim.updatedAt.toISOString()}` : ""}`,
    type: kind,
    occurred_at: occurredAt.toISOString(),
    actor_agent_id: claim.agentId,
    subject: { type: "task_claim", id: claim.id, url: eventUrl(`/api/agents/${claim.agentId}/tasks/${claim.id}`) },
    summary: `${kind === "task_claim_created" ? "Task claimed" : "Task claim updated"}: ${claim.taskType} on ${claim.signalId}.`,
    links: {
      signal: eventUrl(`/api/signals/${claim.signalId}`),
      signal_tasks: eventUrl(`/api/signals/${claim.signalId}/tasks`),
      agent_tasks: eventUrl(`/api/agents/${claim.agentId}/tasks`),
      claim: eventUrl(`/api/agents/${claim.agentId}/tasks/${claim.id}`),
    },
    metadata: {
      signal_id: claim.signalId,
      task_type: claim.taskType,
      status: claim.status,
      claim_until: claim.claimUntil.toISOString(),
    },
  };
}

function toSourceTaskClaimEvent(
  claim: Pick<SourceTaskClaim, "id" | "agentId" | "targetType" | "sourceId" | "host" | "taskType" | "status" | "claimUntil" | "createdAt" | "updatedAt">,
  kind: "source_task_claim_created" | "source_task_claim_updated",
): NodeEvent {
  const occurredAt = kind === "source_task_claim_created" ? claim.createdAt : claim.updatedAt;
  const targetLabel = claim.targetType === "domain_relationship" ? claim.sourceId ?? "domain relationship" : claim.targetType === "source" ? claim.sourceId ?? "source" : claim.host ?? "host";
  const conflictQuery =
    claim.targetType === "domain_relationship"
      ? "/api/domain-relationships"
      : claim.targetType === "source"
      ? `/api/source-conflicts?target_type=source&source_id=${encodeURIComponent(claim.sourceId ?? "")}`
      : `/api/source-conflicts?target_type=host&host=${encodeURIComponent(claim.host ?? "")}`;

  return {
    id: `event:${kind}:${claim.id}${kind === "source_task_claim_updated" ? `:${claim.updatedAt.toISOString()}` : ""}`,
    type: kind,
    occurred_at: occurredAt.toISOString(),
    actor_agent_id: claim.agentId,
    subject: { type: "source_task_claim", id: claim.id, url: eventUrl(`/api/agents/${claim.agentId}/source-tasks/${claim.id}`) },
    summary: `${kind === "source_task_claim_created" ? "Source task claimed" : "Source task claim updated"}: ${claim.taskType} on ${targetLabel}.`,
    links: {
      agent_source_tasks: eventUrl(`/api/agents/${claim.agentId}/source-tasks`),
      claim: eventUrl(`/api/agents/${claim.agentId}/source-tasks/${claim.id}`),
      ...(claim.targetType === "domain_relationship" ? { domain_relationships: eventUrl(conflictQuery), controller_tasks: eventUrl(`/api/source-rendezvous/tasks?target_type=domain_relationship&source_id=${encodeURIComponent(claim.sourceId ?? "")}`) } : { source_conflicts: eventUrl(conflictQuery) }),
      ...(claim.targetType === "source" && claim.sourceId ? { source: eventUrl(`/api/sources/${claim.sourceId}`), source_rendezvous: eventUrl(`/api/sources/${claim.sourceId}/rendezvous`) } : {}),
      ...(claim.host ? { source_rendezvous: eventUrl(`/api/source-rendezvous?target_type=host&host=${encodeURIComponent(claim.host)}`) } : {}),
    },
    metadata: {
      target_type: claim.targetType,
      source_id: claim.sourceId,
      host: claim.host,
      task_type: claim.taskType,
      status: kind === "source_task_claim_created" ? "claimed" : claim.status,
      current_status: claim.status,
      claim_until_current: claim.claimUntil.toISOString(),
    },
  };
}

function toDomainRelationshipReviewConsensusEvent(event: DomainRelationshipReviewConsensusEvent): NodeEvent {
  return {
    id: `event:domain_relationship_review_consensus_changed:${event.id}`,
    type: "domain_relationship_review_consensus_changed",
    occurred_at: event.createdAt.toISOString(),
    actor_agent_id: event.triggeringAgentId,
    subject: { type: "domain_relationship_review_consensus", id: event.id, url: eventUrl(`/api/domain-relationships?domain=${encodeURIComponent(event.domainA)}`) },
    summary: `Controller review consensus changed from ${event.previousState ?? "no_consensus"} to ${event.currentState} for ${event.domainA} and ${event.domainB}.`,
    links: {
      domain_relationships: eventUrl(`/api/domain-relationships?domain=${encodeURIComponent(event.domainA)}`),
      controller_tasks: eventUrl(`/api/source-rendezvous/tasks?target_type=domain_relationship&source_id=${encodeURIComponent(event.relationshipTargetId)}`),
      triggering_claim: eventUrl(`/api/agents/${event.triggeringAgentId}/source-tasks/${event.triggeringClaimId}`),
    },
    metadata: {
      relationship_target_id: event.relationshipTargetId,
      domain_a: event.domainA,
      domain_b: event.domainB,
      previous_state: event.previousState ?? "no_consensus",
      current_state: event.currentState,
      conclusion_counts: JSON.parse(event.conclusionCounts),
      counted_agent_ids: JSON.parse(event.countedAgentIds),
      triggering_claim_id: event.triggeringClaimId,
      governance_effect: "none",
    },
  };
}

function toHandoffPolicyVersionEvent(event: HandoffPolicyVersionEvent): NodeEvent {
  return {
    id: `event:handoff_policy_version_changed:${event.id}`,
    type: "handoff_policy_version_changed",
    occurred_at: event.effectiveAt.toISOString(),
    subject: { type: "handoff_policy", id: event.version, url: eventUrl("/api/handoff-policy") },
    summary: `Agent event handoff policy changed from ${event.previousVersion ?? "unregistered"} to ${event.version}.`,
    links: { policy: eventUrl("/api/handoff-policy"), node_events: eventUrl("/api/events") },
    metadata: { policy_key: event.policyKey, version: event.version, previous_version: event.previousVersion, document_hash: event.documentHash },
  };
}

function toChallengeEvent(challenge: Pick<Challenge, "id" | "signalId" | "challengerAgentId" | "targetAgentId" | "challengeType" | "status" | "expiresAt" | "createdAt" | "updatedAt">, kind: "challenge_created" | "challenge_updated"): NodeEvent {
  const occurredAt = kind === "challenge_created" ? challenge.createdAt : challenge.updatedAt;

  return {
    id: `event:${kind}:${challenge.id}${kind === "challenge_updated" ? `:${challenge.updatedAt.toISOString()}` : ""}`,
    type: kind,
    occurred_at: occurredAt.toISOString(),
    actor_agent_id: challenge.challengerAgentId,
    subject: { type: "challenge", id: challenge.id, url: eventUrl(`/api/challenges/${challenge.id}`) },
    summary: `${kind === "challenge_created" ? "Challenge created" : "Challenge updated"}: ${challenge.challengeType} on ${challenge.signalId}.`,
    links: {
      challenge: eventUrl(`/api/challenges/${challenge.id}`),
      signal: eventUrl(`/api/signals/${challenge.signalId}`),
      signal_challenges: eventUrl(`/api/signals/${challenge.signalId}/challenges`),
      challenger_agent: eventUrl(`/api/agents/${challenge.challengerAgentId}/card`),
      ...(challenge.targetAgentId ? { target_agent: eventUrl(`/api/agents/${challenge.targetAgentId}/card`) } : {}),
    },
    metadata: {
      signal_id: challenge.signalId,
      challenge_type: challenge.challengeType,
      status: challenge.status,
      target_agent_id: challenge.targetAgentId,
      expires_at: challenge.expiresAt.toISOString(),
    },
  };
}

function toDigestEvent(digest: Pick<Digest, "id" | "title" | "date" | "generatedAt">): NodeEvent {
  return {
    id: `event:digest_available:${digest.id}`,
    type: "digest_available",
    occurred_at: digest.generatedAt.toISOString(),
    subject: { type: "digest", id: digest.id, url: eventUrl("/api/digests/latest") },
    summary: `Digest available: ${digest.title}`,
    links: {
      latest_digest: eventUrl("/api/digests/latest"),
    },
    metadata: { date: digest.date.toISOString() },
  };
}

type DomainRelationshipEventRecord = Pick<
  DomainRelationshipAssertion,
  "id" | "agentId" | "domainA" | "domainB" | "stance" | "status" | "expiresAt" | "withdrawnAt" | "supersedesAssertionId" | "createdAt" | "updatedAt"
>;

function domainRelationshipAssertionEvent(
  assertion: DomainRelationshipEventRecord,
  type: "domain_relationship_assertion_created" | "domain_relationship_assertion_renewed" | "domain_relationship_assertion_expiring" | "domain_relationship_assertion_expired" | "domain_relationship_assertion_withdrawn" | "domain_relationship_assertion_superseded",
  occurredAt: Date,
): NodeEvent {
  const action = type.replace("domain_relationship_assertion_", "").replaceAll("_", " ");
  return {
    id: `event:${type}:${assertion.id}:${occurredAt.toISOString()}`,
    type,
    occurred_at: occurredAt.toISOString(),
    actor_agent_id: assertion.agentId,
    subject: { type: "domain_relationship_assertion", id: assertion.id, url: eventUrl(`/api/domain-relationships/${assertion.id}`) },
    summary: `Domain relationship assertion for ${assertion.domainA} and ${assertion.domainB} ${action}.`,
    links: {
      self: eventUrl(`/api/domain-relationships/${assertion.id}`),
      relationships: eventUrl(`/api/domain-relationships?domain=${encodeURIComponent(assertion.domainA)}`),
      agent: eventUrl(`/api/agents/${assertion.agentId}/card`),
    },
    metadata: {
      domain_a: assertion.domainA,
      domain_b: assertion.domainB,
      stance: assertion.stance,
      status: assertion.status,
      expires_at: assertion.expiresAt.toISOString(),
      withdrawn_at: assertion.withdrawnAt?.toISOString(),
      supersedes_assertion_id: assertion.supersedesAssertionId,
    },
  };
}

function toDomainRelationshipAssertionEvents(assertion: DomainRelationshipEventRecord, since: Date, now: Date): NodeEvent[] {
  const events: NodeEvent[] = [];
  if (assertion.createdAt > since) {
    events.push(domainRelationshipAssertionEvent(assertion, assertion.supersedesAssertionId ? "domain_relationship_assertion_renewed" : "domain_relationship_assertion_created", assertion.createdAt));
  }
  if (assertion.status === "withdrawn" && assertion.withdrawnAt && assertion.withdrawnAt > since) {
    events.push(domainRelationshipAssertionEvent(assertion, "domain_relationship_assertion_withdrawn", assertion.withdrawnAt));
  }
  if (assertion.status === "superseded" && assertion.updatedAt > since) {
    events.push(domainRelationshipAssertionEvent(assertion, "domain_relationship_assertion_superseded", assertion.updatedAt));
  }
  const warningAt = new Date(assertion.expiresAt.getTime() - domainRelationshipAssertionWarningHours() * 3_600_000);
  if (assertion.status === "active" && assertion.expiresAt > now && warningAt <= now && warningAt > since) {
    events.push(domainRelationshipAssertionEvent(assertion, "domain_relationship_assertion_expiring", warningAt));
  }
  if (assertion.status === "active" && assertion.expiresAt <= now && assertion.expiresAt > since) {
    events.push(domainRelationshipAssertionEvent(assertion, "domain_relationship_assertion_expired", assertion.expiresAt));
  }
  return events;
}

type InfrastructureClaimEventRecord = Pick<
  AgentInfrastructureClaim,
  "id" | "agentId" | "target" | "registrableDomain" | "proofUrl" | "status" | "verifiedAt" | "expiresAt" | "updatedAt" | "failureReason"
> & { agent: Pick<Agent, "name"> };

function infrastructureClaimLinks(claim: InfrastructureClaimEventRecord) {
  const verificationPath = `/api/agents/${claim.agentId}/infrastructure/verify`;
  return {
    agent_card: eventUrl(`/api/agents/${claim.agentId}/card`),
    prepare_proof: eventUrl(`${verificationPath}?target=${claim.target}`),
    verify_proof: eventUrl(verificationPath),
    proof_document: claim.proofUrl,
  };
}

function infrastructureClaimEvent(
  claim: InfrastructureClaimEventRecord,
  type: "infrastructure_claim_verified" | "infrastructure_claim_expiring" | "infrastructure_claim_expired" | "infrastructure_claim_stale" | "infrastructure_claim_failed",
  occurredAt: Date,
  metadata: Record<string, unknown>,
): NodeEvent {
  const action =
    type === "infrastructure_claim_verified"
      ? "verified"
      : type === "infrastructure_claim_expiring"
        ? "is approaching expiry"
        : type === "infrastructure_claim_expired"
          ? "expired"
          : type === "infrastructure_claim_stale"
            ? "became stale"
            : "verification failed";
  return {
    id: `event:${type}:${claim.id}:${occurredAt.toISOString()}`,
    type,
    occurred_at: occurredAt.toISOString(),
    actor_agent_id: claim.agentId,
    subject: { type: "infrastructure_claim", id: claim.id, url: eventUrl(`/api/agents/${claim.agentId}/card`) },
    summary: `${claim.agent.name}'s ${claim.target} infrastructure claim for ${claim.registrableDomain} ${action}.`,
    links: infrastructureClaimLinks(claim),
    metadata: {
      target: claim.target,
      registrable_domain: claim.registrableDomain,
      claim_status: claim.status,
      verified_at: claim.verifiedAt?.toISOString(),
      expires_at: claim.expiresAt?.toISOString(),
      failure_reason: claim.failureReason,
      ...metadata,
    },
  };
}

function toInfrastructureClaimEvents(claim: InfrastructureClaimEventRecord, since: Date, now: Date): NodeEvent[] {
  const events: NodeEvent[] = [];
  if (claim.verifiedAt && claim.verifiedAt > since) {
    events.push(infrastructureClaimEvent(claim, "infrastructure_claim_verified", claim.verifiedAt, { governance_effect: "claim can support validator infrastructure eligibility until expiry or key change" }));
  }
  if (claim.status === "stale" && claim.updatedAt > since) {
    events.push(infrastructureClaimEvent(claim, "infrastructure_claim_stale", claim.updatedAt, { governance_effect: "claim no longer satisfies validator infrastructure eligibility" }));
  }
  if (claim.status === "failed" && claim.updatedAt > since) {
    events.push(infrastructureClaimEvent(claim, "infrastructure_claim_failed", claim.updatedAt, { governance_effect: "claim does not satisfy validator infrastructure eligibility" }));
  }
  if (claim.expiresAt) {
    const warningAt = new Date(claim.expiresAt.getTime() - infrastructureClaimWarningHours() * 3_600_000);
    if (claim.status === "verified" && claim.expiresAt > now && warningAt <= now && warningAt > since) {
      events.push(
        infrastructureClaimEvent(claim, "infrastructure_claim_expiring", warningAt, {
          governance_effect: "refresh before expires_at to avoid leaving digest quorum",
          hours_remaining: Number(((claim.expiresAt.getTime() - now.getTime()) / 3_600_000).toFixed(2)),
        }),
      );
    }
    if (claim.expiresAt <= now && claim.expiresAt > since) {
      events.push(infrastructureClaimEvent(claim, "infrastructure_claim_expired", claim.expiresAt, { governance_effect: "claim no longer satisfies validator infrastructure eligibility" }));
    }
  }
  return events;
}

function sortAndLimit(events: NodeEvent[], limit: number) {
  return events
    .sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime() || a.id.localeCompare(b.id))
    .slice(0, limit);
}

function nextSince(events: NodeEvent[], since: Date) {
  return events.length ? events[events.length - 1].occurred_at : since.toISOString();
}

export function eventsPolicy() {
  return {
    schema_version: "2026-07-15",
    stream_type: "derived_delta_sync",
    authentication_required: false,
    default_lookback: "24h",
    max_limit: 200,
    cursor: {
      parameter: "since",
      format: "ISO-8601 date-time",
      comparison: "occurred_at > since",
      client_recommendation: "Poll /api/events with cursor.next_since; overlap by one second if strict completeness matters.",
    },
    event_types: [
      "agent_registered",
      "agent_seen",
      "signal_created",
      "signal_updated",
      "validation_created",
      "intent_created",
      "intent_updated",
      "task_claim_created",
      "task_claim_updated",
      "source_task_claim_created",
      "source_task_claim_updated",
      "challenge_created",
      "challenge_updated",
      "digest_available",
      "infrastructure_claim_verified",
      "infrastructure_claim_expiring",
      "infrastructure_claim_expired",
      "infrastructure_claim_stale",
      "infrastructure_claim_failed",
      "domain_relationship_assertion_created",
      "domain_relationship_assertion_renewed",
      "domain_relationship_assertion_expiring",
      "domain_relationship_assertion_expired",
      "domain_relationship_assertion_withdrawn",
      "domain_relationship_assertion_superseded",
      "domain_relationship_review_consensus_changed",
      "handoff_policy_version_changed",
      "inbox_changed",
    ],
    infrastructure_claim_warning_hours: infrastructureClaimWarningHours(),
    infrastructure_claim_event_policy: "verified, stale, and failed use persisted lifecycle timestamps; expiring occurs at expires_at minus the warning window; expired occurs at expires_at.",
    domain_relationship_assertion_warning_hours: domainRelationshipAssertionWarningHours(),
    domain_relationship_assertion_event_policy: "created/renewed, withdrawn, and superseded use persisted lifecycle timestamps; expiring and expired are derived from expires_at.",
    private_event_types: ["source_watch_matched", "source_watch_arbitration_changed"],
    private_event_authentication:
      "Private events are returned only by authenticated agent-specific endpoints or webhook deliveries owned by the agent.",
  };
}

export async function buildNodeEvents(query: EventQuery = {}) {
  const { since, limit } = normalizeQuery(query);
  const now = new Date();
  const infrastructureWarningBoundary = new Date(now.getTime() + infrastructureClaimWarningHours() * 3_600_000);
  const domainRelationshipWarningBoundary = new Date(now.getTime() + domainRelationshipAssertionWarningHours() * 3_600_000);

  const [agents, seenAgents, createdSignals, updatedSignals, validations, createdIntents, updatedIntents, createdTaskClaims, updatedTaskClaims, createdSourceTaskClaims, updatedSourceTaskClaims, createdChallenges, updatedChallenges, infrastructureClaims, domainRelationshipAssertions, reviewConsensusEvents, handoffPolicyEvents, digests] = await Promise.all([
    prisma.agent.findMany({
      where: { createdAt: changedAfter(since) },
      select: { id: true, name: true, agentType: true, createdAt: true },
      orderBy: { createdAt: "asc" },
      take: limit,
    }),
    prisma.agent.findMany({
      where: { lastSeenAt: changedAfter(since) },
      select: { id: true, name: true, lastSeenAt: true },
      orderBy: { lastSeenAt: "asc" },
      take: limit,
    }),
    prisma.signal.findMany({
      where: { createdAt: changedAfter(since) },
      select: { id: true, title: true, category: true, status: true, confidence: true, urgency: true, submittedByAgentId: true, createdAt: true, updatedAt: true },
      orderBy: { createdAt: "asc" },
      take: limit,
    }),
    prisma.signal.findMany({
      where: { updatedAt: changedAfter(since) },
      select: { id: true, title: true, category: true, status: true, confidence: true, urgency: true, submittedByAgentId: true, createdAt: true, updatedAt: true },
      orderBy: { updatedAt: "asc" },
      take: limit,
    }),
    prisma.validation.findMany({
      where: { createdAt: changedAfter(since) },
      select: { id: true, signalId: true, agentId: true, verdict: true, createdAt: true, signal: { select: { title: true } } },
      orderBy: { createdAt: "asc" },
      take: limit,
    }),
    prisma.signalIntent.findMany({
      where: { createdAt: changedAfter(since) },
      select: { id: true, signalId: true, agentId: true, intentType: true, status: true, targetAgentId: true, summary: true, createdAt: true, updatedAt: true },
      orderBy: { createdAt: "asc" },
      take: limit,
    }),
    prisma.signalIntent.findMany({
      where: { updatedAt: changedAfter(since) },
      select: { id: true, signalId: true, agentId: true, intentType: true, status: true, targetAgentId: true, summary: true, createdAt: true, updatedAt: true },
      orderBy: { updatedAt: "asc" },
      take: limit,
    }),
    prisma.taskClaim.findMany({
      where: { createdAt: changedAfter(since) },
      select: { id: true, signalId: true, agentId: true, taskType: true, status: true, claimUntil: true, createdAt: true, updatedAt: true },
      orderBy: { createdAt: "asc" },
      take: limit,
    }),
    prisma.taskClaim.findMany({
      where: { updatedAt: changedAfter(since) },
      select: { id: true, signalId: true, agentId: true, taskType: true, status: true, claimUntil: true, createdAt: true, updatedAt: true },
      orderBy: { updatedAt: "asc" },
      take: limit,
    }),
    prisma.sourceTaskClaim.findMany({
      where: { createdAt: changedAfter(since) },
      select: { id: true, agentId: true, targetType: true, sourceId: true, host: true, taskType: true, status: true, claimUntil: true, createdAt: true, updatedAt: true },
      orderBy: { createdAt: "asc" },
      take: limit,
    }),
    prisma.sourceTaskClaim.findMany({
      where: { updatedAt: changedAfter(since) },
      select: { id: true, agentId: true, targetType: true, sourceId: true, host: true, taskType: true, status: true, claimUntil: true, createdAt: true, updatedAt: true },
      orderBy: { updatedAt: "asc" },
      take: limit,
    }),
    prisma.challenge.findMany({
      where: { createdAt: changedAfter(since) },
      select: { id: true, signalId: true, challengerAgentId: true, targetAgentId: true, challengeType: true, status: true, expiresAt: true, createdAt: true, updatedAt: true },
      orderBy: { createdAt: "asc" },
      take: limit,
    }),
    prisma.challenge.findMany({
      where: { updatedAt: changedAfter(since) },
      select: { id: true, signalId: true, challengerAgentId: true, targetAgentId: true, challengeType: true, status: true, expiresAt: true, createdAt: true, updatedAt: true },
      orderBy: { updatedAt: "asc" },
      take: limit,
    }),
    prisma.agentInfrastructureClaim.findMany({
      where: {
        OR: [
          { updatedAt: changedAfter(since) },
          { verifiedAt: changedAfter(since) },
          { expiresAt: { gt: since, lte: infrastructureWarningBoundary } },
        ],
      },
      select: {
        id: true,
        agentId: true,
        target: true,
        registrableDomain: true,
        proofUrl: true,
        status: true,
        verifiedAt: true,
        expiresAt: true,
        updatedAt: true,
        failureReason: true,
        agent: { select: { name: true } },
      },
      orderBy: { updatedAt: "asc" },
      take: limit,
    }),
    prisma.domainRelationshipAssertion.findMany({
      where: { OR: [{ createdAt: changedAfter(since) }, { updatedAt: changedAfter(since) }, { expiresAt: { gt: since, lte: domainRelationshipWarningBoundary } }] },
      select: { id: true, agentId: true, domainA: true, domainB: true, stance: true, status: true, expiresAt: true, withdrawnAt: true, supersedesAssertionId: true, createdAt: true, updatedAt: true },
      orderBy: { createdAt: "asc" },
      take: limit,
    }),
    prisma.domainRelationshipReviewConsensusEvent.findMany({
      where: { createdAt: changedAfter(since) },
      orderBy: { createdAt: "asc" },
      take: limit,
    }),
    prisma.handoffPolicyVersionEvent.findMany({ where: { effectiveAt: changedAfter(since) }, orderBy: { effectiveAt: "asc" }, take: limit }),
    prisma.digest.findMany({
      where: { generatedAt: changedAfter(since) },
      select: { id: true, title: true, date: true, generatedAt: true },
      orderBy: { generatedAt: "asc" },
      take: limit,
    }),
  ]);

  const events = sortAndLimit(
    [
      ...agents.map(toAgentRegisteredEvent),
      ...seenAgents.map(toAgentSeenEvent).filter((event): event is NodeEvent => event !== null),
      ...createdSignals.map((signal) => toSignalEvent(signal, "signal_created")),
      ...updatedSignals.filter((signal) => isRealUpdate(signal.createdAt, signal.updatedAt)).map((signal) => toSignalEvent(signal, "signal_updated")),
      ...validations.map(toValidationEvent),
      ...createdIntents.map((intent) => toIntentEvent(intent, "intent_created")),
      ...updatedIntents.filter((intent) => isRealUpdate(intent.createdAt, intent.updatedAt)).map((intent) => toIntentEvent(intent, "intent_updated")),
      ...createdTaskClaims.map((claim) => toTaskClaimEvent(claim, "task_claim_created")),
      ...updatedTaskClaims.filter((claim) => isRealUpdate(claim.createdAt, claim.updatedAt)).map((claim) => toTaskClaimEvent(claim, "task_claim_updated")),
      ...createdSourceTaskClaims.map((claim) => toSourceTaskClaimEvent(claim, "source_task_claim_created")),
      ...updatedSourceTaskClaims
        .filter((claim) => isRealUpdate(claim.createdAt, claim.updatedAt))
        .map((claim) => toSourceTaskClaimEvent(claim, "source_task_claim_updated")),
      ...createdChallenges.map((challenge) => toChallengeEvent(challenge, "challenge_created")),
      ...updatedChallenges.filter((challenge) => isRealUpdate(challenge.createdAt, challenge.updatedAt)).map((challenge) => toChallengeEvent(challenge, "challenge_updated")),
      ...infrastructureClaims.flatMap((claim) => toInfrastructureClaimEvents(claim, since, now)),
      ...domainRelationshipAssertions.flatMap((assertion) => toDomainRelationshipAssertionEvents(assertion, since, now)),
      ...reviewConsensusEvents.map(toDomainRelationshipReviewConsensusEvent),
      ...handoffPolicyEvents.map(toHandoffPolicyVersionEvent),
      ...digests.map(toDigestEvent),
    ],
    limit,
  );

  return {
    generated_at: new Date().toISOString(),
    policy: eventsPolicy(),
    cursor: {
      since: since.toISOString(),
      next_since: nextSince(events, since),
    },
    events,
  };
}

export async function buildAgentEvents(agentId: string, query: EventQuery = {}, options: { includePrivateSourceWatchEvents?: boolean; includeAcknowledgements?: boolean; unacknowledgedOnly?: boolean } = {}) {
  const { since, limit } = normalizeQuery(query);
  const now = new Date();
  const infrastructureWarningBoundary = new Date(now.getTime() + infrastructureClaimWarningHours() * 3_600_000);
  const domainRelationshipWarningBoundary = new Date(now.getTime() + domainRelationshipAssertionWarningHours() * 3_600_000);
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: {
      id: true, name: true, agentType: true, createdAt: true, lastSeenAt: true,
      sourceWatches: { where: { status: "active" }, select: { host: true, url: true } },
      domainRelationshipAssertions: { select: { domainA: true, domainB: true } },
      sourceTaskClaims: { where: { targetType: "domain_relationship" }, select: { sourceId: true } },
    },
  });

  if (!agent) return null;

  const [createdSignals, updatedSignals, validations, createdIntents, updatedIntents, createdTaskClaims, createdSourceTaskClaims, updatedSourceTaskClaims, updatedTaskClaims, createdChallenges, updatedChallenges, infrastructureClaims, domainRelationshipAssertions, reviewConsensusEvents, handoffPolicyEvents, inboxSignal] = await Promise.all([
    prisma.signal.findMany({
      where: { submittedByAgentId: agentId, createdAt: changedAfter(since) },
      select: { id: true, title: true, category: true, status: true, confidence: true, urgency: true, submittedByAgentId: true, createdAt: true, updatedAt: true },
      orderBy: { createdAt: "asc" },
      take: limit,
    }),
    prisma.signal.findMany({
      where: { submittedByAgentId: agentId, updatedAt: changedAfter(since) },
      select: { id: true, title: true, category: true, status: true, confidence: true, urgency: true, submittedByAgentId: true, createdAt: true, updatedAt: true },
      orderBy: { updatedAt: "asc" },
      take: limit,
    }),
    prisma.validation.findMany({
      where: {
        createdAt: changedAfter(since),
        OR: [{ agentId }, { signal: { submittedByAgentId: agentId } }],
      },
      select: { id: true, signalId: true, agentId: true, verdict: true, createdAt: true, signal: { select: { title: true } } },
      orderBy: { createdAt: "asc" },
      take: limit,
    }),
    prisma.signalIntent.findMany({
      where: {
        createdAt: changedAfter(since),
        OR: [{ agentId }, { targetAgentId: agentId }, { signal: { submittedByAgentId: agentId } }],
      },
      select: { id: true, signalId: true, agentId: true, intentType: true, status: true, targetAgentId: true, summary: true, createdAt: true, updatedAt: true },
      orderBy: { createdAt: "asc" },
      take: limit,
    }),
    prisma.signalIntent.findMany({
      where: {
        updatedAt: changedAfter(since),
        OR: [{ agentId }, { targetAgentId: agentId }, { signal: { submittedByAgentId: agentId } }],
      },
      select: { id: true, signalId: true, agentId: true, intentType: true, status: true, targetAgentId: true, summary: true, createdAt: true, updatedAt: true },
      orderBy: { updatedAt: "asc" },
      take: limit,
    }),
    prisma.taskClaim.findMany({
      where: {
        createdAt: changedAfter(since),
        OR: [{ agentId }, { signal: { submittedByAgentId: agentId } }],
      },
      select: { id: true, signalId: true, agentId: true, taskType: true, status: true, claimUntil: true, createdAt: true, updatedAt: true },
      orderBy: { createdAt: "asc" },
      take: limit,
    }),
    prisma.sourceTaskClaim.findMany({
      where: { agentId, createdAt: changedAfter(since) },
      select: { id: true, agentId: true, targetType: true, sourceId: true, host: true, taskType: true, status: true, claimUntil: true, createdAt: true, updatedAt: true },
      orderBy: { createdAt: "asc" },
      take: limit,
    }),
    prisma.sourceTaskClaim.findMany({
      where: { agentId, updatedAt: changedAfter(since) },
      select: { id: true, agentId: true, targetType: true, sourceId: true, host: true, taskType: true, status: true, claimUntil: true, createdAt: true, updatedAt: true },
      orderBy: { updatedAt: "asc" },
      take: limit,
    }),
    prisma.taskClaim.findMany({
      where: {
        updatedAt: changedAfter(since),
        OR: [{ agentId }, { signal: { submittedByAgentId: agentId } }],
      },
      select: { id: true, signalId: true, agentId: true, taskType: true, status: true, claimUntil: true, createdAt: true, updatedAt: true },
      orderBy: { updatedAt: "asc" },
      take: limit,
    }),
    prisma.challenge.findMany({
      where: {
        createdAt: changedAfter(since),
        OR: [{ challengerAgentId: agentId }, { targetAgentId: agentId }, { signal: { submittedByAgentId: agentId } }],
      },
      select: { id: true, signalId: true, challengerAgentId: true, targetAgentId: true, challengeType: true, status: true, expiresAt: true, createdAt: true, updatedAt: true },
      orderBy: { createdAt: "asc" },
      take: limit,
    }),
    prisma.challenge.findMany({
      where: {
        updatedAt: changedAfter(since),
        OR: [{ challengerAgentId: agentId }, { targetAgentId: agentId }, { signal: { submittedByAgentId: agentId } }],
      },
      select: { id: true, signalId: true, challengerAgentId: true, targetAgentId: true, challengeType: true, status: true, expiresAt: true, createdAt: true, updatedAt: true },
      orderBy: { updatedAt: "asc" },
      take: limit,
    }),
    prisma.agentInfrastructureClaim.findMany({
      where: {
        agentId,
        OR: [
          { updatedAt: changedAfter(since) },
          { verifiedAt: changedAfter(since) },
          { expiresAt: { gt: since, lte: infrastructureWarningBoundary } },
        ],
      },
      select: {
        id: true,
        agentId: true,
        target: true,
        registrableDomain: true,
        proofUrl: true,
        status: true,
        verifiedAt: true,
        expiresAt: true,
        updatedAt: true,
        failureReason: true,
        agent: { select: { name: true } },
      },
      orderBy: { updatedAt: "asc" },
      take: limit,
    }),
    prisma.domainRelationshipAssertion.findMany({
      where: { agentId, OR: [{ createdAt: changedAfter(since) }, { updatedAt: changedAfter(since) }, { expiresAt: { gt: since, lte: domainRelationshipWarningBoundary } }] },
      select: { id: true, agentId: true, domainA: true, domainB: true, stance: true, status: true, expiresAt: true, withdrawnAt: true, supersedesAssertionId: true, createdAt: true, updatedAt: true },
      orderBy: { createdAt: "asc" },
      take: limit,
    }),
    prisma.domainRelationshipReviewConsensusEvent.findMany({
      where: { createdAt: changedAfter(since) },
      orderBy: { createdAt: "asc" },
      take: limit,
    }),
    prisma.handoffPolicyVersionEvent.findMany({ where: { effectiveAt: changedAfter(since) }, orderBy: { effectiveAt: "asc" }, take: limit }),
    prisma.signal.findFirst({
      where: {
        status: "active",
        submittedByAgentId: { not: agentId },
        OR: [{ createdAt: changedAfter(since) }, { updatedAt: changedAfter(since) }],
      },
      select: { id: true, title: true, submittedByAgentId: true, updatedAt: true, createdAt: true },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    }),
  ]);

  const agentBaseEvents: NodeEvent[] = [
    agent.createdAt > since ? toAgentRegisteredEvent(agent) : null,
    agent.lastSeenAt && agent.lastSeenAt > since ? toAgentSeenEvent(agent) : null,
  ].filter((event): event is NodeEvent => event !== null);

  const inboxEvent: NodeEvent[] = inboxSignal
    ? [
        {
          id: `event:inbox_changed:${agentId}:${inboxSignal.updatedAt.toISOString()}`,
          type: "inbox_changed",
          occurred_at: (inboxSignal.updatedAt > inboxSignal.createdAt ? inboxSignal.updatedAt : inboxSignal.createdAt).toISOString(),
          actor_agent_id: inboxSignal.submittedByAgentId,
          subject: { type: "inbox", id: agentId, url: eventUrl(`/api/agents/${agentId}/inbox`) },
          summary: `Agent inbox changed; latest candidate signal: ${inboxSignal.title}.`,
          links: {
            inbox: eventUrl(`/api/agents/${agentId}/inbox`),
            signal: eventUrl(`/api/signals/${inboxSignal.id}`),
          },
          metadata: { latest_signal_id: inboxSignal.id },
        },
      ]
    : [];

  const privateSourceWatchEvents = options.includePrivateSourceWatchEvents ? await buildSourceWatchEvents(agentId, { since, limit }) : null;
  const watchedDomains = new Set(agent.sourceWatches.flatMap((watch) => [watch.host, watch.url].flatMap((value) => {
    if (!value) return [];
    const normalized = normalizeRelationshipDomain(value);
    return normalized ? [normalized] : [];
  })));
  const assertedDomains = new Set(agent.domainRelationshipAssertions.flatMap((assertion) => [assertion.domainA, assertion.domainB]));
  const reviewedTargets = new Set(agent.sourceTaskClaims.map((claim) => claim.sourceId).filter((value): value is string => Boolean(value)));
  const relevantConsensusEvents = reviewConsensusEvents.filter(
    (event) => event.triggeringAgentId === agentId || reviewedTargets.has(event.relationshipTargetId) || assertedDomains.has(event.domainA) || assertedDomains.has(event.domainB) || watchedDomains.has(event.domainA) || watchedDomains.has(event.domainB),
  );

  const rawEvents = sortAndLimit(
    [
      ...agentBaseEvents,
      ...createdSignals.map((signal) => toSignalEvent(signal, "signal_created")),
      ...updatedSignals.filter((signal) => isRealUpdate(signal.createdAt, signal.updatedAt)).map((signal) => toSignalEvent(signal, "signal_updated")),
      ...validations.map(toValidationEvent),
      ...createdIntents.map((intent) => toIntentEvent(intent, "intent_created")),
      ...updatedIntents.filter((intent) => isRealUpdate(intent.createdAt, intent.updatedAt)).map((intent) => toIntentEvent(intent, "intent_updated")),
      ...createdTaskClaims.map((claim) => toTaskClaimEvent(claim, "task_claim_created")),
      ...updatedTaskClaims.filter((claim) => isRealUpdate(claim.createdAt, claim.updatedAt)).map((claim) => toTaskClaimEvent(claim, "task_claim_updated")),
      ...createdSourceTaskClaims.map((claim) => toSourceTaskClaimEvent(claim, "source_task_claim_created")),
      ...updatedSourceTaskClaims
        .filter((claim) => isRealUpdate(claim.createdAt, claim.updatedAt))
        .map((claim) => toSourceTaskClaimEvent(claim, "source_task_claim_updated")),
      ...createdChallenges.map((challenge) => toChallengeEvent(challenge, "challenge_created")),
      ...updatedChallenges.filter((challenge) => isRealUpdate(challenge.createdAt, challenge.updatedAt)).map((challenge) => toChallengeEvent(challenge, "challenge_updated")),
      ...infrastructureClaims.flatMap((claim) => toInfrastructureClaimEvents(claim, since, now)),
      ...domainRelationshipAssertions.flatMap((assertion) => toDomainRelationshipAssertionEvents(assertion, since, now)),
      ...relevantConsensusEvents.map(toDomainRelationshipReviewConsensusEvent),
      ...handoffPolicyEvents.map(toHandoffPolicyVersionEvent),
      ...inboxEvent,
      ...(privateSourceWatchEvents ?? []),
    ],
    limit,
  );

  let events = rawEvents;
  let unacknowledgedCount = rawEvents.length;
  if ((options.includeAcknowledgements || options.unacknowledgedOnly) && rawEvents.length) {
    const receipts = await prisma.agentEventReceipt.findMany({
      where: { agentId, eventId: { in: rawEvents.map((event) => event.id) } },
      select: { eventId: true, acknowledgedAt: true },
    });
    const receiptByEvent = new Map(receipts.map((receipt) => [receipt.eventId, receipt.acknowledgedAt]));
    const annotatedEvents = rawEvents.map((event) => ({
      ...event,
      acknowledged: receiptByEvent.has(event.id),
      acknowledged_at: receiptByEvent.get(event.id)?.toISOString() ?? null,
    }));
    unacknowledgedCount = annotatedEvents.filter((event) => !event.acknowledged).length;
    events = options.unacknowledgedOnly ? annotatedEvents.filter((event) => !event.acknowledged) : annotatedEvents;
  }

  return {
    generated_at: new Date().toISOString(),
    agent_id: agentId,
    policy: eventsPolicy(),
    cursor: {
      since: since.toISOString(),
      next_since: nextSince(rawEvents, since),
    },
    processing_state: {
      private: Boolean(options.includeAcknowledgements || options.unacknowledgedOnly),
      unacknowledged_only: Boolean(options.unacknowledgedOnly),
      scanned_event_count: rawEvents.length,
      returned_event_count: events.length,
      unacknowledged_count: unacknowledgedCount,
    },
    links: {
      agent_card: eventUrl(`/api/agents/${agentId}/card`),
      inbox: eventUrl(`/api/agents/${agentId}/inbox`),
      memory: eventUrl(`/api/agents/${agentId}/memory`),
      source_watch_feed: eventUrl(`/api/agents/${agentId}/source-watches/feed`),
      infrastructure_proof: eventUrl(`/api/agents/${agentId}/infrastructure/verify`),
      domain_relationships: eventUrl(`/api/domain-relationships?agent_id=${agentId}`),
      node_events: eventUrl("/api/events"),
    },
    events,
  };
}

export async function leaseAgentEvents(agentId: string, options: { since?: Date; limit: number; leaseDurationSeconds: number }) {
  const stream = await buildAgentEvents(
    agentId,
    { since: options.since, limit: 200 },
    { includePrivateSourceWatchEvents: true, includeAcknowledgements: true, unacknowledgedOnly: true },
  );
  if (!stream) return null;
  const leaseToken = randomBytes(32).toString("base64url");
  const leaseTokenHash = hashToken(leaseToken);
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + options.leaseDurationSeconds * 1000);
  const leasedEventIds: string[] = [];
  let blocked: { reason: "active_lease" | "expiry_backoff"; event_id: string; retry_after: string; failure_count: number; requires_reevaluation: boolean } | null = null;
  await prisma.$transaction(async (tx) => {
    for (const event of stream.events) {
      if (leasedEventIds.length >= options.limit) break;
      const existing = await tx.agentEventLease.findUnique({ where: { agentId_eventId: { agentId, eventId: event.id } } });
      if (existing && existing.leaseUntil > now) {
        blocked = { reason: "active_lease", event_id: event.id, retry_after: existing.leaseUntil.toISOString(), failure_count: existing.failureCount, requires_reevaluation: existing.needsReevaluation || existing.failureCount >= EVENT_LEASE_REEVALUATION_THRESHOLD };
        break;
      }
      if (existing) {
        const expiryAlreadyRecorded = existing.lastExpiredLeaseUntil?.getTime() === existing.leaseUntil.getTime();
        if (!expiryAlreadyRecorded) {
          const failureCount = existing.failureCount + 1;
          const nextAvailableAt = new Date(now.getTime() + eventLeaseBackoffSeconds(failureCount) * 1000);
          await tx.agentEventLease.update({
            where: { id: existing.id },
            data: { failureCount, nextAvailableAt, lastExpiredLeaseUntil: existing.leaseUntil, needsReevaluation: failureCount >= EVENT_LEASE_REEVALUATION_THRESHOLD ? true : undefined },
          });
          blocked = { reason: "expiry_backoff", event_id: event.id, retry_after: nextAvailableAt.toISOString(), failure_count: failureCount, requires_reevaluation: existing.needsReevaluation || failureCount >= EVENT_LEASE_REEVALUATION_THRESHOLD };
          break;
        }
        if (existing.nextAvailableAt && existing.nextAvailableAt > now) {
          blocked = { reason: "expiry_backoff", event_id: event.id, retry_after: existing.nextAvailableAt.toISOString(), failure_count: existing.failureCount, requires_reevaluation: existing.needsReevaluation || existing.failureCount >= EVENT_LEASE_REEVALUATION_THRESHOLD };
          break;
        }
        await tx.agentEventLease.update({ where: { id: existing.id }, data: { leaseTokenHash, leaseUntil, nextAvailableAt: null } });
      } else {
        await tx.agentEventLease.create({ data: { agentId, eventId: event.id, leaseTokenHash, leaseUntil } });
      }
      leasedEventIds.push(event.id);
    }
  });
  const leasedSet = new Set(leasedEventIds);
  const events = stream.events.filter((event) => leasedSet.has(event.id));
  const nextSince = events.length ? events[events.length - 1].occurred_at : stream.events.length ? stream.cursor.since : stream.cursor.next_since;
  return {
    agent_id: agentId,
    lease_token: leaseToken,
    lease_until: leaseUntil.toISOString(),
    lease_duration_seconds: options.leaseDurationSeconds,
    cursor: { since: stream.cursor.since, next_since: nextSince },
    processing_state: {
      scanned_event_count: stream.processing_state.scanned_event_count,
      leased_event_count: events.length,
      blocked,
      backoff_policy: {
        base_seconds: EVENT_LEASE_BACKOFF_BASE_SECONDS,
        max_seconds: EVENT_LEASE_BACKOFF_MAX_SECONDS,
        reevaluation_threshold: EVENT_LEASE_REEVALUATION_THRESHOLD,
      },
    },
    events,
  };
}

export async function updateAgentEventLease(input: {
  agentId: string;
  eventIds: string[];
  leaseToken: string;
  action: "renew" | "release" | "report_failure";
  leaseDurationSeconds?: number;
  failureReason?: "temporarily_unreachable" | "capability_mismatch" | "insufficient_evidence" | "malformed_event" | "dependency_failure";
  failureDetail?: string;
}) {
  const eventIds = [...new Set(input.eventIds)];
  const tokenHash = hashToken(input.leaseToken);
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const leases = await tx.agentEventLease.findMany({ where: { agentId: input.agentId, eventId: { in: eventIds } } });
    if (leases.length !== eventIds.length || leases.some((lease) => lease.leaseTokenHash !== tokenHash)) {
      return { status: 409 as const, error: "Event lease token does not match every requested event." };
    }
    if (input.action === "renew") {
      if (leases.some((lease) => lease.leaseUntil <= now)) {
        return { status: 409 as const, error: "Expired event leases cannot be renewed; lease the events again." };
      }
      const leaseUntil = new Date(now.getTime() + (input.leaseDurationSeconds ?? 120) * 1000);
      await tx.agentEventLease.updateMany({
        where: { agentId: input.agentId, eventId: { in: eventIds }, leaseTokenHash: tokenHash },
        data: { leaseUntil },
      });
      return { action: "renew", event_ids: eventIds, lease_until: leaseUntil.toISOString() };
    }
    if (input.action === "report_failure") {
      const nextAvailableAt = new Date(now.getTime() + eventLeaseBackoffSeconds(Math.max(1, Math.max(...leases.map((lease) => lease.failureCount))) ) * 1000);
      await tx.agentEventLease.updateMany({
        where: { agentId: input.agentId, eventId: { in: eventIds }, leaseTokenHash: tokenHash },
        data: {
          needsReevaluation: true,
          failureReason: input.failureReason,
          failureDetail: input.failureDetail,
          reevaluationReportedAt: now,
          leaseUntil: now,
          lastExpiredLeaseUntil: now,
          nextAvailableAt,
        },
      });
      return { action: "report_failure", event_ids: eventIds, failure_reason: input.failureReason, next_available_at: nextAvailableAt.toISOString(), requires_reevaluation: true };
    }
    await tx.agentEventLease.deleteMany({ where: { agentId: input.agentId, eventId: { in: eventIds }, leaseTokenHash: tokenHash } });
    return { action: "release", event_ids: eventIds, released_at: now.toISOString() };
  });
}

export async function acknowledgeAgentEvents(agentId: string, eventIds: string[], leaseToken?: string) {
  const uniqueEventIds = [...new Set(eventIds)];
  const acknowledgedAt = new Date();
  const activeLeases = await prisma.agentEventLease.findMany({
    where: { agentId, eventId: { in: uniqueEventIds }, leaseUntil: { gt: acknowledgedAt } },
    select: { eventId: true, leaseTokenHash: true },
  });
  if (activeLeases.length) {
    const suppliedHash = leaseToken ? hashToken(leaseToken) : null;
    if (!suppliedHash || activeLeases.some((lease) => lease.leaseTokenHash !== suppliedHash)) {
      return { status: 409 as const, error: "Active event leases require the matching lease_token before acknowledgement." };
    }
  }
  await prisma.$transaction(
    [
      ...uniqueEventIds.map((eventId) => prisma.agentEventReceipt.upsert({
        where: { agentId_eventId: { agentId, eventId } },
        update: {},
        create: { agentId, eventId, acknowledgedAt },
      })),
      prisma.agentEventLease.deleteMany({ where: { agentId, eventId: { in: uniqueEventIds } } }),
    ],
  );
  const receipts = await prisma.agentEventReceipt.findMany({
    where: { agentId, eventId: { in: uniqueEventIds } },
    select: { eventId: true, acknowledgedAt: true },
    orderBy: { acknowledgedAt: "asc" },
  });
  return {
    agent_id: agentId,
    acknowledged_count: receipts.length,
    receipts: receipts.map((receipt) => ({ event_id: receipt.eventId, acknowledged_at: receipt.acknowledgedAt.toISOString() })),
  };
}
