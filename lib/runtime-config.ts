const DEFAULT_ADMIN_TOKENS = new Set(["", "change-me"]);
const DEFAULT_COOKIE_SECRETS = new Set(["", "change-me-too"]);
const SHA256_FINGERPRINT = /^[a-f0-9]{64}$/;

export function validateProductionRuntimeConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV !== "production") return;
  const errors: string[] = [];
  const adminToken = env.ADMIN_TOKEN?.trim() ?? "";
  const cookieSecret = env.ADMIN_COOKIE_SECRET?.trim() ?? "";
  const databaseUrl = env.DATABASE_URL?.trim() ?? "";
  const appUrl = env.NEXT_PUBLIC_APP_URL?.trim() ?? "";
  const bootstrapFingerprints = (env.BOOTSTRAP_VALIDATOR_PUBLIC_KEY_FINGERPRINTS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const uniqueBootstrapFingerprints = new Set(bootstrapFingerprints);
  const domainRelationshipTtlHours = Number(env.DOMAIN_RELATIONSHIP_ASSERTION_TTL_HOURS ?? 720);
  const domainRelationshipWarningHours = Number(env.DOMAIN_RELATIONSHIP_ASSERTION_WARNING_HOURS ?? 72);
  const domainControllerMaxClusterSize = Number(env.DOMAIN_CONTROLLER_MAX_CLUSTER_SIZE ?? 8);
  const publicRegistrationEnabled = env.ASH_PUBLIC_REGISTRATION_ENABLED === "true";
  const registrationPowDifficulty = Number(env.REGISTRATION_POW_DIFFICULTY ?? (publicRegistrationEnabled ? 5 : 3));
  const trustedProxyHops = Number(env.ASH_TRUSTED_PROXY_HOPS ?? 0);
  const registrationGlobalLimit = Number(env.REGISTRATION_GLOBAL_LIMIT_PER_HOUR ?? 30);
  const registrationNetworkLimit = Number(env.REGISTRATION_NETWORK_LIMIT_PER_HOUR ?? 5);
  const agentWriteGlobalLimit = Number(env.AGENT_WRITE_GLOBAL_LIMIT_PER_MINUTE ?? 300);
  const agentWriteNetworkLimit = Number(env.AGENT_WRITE_NETWORK_LIMIT_PER_MINUTE ?? 90);
  const agentWriteAgentLimit = Number(env.AGENT_WRITE_AGENT_LIMIT_PER_MINUTE ?? 120);
  const registrationInviteHashes = (env.REGISTRATION_INVITE_CODE_HASHES ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (DEFAULT_ADMIN_TOKENS.has(adminToken) || adminToken.length < 24) errors.push("ADMIN_TOKEN must be non-default and at least 24 characters.");
  if (DEFAULT_COOKIE_SECRETS.has(cookieSecret) || cookieSecret.length < 32) errors.push("ADMIN_COOKIE_SECRET must be non-default and at least 32 characters.");
  if (!databaseUrl.startsWith("file:")) errors.push("DATABASE_URL must be an explicit persistent SQLite file: URL.");
  try { if (!appUrl) throw new Error("missing"); const parsedAppUrl = new URL(appUrl); if (parsedAppUrl.protocol !== "https:") throw new Error("https required"); } catch { errors.push("NEXT_PUBLIC_APP_URL must be an absolute HTTPS URL."); }
  if (bootstrapFingerprints.some((fingerprint) => !SHA256_FINGERPRINT.test(fingerprint))) {
    errors.push("BOOTSTRAP_VALIDATOR_PUBLIC_KEY_FINGERPRINTS must contain only comma-separated SHA-256 hex fingerprints.");
  }
  if (uniqueBootstrapFingerprints.size < 2) {
    errors.push("BOOTSTRAP_VALIDATOR_PUBLIC_KEY_FINGERPRINTS must contain at least two distinct seed validator fingerprints.");
  }
  if (!Number.isFinite(domainRelationshipTtlHours) || domainRelationshipTtlHours < 1 || domainRelationshipTtlHours > 2160) {
    errors.push("DOMAIN_RELATIONSHIP_ASSERTION_TTL_HOURS must be between 1 and 2160.");
  }
  if (!Number.isFinite(domainRelationshipWarningHours) || domainRelationshipWarningHours < 1 || domainRelationshipWarningHours > 720 || domainRelationshipWarningHours >= domainRelationshipTtlHours) {
    errors.push("DOMAIN_RELATIONSHIP_ASSERTION_WARNING_HOURS must be between 1 and 720 and smaller than the TTL.");
  }
  if (!Number.isInteger(domainControllerMaxClusterSize) || domainControllerMaxClusterSize < 2 || domainControllerMaxClusterSize > 50) {
    errors.push("DOMAIN_CONTROLLER_MAX_CLUSTER_SIZE must be an integer between 2 and 50.");
  }
  if (publicRegistrationEnabled) {
    if (!Number.isInteger(registrationPowDifficulty) || registrationPowDifficulty < 5 || registrationPowDifficulty > 8) errors.push("Public registration requires REGISTRATION_POW_DIFFICULTY between 5 and 8.");
    if (!Number.isInteger(trustedProxyHops) || trustedProxyHops < 1 || trustedProxyHops > 10) errors.push("Public registration requires ASH_TRUSTED_PROXY_HOPS between 1 and 10.");
    if (!Number.isInteger(registrationGlobalLimit) || registrationGlobalLimit < 1 || registrationGlobalLimit > 1000) errors.push("REGISTRATION_GLOBAL_LIMIT_PER_HOUR must be between 1 and 1000.");
    if (!Number.isInteger(registrationNetworkLimit) || registrationNetworkLimit < 1 || registrationNetworkLimit > 20) errors.push("REGISTRATION_NETWORK_LIMIT_PER_HOUR must be between 1 and 20 in public mode.");
    if (!Number.isInteger(agentWriteGlobalLimit) || agentWriteGlobalLimit < 1 || agentWriteGlobalLimit > 10000) errors.push("AGENT_WRITE_GLOBAL_LIMIT_PER_MINUTE must be between 1 and 10000.");
    if (!Number.isInteger(agentWriteNetworkLimit) || agentWriteNetworkLimit < 1 || agentWriteNetworkLimit > 300) errors.push("AGENT_WRITE_NETWORK_LIMIT_PER_MINUTE must be between 1 and 300 in public mode.");
    if (!Number.isInteger(agentWriteAgentLimit) || agentWriteAgentLimit < 1 || agentWriteAgentLimit > 300) errors.push("AGENT_WRITE_AGENT_LIMIT_PER_MINUTE must be between 1 and 300 in public mode.");
  } else {
    if (!registrationInviteHashes.length) errors.push("Private-trial registration requires REGISTRATION_INVITE_CODE_HASHES.");
    if (registrationInviteHashes.some((value) => !SHA256_FINGERPRINT.test(value))) errors.push("REGISTRATION_INVITE_CODE_HASHES must contain only comma-separated SHA-256 hex hashes.");
  }
  if (errors.length) throw new Error(`Invalid production configuration:\n- ${errors.join("\n- ")}`);
}
