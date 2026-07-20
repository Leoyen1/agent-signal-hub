import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";

const baseUrl = (process.env.ASH_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const runId = randomUUID().slice(0, 8);
const startedAt = new Date().toISOString();
const expectDigest = process.env.ASH_EXPECT_MATURE_VALIDATORS === "true";
const useBootstrapValidators = process.env.ASH_USE_BOOTSTRAP_VALIDATORS === "true";
const bootstrapKeyPairs = JSON.parse(process.env.ASH_BOOTSTRAP_AGENTS ?? "[]").map((agent) => ({
  publicKey: agent.publicKey,
  privateKey: createPrivateKey(agent.privateKey),
}));
const registrationInviteCodes = JSON.parse(process.env.ASH_REGISTRATION_INVITE_CODES ?? "[]");

async function request(path, options = {}) {
  const agent = options.headers?.__agent;
  const headers = { ...(options.headers ?? {}) };
  delete headers.__agent;
  if (agent) {
    const timestamp = new Date().toISOString();
    const nonce = randomUUID();
    const bodyHash = createHash("sha256").update(options.body ?? "").digest("hex");
    const canonical = `${timestamp}\n${nonce}\n${(options.method ?? "GET").toUpperCase()}\n${path}\n${bodyHash}`;
    headers.Authorization = `Bearer ${agent.apiKey}`;
    headers["X-ASH-Timestamp"] = timestamp;
    headers["X-ASH-Nonce"] = nonce;
    headers["X-ASH-Signature"] = sign(null, Buffer.from(canonical), agent.privateKey).toString("base64");
  }
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
  });
  const body = await response.json().catch(() => null);
  return { response, body };
}

function requireStatus(result, expected, label) {
  if (result.response.status !== expected) {
    throw new Error(`${label}: expected ${expected}, received ${result.response.status}: ${JSON.stringify(result.body)}`);
  }
  return result.body;
}

function registrationProof(publicKey) {
  const date = new Date().toISOString().slice(0, 10);
  for (let nonce = 0; ; nonce += 1) {
    const value = String(nonce);
    if (createHash("sha256").update(`ash-registration-v1:${date}:${publicKey}:${value}`).digest("hex").startsWith("000")) return value;
  }
}

async function register(label, suppliedKeyPair, profile = {}) {
  const keyPair = suppliedKeyPair ?? generateKeyPairSync("ed25519");
  const publicKey = typeof keyPair.publicKey === "string" ? keyPair.publicKey : keyPair.publicKey.export({ type: "spki", format: "pem" }).toString().trim();
  const recoveryKeyPair = generateKeyPairSync("ed25519");
  const recoveryPublicKey = recoveryKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString().trim();
  const result = await request("/api/agents/register", {
    method: "POST",
    body: JSON.stringify({
      public_key: publicKey,
      recovery_public_key: recoveryPublicKey,
      proof_of_work: registrationProof(publicKey),
      invite_code: registrationInviteCodes.shift(),
      name: `Demo ${label} ${runId}`,
      description: `Temporary ${label} agent used by the Agent Signal Hub exchange demo.`,
      owner_type: "anonymous",
      agent_type: "research",
      focus_areas: ["agent intelligence exchange"],
      capabilities: ["evidence review", "structured validation"],
      homepage_url: profile.homepageUrl,
      callback_url: profile.callbackUrl,
    }),
  });
  const body = requireStatus(result, 200, `register ${label}`);
  return { id: body.agent_id, apiKey: body.api_key, privateKey: keyPair.privateKey, recoveryPrivateKey: recoveryKeyPair.privateKey };
}

function credentialRotationProof(agentId, newApiKey, publicKey, privateKey) {
  const apiKeyHash = createHash("sha256").update(newApiKey).digest("hex");
  const publicKeyFingerprint = createHash("sha256").update(publicKey.trim(), "utf8").digest("hex");
  const canonical = ["ash-agent-credential-rotation-v1", agentId, apiKeyHash, publicKeyFingerprint].join("\n");
  return sign(null, Buffer.from(canonical), privateKey).toString("base64");
}

function credentialRecoveryProof(agentId, timestamp, nonce, newApiKey, publicKey, recoveryPublicKey, recoveryPrivateKey) {
  const apiKeyHash = createHash("sha256").update(newApiKey).digest("hex");
  const publicKeyFingerprint = createHash("sha256").update(publicKey.trim(), "utf8").digest("hex");
  const recoveryKeyFingerprint = createHash("sha256").update(recoveryPublicKey.trim(), "utf8").digest("hex");
  const canonical = [
    "ash-agent-credential-recovery-v1",
    agentId,
    timestamp,
    nonce,
    apiKeyHash,
    publicKeyFingerprint,
    recoveryKeyFingerprint,
  ].join("\n");
  return sign(null, Buffer.from(canonical), recoveryPrivateKey).toString("base64");
}
function auth(agent) {
  return { __agent: agent };
}

function hasEvidenceRequirement(schema) {
  return schema?.allOf?.some(
    (rule) =>
      rule.if?.properties?.verdict?.enum?.includes("support") &&
      rule.if?.properties?.verdict?.enum?.includes("dispute") &&
      rule.then?.required?.includes("evidence_urls") &&
      rule.then?.properties?.evidence_urls?.minItems === 1,
  );
}

const schemaDocument = requireStatus(await request("/api/schemas"), 200, "read JSON schemas");
const openApiDocument = requireStatus(await request("/api/openapi.json"), 200, "read OpenAPI document");
const handoffPolicyDocument = requireStatus(await request("/api/handoff-policy"), 200, "read versioned handoff policy");
if (
  !handoffPolicyDocument.policy?.version ||
  !/^[a-f0-9]{64}$/.test(handoffPolicyDocument.document_hash ?? "") ||
  handoffPolicyDocument.policy?.acceptance?.policy_change_effect !== "reject_acceptance_and_require_new_offer" ||
  !handoffPolicyDocument.policy?.acceptance?.high_risk_acknowledgement?.required_fields?.includes("policy_document_hash") ||
  !handoffPolicyDocument.policy?.acceptance?.high_risk_revalidation_at_accept?.includes("verified_infrastructure_or_bootstrap") ||
  !openApiDocument.paths?.["/api/handoff-policy"]?.get
) {
  throw new Error("Machine contracts are missing versioned handoff policy discovery or events");
}
if (!schemaDocument.schemas?.agent_event_acknowledge?.properties?.event_ids || !openApiDocument.paths?.["/api/agents/{id}/events/ack"]?.post) {
  throw new Error("Machine contracts are missing private agent event acknowledgements");
}
if (!schemaDocument.schemas?.agent_event_query?.properties?.unacknowledged_only || !openApiDocument.paths?.["/api/agents/{id}/events"]?.get?.parameters?.some((parameter) => parameter.name === "unacknowledged_only")) {
  throw new Error("Machine contracts are missing the private unacknowledged event filter");
}
if (!schemaDocument.schemas?.agent_event_lease?.properties?.lease_duration_seconds || !openApiDocument.paths?.["/api/agents/{id}/events/lease"]?.post || !schemaDocument.schemas?.agent_event_acknowledge?.properties?.lease_token) {
  throw new Error("Machine contracts are missing atomic agent event leases");
}
if (!schemaDocument.schemas?.agent_event_lease_update?.properties?.action?.enum?.includes("renew") || !schemaDocument.schemas?.agent_event_lease_update?.properties?.action?.enum?.includes("release") || !openApiDocument.paths?.["/api/agents/{id}/events/lease"]?.patch) {
  throw new Error("Machine contracts are missing event lease renewal or release");
}
if (!schemaDocument.schemas?.agent_event_lease_update?.properties?.action?.enum?.includes("report_failure") || !schemaDocument.schemas?.agent_event_lease_update?.properties?.failure_reason?.enum?.includes("capability_mismatch")) {
  throw new Error("Machine contracts are missing structured event lease failure reporting");
}
if (!schemaDocument.schemas?.agent_event_handoff_create?.properties?.target_agent_id || !schemaDocument.schemas?.agent_event_handoff_update?.properties?.action?.enum?.includes("complete") || !openApiDocument.paths?.["/api/agents/{id}/events/handoffs"]?.post || !openApiDocument.paths?.["/api/agents/{id}/events/handoffs/{handoff_id}"]?.patch) {
  throw new Error("Machine contracts are missing agent event handoff lifecycle");
}
if (!schemaDocument.schemas?.agent_event_handoff_update?.properties?.policy_version || schemaDocument.schemas?.agent_event_handoff_update?.properties?.policy_document_hash?.pattern !== "^[a-f0-9]{64}$") {
  throw new Error("Machine contracts are missing high-risk handoff policy acknowledgement fields");
}
if (schemaDocument.schemas?.agent_event_handoff_create?.required?.includes("target_agent_id") || !schemaDocument.schemas?.agent_event_handoff_candidates?.properties?.requested_capabilities || !openApiDocument.paths?.["/api/agents/{id}/events/handoffs/candidates"]?.post) {
  throw new Error("Machine contracts are missing automatic handoff candidate selection");
}
if (!schemaDocument.schemas?.agent_handoff_profile_update?.properties?.handoff_opt_in || !openApiDocument.paths?.["/api/agents/{id}/handoff-profile"]?.get || !openApiDocument.paths?.["/api/agents/{id}/handoff-profile"]?.patch || !schemaDocument.schemas?.agent_card?.properties?.handoff_profile) {
  throw new Error("Machine contracts are missing public agent handoff profiles");
}
const controllerTaskTypes = ["review_controller_expansion", "gather_controller_ownership_evidence", "dispute_controller_relationship", "recommend_relationship_withdrawal"];
for (const document of [schemaDocument.schemas?.source_task_query, openApiDocument.components?.schemas?.source_task_query]) {
  if (!document?.properties?.target_type?.enum?.includes("domain_relationship")) throw new Error("Source task schema is missing domain_relationship targets");
  for (const taskType of controllerTaskTypes) {
    if (!document?.properties?.task_type?.enum?.includes(taskType)) throw new Error(`Source task schema is missing ${taskType}`);
  }
}
for (const document of [schemaDocument.schemas?.source_rendezvous_query, openApiDocument.components?.schemas?.source_rendezvous_query]) {
  if (document?.properties?.target_type?.enum?.includes("domain_relationship")) throw new Error("Source rendezvous schema incorrectly accepts domain_relationship targets");
}
for (const document of [schemaDocument.schemas?.source_task_claim_update, openApiDocument.components?.schemas?.source_task_claim_update]) {
  const conclusions = document?.properties?.review_conclusion?.enum ?? [];
  for (const conclusion of ["confirm_relationship", "dispute_relationship", "insufficient_evidence", "recommend_withdrawal"]) {
    if (!conclusions.includes(conclusion)) throw new Error(`Source task update schema is missing ${conclusion}`);
  }
}
const discoveryDocument = requireStatus(await request("/.well-known/agent.json"), 200, "read agent discovery document");
if (!discoveryDocument.protocol_layers?.core_stable?.includes("signals") || !discoveryDocument.protocol_layers?.experimental_frozen?.includes("handoffs")) {
  throw new Error("Agent discovery does not declare the stable core and frozen experimental protocol layers");
}
if (!Number.isInteger(discoveryDocument.authentication?.registration_proof_of_work?.difficulty) || !discoveryDocument.authentication?.registration_proof_of_work?.date) {
  throw new Error("Agent discovery does not expose the current registration proof-of-work puzzle");
}
const agentGuide = requireStatus(await request("/api/agent-guide"), 200, "read agent guide");
if (!hasEvidenceRequirement(schemaDocument.schemas?.validation_create)) {
  throw new Error("JSON Schema does not declare evidence_urls required for support/dispute validations");
}
const governanceSchemas = [schemaDocument.schemas?.governance_explanation, openApiDocument.components?.schemas?.governance_explanation];
for (const schema of governanceSchemas) {
  const inputs = schema?.properties?.inputs?.properties;
  if (!inputs?.counted_validator_declared_infrastructure || !inputs?.shared_validator_infrastructure_conflicts) {
    throw new Error("governance machine schema does not expose declared infrastructure independence");
  }
}
const governanceOperationSchema = openApiDocument.paths?.["/api/signals/{id}/governance"]?.get?.responses?.["200"]?.content?.["application/json"]?.schema;
if (governanceOperationSchema?.properties?.governance?.$ref !== "#/components/schemas/governance_explanation") {
  throw new Error("OpenAPI signal governance response does not reference governance_explanation");
}
if (!discoveryDocument.quality_policy?.validator_infrastructure_independence) {
  throw new Error("agent discovery does not declare verified validator infrastructure independence");
}
const outboundPolicy = discoveryDocument.quality_policy?.outbound_https_policy;
if (
  !outboundPolicy?.dns_policy?.includes("pin the connection") ||
  !outboundPolicy?.tls_policy?.includes("original URL hostname") ||
  outboundPolicy.redirects_followed !== false
) {
  throw new Error("agent discovery does not declare the pinned public HTTPS transport");
}
if (!agentGuide.governance_independence?.network_transport?.includes("pins the connection")) {
  throw new Error("agent guide does not explain the pinned infrastructure proof transport");
}
if (
  !discoveryDocument.quality_policy?.infrastructure_claim_refresh?.includes("maintenance worker") ||
  !agentGuide.governance_independence?.automatic_refresh?.includes("maintenance worker")
) {
  throw new Error("machine contracts do not explain automatic infrastructure claim refresh");
}
const maintenanceOperation = openApiDocument.paths?.["/api/admin/maintenance/run"]?.post;
if (!maintenanceOperation?.security?.some((rule) => "adminBearerToken" in rule)) {
  throw new Error("OpenAPI unified maintenance operation must require adminBearerToken");
}
const infrastructureLifecycleEventTypes = [
  "infrastructure_claim_verified",
  "infrastructure_claim_expiring",
  "infrastructure_claim_expired",
  "infrastructure_claim_stale",
  "infrastructure_claim_failed",
];
const documentedSubscriptionEventTypes = schemaDocument.schemas?.webhook_subscription_create?.properties?.event_types?.items?.enum ?? [];
if (!documentedSubscriptionEventTypes.includes("handoff_policy_version_changed")) throw new Error("Webhook event contract is missing handoff policy version changes");
if (!infrastructureLifecycleEventTypes.every((type) => documentedSubscriptionEventTypes.includes(type))) {
  throw new Error("webhook subscription schema does not expose infrastructure claim lifecycle events");
}
const domainRelationshipLifecycleEvents = [
  "domain_relationship_assertion_created",
  "domain_relationship_assertion_renewed",
  "domain_relationship_assertion_expiring",
  "domain_relationship_assertion_expired",
  "domain_relationship_assertion_withdrawn",
  "domain_relationship_assertion_superseded",
];
if (!domainRelationshipLifecycleEvents.every((type) => documentedSubscriptionEventTypes.includes(type))) {
  throw new Error("webhook subscription schema does not expose the full domain relationship lifecycle");
}
if (!domainRelationshipLifecycleEvents.every((type) => agentGuide.governance_independence?.domain_relationship_lifecycle?.events?.includes(type))) {
  throw new Error("agent guide does not expose the full domain relationship lifecycle");
}
if (!domainRelationshipLifecycleEvents.every((type) => discoveryDocument.quality_policy?.domain_relationship_lifecycle_events?.includes(type))) {
  throw new Error("agent discovery does not expose the full domain relationship lifecycle");
}
if (!infrastructureLifecycleEventTypes.every((type) => discoveryDocument.quality_policy?.infrastructure_claim_lifecycle_events?.includes(type))) {
  throw new Error("agent discovery does not expose infrastructure claim lifecycle events");
}
if (!infrastructureLifecycleEventTypes.every((type) => agentGuide.governance_independence?.lifecycle_events?.includes(type))) {
  throw new Error("agent guide does not expose infrastructure claim lifecycle events");
}
const infrastructureVerifyRequired = ["agent_id", "target"];
for (const schema of [schemaDocument.schemas?.agent_infrastructure_verify, openApiDocument.components?.schemas?.agent_infrastructure_verify]) {
  if (!infrastructureVerifyRequired.every((field) => schema?.required?.includes(field))) {
    throw new Error("infrastructure verification contract is incomplete");
  }
}
const infrastructureProofRequired = ["schema_version", "agent_id", "target", "origin", "registrable_domain", "public_key_fingerprint", "signature"];
for (const schema of [schemaDocument.schemas?.infrastructure_proof_document, openApiDocument.components?.schemas?.infrastructure_proof_document]) {
  if (!infrastructureProofRequired.every((field) => schema?.required?.includes(field))) {
    throw new Error("infrastructure proof document contract is incomplete");
  }
}
const infrastructureVerifyOperation = openApiDocument.paths?.["/api/agents/{id}/infrastructure/verify"]?.post;
if (!infrastructureVerifyOperation?.security?.some((rule) => ["bearerApiKey", "agentWriteTimestamp", "agentWriteNonce", "agentWriteSignature"].every((scheme) => scheme in rule))) {
  throw new Error("OpenAPI infrastructure verification must require the complete signed-write security rule");
}
if (!agentGuide.governance_independence?.explanation_fields?.includes("shared_validator_infrastructure_conflicts")) {
  throw new Error("agent guide does not explain validator infrastructure conflicts");
}
const domainRelationshipRequired = ["agent_id", "domain_a", "domain_b", "stance", "summary", "evidence_urls"];
for (const schema of [schemaDocument.schemas?.domain_relationship_assertion_create, openApiDocument.components?.schemas?.domain_relationship_assertion_create]) {
  if (!domainRelationshipRequired.every((field) => schema?.required?.includes(field))) {
    throw new Error("domain relationship assertion contract is incomplete");
  }
}
const domainRelationshipWrite = openApiDocument.paths?.["/api/domain-relationships"]?.post;
if (!domainRelationshipWrite?.security?.some((rule) => ["bearerApiKey", "agentWriteTimestamp", "agentWriteNonce", "agentWriteSignature"].every((scheme) => scheme in rule))) {
  throw new Error("OpenAPI domain relationship writes must require the complete signed-write rule");
}
const domainRelationshipUpdateRequired = ["agent_id", "action"];
for (const schema of [schemaDocument.schemas?.domain_relationship_assertion_update, openApiDocument.components?.schemas?.domain_relationship_assertion_update]) {
  if (!domainRelationshipUpdateRequired.every((field) => schema?.required?.includes(field))) {
    throw new Error("domain relationship lifecycle contract is incomplete");
  }
}
const domainRelationshipUpdate = openApiDocument.paths?.["/api/domain-relationships/{id}"]?.patch;
if (!domainRelationshipUpdate?.security?.some((rule) => ["bearerApiKey", "agentWriteTimestamp", "agentWriteNonce", "agentWriteSignature"].every((scheme) => scheme in rule))) {
  throw new Error("OpenAPI domain relationship lifecycle writes must require the complete signed-write rule");
}
if (
  !discoveryDocument.quality_policy?.domain_controller_independence ||
  !agentGuide.governance_independence?.domain_controller_graph ||
  !discoveryDocument.quality_policy?.domain_controller_cluster_safety ||
  !agentGuide.governance_independence?.domain_controller_cluster_safety
) {
  throw new Error("machine contracts do not expose domain controller independence and cluster safety");
}
const credentialRotationRequired = ["agent_id", "new_api_key", "new_public_key", "new_public_key_proof"];
for (const document of [schemaDocument.schemas?.agent_credential_rotation, openApiDocument.components?.schemas?.agent_credential_rotation]) {
  if (!credentialRotationRequired.every((field) => document?.required?.includes(field))) throw new Error("credential rotation contract is incomplete");
}
if (!openApiDocument.paths?.["/api/agents/{id}/credentials/rotate"]?.post) throw new Error("OpenAPI is missing credential rotation");
const credentialRecoveryRequired = ["agent_id", "new_api_key", "new_public_key", "new_recovery_public_key", "recovery_timestamp", "recovery_nonce", "recovery_signature"];
for (const document of [schemaDocument.schemas?.agent_credential_recovery, openApiDocument.components?.schemas?.agent_credential_recovery]) {
  if (!credentialRecoveryRequired.every((field) => document?.required?.includes(field))) throw new Error("credential recovery contract is incomplete");
}
const recoveryOperation = openApiDocument.paths?.["/api/agents/{id}/credentials/recover"]?.post;
if (!recoveryOperation || recoveryOperation.security) throw new Error("OpenAPI credential recovery must be available without active Bearer credentials");
if (!schemaDocument.schemas?.admin_agent_revoke?.required?.includes("reason")) throw new Error("JSON Schema is missing Admin credential revocation");
const adminRevokeOperation = openApiDocument.paths?.["/api/admin/agents/{id}/revoke"]?.post;
if (!adminRevokeOperation?.security?.some((rule) => Object.keys(rule).length === 1 && "adminBearerToken" in rule)) {
  throw new Error("OpenAPI Admin revocation must require only adminBearerToken");
}
const registrationRequired = ["public_key", "recovery_public_key", "proof_of_work"];
for (const document of [schemaDocument.schemas?.agent_registration, openApiDocument.components?.schemas?.agent_registration]) {
  if (!registrationRequired.every((field) => document?.required?.includes(field))) throw new Error("registration contract does not require active, recovery, and proof-of-work fields");
}

const requiredWriteSecurity = ["bearerApiKey", "agentWriteTimestamp", "agentWriteNonce", "agentWriteSignature"];
for (const pathItem of Object.values(openApiDocument.paths ?? {})) {
  for (const [method, operation] of Object.entries(pathItem ?? {})) {
    if (!["post", "patch", "put", "delete"].includes(method) || !operation?.security?.some((rule) => requiredWriteSecurity.every((scheme) => scheme in rule))) continue;
  }
}
const documentedWriteOperations = Object.values(openApiDocument.paths ?? {}).flatMap((pathItem) => Object.entries(pathItem ?? {})).filter(([method, operation]) => ["post", "patch", "put", "delete"].includes(method) && operation?.security?.some((rule) => "bearerApiKey" in rule));
const documentedReadOperations = Object.values(openApiDocument.paths ?? {}).flatMap((pathItem) => Object.entries(pathItem ?? {})).filter(([method, operation]) => ["get", "head", "options"].includes(method) && operation?.security?.some((rule) => "bearerApiKey" in rule));
if (documentedReadOperations.some(([, operation]) => operation.security.some((rule) => Object.keys(rule).length !== 1 || !("bearerApiKey" in rule)))) {
  throw new Error("OpenAPI authenticated read operations must require only bearerApiKey");
}
if (!documentedWriteOperations.length || documentedWriteOperations.some(([, operation]) => !operation.security.some((rule) => requiredWriteSecurity.every((scheme) => scheme in rule)))) {
  throw new Error("OpenAPI authenticated write operations must require bearer and all agent signature headers");
}
if (!hasEvidenceRequirement(openApiDocument.components?.schemas?.validation_create)) {
  throw new Error("OpenAPI does not declare evidence_urls required for support/dispute validations");
}

const sharedInfrastructurePrimary = { homepageUrl: "https://api.coordination-lab.net/agent" };
const sharedInfrastructureSecondary = { callbackUrl: "https://news.coordination-lab.net/events" };
const independentInfrastructure = { homepageUrl: "https://independent-validator.org/agent" };
const bootstrapProfiles = [sharedInfrastructurePrimary, sharedInfrastructureSecondary, independentInfrastructure];
const bootstrapSeeds = [];
for (const [index, keyPair] of bootstrapKeyPairs.entries()) {
  const seed = await register(`bootstrap-seed-${index + 1}`, keyPair, bootstrapProfiles[index] ?? {});
  const seedCard = requireStatus(await request(`/api/agents/${seed.id}/card`), 200, "read bootstrap seed card");
  if (seedCard.reputation?.score !== 80 || seedCard.reputation?.trust_level !== "trusted") throw new Error("configured bootstrap key must register as trusted/80");
  bootstrapSeeds.push(seed);
}

const submitter = await register("submitter");
const validator = useBootstrapValidators ? bootstrapSeeds[0] : await register("validator", undefined, sharedInfrastructurePrimary);
const observer = useBootstrapValidators ? bootstrapSeeds[2] : await register("observer", undefined, independentInfrastructure);
const repeater = useBootstrapValidators ? bootstrapSeeds[1] : await register("repeater", undefined, sharedInfrastructureSecondary);
const sourceTaskAgent = useBootstrapValidators ? await register("source-task-agent") : observer;
const credentialLifecycleAgent = useBootstrapValidators ? await register("credential-lifecycle-agent", undefined, { homepageUrl: "https://credential-lifecycle.net/agent" }) : repeater;
const credentialInfrastructureTarget = useBootstrapValidators ? "homepage" : "callback";

const infrastructureProofTemplate = requireStatus(
  await request(`/api/agents/${credentialLifecycleAgent.id}/infrastructure/verify?target=${credentialInfrastructureTarget}`, {
    headers: { Authorization: `Bearer ${credentialLifecycleAgent.apiKey}` },
  }),
  200,
  "prepare infrastructure proof template",
);
if (
  infrastructureProofTemplate.document?.schema_version !== "ash-agent-infrastructure-proof-v1" ||
  infrastructureProofTemplate.document?.target !== credentialInfrastructureTarget ||
  !infrastructureProofTemplate.canonical_payload?.startsWith("ash-agent-infrastructure-proof-v1\n") ||
  !infrastructureProofTemplate.proof_url?.endsWith("/.well-known/ash-agent-signal-hub.json")
) {
  throw new Error("infrastructure proof preparation response is incomplete");
}
const locallySignedInfrastructureProof = sign(
  null,
  Buffer.from(infrastructureProofTemplate.canonical_payload),
  credentialLifecycleAgent.privateKey,
).toString("base64");
if (!locallySignedInfrastructureProof) throw new Error("agent could not sign the prepared infrastructure proof payload");

const failedInfrastructureVerification = await request(`/api/agents/${credentialLifecycleAgent.id}/infrastructure/verify`, {
  method: "POST",
  headers: auth(credentialLifecycleAgent),
  body: JSON.stringify({ agent_id: credentialLifecycleAgent.id, target: credentialInfrastructureTarget }),
});
requireStatus(failedInfrastructureVerification, 422, "reject unavailable infrastructure proof");
const credentialCardAfterProofFailure = requireStatus(
  await request(`/api/agents/${credentialLifecycleAgent.id}/card`),
  200,
  "read infrastructure proof failure from agent card",
);
const failedInfrastructureClaim = credentialCardAfterProofFailure.infrastructure?.claims?.find((claim) => claim.target === credentialInfrastructureTarget);
if (!failedInfrastructureClaim || failedInfrastructureClaim.status !== "failed" || !failedInfrastructureClaim.proof_url?.endsWith("/.well-known/ash-agent-signal-hub.json")) {
  throw new Error("agent card does not expose failed infrastructure verification metadata");
}
const failedClaimEvents = requireStatus(
  await request(`/api/agents/${credentialLifecycleAgent.id}/events?since=${encodeURIComponent(startedAt)}`, {
    headers: { Authorization: `Bearer ${credentialLifecycleAgent.apiKey}` },
  }),
  200,
  "read failed infrastructure claim event",
);
const failedClaimEvent = failedClaimEvents.events?.find(
  (event) => event.type === "infrastructure_claim_failed" && event.subject?.id === failedInfrastructureClaim.id,
);
if (!failedClaimEvent?.links?.prepare_proof || !failedClaimEvent?.links?.verify_proof) {
  throw new Error("failed infrastructure claim event is missing renewal links");
}

const privateWebhookSubscription = await request(`/api/agents/${observer.id}/subscriptions`, {
  method: "POST",
  headers: auth(observer),
  body: JSON.stringify({
    agent_id: observer.id,
    callback_url: "https://127.0.0.1/internal",
    event_types: ["signal_created"],
    status: "active",
  }),
});
requireStatus(privateWebhookSubscription, 422, "reject private webhook callback URL");

const mappedPrivateWebhookSubscription = await request(`/api/agents/${observer.id}/subscriptions`, { method: "POST", headers: auth(observer), body: JSON.stringify({ agent_id: observer.id, callback_url: "https://[::ffff:127.0.0.1]/internal", event_types: ["signal_created"], status: "active" }) });
requireStatus(mappedPrivateWebhookSubscription, 422, "reject IPv4-mapped IPv6 webhook callback URL");

const pinnedWebhookSubscription = requireStatus(
  await request(`/api/agents/${observer.id}/subscriptions`, {
    method: "POST",
    headers: auth(observer),
    body: JSON.stringify({
      agent_id: observer.id,
      callback_url: "https://webhook-unreachable.invalid/events",
      event_types: ["signal_created", "validation_created"],
      status: "active",
    }),
  }),
  201,
  "create public HTTPS callback for pinned transport test",
).subscription;

const sourceTaskClaimResult = await request("/api/source-rendezvous/tasks/claim", {
  method: "POST",
  headers: auth(sourceTaskAgent),
  body: JSON.stringify({
    agent_id: sourceTaskAgent.id,
    target_type: "host",
    host: `coordination-${runId}.example`,
    task_type: "gather_additional_evidence",
    summary: "Checking that source-task coordination cannot bootstrap validator reputation.",
    claim_duration_minutes: 30,
  }),
});
const sourceTaskClaim = requireStatus(sourceTaskClaimResult, 201, "claim source rendezvous task").claim;
const sourceTaskReputation = sourceTaskClaim.agent.reputation_score;
const sourceTaskCompletion = requireStatus(
  await request(`/api/agents/${sourceTaskAgent.id}/source-tasks/${sourceTaskClaim.id}`, {
    method: "PATCH",
    headers: auth(sourceTaskAgent),
    body: JSON.stringify({
      status: "completed",
      result_summary: "Recorded coordination work without using it as reputation evidence.",
      evidence_urls: ["https://coordination.example/review"],
    }),
  }),
  200,
  "complete source rendezvous task",
);
if (sourceTaskReputation !== 0 || sourceTaskClaim.agent.trust_level !== "low" || sourceTaskCompletion.completion_effect?.reputation_delta !== 0 || sourceTaskCompletion.claim?.agent?.reputation_score !== sourceTaskReputation) {
  throw new Error("completing a source task must not change the agent reputation score");
}

const sameDomainSources = await request("/api/signals", {
  method: "POST",
  headers: auth(submitter),
  body: JSON.stringify({
    title: `Same registrable domain ${runId}`,
    category: "agent-network",
    summary: "A negative PSL independence test.",
    source_urls: ["https://api.example.com/report", "https://news.example.com/report"],
    evidence: "Two subdomains under one registrable domain are not independent sources.",
    confidence: 0.96,
    urgency: "medium",
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    submitted_by_agent_id: submitter.id,
  }),
});
requireStatus(sameDomainSources, 422, "reject high confidence sources from one registrable domain");

if (expectDigest) {
  const linkedDomainA = `controller-alpha-${runId}.net`;
  const linkedDomainB = `controller-beta-${runId}.org`;
  const domainAssertionIds = [];
  for (const [agent, evidenceUrl] of [
    [validator, `https://ownership-review-a-${runId}.dev/report`],
    [observer, `https://ownership-review-b-${runId}.io/report`],
  ]) {
    const assertion = requireStatus(
      await request("/api/domain-relationships", {
        method: "POST",
        headers: auth(agent),
        body: JSON.stringify({
          agent_id: agent.id,
          domain_a: linkedDomainA,
          domain_b: linkedDomainB,
          stance: "same_controller",
          summary: "Independent evidence indicates both registrable domains are operated by one controller.",
          evidence_urls: [evidenceUrl],
        }),
      }),
      201,
      "record same-controller domain assertion",
    ).assertion;
    domainAssertionIds.push(assertion.id);
  }
  const domainRelationships = requireStatus(
    await request(`/api/domain-relationships?domain=${encodeURIComponent(linkedDomainA)}`),
    200,
    "read established domain controller relationship",
  );
  const establishedRelationship = domainRelationships.relationships?.find(
    (relationship) => relationship.domain_a === linkedDomainA && relationship.domain_b === linkedDomainB,
  );
  const establishedCluster = domainRelationships.clusters?.find((cluster) => cluster.domains?.includes(linkedDomainA));
  if (
    establishedRelationship?.state !== "linked_same_controller" ||
    establishedRelationship.same_controller_count !== 2 ||
    establishedRelationship.controller_path?.join("|") !== [linkedDomainA, linkedDomainB].join("|") ||
    establishedCluster?.size !== 2 ||
    establishedCluster.quarantined !== false
  ) {
    throw new Error(`same-controller quorum was not established: ${JSON.stringify(domainRelationships)}`);
  }
  const domainRelationshipEvents = requireStatus(
    await request(`/api/events?since=${encodeURIComponent(startedAt)}`),
    200,
    "read domain relationship assertion events",
  );
  if (!domainAssertionIds.every((id) => domainRelationshipEvents.events?.some((event) => event.type === "domain_relationship_assertion_created" && event.subject?.id === id))) {
    throw new Error("node event stream does not expose domain relationship assertions");
  }

  const linkedControllerSources = await request("/api/signals", {
    method: "POST",
    headers: auth(submitter),
    body: JSON.stringify({
      title: `Linked controller sources ${runId}`,
      category: "agent-network",
      summary: "A negative controller-level source independence test.",
      source_urls: [`https://${linkedDomainA}/report`, `https://${linkedDomainB}/report`],
      evidence: "Different registrable domains controlled by one established controller are not independent sources.",
      confidence: 0.96,
      urgency: "medium",
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      submitted_by_agent_id: submitter.id,
    }),
  });
  requireStatus(linkedControllerSources, 422, "reject high confidence sources linked to one controller");

  const linkedEvidenceSignal = requireStatus(
    await request("/api/signals", {
      method: "POST",
      headers: auth(submitter),
      body: JSON.stringify({
        title: `Linked controller validation evidence ${runId}`,
        category: "agent-network",
        summary: "A negative controller-level validation evidence independence test.",
        source_urls: [`https://controller-source-a-${runId}.com/report`, `https://controller-source-b-${runId}.info/report`],
        evidence: "Signal sources are independent; validator evidence domains intentionally share one established controller.",
        confidence: 0.9,
        urgency: "high",
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        submitted_by_agent_id: submitter.id,
      }),
    }),
    201,
    "submit linked-controller validation evidence signal",
  ).signal;
  for (const [agent, evidenceDomain] of [[validator, linkedDomainA], [observer, linkedDomainB]]) {
    requireStatus(
      await request(`/api/signals/${linkedEvidenceSignal.id}/validate`, {
        method: "POST",
        headers: auth(agent),
        body: JSON.stringify({ agent_id: agent.id, verdict: "support", evidence_urls: [`https://${evidenceDomain}/review`] }),
      }),
      201,
      "record linked-controller validation evidence",
    );
  }
  const [linkedSourceA, linkedSourceB] = await Promise.all([
    request(`/api/sources?host=${encodeURIComponent(linkedDomainA)}`),
    request(`/api/sources?host=${encodeURIComponent(linkedDomainB)}`),
  ]);
  const sourceA = requireStatus(linkedSourceA, 200, "read first linked-controller source").sources?.[0];
  const sourceB = requireStatus(linkedSourceB, 200, "read second linked-controller source").sources?.[0];
  if (!sourceA?.controller_key || sourceA.controller_key !== sourceB?.controller_key || !sourceA.controller_domains?.includes(linkedDomainB)) {
    throw new Error("source registry does not expose the established controller group");
  }
  const linkedEvidenceGovernance = requireStatus(
    await request(`/api/signals/${linkedEvidenceSignal.id}/governance`),
    200,
    "read linked-controller validation evidence governance",
  ).governance;
  if (linkedEvidenceGovernance.state !== "observable" || linkedEvidenceGovernance.inputs?.established_independent_evidence_backed_support_count !== 1) {
    throw new Error(`linked controller evidence incorrectly satisfied validation quorum: ${JSON.stringify(linkedEvidenceGovernance)}`);
  }

  const renewedAssertion = requireStatus(
    await request(`/api/domain-relationships/${domainAssertionIds[0]}`, {
      method: "PATCH",
      headers: auth(validator),
      body: JSON.stringify({
        agent_id: validator.id,
        action: "renew",
        summary: "Fresh independent evidence continues to support the same-controller relationship.",
        evidence_urls: [`https://ownership-renewal-${runId}.dev/report`],
      }),
    }),
    201,
    "renew domain relationship assertion",
  );
  if (renewedAssertion.superseded_assertion_id !== domainAssertionIds[0] || renewedAssertion.assertion?.supersedes_assertion_id !== domainAssertionIds[0]) {
    throw new Error("domain relationship renewal did not preserve the supersession chain");
  }
  const supersededAssertion = requireStatus(
    await request(`/api/domain-relationships/${domainAssertionIds[0]}`),
    200,
    "read superseded domain relationship assertion",
  ).assertion;
  if (supersededAssertion.status !== "superseded") throw new Error("renewal did not mark the old assertion superseded");
  const relationshipAfterRenewal = requireStatus(
    await request(`/api/domain-relationships?domain=${encodeURIComponent(linkedDomainA)}`),
    200,
    "read relationship after renewal",
  ).relationships?.find((relationship) => relationship.domain_a === linkedDomainA && relationship.domain_b === linkedDomainB);
  if (relationshipAfterRenewal?.same_controller_count !== 2) throw new Error("renewal interrupted the established controller quorum");

  const withdrawnAssertion = requireStatus(
    await request(`/api/domain-relationships/${domainAssertionIds[1]}`, {
      method: "PATCH",
      headers: auth(observer),
      body: JSON.stringify({ agent_id: observer.id, action: "withdraw" }),
    }),
    200,
    "withdraw domain relationship assertion",
  ).assertion;
  if (withdrawnAssertion.status !== "withdrawn" || !withdrawnAssertion.withdrawn_at) {
    throw new Error("domain relationship withdrawal did not preserve lifecycle metadata");
  }
  const relationshipAfterWithdrawal = requireStatus(
    await request(`/api/domain-relationships?domain=${encodeURIComponent(linkedDomainA)}`),
    200,
    "read relationship after withdrawal",
  ).relationships?.find((relationship) => relationship.domain_a === linkedDomainA && relationship.domain_b === linkedDomainB);
  if (relationshipAfterWithdrawal?.state !== "unverified" || relationshipAfterWithdrawal.same_controller_count !== 1) {
    throw new Error("withdrawal did not remove assertion authority from the controller quorum");
  }
  const lifecycleEvents = requireStatus(
    await request(`/api/events?since=${encodeURIComponent(startedAt)}`),
    200,
    "read domain relationship lifecycle events",
  ).events ?? [];
  if (
    !lifecycleEvents.some((event) => event.type === "domain_relationship_assertion_renewed" && event.subject?.id === renewedAssertion.assertion.id) ||
    !lifecycleEvents.some((event) => event.type === "domain_relationship_assertion_superseded" && event.subject?.id === domainAssertionIds[0]) ||
    !lifecycleEvents.some((event) => event.type === "domain_relationship_assertion_withdrawn" && event.subject?.id === domainAssertionIds[1])
  ) {
    throw new Error("node event stream does not expose domain relationship renewal, supersession, and withdrawal");
  }
  const [validatorLifecycleEvents, observerLifecycleEvents] = await Promise.all([
    request(`/api/agents/${validator.id}/events?since=${encodeURIComponent(startedAt)}`, { headers: { Authorization: `Bearer ${validator.apiKey}` } }),
    request(`/api/agents/${observer.id}/events?since=${encodeURIComponent(startedAt)}`, { headers: { Authorization: `Bearer ${observer.apiKey}` } }),
  ]);
  const validatorEvents = requireStatus(validatorLifecycleEvents, 200, "read validator domain lifecycle events").events ?? [];
  const observerEvents = requireStatus(observerLifecycleEvents, 200, "read observer domain lifecycle events").events ?? [];
  if (
    !validatorEvents.some((event) => event.type === "domain_relationship_assertion_renewed" && event.subject?.id === renewedAssertion.assertion.id) ||
    !validatorEvents.some((event) => event.type === "domain_relationship_assertion_superseded" && event.subject?.id === domainAssertionIds[0]) ||
    !observerEvents.some((event) => event.type === "domain_relationship_assertion_withdrawn" && event.subject?.id === domainAssertionIds[1])
  ) {
    throw new Error("agent event streams do not expose owned domain relationship lifecycle changes");
  }

  const infrastructureSignal = requireStatus(
    await request("/api/signals", {
      method: "POST",
      headers: auth(submitter),
      body: JSON.stringify({
        title: `Declared infrastructure independence ${runId}`,
        category: "agent-network",
        summary: "A negative quorum test for validators sharing one declared registrable infrastructure domain.",
        source_urls: ["https://source-one.net/report", "https://source-two.org/report"],
        evidence: "Independent signal sources isolate validator infrastructure overlap from evidence-domain overlap.",
        confidence: 0.9,
        urgency: "high",
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        submitted_by_agent_id: submitter.id,
      }),
    }),
    201,
    "submit validator infrastructure independence signal",
  ).signal;
  for (const [agent, evidenceUrl] of [
    [validator, "https://review-alpha.dev/evidence"],
    [repeater, "https://review-beta.io/evidence"],
  ]) {
    requireStatus(
      await request(`/api/signals/${infrastructureSignal.id}/validate`, {
        method: "POST",
        headers: auth(agent),
        body: JSON.stringify({ agent_id: agent.id, verdict: "support", evidence_urls: [evidenceUrl] }),
      }),
      201,
      "record shared-infrastructure support",
    );
  }
  const linkedGovernance = requireStatus(
    await request(`/api/signals/${infrastructureSignal.id}/governance`),
    200,
    "read shared-infrastructure governance",
  ).governance;
  const infrastructureConflicts = linkedGovernance.inputs?.shared_validator_infrastructure_conflicts ?? [];
  const expectedPair = new Set([validator.id, repeater.id]);
  const sharedConflict = infrastructureConflicts.find(
    (conflict) =>
      expectedPair.has(conflict.counted_agent_id) &&
      expectedPair.has(conflict.rejected_agent_id) &&
      conflict.shared_registrable_domains?.includes("coordination-lab.net"),
  );
  if (
    linkedGovernance.inputs?.verified_infrastructure_required !== useBootstrapValidators ||
    linkedGovernance.state !== "observable" ||
    linkedGovernance.inputs?.established_independent_evidence_backed_support_count !== 1 ||
    linkedGovernance.recommended_action !== "seek_support_from_validator_with_independent_declared_infrastructure" ||
    !sharedConflict
  ) {
    throw new Error(`shared declared infrastructure incorrectly satisfied quorum: ${JSON.stringify(linkedGovernance)}`);
  }
  requireStatus(
    await request(`/api/signals/${infrastructureSignal.id}/validate`, {
      method: "POST",
      headers: auth(observer),
      body: JSON.stringify({ agent_id: observer.id, verdict: "support", evidence_urls: ["https://review-gamma.org/evidence"] }),
    }),
    201,
    "record infrastructure-independent support",
  );
  const independentGovernance = requireStatus(
    await request(`/api/signals/${infrastructureSignal.id}/governance`),
    200,
    "read infrastructure-independent governance",
  ).governance;
  if (independentGovernance.state !== "digest_candidate" || independentGovernance.inputs?.established_independent_evidence_backed_support_count !== 2) {
    throw new Error(`independent validator did not restore quorum: ${JSON.stringify(independentGovernance)}`);
  }
} else {
  const probationDomainA = `probation-controller-a-${runId}.net`;
  const probationDomainB = `probation-controller-b-${runId}.org`;
  for (const [agent, evidenceUrl] of [
    [validator, `https://probation-review-a-${runId}.dev/report`],
    [observer, `https://probation-review-b-${runId}.io/report`],
  ]) {
    requireStatus(
      await request("/api/domain-relationships", {
        method: "POST",
        headers: auth(agent),
        body: JSON.stringify({
          agent_id: agent.id,
          domain_a: probationDomainA,
          domain_b: probationDomainB,
          stance: "same_controller",
          summary: "Probationary agents can publish evidence, but cannot establish controller linkage.",
          evidence_urls: [evidenceUrl],
        }),
      }),
      201,
      "record probationary domain relationship assertion",
    );
  }
  const probationRelationships = requireStatus(
    await request(`/api/domain-relationships?domain=${encodeURIComponent(probationDomainA)}`),
    200,
    "read probationary domain relationship assertions",
  );
  const probationRelationship = probationRelationships.relationships?.find(
    (relationship) => relationship.domain_a === probationDomainA && relationship.domain_b === probationDomainB,
  );
  if (probationRelationship?.state !== "unverified" || probationRelationship.same_controller_count !== 0) {
    throw new Error(`unestablished agents created controller authority: ${JSON.stringify(probationRelationships)}`);
  }
}
const signalResult = await request("/api/signals", {
  method: "POST",
  headers: auth(submitter),
  body: JSON.stringify({
    title: `Exchange demo signal ${runId}`,
    category: "agent-network",
    summary: "A structured end-to-end demo signal for independent agent validation.",
    source_urls: ["https://example.com/demo-primary", "https://iana.org/domains/example"],
    evidence: "Two independent public URLs provide the demonstration evidence.",
    confidence: 0.9,
    urgency: "high",
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    submitted_by_agent_id: submitter.id,
  }),
});
const signal = requireStatus(signalResult, 201, "submit signal").signal;

const selfValidation = await request(`/api/signals/${signal.id}/validate`, {
  method: "POST",
  headers: auth(submitter),
  body: JSON.stringify({ agent_id: submitter.id, verdict: "support", evidence_urls: ["https://example.com/self-review"] }),
});
requireStatus(selfValidation, 403, "reject self validation");

const unverifiedGovernance = requireStatus(await request(`/api/signals/${signal.id}/governance`), 200, "read unverified governance").governance;
if (unverifiedGovernance.state !== "observable") {
  throw new Error(`unverified signal must remain observable: ${JSON.stringify(unverifiedGovernance)}`);
}
const unverifiedDigest = requireStatus(await request("/api/digests/latest"), 200, "read unverified digest").digest;
if (unverifiedDigest.signals.some((item) => item.id === signal.id)) {
  throw new Error("unverified signal entered digest");
}

const evidenceMissingValidation = await request(`/api/signals/${signal.id}/validate`, {
  method: "POST",
  headers: auth(validator),
  body: JSON.stringify({ agent_id: validator.id, verdict: "support" }),
});
requireStatus(evidenceMissingValidation, 400, "reject support without evidence");

const supportValidation = await request(`/api/signals/${signal.id}/validate`, {
  method: "POST",
  headers: auth(validator),
  body: JSON.stringify({ agent_id: validator.id, verdict: "support", evidence_urls: ["https://validator.example/corroboration"] }),
});
requireStatus(supportValidation, 201, "independent support validation");

const singleSupportGovernance = requireStatus(await request(`/api/signals/${signal.id}/governance`), 200, "read single-support governance").governance;
if (singleSupportGovernance.state !== "observable") {
  throw new Error(`single independent support must remain observable: ${JSON.stringify(singleSupportGovernance)}`);
}

const duplicateValidation = await request(`/api/signals/${signal.id}/validate`, {
  method: "POST",
  headers: auth(validator),
  body: JSON.stringify({ agent_id: validator.id, verdict: "support", evidence_urls: ["https://validator.example/duplicate"] }),
});
requireStatus(duplicateValidation, 409, "reject duplicate validation");

const repeatedHostValidation = await request(`/api/signals/${signal.id}/validate`, {
  method: "POST",
  headers: auth(repeater),
  body: JSON.stringify({ agent_id: repeater.id, verdict: "support", evidence_urls: ["https://validator.example/repeated-host"] }),
});
requireStatus(repeatedHostValidation, 201, "accept support with repeated evidence host for audit");

const repeatedHostGovernance = requireStatus(await request(`/api/signals/${signal.id}/governance`), 200, "read repeated-host governance").governance;
if (repeatedHostGovernance.state !== "observable") {
  throw new Error(`repeated validation evidence host must not advance digest eligibility: ${JSON.stringify(repeatedHostGovernance)}`);
}

const contextValidation = await request(`/api/signals/${signal.id}/validate`, {
  method: "POST",
  headers: auth(observer),
  body: JSON.stringify({ agent_id: observer.id, verdict: "support", comment: "Independent observer corroborates the structured evidence.", evidence_urls: ["https://observer.example/corroboration"] }),
});
requireStatus(contextValidation, 201, "second independent support validation");

if (!expectDigest) {
  const submitterCard = requireStatus(await request(`/api/agents/${submitter.id}/card`), 200, "read low-trust submitter card");
  if (submitterCard.reputation?.score !== 0 || submitterCard.reputation?.trust_level !== "low") {
    throw new Error("fresh validator support must not change stored reputation or trust level");
  }

  const criticOne = await register("critic-one");
  const criticTwo = await register("critic-two");
  const reviewedSignal = requireStatus(
    await request("/api/signals", {
      method: "POST",
      headers: auth(submitter),
      body: JSON.stringify({
        title: `Low-trust suppression test ${runId}`,
        category: "agent-network",
        summary: "A negative test for automatic suppression authority.",
        source_urls: ["https://example.com/low-trust-review"],
        evidence: "An external source anchors the negative governance test.",
        confidence: 0.9,
        urgency: "high",
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        submitted_by_agent_id: submitter.id,
      }),
    }),
    201,
    "submit low-trust suppression test signal",
  ).signal;
  for (const critic of [criticOne, criticTwo]) {
    requireStatus(
      await request(`/api/signals/${reviewedSignal.id}/validate`, {
        method: "POST",
        headers: auth(critic),
        body: JSON.stringify({ agent_id: critic.id, verdict: "mark_low_quality" }),
      }),
      201,
      "record low-trust low-quality review",
    );
  }
  const expiryCritic = await register("expiry-critic");
  const expirySignal = requireStatus(
    await request("/api/signals", {
      method: "POST",
      headers: auth(submitter),
      body: JSON.stringify({
        title: `Low-trust expiry test ${runId}`,
        category: "agent-network",
        summary: "A negative test for status-change authority.",
        source_urls: ["https://example.com/low-trust-expiry"],
        evidence: "An external source anchors the status authority test.",
        confidence: 0.8,
        urgency: "medium",
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        submitted_by_agent_id: submitter.id,
      }),
    }),
    201,
    "submit low-trust expiry test signal",
  ).signal;
  requireStatus(
    await request(`/api/signals/${expirySignal.id}/validate`, {
      method: "POST",
      headers: auth(expiryCritic),
      body: JSON.stringify({ agent_id: expiryCritic.id, verdict: "mark_expired" }),
    }),
    201,
    "record low-trust expiry review",
  );
  const expirySignalDetail = requireStatus(await request(`/api/signals/${expirySignal.id}`), 200, "read low-trust expiry signal").signal;
  if (expirySignalDetail.status !== "active") throw new Error("low-trust validators must not change signal status");

  const lowTrustGovernance = requireStatus(await request(`/api/signals/${reviewedSignal.id}/governance`), 200, "read low-trust suppression governance").governance;
  if (lowTrustGovernance.state === "suppressed" || lowTrustGovernance.inputs?.established_low_quality_agents !== 0) {
    throw new Error("low-trust validators must not trigger automatic suppression");
  }
}

const governanceResult = await request(`/api/signals/${signal.id}/governance`);
const governance = requireStatus(governanceResult, 200, "read governance").governance;
const expectedGovernanceState = expectDigest ? "digest_candidate" : "observable";
if (governance.state !== expectedGovernanceState) {
  throw new Error(`governance state mismatch: expected ${expectedGovernanceState}, received ${JSON.stringify(governance)}`);
}

const digestResult = await request("/api/digests/latest");
const digest = requireStatus(digestResult, 200, "read digest").digest;
const digestContainsSignal = digest.signals.some((item) => item.id === signal.id);
if (digestContainsSignal !== expectDigest) {
  throw new Error(`digest inclusion mismatch: expected ${expectDigest}, received ${digestContainsSignal}`);
}

if (expectDigest) {
  const maintenanceHeaders = { Authorization: `Bearer ${process.env.ASH_ADMIN_TOKEN}` };
  const concurrentSnapshots = await Promise.all([
    request("/api/admin/digests/persist", { method: "POST", headers: maintenanceHeaders }),
    request("/api/admin/digests/persist", { method: "POST", headers: maintenanceHeaders }),
  ]);
  const statuses = concurrentSnapshots.map((result) => result.response.status).sort();
  if (statuses[0] !== 200 || statuses[1] !== 201) throw new Error(`concurrent digest persistence returned ${statuses.join(",")}`);
  const snapshotBodies = concurrentSnapshots.map((result) => result.body);
  if (snapshotBodies.filter((body) => body.created).length !== 1 || snapshotBodies[0].digest.id !== snapshotBodies[1].digest.id) {
    throw new Error("concurrent digest persistence must create exactly one snapshot");
  }
  const repeatedSnapshot = requireStatus(await request("/api/admin/digests/persist", { method: "POST", headers: maintenanceHeaders }), 200, "reuse digest snapshot bucket");
  if (repeatedSnapshot.created || repeatedSnapshot.digest.id !== snapshotBodies[0].digest.id) throw new Error("digest snapshot bucket retry was not idempotent");
}

const challengeResult = await request(`/api/signals/${signal.id}/challenges`, {
  method: "POST",
  headers: auth(observer),
  body: JSON.stringify({
    agent_id: observer.id,
    target_agent_id: submitter.id,
    challenge_type: "request_evidence",
    claim: "Please retain a machine-readable evidence trail for later agents.",
    evidence_urls: ["https://observer.example/request-evidence"],
  }),
});
requireStatus(challengeResult, 201, "create evidence challenge after digest consumption");

const pinnedWebhookDelivery = await request(
  `/api/agents/${observer.id}/subscriptions/${pinnedWebhookSubscription.id}/deliver`,
  {
    method: "POST",
    headers: auth(observer),
    body: JSON.stringify({ since: startedAt, limit: 100 }),
  },
);
requireStatus(pinnedWebhookDelivery, 502, "reject unreachable callback through pinned transport");
if (pinnedWebhookDelivery.body?.status !== "blocked_callback_url") {
  throw new Error(`pinned webhook transport did not report a policy-safe failure: ${JSON.stringify(pinnedWebhookDelivery.body)}`);
}
const observerSubscriptions = requireStatus(
  await request(`/api/agents/${observer.id}/subscriptions`, { headers: { Authorization: `Bearer ${observer.apiKey}` } }),
  200,
  "read pinned webhook delivery status",
);
const pinnedSubscriptionState = observerSubscriptions.subscriptions?.find((subscription) => subscription.id === pinnedWebhookSubscription.id);
if (pinnedSubscriptionState?.last_delivery_status !== "blocked_callback_url") {
  throw new Error("pinned webhook failure was not persisted on the subscription");
}

const eventsResult = await request(`/api/events?since=${encodeURIComponent(startedAt)}&limit=200`);
const events = requireStatus(eventsResult, 200, "read event stream").events;
const eventTypes = new Set(events.filter((event) => event.type === "digest_available" || event.subject?.id === signal.id || event.links?.signal?.endsWith(`/signals/${signal.id}`)).map((event) => event.type));
for (const expected of ["signal_created", "validation_created", "challenge_created", ...(expectDigest ? ["digest_available"] : [])]) {
  if (!eventTypes.has(expected)) throw new Error(`event stream is missing ${expected}`);
}

const previousRepeaterCredentials = { ...credentialLifecycleAgent };
const rotatedKeyPair = generateKeyPairSync("ed25519");
const rotatedPublicKey = rotatedKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString().trim();
const rotatedApiKey = "ash_" + randomBytes(32).toString("base64url");
const rotationBody = {
  agent_id: credentialLifecycleAgent.id,
  new_api_key: rotatedApiKey,
  new_public_key: rotatedPublicKey,
  new_public_key_proof: credentialRotationProof(credentialLifecycleAgent.id, rotatedApiKey, rotatedPublicKey, rotatedKeyPair.privateKey),
};
const rotation = requireStatus(
  await request("/api/agents/" + credentialLifecycleAgent.id + "/credentials/rotate", {
    method: "POST",
    headers: auth(previousRepeaterCredentials),
    body: JSON.stringify(rotationBody),
  }),
  200,
  "rotate agent credentials",
);
if ("api_key" in rotation || rotation.credential_status !== "active") {
  throw new Error("credential rotation must not return plaintext credentials");
}
const oldCredentialRead = await request("/api/agents/" + credentialLifecycleAgent.id + "/source-tasks", {
  headers: auth(previousRepeaterCredentials),
});
requireStatus(oldCredentialRead, 401, "reject old API key after credential rotation");
credentialLifecycleAgent.apiKey = rotatedApiKey;
credentialLifecycleAgent.privateKey = rotatedKeyPair.privateKey;
requireStatus(
  await request("/api/agents/" + credentialLifecycleAgent.id + "/source-tasks", { headers: auth(credentialLifecycleAgent) }),
  200,
  "accept rotated credentials",
);
const rotatedCard = requireStatus(
  await request("/api/agents/" + credentialLifecycleAgent.id + "/card"),
  200,
  "read rotated agent card",
);
if (rotatedCard.identity?.credential_status !== "active" || !rotatedCard.identity?.credentials_rotated_at) {
  throw new Error("agent card does not expose active rotated credential status");
}
const staleInfrastructureClaim = rotatedCard.infrastructure?.claims?.find((claim) => claim.target === credentialInfrastructureTarget);
if (!staleInfrastructureClaim || staleInfrastructureClaim.status !== "stale") {
  throw new Error("credential rotation did not mark the previous infrastructure claim stale");
}
const staleClaimEvents = requireStatus(
  await request(`/api/agents/${credentialLifecycleAgent.id}/events?since=${encodeURIComponent(startedAt)}`, {
    headers: { Authorization: `Bearer ${credentialLifecycleAgent.apiKey}` },
  }),
  200,
  "read stale infrastructure claim event",
);
if (!staleClaimEvents.events?.some((event) => event.type === "infrastructure_claim_stale" && event.subject?.id === staleInfrastructureClaim.id)) {
  throw new Error("credential rotation did not emit an infrastructure_claim_stale event");
}
const publicStaleClaimEvents = requireStatus(
  await request(`/api/events?since=${encodeURIComponent(startedAt)}&limit=200`),
  200,
  "read public stale infrastructure claim event",
);
if (!publicStaleClaimEvents.events?.some((event) => event.type === "infrastructure_claim_stale" && event.subject?.id === staleInfrastructureClaim.id)) {
  throw new Error("node event stream does not expose the public infrastructure claim lifecycle");
}

const rotatedRepeaterCredentials = { ...credentialLifecycleAgent };
const recoveredActiveKeyPair = generateKeyPairSync("ed25519");
const recoveredRecoveryKeyPair = generateKeyPairSync("ed25519");
const recoveredPublicKey = recoveredActiveKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString().trim();
const recoveredRecoveryPublicKey = recoveredRecoveryKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString().trim();
const recoveredApiKey = "ash_" + randomBytes(32).toString("base64url");
const recoveryTimestamp = new Date().toISOString();
const recoveryNonce = randomUUID();
const recoveryBody = {
  agent_id: credentialLifecycleAgent.id,
  new_api_key: recoveredApiKey,
  new_public_key: recoveredPublicKey,
  new_recovery_public_key: recoveredRecoveryPublicKey,
  recovery_timestamp: recoveryTimestamp,
  recovery_nonce: recoveryNonce,
  recovery_signature: credentialRecoveryProof(
    credentialLifecycleAgent.id,
    recoveryTimestamp,
    recoveryNonce,
    recoveredApiKey,
    recoveredPublicKey,
    recoveredRecoveryPublicKey,
    credentialLifecycleAgent.recoveryPrivateKey,
  ),
};
const recovery = requireStatus(
  await request("/api/agents/" + credentialLifecycleAgent.id + "/credentials/recover", {
    method: "POST",
    body: JSON.stringify(recoveryBody),
  }),
  200,
  "recover agent credentials with offline key",
);
if ("api_key" in recovery || recovery.credential_status !== "active") {
  throw new Error("credential recovery must not return plaintext credentials");
}
requireStatus(
  await request("/api/agents/" + credentialLifecycleAgent.id + "/source-tasks", { headers: auth(rotatedRepeaterCredentials) }),
  401,
  "reject credentials replaced by offline recovery",
);
credentialLifecycleAgent.apiKey = recoveredApiKey;
credentialLifecycleAgent.privateKey = recoveredActiveKeyPair.privateKey;
credentialLifecycleAgent.recoveryPrivateKey = recoveredRecoveryKeyPair.privateKey;
requireStatus(
  await request("/api/agents/" + credentialLifecycleAgent.id + "/source-tasks", { headers: auth(credentialLifecycleAgent) }),
  200,
  "accept recovered active credentials",
);
const recoveredCard = requireStatus(
  await request("/api/agents/" + credentialLifecycleAgent.id + "/card"),
  200,
  "read recovered agent card",
);
if (
  recoveredCard.identity?.credential_status !== "active" ||
  !recoveredCard.identity?.credentials_recovered_at ||
  !recoveredCard.identity?.recovery_configured
) {
  throw new Error("agent card does not expose recovered credential status");
}
const replayedRecovery = await request("/api/agents/" + credentialLifecycleAgent.id + "/credentials/recover", {
  method: "POST",
  body: JSON.stringify(recoveryBody),
});
if (![401, 409].includes(replayedRecovery.response.status)) {
  throw new Error("credential recovery replay was not rejected");
}
const revocationValidator = bootstrapSeeds[2];
if (!revocationValidator) throw new Error("credential revocation governance test requires a third configured bootstrap validator");
const revocationSignal = requireStatus(
  await request("/api/signals", {
    method: "POST",
    headers: auth(submitter),
    body: JSON.stringify({
      title: "Revocation authority test " + runId,
      category: "agent-network",
      summary: "A signal used to prove that credential revocation removes governance authority.",
      source_urls: ["https://rotation-source-one.net/report", "https://rotation-source-two.org/report"],
      evidence: "Two independent source domains anchor the revocation authority test.",
      confidence: 0.9,
      urgency: "high",
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      submitted_by_agent_id: submitter.id,
    }),
  }),
  201,
  "submit revocation authority signal",
).signal;
requireStatus(
  await request("/api/signals/" + revocationSignal.id + "/validate", {
    method: "POST",
    headers: auth(bootstrapSeeds[0]),
    body: JSON.stringify({
      agent_id: bootstrapSeeds[0].id,
      verdict: "support",
      comment: "First established support before revocation.",
      evidence_urls: ["https://review-alpha.dev/evidence"],
    }),
  }),
  201,
  "record first revocation authority support",
);
requireStatus(
  await request("/api/signals/" + revocationSignal.id + "/validate", {
    method: "POST",
    headers: auth(revocationValidator),
    body: JSON.stringify({
      agent_id: revocationValidator.id,
      verdict: "support",
      comment: "Second established support before revocation.",
      evidence_urls: ["https://review-beta.io/evidence"],
    }),
  }),
  201,
  "record second revocation authority support",
);
const governanceBeforeRevocation = requireStatus(
  await request("/api/signals/" + revocationSignal.id + "/governance"),
  200,
  "read governance before credential revocation",
).governance;
if (governanceBeforeRevocation.state !== "digest_candidate" || governanceBeforeRevocation.inputs?.established_independent_evidence_backed_support_count !== 2) {
  throw new Error("configured bootstrap validators did not form revocation-test quorum: " + JSON.stringify(governanceBeforeRevocation));
}

const revocation = requireStatus(
  await request("/api/admin/agents/" + revocationValidator.id + "/revoke", {
    method: "POST",
    headers: { Authorization: "Bearer " + process.env.ASH_ADMIN_TOKEN },
    body: JSON.stringify({ reason: "Integration incident-response credential revocation." }),
  }),
  200,
  "revoke agent credentials",
);
if (revocation.credential_status !== "revoked") throw new Error("admin revocation did not return revoked status");
const repeatedRevocation = requireStatus(
  await request("/api/admin/agents/" + revocationValidator.id + "/revoke", {
    method: "POST",
    headers: { Authorization: "Bearer " + process.env.ASH_ADMIN_TOKEN },
    body: JSON.stringify({ reason: "Repeated integration revocation must be idempotent." }),
  }),
  200,
  "repeat credential revocation",
);
if (!repeatedRevocation.already_revoked) throw new Error("credential revocation retry was not idempotent");
requireStatus(
  await request("/api/agents/" + revocationValidator.id + "/source-tasks", { headers: auth(revocationValidator) }),
  403,
  "reject revoked agent credentials",
);
const revokedCard = requireStatus(
  await request("/api/agents/" + revocationValidator.id + "/card"),
  200,
  "read revoked agent card",
);
if (revokedCard.identity?.credential_status !== "revoked" || !revokedCard.identity?.credentials_revoked_at) {
  throw new Error("revoked agent card does not retain public revocation status");
}
const revokedRecoveryActiveKeyPair = generateKeyPairSync("ed25519");
const revokedRecoveryKeyPair = generateKeyPairSync("ed25519");
const revokedRecoveryPublicKey = revokedRecoveryActiveKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString().trim();
const revokedNextRecoveryPublicKey = revokedRecoveryKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString().trim();
const revokedRecoveryApiKey = "ash_" + randomBytes(32).toString("base64url");
const revokedRecoveryTimestamp = new Date().toISOString();
const revokedRecoveryNonce = randomUUID();
const revokedRecoveryAttempt = await request("/api/agents/" + revocationValidator.id + "/credentials/recover", {
  method: "POST",
  body: JSON.stringify({
    agent_id: revocationValidator.id,
    new_api_key: revokedRecoveryApiKey,
    new_public_key: revokedRecoveryPublicKey,
    new_recovery_public_key: revokedNextRecoveryPublicKey,
    recovery_timestamp: revokedRecoveryTimestamp,
    recovery_nonce: revokedRecoveryNonce,
    recovery_signature: credentialRecoveryProof(
      revocationValidator.id,
      revokedRecoveryTimestamp,
      revokedRecoveryNonce,
      revokedRecoveryApiKey,
      revokedRecoveryPublicKey,
      revokedNextRecoveryPublicKey,
      revocationValidator.recoveryPrivateKey,
    ),
  }),
});
requireStatus(revokedRecoveryAttempt, 403, "prevent offline recovery from bypassing Admin revocation");
const governanceAfterRevocation = requireStatus(
  await request("/api/signals/" + revocationSignal.id + "/governance"),
  200,
  "read governance after credential revocation",
).governance;
if (governanceAfterRevocation.state === "digest_candidate" || governanceAfterRevocation.inputs?.established_independent_evidence_backed_support_count !== 1) {
  throw new Error("revoked validator continued to satisfy digest governance quorum");
}
console.log(
  JSON.stringify(
    {
      status: "ok",
      run_id: runId,
      signal_id: signal.id,
      governance_state: governance.state,
      digest_contains_signal: digestContainsSignal,
      observed_event_types: [...eventTypes].sort(),
      credential_lifecycle: { rotation: "verified", recovery: "verified", recovery_replay_rejection: "verified", old_key_rejection: "verified", revocation: "verified", revoked_governance_authority_removed: "verified" },
      identity_independence: { declared_infrastructure_quorum_collapse: expectDigest ? "verified" : "not_applicable_to_unestablished_validators", domain_controller_relationships: expectDigest ? "verified_for_signal_sources_validation_evidence_source_registry_and_events" : "verified_unestablished_assertions_remain_unverified", domain_relationship_lifecycle: expectDigest ? "verified_renew_supersede_withdraw_and_owned_event_streams" : "not_applicable_to_unestablished_quorum", proof_template: "verified", failed_proof_audit: "verified", key_rotation_stales_claim: "verified", claim_lifecycle_events: "verified_for_agent_and_node_streams", pinned_https_transport: "verified_for_proof_and_webhook" },
      note: "Runtime digest reads do not mutate reputation. Persisted snapshots require two independent support validations before a one-time +1 reward.",
    },
    null,
    2,
  ),
);
