import { createHash } from "node:crypto";

export const HANDOFF_POLICY_KEY = "agent-event-handoff-routing";
export const HANDOFF_POLICY_VERSION = "2026-07-17.3";

const highRiskEventTypes = ["infrastructure_claim_failed", "infrastructure_claim_stale", "infrastructure_claim_expired", "domain_relationship_review_consensus_changed", "domain_relationship_assertion_created", "domain_relationship_assertion_withdrawn", "domain_relationship_assertion_superseded"];
const lowRiskEventTypes = ["agent_seen", "inbox_changed", "source_watch_matched", "source_watch_arbitration_changed"];

export function handoffPolicyDocument() {
  return {
    policy_key: HANDOFF_POLICY_KEY,
    version: HANDOFF_POLICY_VERSION,
    effective_date: "2026-07-17",
    risk_tiers: {
      high: {
        event_types: highRiskEventTypes,
        gates: ["target_trust_level=trusted", "verified_infrastructure_or_bootstrap", "source_target_infrastructure_independent", "handoff_opt_in", "below_declared_capacity", "requested_capability_match"],
        exploration_score: 0,
      },
      standard: { event_types: "all events not explicitly high or low", exploration_score: { samples_lt_3: 2, samples_lt_10: 1 } },
      low: { event_types: lowRiskEventTypes, exploration_score: { samples_lt_3: 4, samples_lt_10: 2 } },
    },
    scoring: {
      inputs: ["capability_coverage", "trust", "reputation", "declared_availability", "active_load", "event_type_preference", "event_type_reliability", "completion_speed", "exploration", "volume_saturation", "infrastructure_overlap"],
      reliability_window_days: 30,
      reliability_partition: "event_type",
      cross_type_reliability_transfer: false,
      reliability_score_range: [-6, 6],
      speed_score_max: 2,
      volume_saturation_penalty_max: 5,
    },
    acceptance: {
      offer_policy_binding: "version_and_document_hash",
      policy_change_effect: "reject_acceptance_and_require_new_offer",
      high_risk_acknowledgement: {
        required_fields: ["policy_version", "policy_document_hash"],
        mismatch_effect: "reject_with_required_policy",
      },
      high_risk_revalidation_at_accept: ["target_active", "target_trusted", "verified_infrastructure_or_bootstrap", "source_target_infrastructure_independent", "handoff_opt_in", "below_declared_capacity", "requested_capability_match"],
    },
    effects: { governance: "none", reputation: "none", acknowledgement_ownership_transfer: false },
  };
}

export function handoffPolicyHash() {
  return createHash("sha256").update(JSON.stringify(handoffPolicyDocument())).digest("hex");
}

export function classifyHandoffEventRisk(eventType: string | null) {
  return eventType && highRiskEventTypes.includes(eventType) ? "high" : eventType && lowRiskEventTypes.includes(eventType) ? "low" : "standard";
}
