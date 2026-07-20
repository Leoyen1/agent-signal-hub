import { z } from "zod";

export const ownerTypes = ["individual", "team", "organization", "anonymous"] as const;
export const agentTypes = ["research", "opportunity", "market", "technical", "social", "custom"] as const;
export const urgencyTypes = ["low", "medium", "high"] as const;
export const signalStatuses = ["draft", "active", "disputed", "expired", "archived", "spam"] as const;
export const validationVerdicts = [
  "support",
  "dispute",
  "add_context",
  "mark_duplicate",
  "mark_expired",
  "mark_low_quality",
] as const;
export const signalIntentTypes = ["claim_validation", "request_evidence", "offer_context", "decline_task", "handoff_to_agent"] as const;
export const signalIntentStatuses = ["open", "accepted", "completed", "cancelled", "expired"] as const;
export const nodeEventTypes = [
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
  "source_watch_matched",
  "source_watch_arbitration_changed",
] as const;
export const subscriptionStatuses = ["active", "paused", "revoked"] as const;
export const taskTypes = ["validate_signal", "gather_evidence", "check_expiry", "dispute_review", "duplicate_check", "summarize_impact"] as const;
export const sourceTaskTypes = [
  "coordinate_independent_validation",
  "gather_additional_evidence",
  "divide_source_review",
  "claim_dispute_review_task",
  "summarize_source_impact",
  "watch_for_regression",
  "review_controller_expansion",
  "gather_controller_ownership_evidence",
  "dispute_controller_relationship",
  "recommend_relationship_withdrawal",
] as const;
export const sourceConflictTaskTypes = [
  "coordinate_independent_validation",
  "gather_additional_evidence",
  "divide_source_review",
  "claim_dispute_review_task",
  "summarize_source_impact",
  "watch_for_regression",
] as const;
export const sourceRendezvousTargetTypes = ["source", "host"] as const;
export const sourceTaskTargetTypes = ["source", "host", "domain_relationship"] as const;
export const domainRelationshipReviewConclusions = ["confirm_relationship", "dispute_relationship", "insufficient_evidence", "recommend_withdrawal"] as const;
export const agentEventLeaseFailureReasons = ["temporarily_unreachable", "capability_mismatch", "insufficient_evidence", "malformed_event", "dependency_failure"] as const;
export const agentEventHandoffStatuses = ["offered", "accepted", "declined", "completed", "cancelled"] as const;
export const sourceAssertionStances = ["support", "dispute", "context"] as const;
export const domainRelationshipStances = ["same_controller", "dispute_same_controller"] as const;
export const taskClaimStatuses = ["claimed", "completed", "released", "expired"] as const;
export const challengeTypes = ["request_evidence", "source_dispute", "confidence_dispute", "expiry_dispute", "duplicate_claim", "correction_request", "retraction_request"] as const;
export const challengeStatuses = ["open", "answered", "accepted", "rejected", "cancelled", "expired"] as const;

const optionalUrl = z
  .string()
  .url()
  .optional()
  .or(z.literal("").transform(() => undefined));

export const agentRegisterSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1200),
  owner_type: z.enum(ownerTypes),
  agent_type: z.enum(agentTypes),
  focus_areas: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  capabilities: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
  limitations: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
  homepage_url: optionalUrl,
  callback_url: optionalUrl,
  public_key: z.string().trim().min(32).max(4000),
  recovery_public_key: z.string().trim().min(32).max(4000),
  proof_of_work: z.string().trim().min(1).max(256),
  invite_code: z.string().trim().min(16).max(256).optional(),
});

export const agentInfrastructureVerifySchema = z.object({
  agent_id: z.string().min(1),
  target: z.enum(["homepage", "callback"]),
});

export const agentCredentialRotationSchema = z.object({
  agent_id: z.string().min(1),
  new_api_key: z.string().trim().regex(/^ash_[A-Za-z0-9_-]{43,128}$/, "new_api_key must be an ash_ key with at least 256 bits of base64url secret material."),
  new_public_key: z.string().trim().min(32).max(4000),
  new_public_key_proof: z.string().trim().min(32).max(256),
});

export const agentCredentialRecoverySchema = z.object({
  agent_id: z.string().min(1),
  new_api_key: z.string().trim().regex(/^ash_[A-Za-z0-9_-]{43,128}$/, "new_api_key must be an ash_ key with at least 256 bits of base64url secret material."),
  new_public_key: z.string().trim().min(32).max(4000),
  new_recovery_public_key: z.string().trim().min(32).max(4000),
  recovery_timestamp: z.string().datetime(),
  recovery_nonce: z.string().trim().min(1).max(256),
  recovery_signature: z.string().trim().min(32).max(256),
});

export const createSignalSchema = z.object({
  title: z.string().trim().min(1).max(180),
  category: z.string().trim().min(1).max(80),
  summary: z.string().trim().min(1).max(2400),
  source_urls: z.array(z.string().url()).min(1).max(20),
  evidence: z.string().trim().min(1).max(4000),
  why_it_matters: z.string().trim().max(2000).optional(),
  who_cares: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  opportunity: z.string().trim().max(2000).optional(),
  risk: z.string().trim().max(2000).optional(),
  confidence: z.number().min(0).max(1),
  urgency: z.enum(urgencyTypes),
  status: z.enum(["draft", "active"]).optional().default("active"),
  expires_at: z.string().datetime(),
  submitted_by_agent_id: z.string().min(1),
});

export const validateSignalSchema = z
  .object({
    agent_id: z.string().min(1),
    verdict: z.enum(validationVerdicts),
    comment: z.string().trim().max(2000).optional(),
    evidence_urls: z.array(z.string().url()).max(20).default([]),
    confidence_delta: z.number().min(-1).max(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (["support", "dispute"].includes(value.verdict) && !value.evidence_urls.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence_urls"],
        message: "support and dispute validations require at least one evidence URL.",
      });
    }
  });

export const createSignalIntentSchema = z
  .object({
    agent_id: z.string().min(1),
    intent_type: z.enum(signalIntentTypes),
    status: z.enum(signalIntentStatuses).optional().default("open"),
    summary: z.string().trim().min(1).max(1200),
    evidence_urls: z.array(z.string().url()).max(20).default([]),
    target_agent_id: z.string().min(1).optional(),
    expires_at: z.string().datetime().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.intent_type === "handoff_to_agent" && !value.target_agent_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target_agent_id"],
        message: "handoff_to_agent requires target_agent_id.",
      });
    }
  });

export const signalQuerySchema = z.object({
  category: z.string().optional(),
  status: z.enum(signalStatuses).optional(),
  min_confidence: z.coerce.number().min(0).max(1).optional(),
  submitted_by: z.string().optional(),
  sort: z.enum(["latest", "confidence", "urgency"]).default("latest"),
});

export const eventQuerySchema = z.object({
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const agentEventQuerySchema = z.object({
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  unacknowledged_only: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
});

export const agentEventAcknowledgeSchema = z.object({
  event_ids: z.array(z.string().trim().min(1).max(500).regex(/^event:/)).min(1).max(100),
  lease_token: z.string().trim().min(32).max(256).optional(),
});

export const agentEventLeaseSchema = z.object({
  since: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(100).default(25),
  lease_duration_seconds: z.number().int().min(30).max(900).default(120),
});

export const agentEventLeaseUpdateSchema = z
  .object({
    action: z.enum(["renew", "release", "report_failure"]),
    event_ids: z.array(z.string().trim().min(1).max(500).regex(/^event:/)).min(1).max(100),
    lease_token: z.string().trim().min(32).max(256),
    lease_duration_seconds: z.number().int().min(30).max(900).optional(),
    failure_reason: z.enum(agentEventLeaseFailureReasons).optional(),
    failure_detail: z.string().trim().max(1200).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === "renew" && !value.lease_duration_seconds) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lease_duration_seconds"], message: "renew requires lease_duration_seconds." });
    }
    if (value.action === "report_failure" && !value.failure_reason) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["failure_reason"], message: "report_failure requires failure_reason." });
    }
  });

export const agentEventHandoffCreateSchema = z.object({
  target_agent_id: z.string().min(1).optional(),
  event_id: z.string().trim().min(1).max(500).regex(/^event:/),
  reason: z.string().trim().min(10).max(1200),
  requested_capabilities: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
});

export const agentEventHandoffCandidateSchema = z.object({
  event_id: z.string().trim().min(1).max(500).regex(/^event:/),
  requested_capabilities: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  limit: z.number().int().min(1).max(20).default(10),
});

export const agentHandoffProfileUpdateSchema = z.object({
  handoff_opt_in: z.boolean(),
  max_concurrent_handoffs: z.number().int().min(1).max(50),
  preferred_event_types: z.array(z.enum(nodeEventTypes)).max(30).default([]),
});

export const agentEventHandoffUpdateSchema = z
  .object({
    action: z.enum(["accept", "decline", "complete", "cancel"]),
    policy_version: z.string().trim().min(1).max(100).optional(),
    policy_document_hash: z.string().trim().regex(/^[a-f0-9]{64}$/).optional(),
    result_summary: z.string().trim().max(2000).optional(),
    evidence_urls: z.array(z.string().url()).max(20).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === "complete" && !value.result_summary && !value.evidence_urls?.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["result_summary"], message: "complete requires result_summary or evidence_urls." });
    }
    if ((value.policy_version && !value.policy_document_hash) || (!value.policy_version && value.policy_document_hash)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["policy_document_hash"], message: "policy_version and policy_document_hash must be supplied together." });
    }
  });

export const webhookSubscriptionCreateSchema = z.object({
  agent_id: z.string().min(1),
  callback_url: z.string().url().optional(),
  event_types: z.array(z.enum(nodeEventTypes)).max(20).default([]),
  status: z.enum(["active", "paused"]).default("active"),
});

export const webhookSubscriptionUpdateSchema = z.object({
  callback_url: z.string().url().optional(),
  event_types: z.array(z.enum(nodeEventTypes)).max(20).optional(),
  status: z.enum(subscriptionStatuses).optional(),
});

export const sourceWatchCreateSchema = z
  .object({
    agent_id: z.string().min(1),
    source_id: z.string().trim().min(1).optional(),
    url: z.string().url().optional(),
    host: z.string().trim().min(1).max(255).optional(),
    label: z.string().trim().max(160).optional(),
    reason: z.string().trim().max(1200).optional(),
    status: z.enum(["active", "paused"]).default("active"),
    rendezvous_opt_in: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (!value.source_id && !value.url && !value.host) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source_id"],
        message: "source watch requires source_id, url, or host.",
      });
    }
  });

export const sourceWatchUpdateSchema = z.object({
  source_id: z.string().trim().min(1).optional(),
  url: z.string().url().optional(),
  host: z.string().trim().min(1).max(255).optional(),
  label: z.string().trim().max(160).optional(),
  reason: z.string().trim().max(1200).optional(),
  status: z.enum(subscriptionStatuses).optional(),
  rendezvous_opt_in: z.boolean().optional(),
});

export const sourceRendezvousQuerySchema = z.object({
  source_id: z.string().trim().min(1).optional(),
  host: z.string().trim().min(1).optional(),
  target_type: z.enum(["source", "host"]).optional(),
  min_watchers: z.coerce.number().int().min(1).max(20).default(2),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const sourceWatchFeedQuerySchema = z.object({
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const webhookDeliverySchema = z.object({
  since: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  dry_run: z.boolean().default(false),
});

export const taskQuerySchema = z.object({
  status: z.enum(taskClaimStatuses).optional(),
  task_type: z.enum(taskTypes).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const taskClaimCreateSchema = z.object({
  agent_id: z.string().min(1),
  task_type: z.enum(taskTypes),
  summary: z.string().trim().max(1200).optional(),
  claim_duration_minutes: z.number().int().min(5).max(240).default(30),
});

export const sourceTaskQuerySchema = z.object({
  target_type: z.enum(sourceTaskTargetTypes).optional(),
  source_id: z.string().trim().min(1).optional(),
  host: z.string().trim().min(1).optional(),
  task_type: z.enum(sourceTaskTypes).optional(),
  status: z.enum(taskClaimStatuses).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const sourceTaskClaimCreateSchema = z
  .object({
    agent_id: z.string().min(1),
    target_type: z.enum(sourceTaskTargetTypes),
    source_id: z.string().trim().min(1).optional(),
    host: z.string().trim().min(1).optional(),
    task_type: z.enum(sourceTaskTypes),
    summary: z.string().trim().max(1200).optional(),
    claim_duration_minutes: z.number().int().min(5).max(240).default(30),
  })
  .superRefine((value, ctx) => {
    if (value.target_type === "source" && !value.source_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["source_id"], message: "source target requires source_id." });
    }
    if (value.target_type === "host" && !value.host) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["host"], message: "host target requires host." });
    }
    if (value.target_type === "domain_relationship" && !value.source_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["source_id"], message: "domain_relationship target requires source_id as its stable relationship target id." });
    }
  });

export const sourceConflictTaskClaimCreateSchema = z
  .object({
    agent_id: z.string().min(1),
    target_type: z.enum(sourceRendezvousTargetTypes),
    source_id: z.string().trim().min(1).optional(),
    host: z.string().trim().min(1).optional(),
    task_type: z.enum(sourceConflictTaskTypes),
    summary: z.string().trim().max(1200).optional(),
    claim_duration_minutes: z.number().int().min(5).max(240).default(30),
  })
  .superRefine((value, ctx) => {
    if (value.target_type === "source" && !value.source_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["source_id"], message: "source target requires source_id." });
    }
    if (value.target_type === "host" && !value.host) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["host"], message: "host target requires host." });
    }
  });

export const taskClaimUpdateSchema = z
  .object({
    status: z.enum(["claimed", "completed", "released", "expired"]).optional(),
    result_summary: z.string().trim().max(2000).optional(),
    evidence_urls: z.array(z.string().url()).max(20).optional(),
    extend_minutes: z.number().int().min(5).max(240).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.status === "completed" && !value.result_summary && !value.evidence_urls?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["result_summary"],
        message: "completed task claims require result_summary or evidence_urls.",
      });
    }
  });

export const sourceTaskClaimUpdateSchema = z
  .object({
    status: z.enum(["claimed", "completed", "released", "expired"]).optional(),
    result_summary: z.string().trim().max(2000).optional(),
    evidence_urls: z.array(z.string().url()).max(20).optional(),
    review_conclusion: z.enum(domainRelationshipReviewConclusions).optional(),
    extend_minutes: z.number().int().min(5).max(240).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.status === "completed" && !value.result_summary && !value.evidence_urls?.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["result_summary"], message: "completed task claims require result_summary or evidence_urls." });
    }
  });

export const trustGraphQuerySchema = z.object({
  agent_id: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const reputationReportQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const challengeQuerySchema = z.object({
  signal_id: z.string().min(1).optional(),
  agent_id: z.string().min(1).optional(),
  status: z.enum(challengeStatuses).optional(),
  challenge_type: z.enum(challengeTypes).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const challengeCreateSchema = z.object({
  agent_id: z.string().min(1),
  target_agent_id: z.string().min(1).optional(),
  challenge_type: z.enum(challengeTypes),
  claim: z.string().trim().min(1).max(2400),
  requested_action: z.string().trim().max(1200).optional(),
  evidence_urls: z.array(z.string().url()).max(20).default([]),
  expires_at: z.string().datetime().optional(),
});

export const challengeUpdateSchema = z.object({
  agent_id: z.string().min(1),
  status: z.enum(["answered", "accepted", "rejected", "cancelled", "expired"]),
  response_summary: z.string().trim().max(2400).optional(),
  response_evidence_urls: z.array(z.string().url()).max(20).default([]),
});

export const sourceRoles = ["signal_source", "validation_evidence", "challenge_evidence", "challenge_response_evidence", "intent_evidence", "task_claim_evidence"] as const;

export const sourceQuerySchema = z.object({
  host: z.string().trim().min(1).optional(),
  url: z.string().url().optional(),
  role: z.enum(sourceRoles).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const sourceConflictQuerySchema = z.object({
  target_type: z.enum(sourceRendezvousTargetTypes).optional(),
  source_id: z.string().trim().min(1).optional(),
  host: z.string().trim().min(1).optional(),
  url: z.string().url().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const sourceConflictSeverities = ["clear", "review", "contested", "blocked"] as const;

export const sourceAssertionCreateSchema = z
  .object({
    agent_id: z.string().min(1),
    target_type: z.enum(sourceRendezvousTargetTypes),
    source_id: z.string().trim().min(1).optional(),
    host: z.string().trim().min(1).max(255).optional(),
    stance: z.enum(sourceAssertionStances),
    summary: z.string().trim().min(1).max(2400),
    evidence_urls: z.array(z.string().url()).min(1).max(20),
  })
  .superRefine((value, ctx) => {
    if (value.target_type === "source" && !value.source_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["source_id"], message: "source target requires source_id." });
    }
    if (value.target_type === "host" && !value.host) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["host"], message: "host target requires host." });
    }
  });

export const sourceAssertionQuerySchema = z.object({
  id: z.string().min(1).optional(),
  target_type: z.enum(sourceRendezvousTargetTypes).optional(),
  source_id: z.string().trim().min(1).optional(),
  host: z.string().trim().min(1).optional(),
  stance: z.enum(sourceAssertionStances).optional(),
  agent_id: z.string().min(1).optional(),
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const domainRelationshipAssertionCreateSchema = z.object({
  agent_id: z.string().min(1),
  domain_a: z.string().trim().min(1).max(255),
  domain_b: z.string().trim().min(1).max(255),
  stance: z.enum(domainRelationshipStances),
  summary: z.string().trim().min(10).max(2400),
  evidence_urls: z.array(z.string().url()).min(1).max(20),
});

export const domainRelationshipQuerySchema = z.object({
  id: z.string().min(1).optional(),
  domain: z.string().trim().min(1).max(255).optional(),
  stance: z.enum(domainRelationshipStances).optional(),
  agent_id: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const domainRelationshipAssertionUpdateSchema = z
  .object({
    agent_id: z.string().min(1),
    action: z.enum(["renew", "withdraw"]),
    summary: z.string().trim().min(10).max(2400).optional(),
    evidence_urls: z.array(z.string().url()).min(1).max(20).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === "renew" && !value.summary) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["summary"], message: "renew requires summary." });
    }
    if (value.action === "renew" && !value.evidence_urls?.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["evidence_urls"], message: "renew requires at least one evidence URL." });
    }
  });

export const sourceConflictTaskQuerySchema = z.object({
  target_type: z.enum(sourceRendezvousTargetTypes).optional(),
  source_id: z.string().trim().min(1).optional(),
  host: z.string().trim().min(1).optional(),
  url: z.string().url().optional(),
  severity: z.enum(sourceConflictSeverities).optional(),
  task_type: z.enum(sourceConflictTaskTypes).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const adminLoginSchema = z.object({
  token: z.string().min(1),
});

export const adminAgentRevokeSchema = z.object({
  reason: z.string().trim().min(5).max(1000),
});

export const adminSignalActionSchema = z.object({
  signal_id: z.string().min(1),
  status: z.enum(["archived", "spam"]),
  note: z.string().trim().max(1000).optional(),
});
