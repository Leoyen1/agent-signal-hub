import crypto from "node:crypto";

process.env.INFRASTRUCTURE_CLAIM_TTL_HOURS = "1";
process.env.INFRASTRUCTURE_CLAIM_WARNING_HOURS = "1";
process.env.NEXT_PUBLIC_APP_URL ||= "https://agent-signal-hub.example.test";
process.env.DOMAIN_RELATIONSHIP_ASSERTION_WARNING_HOURS = "1";
process.env.DIGEST_ESTABLISHED_VALIDATOR_MIN_HOURS = "0";
process.env.DIGEST_ESTABLISHED_VALIDATOR_MIN_REPUTATION = "0";
process.env.DIGEST_REQUIRE_VERIFIED_INFRASTRUCTURE = "false";
process.env.DOMAIN_CONTROLLER_MAX_CLUSTER_SIZE = "3";

const {
  fetchAndVerifyInfrastructureProof,
  infrastructureProofCanonical,
  INFRASTRUCTURE_PROOF_SCHEMA_VERSION,
} = await import("../lib/infrastructure-proof.ts");
const { publicKeyFingerprint } = await import("../lib/agent-credentials.ts");
const { handoffPolicyDocument, handoffPolicyHash, syncHandoffPolicyVersion } = await import("../lib/handoff-policy.ts");
const { acknowledgeAgentEvents, buildAgentEvents, buildNodeEvents, leaseAgentEvents, updateAgentEventLease } = await import("../lib/events.ts");
const { buildAgentInbox } = await import("../lib/agent-inbox.ts");
const { createAgentEventHandoff, recommendAgentEventHandoffCandidates, updateAgentEventHandoff } = await import("../lib/event-handoffs.ts");
const { refreshDueInfrastructureClaims } = await import("../lib/infrastructure-maintenance.ts");
const { buildDomainControllerIndex, listDomainRelationshipAssertions } = await import("../lib/domain-relationships.ts");
const { buildSourceRendezvousTasks, claimSourceRendezvousTask, updateSourceTaskClaim } = await import("../lib/source-rendezvous-tasks.ts");
const { checkSignalQuality } = await import("../lib/quality.ts");
const { evaluateSignalGovernance } = await import("../lib/governance.ts");
const { prisma } = await import("../lib/prisma.ts");

const keyPair = crypto.generateKeyPairSync("ed25519");
const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString().trim();
const privateKey = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim();
const agentId = `infrastructure-proof-success-${process.pid}`;
const origin = "https://proof-success.example.test";
const registrableDomain = "example.test";
const fingerprint = publicKeyFingerprint(publicKey);
const canonicalPayload = infrastructureProofCanonical({
  agentId,
  target: "homepage",
  origin,
  registrableDomain,
  publicKeyFingerprint: fingerprint,
});
const document = {
  schema_version: INFRASTRUCTURE_PROOF_SCHEMA_VERSION,
  agent_id: agentId,
  target: "homepage",
  origin,
  registrable_domain: registrableDomain,
  public_key_fingerprint: fingerprint,
  signature: crypto.sign(null, Buffer.from(canonicalPayload), privateKey).toString("base64"),
};
const serializedDocument = JSON.stringify(document);
let requestedUrl;
const transport = async (url, options) => {
  requestedUrl = url;
  if (options?.method !== "GET" || options?.maxResponseBytes !== 32 * 1024) {
    throw new Error("infrastructure proof did not preserve the bounded GET transport contract");
  }
  return {
    status: 200,
    headers: { "content-length": String(Buffer.byteLength(serializedDocument)) },
    body: serializedDocument,
    remoteAddress: "203.0.113.10",
  };
};

const verificationNow = new Date(Date.now() - 30 * 60_000);
const verification = await fetchAndVerifyInfrastructureProof(
  { id: agentId, homepageUrl: `${origin}/agent`, callbackUrl: null, publicKey },
  "homepage",
  { transport, now: verificationNow },
);
if (!verification.ok) throw new Error(`valid injected infrastructure proof was rejected: ${verification.error}`);
if (requestedUrl !== `${origin}/.well-known/ash-agent-signal-hub.json`) {
  throw new Error(`proof transport requested an unexpected URL: ${requestedUrl}`);
}
if (verification.publicKeyFingerprint !== fingerprint || verification.verifiedAt.getTime() !== verificationNow.getTime()) {
  throw new Error("verified proof was not bound to the active key and controlled clock");
}
if (verification.expiresAt.getTime() - verification.verifiedAt.getTime() !== 3_600_000) {
  throw new Error("infrastructure proof TTL was not applied to the verified claim");
}

await prisma.agent.create({
  data: {
    id: agentId,
    name: "Infrastructure proof success fixture",
    description: "Isolated lifecycle event fixture",
    ownerType: "anonymous",
    agentType: "research",
    homepageUrl: `${origin}/agent`,
    publicKey,
    apiKeyHash: crypto.createHash("sha256").update(agentId).digest("hex"),
  },
});
const peerKeyPair = crypto.generateKeyPairSync("ed25519");
const peerPublicKey = peerKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString().trim();
const peerAgentId = `${agentId}-peer`;
await prisma.agent.create({
  data: {
    id: peerAgentId,
    name: "Domain relationship lifecycle peer",
    description: "Independent controller assertion fixture",
    ownerType: "anonymous",
    agentType: "research",
    capabilities: JSON.stringify(["event_reanalysis"]),
    homepageUrl: "https://domain-lifecycle-peer.org/agent",
    publicKey: peerPublicKey,
    apiKeyHash: crypto.createHash("sha256").update(peerAgentId).digest("hex"),
  },
});

try {
  const policySince = new Date(Date.now() - 1000);
  const policyDocumentBeforeSync = handoffPolicyDocument();
  const policyHashBeforeSync = handoffPolicyHash();
  const firstPolicySync = await syncHandoffPolicyVersion();
  const repeatedPolicySync = await syncHandoffPolicyVersion();
  if (!firstPolicySync.created || repeatedPolicySync.created || firstPolicySync.event.documentHash !== policyHashBeforeSync || policyDocumentBeforeSync.version !== firstPolicySync.event.version) {
    throw new Error(`handoff policy version registration was not stable and idempotent: ${JSON.stringify({ firstPolicySync, repeatedPolicySync, policyDocumentBeforeSync, policyHashBeforeSync })}`);
  }
  const policyNodeEvents = await buildNodeEvents({ since: policySince, limit: 200 });
  const policyAgentEvents = await buildAgentEvents(agentId, { since: policySince, limit: 200 });
  if (!policyNodeEvents.events.some((event) => event.type === "handoff_policy_version_changed" && event.metadata?.document_hash === policyHashBeforeSync) || !policyAgentEvents?.events.some((event) => event.type === "handoff_policy_version_changed")) {
    throw new Error(`handoff policy version event was not visible in node and agent streams: ${JSON.stringify({ policyNodeEvents: policyNodeEvents.events, policyAgentEvents: policyAgentEvents?.events })}`);
  }
  const claim = await prisma.agentInfrastructureClaim.create({
    data: {
      agentId,
      target: "homepage",
      declaredUrl: verification.descriptor.declaredUrl,
      origin: verification.descriptor.origin,
      registrableDomain: verification.descriptor.registrableDomain,
      proofUrl: verification.descriptor.proofUrl,
      publicKeyFingerprint: verification.publicKeyFingerprint,
      proofDocumentHash: verification.proofDocumentHash,
      status: "verified",
      verifiedAt: verification.verifiedAt,
      expiresAt: verification.expiresAt,
      lastCheckedAt: verification.verifiedAt,
    },
  });
  const since = new Date(verificationNow.getTime() - 60_000);
  const [nodeEvents, agentEvents] = await Promise.all([
    buildNodeEvents({ since, limit: 100 }),
    buildAgentEvents(agentId, { since, limit: 100 }),
  ]);
  for (const stream of [nodeEvents, agentEvents]) {
    const claimEvents = stream?.events?.filter((event) => event.subject?.id === claim.id) ?? [];
    if (!claimEvents.some((event) => event.type === "infrastructure_claim_verified")) {
      throw new Error("verified infrastructure claim event is missing");
    }
    if (!claimEvents.some((event) => event.type === "infrastructure_claim_expiring")) {
      throw new Error("expiring infrastructure claim event is missing");
    }
  }

  const refreshNow = new Date();
  const successfulRefresh = await refreshDueInfrastructureClaims({ transport, now: refreshNow, batchSize: 10 });
  if (successfulRefresh.refreshed !== 1 || successfulRefresh.processed !== 1) {
    throw new Error(`due infrastructure claim was not automatically refreshed: ${JSON.stringify(successfulRefresh)}`);
  }
  const refreshedClaim = await prisma.agentInfrastructureClaim.findUniqueOrThrow({ where: { id: claim.id } });
  if (
    refreshedClaim.status !== "verified" ||
    refreshedClaim.verifiedAt?.getTime() !== refreshNow.getTime() ||
    refreshedClaim.expiresAt?.getTime() !== refreshNow.getTime() + 3_600_000
  ) {
    throw new Error("automatic refresh did not renew the claim from the controlled maintenance time");
  }

  const deferredExpiry = new Date(refreshNow.getTime() + 30 * 60_000);
  await prisma.agentInfrastructureClaim.update({ where: { id: claim.id }, data: { expiresAt: deferredExpiry } });
  const unavailableTransport = async () => {
    throw new Error("simulated transient network failure");
  };
  const deferredRefresh = await refreshDueInfrastructureClaims({ transport: unavailableTransport, now: refreshNow, batchSize: 10 });
  const deferredClaim = await prisma.agentInfrastructureClaim.findUniqueOrThrow({ where: { id: claim.id } });
  if (deferredRefresh.deferred !== 1 || deferredClaim.status !== "verified" || !deferredClaim.failureReason) {
    throw new Error("transient refresh failure did not preserve the still-valid claim with failure metadata");
  }

  const expiredAt = new Date(refreshNow.getTime() - 1000);
  await prisma.agentInfrastructureClaim.update({ where: { id: claim.id }, data: { expiresAt: expiredAt } });
  const failedRefresh = await refreshDueInfrastructureClaims({ transport: unavailableTransport, now: refreshNow, batchSize: 10 });
  const failedClaim = await prisma.agentInfrastructureClaim.findUniqueOrThrow({ where: { id: claim.id } });
  if (failedRefresh.failed !== 1 || failedClaim.status !== "failed") {
    throw new Error("expired claim did not fail closed after automatic refresh failure");
  }
  const [expiredNodeEvents, expiredAgentEvents] = await Promise.all([
    buildNodeEvents({ since, limit: 100 }),
    buildAgentEvents(agentId, { since, limit: 100 }),
  ]);
  for (const stream of [expiredNodeEvents, expiredAgentEvents]) {
    const expiredEvent = stream?.events?.find(
      (event) => event.type === "infrastructure_claim_expired" && event.subject?.id === claim.id,
    );
    if (!expiredEvent || expiredEvent.occurred_at !== expiredAt.toISOString()) {
      throw new Error("expired infrastructure claim event is missing or does not use expires_at");
    }
  }

  const relationshipNow = new Date();
  const relationshipExpiresAt = new Date(relationshipNow.getTime() + 30 * 60_000);
  const relationshipPair = ["lifecycle-controller-a.net", "lifecycle-controller-b.org"];
  const relationshipAssertions = [];
  for (const [assertingAgentId, evidenceUrl] of [
    [agentId, "https://lifecycle-evidence-a.dev/report"],
    [peerAgentId, "https://lifecycle-evidence-b.io/report"],
  ]) {
    relationshipAssertions.push(
      await prisma.domainRelationshipAssertion.create({
        data: {
          agentId: assertingAgentId,
          domainA: relationshipPair[0],
          domainB: relationshipPair[1],
          stance: "same_controller",
          status: "active",
          summary: "Controlled domain relationship lifecycle fixture.",
          evidenceUrls: JSON.stringify([evidenceUrl]),
          expiresAt: relationshipExpiresAt,
          createdAt: relationshipNow,
        },
      }),
    );
  }
  const activeControllerIndex = await buildDomainControllerIndex({ now: relationshipNow });
  if (activeControllerIndex.controllerKey(relationshipPair[0]) !== activeControllerIndex.controllerKey(relationshipPair[1])) {
    throw new Error("active domain relationship assertion quorum did not link controller groups");
  }
  const relationshipSince = new Date(relationshipNow.getTime() - 60 * 60_000);
  const [relationshipNodeEvents, relationshipAgentEvents] = await Promise.all([
    buildNodeEvents({ since: relationshipSince, limit: 100 }),
    buildAgentEvents(agentId, { since: relationshipSince, limit: 100 }),
  ]);
  for (const stream of [relationshipNodeEvents, relationshipAgentEvents]) {
    if (
      !stream?.events.some((event) => event.type === "domain_relationship_assertion_created" && event.subject?.id === relationshipAssertions[0].id) ||
      !stream?.events.some((event) => event.type === "domain_relationship_assertion_expiring" && event.subject?.id === relationshipAssertions[0].id)
    ) {
      throw new Error("domain relationship created or expiring lifecycle events are missing from node or agent stream");
    }
  }
  const relationshipExpiredAt = new Date(relationshipNow.getTime() - 1000);
  await prisma.domainRelationshipAssertion.update({ where: { id: relationshipAssertions[0].id }, data: { expiresAt: relationshipExpiredAt } });
  const expiredControllerIndex = await buildDomainControllerIndex({ now: relationshipNow });
  if (expiredControllerIndex.controllerKey(relationshipPair[0]) === expiredControllerIndex.controllerKey(relationshipPair[1])) {
    throw new Error("expired domain relationship assertion continued contributing controller authority");
  }
  const [expiredRelationshipNodeEvents, expiredRelationshipAgentEvents] = await Promise.all([
    buildNodeEvents({ since: relationshipSince, limit: 100 }),
    buildAgentEvents(agentId, { since: relationshipSince, limit: 100 }),
  ]);
  for (const stream of [expiredRelationshipNodeEvents, expiredRelationshipAgentEvents]) {
    if (!stream?.events.some((event) => event.type === "domain_relationship_assertion_expired" && event.subject?.id === relationshipAssertions[0].id)) {
      throw new Error("domain relationship expired lifecycle event is missing from node or agent stream");
    }
  }

  const quarantineDomains = ["quarantine-a.net", "quarantine-b.org", "quarantine-c.info", "quarantine-d.dev"];
  for (let index = 0; index < quarantineDomains.length - 1; index += 1) {
    for (const [assertingAgentId, evidenceUrl] of [
      [agentId, `https://cluster-evidence-a-${index}.com/report`],
      [peerAgentId, `https://cluster-evidence-b-${index}.io/report`],
    ]) {
      await prisma.domainRelationshipAssertion.create({
        data: {
          agentId: assertingAgentId,
          domainA: quarantineDomains[index],
          domainB: quarantineDomains[index + 1],
          stance: "same_controller",
          status: "active",
          summary: "Controlled transitive cluster expansion fixture.",
          evidenceUrls: JSON.stringify([evidenceUrl]),
          expiresAt: new Date(relationshipNow.getTime() + 60 * 60_000),
          createdAt: new Date(relationshipNow.getTime() + index + 1),
        },
      });
    }
  }
  const quarantinedIndex = await buildDomainControllerIndex({ now: relationshipNow });
  const expansionAnomaly = quarantinedIndex.anomalies.find(
    (relationship) => relationship.domain_a === quarantineDomains[2] && relationship.domain_b === quarantineDomains[3],
  );
  if (
    expansionAnomaly?.state !== "quarantined_cluster_expansion" ||
    !expansionAnomaly.anomaly_reasons.some((reason) => reason.includes("cluster_size_limit_exceeded")) ||
    quarantinedIndex.quarantinedDomainsFor(quarantineDomains).length !== quarantineDomains.length
  ) {
    throw new Error(`transitive controller cluster expansion was not quarantined: ${JSON.stringify(quarantinedIndex.anomalies)}`);
  }
  const acceptedPath = quarantinedIndex.controllerPath(quarantineDomains[0], quarantineDomains[2]);
  if (acceptedPath?.join("|") !== quarantineDomains.slice(0, 3).join("|")) {
    throw new Error(`controller path explanation is incomplete: ${JSON.stringify(acceptedPath)}`);
  }
  const quarantinedQuality = await checkSignalQuality({
    title: "Quarantined controller source fixture",
    source_urls: [`https://${quarantineDomains[0]}/report`, `https://${quarantineDomains[3]}/report`],
    confidence: 0.96,
    submitted_by_agent_id: agentId,
  });
  if (!quarantinedQuality.errors.some((error) => error.includes("controller-relationship quarantine"))) {
    throw new Error(`high-confidence quality check accepted quarantined controller domains: ${JSON.stringify(quarantinedQuality)}`);
  }
  const governanceAgents = await prisma.agent.findMany({
    where: { id: { in: [agentId, peerAgentId] } },
    include: { infrastructureClaims: true },
    orderBy: { id: "asc" },
  });
  const syntheticSignal = {
    id: "synthetic-quarantine-signal",
    title: "Synthetic quarantine governance fixture",
    category: "test",
    summary: "Synthetic governance fixture",
    sourceUrls: JSON.stringify(["https://safe-source-one.com/report", "https://safe-source-two.org/report"]),
    evidence: "Synthetic evidence",
    whyItMatters: null,
    whoCares: "[]",
    opportunity: null,
    risk: null,
    confidence: 0.9,
    urgency: "high",
    status: "active",
    expiresAt: new Date(relationshipNow.getTime() + 24 * 60 * 60_000),
    submittedByAgentId: "synthetic-owner",
    createdAt: relationshipNow,
    updatedAt: relationshipNow,
    submittedByAgent: { id: "synthetic-owner", name: "Synthetic owner", reputationScore: 0, trustLevel: "low" },
    validations: governanceAgents.map((agent, index) => ({
      id: `synthetic-validation-${index}`,
      signalId: "synthetic-quarantine-signal",
      agentId: agent.id,
      verdict: "support",
      comment: null,
      evidenceUrls: JSON.stringify([`https://${quarantineDomains[index === 0 ? 0 : 3]}/review`]),
      confidenceDelta: null,
      createdAt: new Date(relationshipNow.getTime() + index),
      agent,
    })),
  };
  const quarantinedEvidenceGovernance = evaluateSignalGovernance(syntheticSignal, null, quarantinedIndex);
  if (
    quarantinedEvidenceGovernance.inputs.quarantined_evidence_validator_ids.length !== 2 ||
    quarantinedEvidenceGovernance.inputs.established_independent_evidence_backed_support_count !== 0
  ) {
    throw new Error(`quarantined validation evidence contributed governance weight: ${JSON.stringify(quarantinedEvidenceGovernance)}`);
  }
  const quarantinedSourceGovernance = evaluateSignalGovernance(
    { ...syntheticSignal, sourceUrls: JSON.stringify([`https://${quarantineDomains[0]}/report`, `https://${quarantineDomains[3]}/report`]), validations: [] },
    null,
    quarantinedIndex,
  );
  if (quarantinedSourceGovernance.state !== "suppressed" || quarantinedSourceGovernance.inputs.quarantined_source_domains.length !== 2) {
    throw new Error(`quarantined signal sources were not suppressed: ${JSON.stringify(quarantinedSourceGovernance)}`);
  }

  const controllerTasks = await buildSourceRendezvousTasks({ targetType: "domain_relationship" });
  const controllerTask = controllerTasks.tasks.find(
    (task) => task.target_type === "domain_relationship" && task.target.domain_a === quarantineDomains[2] && task.target.domain_b === quarantineDomains[3] && task.task_type === "review_controller_expansion",
  );
  if (!controllerTask || controllerTask.priority < 90 || !controllerTask.target.anomaly_reasons.length) {
    throw new Error(`quarantined controller expansion was not routed as an explainable high-priority task: ${JSON.stringify(controllerTasks.tasks)}`);
  }
  const controllerClaimResult = await claimSourceRendezvousTask({
    agent: governanceAgents[0],
    targetType: "domain_relationship",
    sourceId: controllerTask.target.source_id,
    taskType: "review_controller_expansion",
    summary: "Inspecting the quarantined transitive controller expansion.",
    claimDurationMinutes: 30,
  });
  if (controllerClaimResult.status !== 201) {
    throw new Error(`controller anomaly task could not be claimed: ${JSON.stringify(controllerClaimResult.body)}`);
  }
  const missingConclusionCompletion = await updateSourceTaskClaim({
    agentId: governanceAgents[0].id,
    claimId: controllerClaimResult.body.claim.id,
    status: "completed",
    resultSummary: "Reviewed the expansion; relationship lifecycle action remains separate.",
  });
  if (!missingConclusionCompletion || !("error" in missingConclusionCompletion) || missingConclusionCompletion.status !== 422) {
    throw new Error(`controller task completed without a structured conclusion: ${JSON.stringify(missingConclusionCompletion)}`);
  }
  const completedControllerClaim = await updateSourceTaskClaim({
    agentId: governanceAgents[0].id,
    claimId: controllerClaimResult.body.claim.id,
    status: "completed",
    resultSummary: "Reviewed the expansion; relationship lifecycle action remains separate.",
    evidenceUrls: ["https://controller-review-one.com/report"],
    reviewConclusion: "recommend_withdrawal",
  });
  if (!completedControllerClaim || "error" in completedControllerClaim || completedControllerClaim.completion_effect?.reputation_delta !== 0 || completedControllerClaim.claim.review_conclusion !== "recommend_withdrawal") {
    throw new Error(`controller task completion changed reputation: ${JSON.stringify(completedControllerClaim)}`);
  }
  const peerControllerClaim = await claimSourceRendezvousTask({
    agent: governanceAgents[1],
    targetType: "domain_relationship",
    sourceId: controllerTask.target.source_id,
    taskType: "review_controller_expansion",
    summary: "Independent review of the quarantined controller expansion.",
    claimDurationMinutes: 30,
  });
  if (peerControllerClaim.status !== 201) {
    throw new Error(`independent controller review task could not be claimed: ${JSON.stringify(peerControllerClaim.body)}`);
  }
  const peerControllerCompletion = await updateSourceTaskClaim({
    agentId: governanceAgents[1].id,
    claimId: peerControllerClaim.body.claim.id,
    status: "completed",
    resultSummary: "Independent evidence indicates the expansion edge should be withdrawn.",
    evidenceUrls: ["https://controller-review-two.org/report"],
    reviewConclusion: "recommend_withdrawal",
  });
  if (!peerControllerCompletion || "error" in peerControllerCompletion) {
    throw new Error(`independent controller review could not be completed: ${JSON.stringify(peerControllerCompletion)}`);
  }
  const activeReviewIndex = await listDomainRelationshipAssertions({ domain: quarantineDomains[2] });
  const activeReview = activeReviewIndex.controller_reviews.find((review) => review.id === controllerClaimResult.body.claim.id);
  if (!activeReview?.anomaly_active || activeReview.review_conclusion !== "recommend_withdrawal" || activeReview.relationship_target_id !== controllerTask.target.source_id || !activeReview.protocol_actions.submit_relationship_evidence) {
    throw new Error(`completed controller review was not linked to the active anomaly: ${JSON.stringify(activeReviewIndex.controller_reviews)}`);
  }
  const activeConsensus = activeReviewIndex.review_consensus.find((consensus) => consensus.relationship_target_id === controllerTask.target.source_id);
  if (activeConsensus?.state !== "withdrawal_recommended" || activeConsensus.independent_evidence_backed_counts.recommend_withdrawal !== 2 || activeConsensus.governance_effect !== "none") {
    throw new Error(`independent controller reviews did not produce advisory consensus: ${JSON.stringify(activeReviewIndex.review_consensus)}`);
  }
  const consensusNodeEvents = await buildNodeEvents({ since: relationshipSince, limit: 200 });
  const consensusAgentEvents = await buildAgentEvents(governanceAgents[0].id, { since: relationshipSince, limit: 200 });
  if (!consensusNodeEvents.events.some((event) => event.type === "domain_relationship_review_consensus_changed" && event.metadata?.current_state === "withdrawal_recommended")) {
    throw new Error(`controller review consensus change was missing from node events: ${JSON.stringify(consensusNodeEvents.events)}`);
  }
  if (!consensusAgentEvents?.events.some((event) => event.type === "domain_relationship_review_consensus_changed" && event.metadata?.relationship_target_id === controllerTask.target.source_id)) {
    throw new Error(`controller review consensus change was missing from relevant agent events: ${JSON.stringify(consensusAgentEvents?.events)}`);
  }
  const consensusEvent = consensusAgentEvents.events.find((event) => event.type === "domain_relationship_review_consensus_changed" && event.metadata?.relationship_target_id === controllerTask.target.source_id);
  const acknowledgement = await acknowledgeAgentEvents(governanceAgents[0].id, [consensusEvent.id, consensusEvent.id]);
  const acknowledgedAgentEvents = await buildAgentEvents(governanceAgents[0].id, { since: relationshipSince, limit: 200 }, { includeAcknowledgements: true });
  const acknowledgedConsensusEvent = acknowledgedAgentEvents?.events.find((event) => event.id === consensusEvent.id);
  if (acknowledgement.acknowledged_count !== 1 || !acknowledgedConsensusEvent?.acknowledged || !acknowledgedConsensusEvent.acknowledged_at) {
    throw new Error(`controller consensus acknowledgement was not idempotent or visible: ${JSON.stringify({ acknowledgement, acknowledgedConsensusEvent })}`);
  }
  const pendingOwnerEvents = await buildAgentEvents(
    governanceAgents[0].id,
    { since: relationshipSince, limit: 200 },
    { includeAcknowledgements: true, unacknowledgedOnly: true },
  );
  if (
    pendingOwnerEvents?.events.some((event) => event.id === consensusEvent.id) ||
    pendingOwnerEvents?.processing_state.unacknowledged_only !== true ||
    pendingOwnerEvents?.processing_state.scanned_event_count === undefined ||
    new Date(pendingOwnerEvents.cursor.next_since).getTime() <= relationshipSince.getTime()
  ) {
    throw new Error(`unacknowledged event filtering did not advance across acknowledged events: ${JSON.stringify(pendingOwnerEvents)}`);
  }
  const failureLease = await leaseAgentEvents(governanceAgents[0].id, { since: relationshipSince, limit: 100, leaseDurationSeconds: 120 });
  if (!failureLease?.events.length) throw new Error(`no pending event was available for lease backoff verification: ${JSON.stringify(failureLease)}`);
  const failureLeaseIds = failureLease.events.map((event) => event.id);
  await prisma.agentEventLease.updateMany({
    where: { agentId: governanceAgents[0].id, eventId: { in: failureLeaseIds } },
    data: { leaseUntil: new Date(Date.now() - 1000) },
  });
  const firstBackoff = await leaseAgentEvents(governanceAgents[0].id, { since: relationshipSince, limit: 100, leaseDurationSeconds: 120 });
  const repeatedBackoff = await leaseAgentEvents(governanceAgents[0].id, { since: relationshipSince, limit: 100, leaseDurationSeconds: 120 });
  if (firstBackoff?.processing_state.blocked?.reason !== "expiry_backoff" || firstBackoff.processing_state.blocked.failure_count !== 1 || repeatedBackoff?.processing_state.blocked?.failure_count !== 1) {
    throw new Error(`event lease expiry was not counted once with backoff: ${JSON.stringify({ firstBackoff, repeatedBackoff })}`);
  }
  await prisma.agentEventLease.update({
    where: { agentId_eventId: { agentId: governanceAgents[0].id, eventId: failureLeaseIds[0] } },
    data: { failureCount: 2, nextAvailableAt: null, lastExpiredLeaseUntil: null },
  });
  const reevaluationBackoff = await leaseAgentEvents(governanceAgents[0].id, { since: relationshipSince, limit: 100, leaseDurationSeconds: 120 });
  if (reevaluationBackoff?.processing_state.blocked?.failure_count !== 3 || !reevaluationBackoff.processing_state.blocked.requires_reevaluation) {
    throw new Error(`repeated lease expiry did not trigger reevaluation: ${JSON.stringify(reevaluationBackoff)}`);
  }
  const reportedFailure = await updateAgentEventLease({
    agentId: governanceAgents[0].id,
    eventIds: failureLeaseIds,
    leaseToken: failureLease.lease_token,
    action: "report_failure",
    failureReason: "capability_mismatch",
    failureDetail: "Current worker lacks the capability required to process this event safely.",
  });
  if ("error" in reportedFailure || reportedFailure.action !== "report_failure" || !reportedFailure.requires_reevaluation) {
    throw new Error(`structured lease failure could not be reported: ${JSON.stringify(reportedFailure)}`);
  }
  const reevaluationInbox = await buildAgentInbox(governanceAgents[0].id, 25);
  if (!reevaluationInbox?.event_reevaluation.some((item) => item.event_id === failureLeaseIds[0] && item.failure_reason === "capability_mismatch" && item.requires_reevaluation)) {
    throw new Error(`lease failure was not routed to agent inbox reevaluation: ${JSON.stringify(reevaluationInbox?.event_reevaluation)}`);
  }
  await prisma.agent.update({
    where: { id: governanceAgents[1].id },
    data: { handoffOptIn: false, handoffMaxConcurrent: 1, handoffPreferredEventTypes: JSON.stringify([consensusEvent.type]), handoffProfileUpdatedAt: new Date() },
  });
  const optedOutCandidates = await recommendAgentEventHandoffCandidates({
    sourceAgent: governanceAgents[0],
    eventId: failureLeaseIds[0],
    requestedCapabilities: ["event_reanalysis"],
    limit: 10,
  });
  if (optedOutCandidates.status !== 200 || optedOutCandidates.body.candidates.some((candidate) => candidate.agent.id === governanceAgents[1].id)) {
    throw new Error(`opted-out agent remained eligible for handoff: ${JSON.stringify(optedOutCandidates.body)}`);
  }
  await prisma.agent.update({ where: { id: governanceAgents[1].id }, data: { handoffOptIn: true, trustLevel: "trusted" } });
  await prisma.agentInfrastructureClaim.create({
    data: {
      agentId: governanceAgents[1].id,
      target: "homepage",
      declaredUrl: "https://domain-lifecycle-peer.org/agent",
      origin: "https://domain-lifecycle-peer.org",
      registrableDomain: "domain-lifecycle-peer.org",
      proofUrl: "https://domain-lifecycle-peer.org/.well-known/ash-agent-signal-hub.json",
      publicKeyFingerprint: publicKeyFingerprint(peerPublicKey),
      status: "verified",
      verifiedAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60_000),
    },
  });
  const handoffCandidates = await recommendAgentEventHandoffCandidates({
    sourceAgent: governanceAgents[0],
    eventId: failureLeaseIds[0],
    requestedCapabilities: ["event_reanalysis"],
    limit: 10,
  });
  if (handoffCandidates.status !== 200 || handoffCandidates.body.candidates[0]?.agent.id !== governanceAgents[1].id || !handoffCandidates.body.candidates[0].infrastructure_independent || handoffCandidates.body.candidates[0].max_concurrent_handoffs !== 1 || handoffCandidates.body.candidates[0].handoff_opt_in !== true) {
    throw new Error(`event handoff candidate ranking did not select the capable independent agent: ${JSON.stringify(handoffCandidates.body)}`);
  }
  const eventHandoff = await createAgentEventHandoff({
    sourceAgent: governanceAgents[0],
    eventId: failureLeaseIds[0],
    reason: "Source worker reported a capability mismatch and requests independent processing.",
    requestedCapabilities: ["event_reanalysis"],
  });
  if (eventHandoff.status !== 201 || eventHandoff.body.handoff.target_agent.id !== governanceAgents[1].id || eventHandoff.body.handoff.ownership.event_acknowledgement_agent_id !== governanceAgents[0].id) {
    throw new Error(`reevaluation event could not be handed off without moving acknowledgement ownership: ${JSON.stringify(eventHandoff.body)}`);
  }
  const capacityCandidates = await recommendAgentEventHandoffCandidates({
    sourceAgent: governanceAgents[0],
    eventId: failureLeaseIds[0],
    requestedCapabilities: ["event_reanalysis"],
    limit: 10,
  });
  if (capacityCandidates.status !== 200 || capacityCandidates.body.candidates.some((candidate) => candidate.agent.id === governanceAgents[1].id)) {
    throw new Error(`agent at declared handoff capacity remained eligible: ${JSON.stringify(capacityCandidates.body)}`);
  }
  const targetHandoffInbox = await buildAgentInbox(governanceAgents[1].id, 25);
  if (!targetHandoffInbox?.event_handoffs.some((item) => item.id === eventHandoff.body.handoff.id && item.direction === "incoming" && item.status === "offered")) {
    throw new Error(`event handoff was not routed to target agent inbox: ${JSON.stringify(targetHandoffInbox?.event_handoffs)}`);
  }
  await prisma.agent.update({ where: { id: governanceAgents[1].id }, data: { trustLevel: "low" } });
  const ineligibleTargetAcceptance = await updateAgentEventHandoff({ actorAgentId: governanceAgents[1].id, handoffId: eventHandoff.body.handoff.id, action: "accept", policyVersion: handoffPolicyDocument().version, policyDocumentHash: handoffPolicyHash() });
  if (ineligibleTargetAcceptance.status !== 409 || ineligibleTargetAcceptance.body.required_action !== "source_agent_reselect_target") {
    throw new Error(`high-risk handoff accepted after target lost eligibility: ${JSON.stringify(ineligibleTargetAcceptance)}`);
  }
  await prisma.agent.update({ where: { id: governanceAgents[1].id }, data: { trustLevel: "trusted" } });
  await prisma.agentEventHandoff.update({ where: { id: eventHandoff.body.handoff.id }, data: { offeredPolicyHash: "0".repeat(64) } });
  const changedOfferPolicyAcceptance = await updateAgentEventHandoff({ actorAgentId: governanceAgents[1].id, handoffId: eventHandoff.body.handoff.id, action: "accept", policyVersion: handoffPolicyDocument().version, policyDocumentHash: handoffPolicyHash() });
  if (changedOfferPolicyAcceptance.status !== 409 || changedOfferPolicyAcceptance.body.required_action !== "source_agent_recreate_handoff") {
    throw new Error(`handoff accepted after its offer policy changed: ${JSON.stringify(changedOfferPolicyAcceptance)}`);
  }
  await prisma.agentEventHandoff.update({ where: { id: eventHandoff.body.handoff.id }, data: { offeredPolicyHash: handoffPolicyHash() } });
  const stalePolicyAcceptance = await updateAgentEventHandoff({ actorAgentId: governanceAgents[1].id, handoffId: eventHandoff.body.handoff.id, action: "accept" });
  if (stalePolicyAcceptance.status !== 409 || !stalePolicyAcceptance.body.required_policy) {
    throw new Error(`high-risk handoff accepted without current policy acknowledgement: ${JSON.stringify(stalePolicyAcceptance)}`);
  }
  const acceptedHandoff = await updateAgentEventHandoff({
    actorAgentId: governanceAgents[1].id,
    handoffId: eventHandoff.body.handoff.id,
    action: "accept",
    policyVersion: handoffPolicyDocument().version,
    policyDocumentHash: handoffPolicyHash(),
  });
  const completedHandoff = await updateAgentEventHandoff({
    actorAgentId: governanceAgents[1].id,
    handoffId: eventHandoff.body.handoff.id,
    action: "complete",
    resultSummary: "Target agent processed the delegated event and returned structured context.",
    evidenceUrls: ["https://handoff-result.example.org/report"],
  });
  if (acceptedHandoff.status !== 200 || acceptedHandoff.body.handoff.accepted_policy?.document_hash !== handoffPolicyHash() || completedHandoff.status !== 200 || completedHandoff.body.handoff.status !== "completed") {
    throw new Error(`target agent could not complete the event handoff lifecycle: ${JSON.stringify({ acceptedHandoff, completedHandoff })}`);
  }
  const postCompletionCandidates = await recommendAgentEventHandoffCandidates({
    sourceAgent: governanceAgents[0],
    eventId: failureLeaseIds[0],
    requestedCapabilities: ["event_reanalysis"],
    limit: 10,
  });
  const completedCandidate = postCompletionCandidates.status === 200 ? postCompletionCandidates.body.candidates.find((candidate) => candidate.agent.id === governanceAgents[1].id) : null;
  if (!completedCandidate || !completedCandidate.reliability.event_type || completedCandidate.reliability.completed_count !== 1 || completedCandidate.reliability.overall_completed_count !== 1 || completedCandidate.reliability.smoothed_completion_rate <= 0.5 || completedCandidate.reliability.exploration_score !== 0 || completedCandidate.reliability.cross_type_transfer !== "disabled_for_scoring" || completedCandidate.risk_policy.event_risk_tier !== "high") {
    throw new Error(`completed handoff did not contribute bounded smoothed reliability metrics: ${JSON.stringify(postCompletionCandidates.body)}`);
  }
  const sourceHandoffInbox = await buildAgentInbox(governanceAgents[0].id, 25);
  if (!sourceHandoffInbox?.event_handoffs.some((item) => item.id === eventHandoff.body.handoff.id && item.direction === "outgoing" && item.status === "completed" && item.result_summary)) {
    throw new Error(`completed handoff result was not returned to source agent inbox: ${JSON.stringify(sourceHandoffInbox?.event_handoffs)}`);
  }
  const sourceReceiptAfterHandoff = await prisma.agentEventReceipt.findUnique({ where: { agentId_eventId: { agentId: governanceAgents[0].id, eventId: failureLeaseIds[0] } } });
  if (sourceReceiptAfterHandoff) throw new Error("target handoff completion incorrectly acknowledged the source agent event");
  const releasedFailureLease = await updateAgentEventLease({
    agentId: governanceAgents[0].id,
    eventIds: failureLeaseIds,
    leaseToken: failureLease.lease_token,
    action: "release",
  });
  if ("error" in releasedFailureLease) throw new Error(`backoff test leases could not be released: ${JSON.stringify(releasedFailureLease)}`);
  const unacknowledgedPeerEvents = await buildAgentEvents(governanceAgents[1].id, { since: relationshipSince, limit: 200 }, { includeAcknowledgements: true });
  const peerConsensusEvent = unacknowledgedPeerEvents?.events.find((event) => event.id === consensusEvent.id);
  if (peerConsensusEvent?.acknowledged) {
    throw new Error(`event acknowledgement leaked across agents: ${JSON.stringify(peerConsensusEvent)}`);
  }
  await prisma.agentEventLease.upsert({
    where: { agentId_eventId: { agentId: governanceAgents[1].id, eventId: consensusEvent.id } },
    update: { needsReevaluation: true, leaseUntil: new Date(Date.now() + 120_000) },
    create: { agentId: governanceAgents[1].id, eventId: consensusEvent.id, leaseTokenHash: crypto.createHash("sha256").update("high-risk-test").digest("hex"), leaseUntil: new Date(Date.now() + 120_000), needsReevaluation: true },
  });
  const highRiskBeforeTrust = await recommendAgentEventHandoffCandidates({ sourceAgent: governanceAgents[1], eventId: consensusEvent.id, requestedCapabilities: [], limit: 20 });
  if (highRiskBeforeTrust.status !== 200 || highRiskBeforeTrust.body.event_risk_tier !== "high" || highRiskBeforeTrust.body.candidates.some((candidate) => candidate.agent.id === governanceAgents[0].id)) {
    throw new Error(`high-risk candidate policy accepted a low-trust target: ${JSON.stringify(highRiskBeforeTrust.body)}`);
  }
  await prisma.agent.update({ where: { id: governanceAgents[0].id }, data: { trustLevel: "trusted" } });
  await prisma.agentInfrastructureClaim.updateMany({
    where: { agentId: governanceAgents[0].id },
    data: { status: "verified", expiresAt: new Date(Date.now() + 60 * 60_000), failureReason: null },
  });
  const highRiskAfterTrust = await recommendAgentEventHandoffCandidates({ sourceAgent: governanceAgents[1], eventId: consensusEvent.id, requestedCapabilities: [], limit: 20 });
  const highRiskTarget = highRiskAfterTrust.status === 200 ? highRiskAfterTrust.body.candidates.find((candidate) => candidate.agent.id === governanceAgents[0].id) : null;
  if (!highRiskTarget?.verified_infrastructure_or_bootstrap || !highRiskTarget.infrastructure_independent || highRiskTarget.reliability.exploration_score !== 0) {
    throw new Error(`high-risk candidate policy did not require trusted independent infrastructure: ${JSON.stringify(highRiskAfterTrust.body)}`);
  }
  await prisma.agentEventLease.delete({ where: { agentId_eventId: { agentId: governanceAgents[1].id, eventId: consensusEvent.id } } });
  const peerLease = await leaseAgentEvents(governanceAgents[1].id, { since: relationshipSince, limit: 100, leaseDurationSeconds: 120 });
  const leasedConsensusEvent = peerLease?.events.find((event) => event.id === consensusEvent.id);
  if (!peerLease?.lease_token || !leasedConsensusEvent) {
    throw new Error(`relevant consensus event was not leased: ${JSON.stringify(peerLease)}`);
  }
  const leasedEventIds = peerLease.events.map((event) => event.id);
  const renewedLease = await updateAgentEventLease({
    agentId: governanceAgents[1].id,
    eventIds: leasedEventIds,
    leaseToken: peerLease.lease_token,
    action: "renew",
    leaseDurationSeconds: 240,
  });
  if ("error" in renewedLease || renewedLease.action !== "renew" || new Date(renewedLease.lease_until).getTime() <= new Date(peerLease.lease_until).getTime()) {
    throw new Error(`event lease could not be renewed: ${JSON.stringify(renewedLease)}`);
  }
  const invalidRelease = await updateAgentEventLease({
    agentId: governanceAgents[1].id,
    eventIds: leasedEventIds,
    leaseToken: `${peerLease.lease_token}invalid`,
    action: "release",
  });
  if (!("error" in invalidRelease) || invalidRelease.status !== 409) {
    throw new Error(`event leases were released with an invalid token: ${JSON.stringify(invalidRelease)}`);
  }
  const competingPeerLease = await leaseAgentEvents(governanceAgents[1].id, { since: relationshipSince, limit: 100, leaseDurationSeconds: 120 });
  if (!competingPeerLease || competingPeerLease.events.length !== 0 || competingPeerLease.cursor.next_since !== competingPeerLease.cursor.since) {
    throw new Error(`concurrent agent instance leased an already active event or advanced past it: ${JSON.stringify(competingPeerLease)}`);
  }
  const releasedLease = await updateAgentEventLease({
    agentId: governanceAgents[1].id,
    eventIds: leasedEventIds,
    leaseToken: peerLease.lease_token,
    action: "release",
  });
  if ("error" in releasedLease || releasedLease.action !== "release") {
    throw new Error(`event leases could not be actively released: ${JSON.stringify(releasedLease)}`);
  }
  const reacquiredPeerLease = await leaseAgentEvents(governanceAgents[1].id, { since: relationshipSince, limit: 100, leaseDurationSeconds: 120 });
  if (!reacquiredPeerLease?.events.some((event) => event.id === consensusEvent.id)) {
    throw new Error(`released events were not immediately leaseable: ${JSON.stringify(reacquiredPeerLease)}`);
  }
  const missingLeaseTokenAck = await acknowledgeAgentEvents(governanceAgents[1].id, [consensusEvent.id]);
  if (!("error" in missingLeaseTokenAck) || missingLeaseTokenAck.status !== 409) {
    throw new Error(`active event lease was acknowledged without its token: ${JSON.stringify(missingLeaseTokenAck)}`);
  }
  const leasedAcknowledgement = await acknowledgeAgentEvents(governanceAgents[1].id, [consensusEvent.id], reacquiredPeerLease.lease_token);
  if ("error" in leasedAcknowledgement || leasedAcknowledgement.acknowledged_count !== 1) {
    throw new Error(`leased event could not be acknowledged with its token: ${JSON.stringify(leasedAcknowledgement)}`);
  }
  const consensusInbox = await buildAgentInbox(governanceAgents[1].id, 25);
  if (!consensusInbox?.controller_consensus.some((item) => item.relationship_target_id === controllerTask.target.source_id && item.current_state === "withdrawal_recommended")) {
    throw new Error(`controller review consensus change was missing from relevant agent inbox: ${JSON.stringify(consensusInbox?.controller_consensus)}`);
  }
  await prisma.domainRelationshipAssertion.updateMany({
    where: { domainA: quarantineDomains[2], domainB: quarantineDomains[3] },
    data: { status: "withdrawn", withdrawnAt: new Date() },
  });
  const staleControllerClaim = await claimSourceRendezvousTask({
    agent: governanceAgents[1],
    targetType: "domain_relationship",
    sourceId: controllerTask.target.source_id,
    taskType: "review_controller_expansion",
    claimDurationMinutes: 30,
  });
  if (staleControllerClaim.status !== 409) {
    throw new Error(`resolved controller anomaly remained claimable: ${JSON.stringify(staleControllerClaim.body)}`);
  }
  const resolvedReviewIndex = await listDomainRelationshipAssertions({ domain: quarantineDomains[2] });
  const resolvedReview = resolvedReviewIndex.controller_reviews.find((review) => review.id === controllerClaimResult.body.claim.id);
  if (resolvedReview?.anomaly_active || resolvedReview?.current_relationship_state !== "resolved_or_inactive" || resolvedReview.domain_a !== quarantineDomains[2]) {
    throw new Error(`completed controller review did not preserve auditable resolved state: ${JSON.stringify(resolvedReviewIndex.controller_reviews)}`);
  }
  const resolvedConsensus = resolvedReviewIndex.review_consensus.find((consensus) => consensus.relationship_target_id === controllerTask.target.source_id);
  if (resolvedConsensus?.state !== "withdrawal_recommended" || resolvedConsensus.current_relationship_state !== "resolved_or_inactive" || resolvedConsensus.governance_effect !== "none") {
    throw new Error(`resolved controller review consensus was not preserved as advisory audit data: ${JSON.stringify(resolvedReviewIndex.review_consensus)}`);
  }

  process.stdout.write(
    JSON.stringify({
      status: "ok",
      proof_fetch_success: "verified with injected bounded transport",
      automatic_refresh: {
        success: "verified",
        transient_failure_before_expiry: "deferred_without_losing_authority",
        failure_after_expiry: "failed_closed",
      },
      lifecycle_events: ["infrastructure_claim_verified", "infrastructure_claim_expiring", "infrastructure_claim_expired"],
      event_streams: ["node", "agent"],
      handoff_policy_versioning: "stable_hash_idempotent_registration_and_node_agent_events",
      domain_relationship_lifecycle: {
        active_quorum: "verified",
        created_and_expiring_events: "verified_for_node_and_agent_streams",
        expiry_removes_controller_authority: "verified",
        expired_event: "verified_for_node_and_agent_streams",
        cluster_expansion_quarantine: "verified_with_path_and_governance_fail_closed",
        quarantined_expansion_task_routing: "claimable_until_resolved_with_independent_advisory_consensus_and_private_idempotent_event_receipts",
      },
    }) + "\n",
  );
} finally {
  await prisma.agent.delete({ where: { id: peerAgentId } }).catch(() => undefined);
  await prisma.agent.delete({ where: { id: agentId } }).catch(() => undefined);
  await prisma.$disconnect();
}
