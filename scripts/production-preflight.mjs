import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { inspectSqliteDatabase, resolvePrismaSqlitePath, sha256File } from "./lib/sqlite-operations.mjs";
import { emitOpsEvent } from "./lib/ops-events.mjs";

const { HANDOFF_POLICY_KEY, HANDOFF_POLICY_VERSION, handoffPolicyHash } = await import("../lib/handoff-policy-document.ts");
const { validateProductionRuntimeConfig } = await import("../lib/runtime-config.ts");

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checks = [];

async function check(name, operation) {
  try {
    const detail = await operation();
    checks.push({ name, status: "pass", detail });
  } catch (error) {
    checks.push({ name, status: "fail", error: error instanceof Error ? error.message : String(error) });
  }
}

function requiredFingerprints() {
  const fingerprints = (process.env.BOOTSTRAP_VALIDATOR_PUBLIC_KEY_FINGERPRINTS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (fingerprints.some((value) => !/^[a-f0-9]{64}$/.test(value))) {
    throw new Error("bootstrap fingerprints must be SHA-256 hex values");
  }
  const unique = [...new Set(fingerprints)];
  if (unique.length < 2) throw new Error("at least two distinct bootstrap fingerprints are required");
  return unique;
}

function databaseSchema(databasePath) {
  const database = new DatabaseSync(databasePath);
  try {
    return database
      .prepare("SELECT type, name, tbl_name AS table_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma_migrations%' AND tbl_name <> '_prisma_migrations' ORDER BY type, name")
      .all()
      .map((row) => ({
        type: row.type,
        name: row.name,
        table_name: row.table_name,
        sql: row.sql.replace(/\s+/g, " ").trim(),
      }));
  } finally {
    database.close();
  }
}

function schemaHash(schema) {
  return createHash("sha256").update(JSON.stringify(schema), "utf8").digest("hex");
}

async function expectedMigrationSchema() {
  const migrationsDirectory = join(repoRoot, "prisma", "migrations");
  const names = (await readdir(migrationsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (!names.length) throw new Error("no checked-in Prisma migrations found");

  const temporaryPath = join(tmpdir(), "agent-signal-hub-preflight-" + process.pid + "-" + Date.now() + ".db");
  const database = new DatabaseSync(temporaryPath);
  try {
    for (const name of names) {
      const sql = await readFile(join(migrationsDirectory, name, "migration.sql"), "utf8");
      database.exec(sql);
    }
  } finally {
    database.close();
  }

  try {
    const schema = databaseSchema(temporaryPath);
    return { migration_names: names, schema, sha256: schemaHash(schema) };
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function parsePositiveNumber(value, fallback, name) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number <= 0) throw new Error(name + " must be a positive number");
  return number;
}

let databasePath;
let fingerprints;

await check("production_environment", async () => {
  validateProductionRuntimeConfig();
  if (process.env.NODE_ENV !== "production") throw new Error("NODE_ENV must be production");
  const adminToken = process.env.ADMIN_TOKEN?.trim() ?? "";
  const cookieSecret = process.env.ADMIN_COOKIE_SECRET?.trim() ?? "";
  if (!adminToken || adminToken === "change-me" || adminToken.length < 24) throw new Error("ADMIN_TOKEN is missing, default, or shorter than 24 characters");
  if (!cookieSecret || cookieSecret === "change-me-too" || cookieSecret.length < 32) throw new Error("ADMIN_COOKIE_SECRET is missing, default, or shorter than 32 characters");
  const appUrl = new URL(process.env.NEXT_PUBLIC_APP_URL ?? "");
  if (appUrl.protocol !== "https:") throw new Error("NEXT_PUBLIC_APP_URL must use HTTPS");
  fingerprints = requiredFingerprints();
  if (process.env.DIGEST_REQUIRE_VERIFIED_INFRASTRUCTURE === "false") {
    throw new Error("DIGEST_REQUIRE_VERIFIED_INFRASTRUCTURE must remain enabled in production");
  }
  const infrastructureClaimTtlHours = parsePositiveNumber(
    process.env.INFRASTRUCTURE_CLAIM_TTL_HOURS,
    168,
    "INFRASTRUCTURE_CLAIM_TTL_HOURS",
  );
  if (infrastructureClaimTtlHours > 720) throw new Error("INFRASTRUCTURE_CLAIM_TTL_HOURS cannot exceed 720");
  const infrastructureClaimWarningHours = parsePositiveNumber(
    process.env.INFRASTRUCTURE_CLAIM_WARNING_HOURS,
    24,
    "INFRASTRUCTURE_CLAIM_WARNING_HOURS",
  );
  if (infrastructureClaimWarningHours > 720) throw new Error("INFRASTRUCTURE_CLAIM_WARNING_HOURS cannot exceed 720");
  if (infrastructureClaimWarningHours >= infrastructureClaimTtlHours) {
    throw new Error("INFRASTRUCTURE_CLAIM_WARNING_HOURS must be smaller than INFRASTRUCTURE_CLAIM_TTL_HOURS");
  }
  const domainRelationshipTtlHours = parsePositiveNumber(
    process.env.DOMAIN_RELATIONSHIP_ASSERTION_TTL_HOURS,
    720,
    "DOMAIN_RELATIONSHIP_ASSERTION_TTL_HOURS",
  );
  if (domainRelationshipTtlHours > 2160) throw new Error("DOMAIN_RELATIONSHIP_ASSERTION_TTL_HOURS cannot exceed 2160");
  const domainRelationshipWarningHours = parsePositiveNumber(
    process.env.DOMAIN_RELATIONSHIP_ASSERTION_WARNING_HOURS,
    72,
    "DOMAIN_RELATIONSHIP_ASSERTION_WARNING_HOURS",
  );
  if (domainRelationshipWarningHours > 720) throw new Error("DOMAIN_RELATIONSHIP_ASSERTION_WARNING_HOURS cannot exceed 720");
  if (domainRelationshipWarningHours >= domainRelationshipTtlHours) {
    throw new Error("DOMAIN_RELATIONSHIP_ASSERTION_WARNING_HOURS must be smaller than DOMAIN_RELATIONSHIP_ASSERTION_TTL_HOURS");
  }
  const domainControllerMaxClusterSize = parsePositiveNumber(
    process.env.DOMAIN_CONTROLLER_MAX_CLUSTER_SIZE,
    8,
    "DOMAIN_CONTROLLER_MAX_CLUSTER_SIZE",
  );
  if (!Number.isInteger(domainControllerMaxClusterSize) || domainControllerMaxClusterSize < 2 || domainControllerMaxClusterSize > 50) {
    throw new Error("DOMAIN_CONTROLLER_MAX_CLUSTER_SIZE must be an integer between 2 and 50");
  }
  databasePath = resolvePrismaSqlitePath(process.env.DATABASE_URL, repoRoot);
  const opsLogValue = process.env.ASH_OPS_EVENT_LOG_PATH?.trim();
  if (!opsLogValue) throw new Error("ASH_OPS_EVENT_LOG_PATH is required");
  const opsLogPath = resolve(opsLogValue);
  try {
    await access(opsLogPath, constants.R_OK | constants.W_OK);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await access(dirname(opsLogPath), constants.W_OK);
  }
  return {
    app_origin: appUrl.origin,
    database_path: databasePath,
    bootstrap_fingerprint_count: fingerprints.length,
    verified_infrastructure_required: true,
    infrastructure_claim_ttl_hours: infrastructureClaimTtlHours,
    infrastructure_claim_warning_hours: infrastructureClaimWarningHours,
    domain_relationship_assertion_ttl_hours: domainRelationshipTtlHours,
    domain_relationship_assertion_warning_hours: domainRelationshipWarningHours,
    domain_controller_max_cluster_size: domainControllerMaxClusterSize,
    ops_event_log_path: opsLogPath,
  };
});

await check("sqlite_health_and_writability", async () => {
  if (!databasePath) throw new Error("production environment check did not resolve DATABASE_URL");
  await access(databasePath, constants.R_OK | constants.W_OK);
  await access(dirname(databasePath), constants.W_OK);
  const inspection = inspectSqliteDatabase(databasePath);
  if (inspection.integrity_check.length !== 1 || inspection.integrity_check[0] !== "ok") {
    throw new Error("SQLite integrity_check failed");
  }
  if (inspection.foreign_key_violation_count !== 0) throw new Error("SQLite foreign_key_check found violations");
  return inspection;
});

await check("migration_schema", async () => {
  if (!databasePath) throw new Error("production environment check did not resolve DATABASE_URL");
  const expected = await expectedMigrationSchema();
  const actualSchema = databaseSchema(databasePath);
  const actualHash = schemaHash(actualSchema);
  if (actualHash !== expected.sha256) {
    throw new Error("database schema differs from the schema produced by checked-in migrations");
  }
  return {
    migration_count: expected.migration_names.length,
    latest_migration: expected.migration_names.at(-1),
    schema_sha256: actualHash,
  };
});

await check("handoff_policy_registration", () => {
  if (!databasePath) throw new Error("production environment check did not resolve DATABASE_URL");
  const expectedHash = handoffPolicyHash();
  const database = new DatabaseSync(databasePath);
  try {
    const latest = database
      .prepare('SELECT version, documentHash, effectiveAt FROM "HandoffPolicyVersionEvent" WHERE policyKey = ? ORDER BY effectiveAt DESC, id DESC LIMIT 1')
      .get(HANDOFF_POLICY_KEY);
    if (!latest) throw new Error("current handoff policy has not been registered by maintenance");
    if (latest.version !== HANDOFF_POLICY_VERSION || latest.documentHash !== expectedHash) {
      throw new Error("latest registered handoff policy does not match the running policy document");
    }
    return {
      policy_key: HANDOFF_POLICY_KEY,
      version: latest.version,
      document_hash: latest.documentHash,
      effective_at: latest.effectiveAt,
    };
  } finally {
    database.close();
  }
});

await check("registered_seed_quorum", () => {
  if (!databasePath || !fingerprints) throw new Error("production environment check did not resolve seed policy");
  const database = new DatabaseSync(databasePath);
  try {
    const agents = database
      .prepare('SELECT id, publicKey, recoveryPublicKey, reputationScore, trustLevel FROM "Agent" WHERE publicKey IS NOT NULL AND credentialsRevokedAt IS NULL')
      .all();
    const established = agents
      .map((agent) => ({
        id: agent.id,
        fingerprint: createHash("sha256").update(agent.publicKey.trim(), "utf8").digest("hex"),
        reputation_score: agent.reputationScore,
        trust_level: agent.trustLevel,
        recovery_configured: Boolean(agent.recoveryPublicKey),
      }))
      .filter(
        (agent) =>
          fingerprints.includes(agent.fingerprint) &&
          agent.reputation_score >= 80 &&
          agent.trust_level === "trusted" &&
          agent.recovery_configured,
      );
    if (new Set(established.map((agent) => agent.fingerprint)).size < 2) {
      throw new Error("fewer than two configured seed validators are registered as trusted/80 with recovery keys");
    }
    return { established_seed_count: established.length, agent_ids: established.map((agent) => agent.id) };
  } finally {
    database.close();
  }
});

await check("validator_infrastructure_claims", () => {
  if (!databasePath || !fingerprints) throw new Error("production environment check did not resolve infrastructure policy");
  const configuredAgeHours = Number(process.env.DIGEST_ESTABLISHED_VALIDATOR_MIN_HOURS ?? 168);
  const minimumAgeHours = Number.isFinite(configuredAgeHours) ? Math.max(0, configuredAgeHours) : 168;
  const configuredReputation = Number(process.env.DIGEST_ESTABLISHED_VALIDATOR_MIN_REPUTATION ?? 55);
  const minimumReputation = Number.isFinite(configuredReputation) ? Math.max(0, configuredReputation) : 55;
  const database = new DatabaseSync(databasePath);
  try {
    const agents = database
      .prepare('SELECT id, publicKey, reputationScore, createdAt FROM "Agent" WHERE publicKey IS NOT NULL AND credentialsRevokedAt IS NULL')
      .all();
    const claims = database
      .prepare('SELECT agentId, registrableDomain, publicKeyFingerprint, status, verifiedAt, expiresAt FROM "AgentInfrastructureClaim"')
      .all();
    const activeClaimAgents = new Set();
    const now = Date.now();
    for (const claim of claims) {
      const agent = agents.find((candidate) => candidate.id === claim.agentId);
      if (!agent || claim.status !== "verified" || !claim.expiresAt) continue;
      const expiresAt = new Date(claim.expiresAt).getTime();
      const fingerprint = createHash("sha256").update(agent.publicKey.trim(), "utf8").digest("hex");
      if (Number.isFinite(expiresAt) && expiresAt > now && claim.publicKeyFingerprint === fingerprint) {
        activeClaimAgents.add(agent.id);
      }
    }
    const ordinaryEstablished = agents.filter((agent) => {
      const fingerprint = createHash("sha256").update(agent.publicKey.trim(), "utf8").digest("hex");
      if (fingerprints.includes(fingerprint)) return false;
      const createdAt = new Date(agent.createdAt).getTime();
      return Number.isFinite(createdAt) && now - createdAt >= minimumAgeHours * 3_600_000 && agent.reputationScore >= minimumReputation;
    });
    const missingClaims = ordinaryEstablished.filter((agent) => !activeClaimAgents.has(agent.id));
    if (missingClaims.length) {
      throw new Error("established non-bootstrap validators lack a current active-key infrastructure claim: " + missingClaims.map((agent) => agent.id).join(", "));
    }
    return {
      verified_claim_count: claims.filter((claim) => claim.status === "verified" && claim.expiresAt && new Date(claim.expiresAt).getTime() > now).length,
      ordinary_established_validator_count: ordinaryEstablished.length,
      ordinary_established_with_active_claim_count: ordinaryEstablished.length - missingClaims.length,
      bootstrap_exemption_count: agents.filter((agent) => fingerprints.includes(createHash("sha256").update(agent.publicKey.trim(), "utf8").digest("hex"))).length,
    };
  } finally {
    database.close();
  }
});

await check("digest_snapshot_freshness", () => {
  if (!databasePath) throw new Error("production environment check did not resolve DATABASE_URL");
  const intervalMinutes = parsePositiveNumber(process.env.DIGEST_SNAPSHOT_INTERVAL_MINUTES, 60, "DIGEST_SNAPSHOT_INTERVAL_MINUTES");
  const maximumAgeMinutes = parsePositiveNumber(
    process.env.ASH_MAX_DIGEST_AGE_MINUTES,
    intervalMinutes * 2 + 10,
    "ASH_MAX_DIGEST_AGE_MINUTES",
  );
  const database = new DatabaseSync(databasePath);
  try {
    const latest = database.prepare('SELECT id, generatedAt FROM "Digest" ORDER BY generatedAt DESC LIMIT 1').get();
    if (!latest) throw new Error("no persisted digest snapshot exists");
    const generatedAt = new Date(latest.generatedAt);
    const ageMinutes = (Date.now() - generatedAt.getTime()) / 60_000;
    if (!Number.isFinite(ageMinutes) || ageMinutes < 0) throw new Error("latest digest generatedAt is invalid");
    if (ageMinutes > maximumAgeMinutes) {
      throw new Error("latest digest snapshot is " + ageMinutes.toFixed(1) + " minutes old");
    }
    return {
      digest_id: latest.id,
      generated_at: generatedAt.toISOString(),
      age_minutes: Number(ageMinutes.toFixed(2)),
      maximum_age_minutes: maximumAgeMinutes,
    };
  } finally {
    database.close();
  }
});

await check("digest_maintenance_heartbeat", async () => {
  if (!databasePath) throw new Error("production environment check did not resolve DATABASE_URL");
  if (!process.env.ASH_MAINTENANCE_HEARTBEAT_PATH) throw new Error("ASH_MAINTENANCE_HEARTBEAT_PATH is required");
  const heartbeatPath = resolve(process.env.ASH_MAINTENANCE_HEARTBEAT_PATH);
  const heartbeat = JSON.parse(await readFile(heartbeatPath, "utf8"));
  if (heartbeat.format !== "agent-signal-hub-digest-maintenance-v1") {
    throw new Error("unsupported digest maintenance heartbeat format");
  }
  if (!["healthy", "running"].includes(heartbeat.status)) {
    throw new Error("digest maintenance worker status is " + heartbeat.status);
  }
  const infrastructureRefresh = heartbeat.last_infrastructure_refresh;
  if (
    !infrastructureRefresh ||
    !["processed", "refreshed", "deferred", "failed"].every((field) => Number.isInteger(infrastructureRefresh[field]) && infrastructureRefresh[field] >= 0) ||
    infrastructureRefresh.refreshed + infrastructureRefresh.deferred + infrastructureRefresh.failed !== infrastructureRefresh.processed
  ) {
    throw new Error("maintenance heartbeat lacks a valid infrastructure refresh summary");
  }
  const intervalMinutes = parsePositiveNumber(process.env.DIGEST_SNAPSHOT_INTERVAL_MINUTES, 60, "DIGEST_SNAPSHOT_INTERVAL_MINUTES");
  const maximumAgeMinutes = parsePositiveNumber(
    process.env.ASH_MAX_MAINTENANCE_AGE_MINUTES,
    intervalMinutes * 2 + 10,
    "ASH_MAX_MAINTENANCE_AGE_MINUTES",
  );
  const lastSuccess = new Date(heartbeat.last_success_at);
  const ageMinutes = (Date.now() - lastSuccess.getTime()) / 60_000;
  if (!Number.isFinite(ageMinutes) || ageMinutes < 0) throw new Error("maintenance heartbeat last_success_at is invalid");
  if (ageMinutes > maximumAgeMinutes) {
    throw new Error("digest maintenance heartbeat is " + ageMinutes.toFixed(1) + " minutes old");
  }
  const database = new DatabaseSync(databasePath);
  try {
    const digest = database.prepare('SELECT id FROM "Digest" WHERE id = ?').get(heartbeat.last_digest_id);
    if (!digest) throw new Error("maintenance heartbeat references a digest that is not in the database");
  } finally {
    database.close();
  }
  return {
    heartbeat_path: heartbeatPath,
    worker_status: heartbeat.status,
    last_success_at: lastSuccess.toISOString(),
    last_digest_id: heartbeat.last_digest_id,
    age_minutes: Number(ageMinutes.toFixed(2)),
    maximum_age_minutes: maximumAgeMinutes,
    consecutive_failures: heartbeat.consecutive_failures,
    infrastructure_refresh: infrastructureRefresh,
  };
});
await check("backup_freshness_and_hash", async () => {
  if (!databasePath) throw new Error("production environment check did not resolve DATABASE_URL");
  if (!process.env.ASH_PREFLIGHT_BACKUP_MANIFEST) throw new Error("ASH_PREFLIGHT_BACKUP_MANIFEST is required");
  const manifestPath = resolve(process.env.ASH_PREFLIGHT_BACKUP_MANIFEST);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.format !== "agent-signal-hub-sqlite-backup-v1") throw new Error("unsupported backup manifest format");
  if (resolve(manifest.source_database) !== databasePath) throw new Error("backup manifest source_database does not match DATABASE_URL");
  const backupPath = resolve(manifest.backup_database);
  await stat(backupPath);
  const actualSha256 = await sha256File(backupPath);
  if (actualSha256 !== manifest.sha256) throw new Error("backup SHA-256 does not match its manifest");
  const maximumAgeHours = parsePositiveNumber(process.env.ASH_MAX_BACKUP_AGE_HOURS, 25, "ASH_MAX_BACKUP_AGE_HOURS");
  const createdAt = new Date(manifest.created_at);
  const ageHours = (Date.now() - createdAt.getTime()) / 3_600_000;
  if (!Number.isFinite(ageHours) || ageHours < 0) throw new Error("backup manifest created_at is invalid");
  if (ageHours > maximumAgeHours) throw new Error("latest verified backup is " + ageHours.toFixed(1) + " hours old");
  return {
    manifest_path: manifestPath,
    backup_path: backupPath,
    created_at: createdAt.toISOString(),
    age_hours: Number(ageHours.toFixed(2)),
    maximum_age_hours: maximumAgeHours,
    sha256: actualSha256,
  };
});

const failed = checks.filter((entry) => entry.status === "fail");
await emitOpsEvent({
  severity: failed.length ? "critical" : "info",
  component: "production-preflight",
  eventType: failed.length ? "production_preflight_failed" : "production_preflight_passed",
  outcome: failed.length ? "failure" : "success",
  details: {
    passed_check_count: checks.length - failed.length,
    failed_checks: failed.map((entry) => entry.name),
  },
});
process.stdout.write(
  JSON.stringify(
    {
      status: failed.length ? "failed" : "ok",
      checked_at: new Date().toISOString(),
      checks,
    },
    null,
    2,
  ) + "\n",
);
if (failed.length) process.exitCode = 1;
