import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const databaseName = `integration-test-${process.pid}.db`;
const databaseUrl = `file:./${databaseName}`;
const cooldownMinutes = process.env.ASH_TEST_COOLDOWN_MINUTES ?? "0";
const expectMatureValidators = process.env.ASH_EXPECT_MATURE_VALIDATORS ?? (cooldownMinutes === "0" ? "true" : "false");
const testBootstrapQuorum = process.env.ASH_TEST_BOOTSTRAP_QUORUM === "true";
const useRelaxedEstablishedThresholds = expectMatureValidators === "true" && !testBootstrapQuorum;
const bootstrapAgents = Array.from({ length: 3 }, () => {
  const keyPair = generateKeyPairSync("ed25519");
  return {
    publicKey: keyPair.publicKey.export({ type: "spki", format: "pem" }).toString().trim(),
    privateKey: keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim(),
  };
});
const bootstrapFingerprints = bootstrapAgents.map((agent) => createHash("sha256").update(agent.publicKey, "utf8").digest("hex")).join(",");
const registrationInviteCodes = Array.from({ length: 40 }, (_, index) => `integration-invite-${process.pid}-${index}-${createHash("sha256").update(String(index)).digest("hex").slice(0, 20)}`);
const registrationInviteHashes = registrationInviteCodes.map((code) => createHash("sha256").update(`ash-registration-invite-v1:${code}`).digest("hex")).join(",");
const prismaDirectory = join(repoRoot, "prisma");
const migrationsDirectory = join(prismaDirectory, "migrations");
const validationIntegrityMigration = "20260712090000_validation_integrity";
const databaseFiles = [
  join(prismaDirectory, databaseName),
  join(prismaDirectory, `${databaseName}-journal`),
  join(prismaDirectory, `${databaseName}-wal`),
  join(prismaDirectory, `${databaseName}-shm`),
];
const backupDatabasePath = join(prismaDirectory, `integration-test-${process.pid}.backup.db`);
const restoredDatabasePath = join(prismaDirectory, `integration-test-${process.pid}.restored.db`);
const maintenanceHeartbeatPath = join(prismaDirectory, `integration-test-${process.pid}.maintenance.json`);
const maintenanceLockPath = `${maintenanceHeartbeatPath}.lock`;
const opsEventLogPath = join(prismaDirectory, `integration-test-${process.pid}.ops.jsonl`);
const trialMonitorStatePath = join(prismaDirectory, `integration-test-${process.pid}.trial-state.json`);
const trialMonitorLogPath = join(prismaDirectory, `integration-test-${process.pid}.trial-observations.jsonl`);
const externalAgentIdentityPath = join(prismaDirectory, `integration-test-${process.pid}.external-agent.json`);
const externalAgentRecoveryIdentityPath = join(prismaDirectory, `integration-test-${process.pid}.external-agent-recovery.json`);
const externalValidatorIdentityPath = join(prismaDirectory, `integration-test-${process.pid}.external-validator.json`);
const externalValidatorRecoveryIdentityPath = join(prismaDirectory, `integration-test-${process.pid}.external-validator-recovery.json`);
const externalInfrastructureProofPath = join(prismaDirectory, `integration-test-${process.pid}.infrastructure-proof.json`);
const reusedInviteIdentityPath = join(prismaDirectory, `integration-test-${process.pid}.reused-invite-agent.json`);
const reusedInviteRecoveryPath = join(prismaDirectory, `integration-test-${process.pid}.reused-invite-recovery.json`);
const operationsFiles = [
  backupDatabasePath,
  `${backupDatabasePath}.manifest.json`,
  restoredDatabasePath,
  `${restoredDatabasePath}-journal`,
  `${restoredDatabasePath}-wal`,
  `${restoredDatabasePath}-shm`,
  maintenanceHeartbeatPath,
  maintenanceLockPath,
  opsEventLogPath,
  trialMonitorStatePath,
  trialMonitorLogPath,
  externalAgentIdentityPath,
  externalAgentRecoveryIdentityPath,
  externalValidatorIdentityPath,
  externalValidatorRecoveryIdentityPath,
  `${externalValidatorIdentityPath}.pending-rotation`,
  `${externalValidatorIdentityPath}.pending-recovery`,
  `${externalValidatorRecoveryIdentityPath}.pending-recovery`,
  externalInfrastructureProofPath,
  reusedInviteIdentityPath,
  reusedInviteRecoveryPath,
];
const legacyFixtureFiles = [
  join(prismaDirectory, "validation-integrity-fixture.db"),
  join(prismaDirectory, "validation-integrity-fixture.db-journal"),
  join(prismaDirectory, "validation-integrity-fixture.db-wal"),
  join(prismaDirectory, "validation-integrity-fixture.db-shm"),
];

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl, ASH_OPS_EVENT_LOG_PATH: opsEventLogPath, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", rejectRun);
    child.on("close", (code) => {
      if (code === 0) resolveRun({ stdout, stderr });
      else rejectRun(new Error(`${command} ${args.join(" ")} failed with ${code}\n${stdout}\n${stderr}`));
    });
  });
}

function reservePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => (error ? rejectPort(error) : resolvePort(address.port)));
    });
  });
}

const SQLITE_FILE_RELEASE_RETRIES = 120;

async function removeFiles(files, { ignoreBusy = false } = {}) {
  for (const file of files) {
    for (let attempt = 0; attempt < SQLITE_FILE_RELEASE_RETRIES; attempt += 1) {
      try {
        await rm(file, { force: true });
        break;
      } catch (error) {
        if (error?.code !== "EBUSY") throw error;
        if (attempt === SQLITE_FILE_RELEASE_RETRIES - 1) {
          if (!ignoreBusy) throw error;
          process.stderr.write(`Warning: deferred cleanup for locked SQLite test file ${file}\n`);
          break;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
    }
  }
}

async function migrateFreshDatabase() {
  const db = new DatabaseSync(databaseFiles[0]);
  try {
    const migrationNames = (await readdir(migrationsDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const migrationName of migrationNames) {
      const sql = await readFile(join(migrationsDirectory, migrationName, "migration.sql"), "utf8");
      db.exec(sql);
    }
  } finally {
    db.close();
  }
}

async function verifyValidationIntegrityMigration() {
  await removeFiles(legacyFixtureFiles);
  const db = new DatabaseSync(legacyFixtureFiles[0]);

  try {
    const migrationNames = (await readdir(migrationsDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name < validationIntegrityMigration)
      .map((entry) => entry.name)
      .sort();

    for (const migrationName of migrationNames) {
      const sql = await readFile(join(migrationsDirectory, migrationName, "migration.sql"), "utf8");
      db.exec(sql);
    }

    db.exec(`
      INSERT INTO "Agent" ("id", "name", "description", "ownerType", "agentType", "apiKeyHash")
      VALUES
        ('legacy-submitter', 'Legacy submitter', 'Fixture agent', 'anonymous', 'research', 'legacy-submitter-key'),
        ('legacy-validator', 'Legacy validator', 'Fixture agent', 'anonymous', 'research', 'legacy-validator-key');
      INSERT INTO "Signal" ("id", "title", "category", "summary", "evidence", "confidence", "urgency", "expiresAt", "submittedByAgentId", "updatedAt")
      VALUES ('legacy-signal', 'Legacy duplicate fixture', 'test', 'Fixture signal', 'Fixture evidence', 0.8, 'medium', '2026-12-31T00:00:00.000Z', 'legacy-submitter', '2026-07-12T00:00:00.000Z');
      INSERT INTO "Validation" ("id", "signalId", "agentId", "verdict", "evidenceUrls", "createdAt")
      VALUES
        ('validation-first', 'legacy-signal', 'legacy-validator', 'support', '["https://example.com/first"]', '2026-07-12T00:00:00.000Z'),
        ('validation-second', 'legacy-signal', 'legacy-validator', 'support', '["https://example.com/second"]', '2026-07-12T00:01:00.000Z');
    `);

    const integritySql = await readFile(join(migrationsDirectory, validationIntegrityMigration, "migration.sql"), "utf8");
    db.exec(integritySql);

    const count = db.prepare('SELECT COUNT(*) AS count FROM "Validation" WHERE "signalId" = \'legacy-signal\'').get().count;
    const survivor = db.prepare('SELECT "id" AS id FROM "Validation" WHERE "signalId" = \'legacy-signal\'').get().id;
    if (count !== 1 || survivor !== "validation-first") {
      throw new Error(`validation integrity migration did not preserve one earliest record: count=${count}, survivor=${survivor}`);
    }

    let uniqueConstraintEnforced = false;
    try {
      db.exec(`INSERT INTO "Validation" ("id", "signalId", "agentId", "verdict") VALUES ('validation-third', 'legacy-signal', 'legacy-validator', 'support')`);
    } catch {
      uniqueConstraintEnforced = true;
    }
    if (!uniqueConstraintEnforced) throw new Error("validation integrity migration did not enforce the unique constraint");
  } finally {
    db.close();
    await removeFiles(legacyFixtureFiles);
  }
}

async function waitForServer(baseUrl, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
      lastError = new Error(`health endpoint returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`isolated Next server did not become ready: ${lastError?.message ?? "unknown error"}`);
}

async function assertProductionServerRejects(envOverrides, description) {
  const port = await reservePort();
  const nextCli = join(repoRoot, "node_modules", "next", "dist", "bin", "next");
  const candidate = spawn(process.execPath, [nextCli, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      ADMIN_TOKEN: "integration-admin-token-32-characters",
      ADMIN_COOKIE_SECRET: "integration-cookie-secret-at-least-32-characters",
      NEXT_PUBLIC_APP_URL: "https://agent-signal-hub.example.test",
      BOOTSTRAP_VALIDATOR_PUBLIC_KEY_FINGERPRINTS: bootstrapFingerprints,
      ...envOverrides,
    },
    stdio: "ignore",
    windowsHide: true,
  });
  const exitCode = await Promise.race([
    new Promise((resolveExit) => candidate.once("close", resolveExit)),
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout("timeout"), 10_000)),
  ]);
  if (exitCode === "timeout") {
    candidate.kill("SIGKILL");
    throw new Error(`production server accepted ${description}`);
  }
  if (exitCode === 0) throw new Error(`production server exited successfully with ${description}`);
}

async function verifyProductionConfigFailsClosed() {
  await assertProductionServerRejects(
    { ADMIN_TOKEN: "change-me", ADMIN_COOKIE_SECRET: "change-me-too" },
    "default admin secrets",
  );
  await assertProductionServerRejects(
    { NEXT_PUBLIC_APP_URL: "http://agent-signal-hub.example.test" },
    "a non-HTTPS public application URL",
  );
  await assertProductionServerRejects(
    { BOOTSTRAP_VALIDATOR_PUBLIC_KEY_FINGERPRINTS: "" },
    "fewer than two bootstrap validator fingerprints",
  );
  const firstFingerprint = bootstrapFingerprints.split(",")[0];
  await assertProductionServerRejects(
    { BOOTSTRAP_VALIDATOR_PUBLIC_KEY_FINGERPRINTS: `${firstFingerprint},${firstFingerprint}` },
    "duplicate bootstrap validator fingerprints",
  );
  await assertProductionServerRejects(
    { BOOTSTRAP_VALIDATOR_PUBLIC_KEY_FINGERPRINTS: `${firstFingerprint},not-a-sha256-fingerprint` },
    "malformed bootstrap validator fingerprints",
  );
  await assertProductionServerRejects(
    { ASH_PUBLIC_REGISTRATION_ENABLED: "false", REGISTRATION_INVITE_CODE_HASHES: "" },
    "private-trial registration without invite hashes",
  );
  await assertProductionServerRejects(
    { ASH_PUBLIC_REGISTRATION_ENABLED: "true", REGISTRATION_POW_DIFFICULTY: "3", ASH_TRUSTED_PROXY_HOPS: "1" },
    "public registration with low proof-of-work difficulty",
  );
  await assertProductionServerRejects(
    { ASH_PUBLIC_REGISTRATION_ENABLED: "true", REGISTRATION_POW_DIFFICULTY: "5", ASH_TRUSTED_PROXY_HOPS: "0" },
    "public registration without a trusted proxy hop boundary",
  );
  await assertProductionServerRejects(
    { DOMAIN_RELATIONSHIP_ASSERTION_TTL_HOURS: "24", DOMAIN_RELATIONSHIP_ASSERTION_WARNING_HOURS: "24" },
    "a domain relationship warning window that is not smaller than its TTL",
  );
  await assertProductionServerRejects(
    { DOMAIN_CONTROLLER_MAX_CLUSTER_SIZE: "1" },
    "a domain controller cluster limit below two",
  );
}
function waitForProcessExit(process, timeoutMs = 10_000) {
  if (process.exitCode !== null) return Promise.resolve();
  return new Promise((resolveWait) => {
    const timeout = setTimeout(resolveWait, timeoutMs);
    process.once("close", () => {
      clearTimeout(timeout);
      resolveWait();
    });
  });
}

async function stopServer(server) {
  if (!server || server.exitCode !== null) return;
  if (process.platform === "win32") {
    server.kill("SIGTERM");
    await waitForProcessExit(server, 5_000);
    if (server.exitCode === null) {
      server.kill("SIGKILL");
      await waitForProcessExit(server, 5_000);
    }
    server.unref();
    // Windows releases SQLite handles from a terminated Next process asynchronously.
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    return;
  }
  await new Promise((resolveStop) => {
    const timeout = setTimeout(() => { server.kill("SIGKILL"); resolveStop(); }, 5_000);
    server.once("close", () => { clearTimeout(timeout); resolveStop(); });
    server.kill("SIGTERM");
  });
}

let server;
let infrastructureProofSuccess;
let publicNetworkPolicy;
let abuseRateLimit;
let edgeBoundaryPolicy;
try {
  await verifyValidationIntegrityMigration();
  await removeFiles(databaseFiles, { ignoreBusy: true });
  await removeFiles(operationsFiles, { ignoreBusy: true });
  await migrateFreshDatabase();
  const nginxBoundary = await readFile(join(repoRoot, "deploy", "nginx", "agent-signal-hub.conf"), "utf8");
  if (!nginxBoundary.includes("proxy_set_header X-Forwarded-For $remote_addr;") || nginxBoundary.includes("proxy_add_x_forwarded_for") || !nginxBoundary.includes("ash_registration_network") || !nginxBoundary.includes("ash_write_network") || !nginxBoundary.includes("ash_read_network") || !nginxBoundary.includes("limit_conn ash_connections")) {
    throw new Error("Nginx public-trial boundary is missing forwarding-header replacement or connection/read/write/registration limits");
  }
  edgeBoundaryPolicy = { status: "ok", forwarded_chain_replacement: "verified", registration_read_write_connection_limits: "verified", nginx_syntax_check: "required_on_deployment_host" };
  publicNetworkPolicy = JSON.parse(
    (
      await run(process.execPath, [
        "--import",
        pathToFileURL(join(repoRoot, "scripts", "register-typescript-loader.mjs")).href,
        join(repoRoot, "scripts", "public-network-policy-test.mjs"),
      ])
    ).stdout,
  );
  abuseRateLimit = JSON.parse(
    (
      await run(process.execPath, [
        "--import",
        pathToFileURL(join(repoRoot, "scripts", "register-typescript-loader.mjs")).href,
        join(repoRoot, "scripts", "abuse-rate-limit-test.mjs"),
      ])
    ).stdout,
  );
  infrastructureProofSuccess = JSON.parse(
    (
      await run(process.execPath, [
        "--import",
        pathToFileURL(join(repoRoot, "scripts", "register-typescript-loader.mjs")).href,
        join(repoRoot, "scripts", "infrastructure-proof-success-test.mjs"),
      ])
    ).stdout.trim().split(/\r?\n/).at(-1),
  );

  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const nextCli = join(repoRoot, "node_modules", "next", "dist", "bin", "next");
  server = spawn(process.execPath, [nextCli, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl, ADMIN_TOKEN: "integration-admin-token-32-characters", ADMIN_COOKIE_SECRET: "integration-cookie-secret-at-least-32-characters", NEXT_PUBLIC_APP_URL: "https://agent-signal-hub.example.test", DIGEST_VALIDATOR_COOLDOWN_MINUTES: cooldownMinutes, DIGEST_ESTABLISHED_VALIDATOR_MIN_HOURS: useRelaxedEstablishedThresholds ? "0" : "168", DIGEST_ESTABLISHED_VALIDATOR_MIN_REPUTATION: useRelaxedEstablishedThresholds ? "0" : "55", DIGEST_REQUIRE_VERIFIED_INFRASTRUCTURE: testBootstrapQuorum ? "true" : "false", BOOTSTRAP_VALIDATOR_PUBLIC_KEY_FINGERPRINTS: bootstrapFingerprints, REGISTRATION_INVITE_CODE_HASHES: registrationInviteHashes, ASH_OPS_EVENT_LOG_PATH: opsEventLogPath, REGISTRATION_GLOBAL_LIMIT_PER_HOUR: "1000", REGISTRATION_NETWORK_LIMIT_PER_HOUR: "1000", AGENT_WRITE_GLOBAL_LIMIT_PER_MINUTE: "10000", AGENT_WRITE_NETWORK_LIMIT_PER_MINUTE: "10000", AGENT_WRITE_AGENT_LIMIT_PER_MINUTE: "10000" },
    stdio: "ignore",
    windowsHide: true,
  });

  await waitForServer(baseUrl);
  await run(process.execPath, [join(repoRoot, "examples", "agent-client.mjs"), "init", "--identity", externalAgentIdentityPath, "--recovery-identity", externalAgentRecoveryIdentityPath]);
  const separatedActiveIdentity = JSON.parse(await readFile(externalAgentIdentityPath, "utf8"));
  const separatedRecoveryIdentity = JSON.parse(await readFile(externalAgentRecoveryIdentityPath, "utf8"));
  if (separatedActiveIdentity.recovery_private_key || separatedRecoveryIdentity.active_private_key || separatedRecoveryIdentity.api_key || !separatedRecoveryIdentity.recovery_private_key) throw new Error("external client did not isolate offline recovery key material from the active identity");
  const registrationBudgetBeforeInvalid = (() => { const database = new DatabaseSync(databaseFiles[0]); try { return database.prepare('SELECT COALESCE(SUM(count), 0) AS total FROM "AbuseRateWindow" WHERE scope LIKE \'registration_%\'').get().total; } finally { database.close(); } })();
  let missingInviteRejected = false;
  try { await run(process.execPath, [join(repoRoot, "examples", "agent-client.mjs"), "register", "--identity", externalAgentIdentityPath, "--recovery-identity", externalAgentRecoveryIdentityPath, "--base-url", baseUrl, "--name", "Uninvited Agent", "--description", "This registration must be rejected."]); } catch (error) { missingInviteRejected = String(error).includes("403"); }
  const registrationBudgetAfterInvalid = (() => { const database = new DatabaseSync(databaseFiles[0]); try { return database.prepare('SELECT COALESCE(SUM(count), 0) AS total FROM "AbuseRateWindow" WHERE scope LIKE \'registration_%\'').get().total; } finally { database.close(); } })();
  if (!missingInviteRejected || registrationBudgetAfterInvalid !== registrationBudgetBeforeInvalid) throw new Error("missing private-trial invite was not rejected before persistent registration budget consumption");
  const externalRegistration = JSON.parse((await run(process.execPath, [join(repoRoot, "examples", "agent-client.mjs"), "register", "--identity", externalAgentIdentityPath, "--recovery-identity", externalAgentRecoveryIdentityPath, "--base-url", baseUrl, "--invite-code", registrationInviteCodes[0], "--name", "External Trial Agent", "--description", "Independent client integration fixture.", "--capability", "signal_submission", "--homepage-url", "https://external-client.example.org/agent"])).stdout);
  await run(process.execPath, [join(repoRoot, "examples", "agent-client.mjs"), "init", "--identity", reusedInviteIdentityPath, "--recovery-identity", reusedInviteRecoveryPath]);
  let reusedInviteRejected = false;
  try { await run(process.execPath, [join(repoRoot, "examples", "agent-client.mjs"), "register", "--identity", reusedInviteIdentityPath, "--recovery-identity", reusedInviteRecoveryPath, "--base-url", baseUrl, "--invite-code", registrationInviteCodes[0], "--name", "Reused Invite Agent", "--description", "This registration must be rejected."]); } catch (error) { reusedInviteRejected = String(error).includes("409"); }
  if (!reusedInviteRejected) throw new Error("one-time registration invite was accepted more than once");
  const externalSignal = JSON.parse((await run(process.execPath, [join(repoRoot, "examples", "agent-client.mjs"), "signal", "--identity", externalAgentIdentityPath, "--title", `External client signal ${process.pid}`, "--summary", "The standalone external client completed registration and a signed Signal submission.", "--source-url", "https://external-client.example.org/evidence", "--evidence", "Standalone client fixture evidence."])).stdout);
  if (!externalRegistration.agent_id || !externalSignal.signal_id) throw new Error("standalone external Agent client did not register and submit a signed Signal");
  const externalProof = JSON.parse((await run(process.execPath, [join(repoRoot, "examples", "agent-client.mjs"), "infrastructure-proof", "--identity", externalAgentIdentityPath, "--output", externalInfrastructureProofPath])).stdout);
  const externalProofDocument = JSON.parse(await readFile(externalInfrastructureProofPath, "utf8"));
  if (!externalProof.proof_url?.endsWith("/.well-known/ash-agent-signal-hub.json") || !externalProofDocument.signature || externalProofDocument.agent_id !== externalRegistration.agent_id) throw new Error("standalone external Agent client did not generate a signed infrastructure proof document");
  await run(process.execPath, [join(repoRoot, "examples", "agent-client.mjs"), "init", "--identity", externalValidatorIdentityPath, "--recovery-identity", externalValidatorRecoveryIdentityPath]);
  const externalValidator = JSON.parse((await run(process.execPath, [join(repoRoot, "examples", "agent-client.mjs"), "register", "--identity", externalValidatorIdentityPath, "--recovery-identity", externalValidatorRecoveryIdentityPath, "--base-url", baseUrl, "--invite-code", registrationInviteCodes[1], "--name", "External Trial Validator", "--description", "Independent validation client fixture.", "--capability", "signal_validation"])).stdout);
  const externalValidation = JSON.parse((await run(process.execPath, [join(repoRoot, "examples", "agent-client.mjs"), "validate", "--identity", externalValidatorIdentityPath, "--signal-id", externalSignal.signal_id, "--verdict", "support", "--comment", "Independent client confirms the integration evidence.", "--evidence-url", "https://validator-client.example.net/review"])).stdout);
  const externalEvents = JSON.parse((await run(process.execPath, [join(repoRoot, "examples", "agent-client.mjs"), "events", "--identity", externalValidatorIdentityPath])).stdout);
  if (!externalValidator.agent_id || !externalValidation.validation_id || !externalEvents.cursor?.next_since) throw new Error("standalone validator client did not validate the Signal and consume private events");
  const validatorIdentityBeforeRotation = await readFile(externalValidatorIdentityPath, "utf8");
  const externalRotation = JSON.parse((await run(process.execPath, [join(repoRoot, "examples", "agent-client.mjs"), "rotate", "--identity", externalValidatorIdentityPath])).stdout);
  const validatorIdentityAfterRotation = JSON.parse(await readFile(externalValidatorIdentityPath, "utf8"));
  validatorIdentityAfterRotation.credential_transition = { type: "rotation", prepared_at: new Date().toISOString() };
  await writeFile(`${externalValidatorIdentityPath}.pending-rotation`, JSON.stringify(validatorIdentityAfterRotation, null, 2) + "\n", "utf8");
  await writeFile(externalValidatorIdentityPath, validatorIdentityBeforeRotation, "utf8");
  const resumedRotation = JSON.parse((await run(process.execPath, [join(repoRoot, "examples", "agent-client.mjs"), "resume-transition", "--identity", externalValidatorIdentityPath])).stdout);
  const eventsAfterRotation = JSON.parse((await run(process.execPath, [join(repoRoot, "examples", "agent-client.mjs"), "events", "--identity", externalValidatorIdentityPath])).stdout);
  const externalRecovery = JSON.parse((await run(process.execPath, [join(repoRoot, "examples", "agent-client.mjs"), "recover", "--identity", externalValidatorIdentityPath, "--recovery-identity", externalValidatorRecoveryIdentityPath])).stdout);
  const eventsAfterRecovery = JSON.parse((await run(process.execPath, [join(repoRoot, "examples", "agent-client.mjs"), "events", "--identity", externalValidatorIdentityPath])).stdout);
  const externalDoctor = JSON.parse((await run(process.execPath, [join(repoRoot, "examples", "agent-client.mjs"), "doctor", "--identity", externalValidatorIdentityPath, "--recovery-identity", externalValidatorRecoveryIdentityPath])).stdout);
  if (!externalRotation.credentials_rotated_at || resumedRotation.resumed_transition !== "rotation" || !eventsAfterRotation.cursor?.next_since || !externalRecovery.credentials_recovered_at || !eventsAfterRecovery.cursor?.next_since || externalDoctor.status !== "ok" || externalDoctor.checks?.no_pending_transition !== true) throw new Error("standalone client credential lifecycle or onboarding doctor did not preserve a healthy authenticated identity");
  const writeBudgetBeforeInvalidAuth = (() => { const database = new DatabaseSync(databaseFiles[0]); try { return database.prepare('SELECT COALESCE(SUM(count), 0) AS total FROM "AbuseRateWindow" WHERE scope LIKE \'agent_write_%\'').get().total; } finally { database.close(); } })();
  const missingAgentAuth = await fetch(baseUrl + "/api/signals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (missingAgentAuth.status !== 401) throw new Error("unauthenticated agent write was not rejected");
  const writeBudgetAfterInvalidAuth = (() => { const database = new DatabaseSync(databaseFiles[0]); try { return database.prepare('SELECT COALESCE(SUM(count), 0) AS total FROM "AbuseRateWindow" WHERE scope LIKE \'agent_write_%\'').get().total; } finally { database.close(); } })();
  if (writeBudgetAfterInvalidAuth !== writeBudgetBeforeInvalidAuth) throw new Error("unauthenticated write consumed persistent Agent write budget");
  const missingAdminAuth = await fetch(baseUrl + "/api/admin/digests/persist", { method: "POST" });
  if (missingAdminAuth.status !== 401) throw new Error("unauthenticated admin maintenance request was not rejected");
  const missingMaintenanceAuth = await fetch(baseUrl + "/api/admin/maintenance/run", { method: "POST" });
  if (missingMaintenanceAuth.status !== 401) throw new Error("unauthenticated unified maintenance cycle was not rejected");
  const demo = await run(process.execPath, [join(repoRoot, "scripts", "demo-agent-exchange.mjs")], {
    env: { ASH_BASE_URL: baseUrl, ASH_ADMIN_TOKEN: "integration-admin-token-32-characters", ASH_EXPECT_MATURE_VALIDATORS: expectMatureValidators, ASH_USE_BOOTSTRAP_VALIDATORS: String(testBootstrapQuorum), ASH_BOOTSTRAP_AGENTS: JSON.stringify(bootstrapAgents), ASH_REGISTRATION_INVITE_CODES: JSON.stringify(registrationInviteCodes.slice(2)) },
  });
  const trialMonitor = JSON.parse(
    (
      await run(process.execPath, [join(repoRoot, "scripts", "private-trial-monitor.mjs")], {
        env: { ASH_TRIAL_BASE_URL: baseUrl, ASH_TRIAL_ONCE: "true", ASH_TRIAL_STATE_PATH: trialMonitorStatePath, ASH_TRIAL_LOG_PATH: trialMonitorLogPath },
      })
    ).stdout.trim().split(/\r?\n/).at(-1),
  );
  if (trialMonitor.observation?.status !== "ok" || trialMonitor.state?.successful_cycles !== 1 || !trialMonitor.state?.event_cursor) {
    throw new Error(`private trial monitor failed against the isolated Next service: ${JSON.stringify(trialMonitor)}`);
  }
  const backup = JSON.parse(
    (
      await run(process.execPath, [join(repoRoot, "scripts", "sqlite-backup.mjs"), "--output", backupDatabasePath])
    ).stdout,
  );
  const restored = JSON.parse(
    (
      await run(process.execPath, [
        join(repoRoot, "scripts", "sqlite-restore-drill.mjs"),
        "--backup",
        backupDatabasePath,
        "--target",
        restoredDatabasePath,
      ])
    ).stdout,
  );
  if (backup.sha256 !== restored.sha256) throw new Error("restored SQLite database hash differs from the online backup");
  if (JSON.stringify(backup.inspection.counts) !== JSON.stringify(restored.inspection.counts)) {
    throw new Error("restored SQLite database row counts differ from the online backup");
  }
  if ((backup.inspection.counts.Agent ?? 0) < 3 || (backup.inspection.counts.Signal ?? 0) < 1) {
    throw new Error("online SQLite backup did not capture the live agent exchange");
  }
  let overwriteRejected = false;
  try {
    await run(process.execPath, [join(repoRoot, "scripts", "sqlite-backup.mjs"), "--output", backupDatabasePath]);
  } catch {
    overwriteRejected = true;
  }
  if (!overwriteRejected) throw new Error("SQLite backup command overwrote an existing backup target");
  let restoreOverwriteRejected = false;
  try {
    await run(process.execPath, [
      join(repoRoot, "scripts", "sqlite-restore-drill.mjs"),
      "--backup",
      backupDatabasePath,
      "--target",
      restoredDatabasePath,
    ]);
  } catch {
    restoreOverwriteRejected = true;
  }
  if (!restoreOverwriteRejected) throw new Error("SQLite restore drill overwrote an existing restore target");
  const maintenanceEnvironment = {
    ASH_MAINTENANCE_BASE_URL: baseUrl,
    ASH_MAINTENANCE_HEARTBEAT_PATH: maintenanceHeartbeatPath,
    ASH_MAINTENANCE_LOCK_PATH: maintenanceLockPath,
    ASH_MAINTENANCE_RETRY_ATTEMPTS: "2",
    ASH_MAINTENANCE_RETRY_BASE_MS: "50",
    ASH_MAINTENANCE_REQUEST_TIMEOUT_MS: "5000",
    ADMIN_TOKEN: "integration-admin-token-32-characters",
  };
  const maintenanceRun = await run(
    process.execPath,
    [join(repoRoot, "scripts", "digest-maintenance-worker.mjs"), "--once"],
    { env: maintenanceEnvironment },
  );
  const maintenance = JSON.parse(maintenanceRun.stdout.trim().split(/\r?\n/).at(-1));
  const maintenanceHeartbeat = JSON.parse(await readFile(maintenanceHeartbeatPath, "utf8"));
  if (maintenanceHeartbeat.status !== "healthy" || maintenanceHeartbeat.last_digest_id !== maintenance.digest_id) {
    throw new Error("digest maintenance worker did not persist a healthy heartbeat");
  }
  if (!maintenance.infrastructure_refresh || !maintenanceHeartbeat.last_infrastructure_refresh) {
    throw new Error("maintenance worker did not expose infrastructure refresh results in output and heartbeat");
  }
  await writeFile(maintenanceLockPath, JSON.stringify({ fixture: "existing worker lock" }) + "\n", "utf8");
  let maintenanceLockRejected = false;
  try {
    await run(process.execPath, [join(repoRoot, "scripts", "digest-maintenance-worker.mjs"), "--once"], {
      env: maintenanceEnvironment,
    });
  } catch {
    maintenanceLockRejected = true;
  }
  if (!maintenanceLockRejected) throw new Error("digest maintenance worker accepted a second singleton lock");
  await readFile(maintenanceLockPath, "utf8");
  await rm(maintenanceLockPath, { force: true });
  const preflightEnvironment = {
    NODE_ENV: "production",
    ADMIN_TOKEN: "integration-admin-token-32-characters",
    ADMIN_COOKIE_SECRET: "integration-cookie-secret-at-least-32-characters",
    NEXT_PUBLIC_APP_URL: "https://agent-signal-hub.example.test",
    BOOTSTRAP_VALIDATOR_PUBLIC_KEY_FINGERPRINTS: bootstrapFingerprints,
    REGISTRATION_INVITE_CODE_HASHES: registrationInviteHashes,
    DIGEST_REQUIRE_VERIFIED_INFRASTRUCTURE: "true",
    INFRASTRUCTURE_CLAIM_TTL_HOURS: "168",
    INFRASTRUCTURE_CLAIM_WARNING_HOURS: "24",
    DOMAIN_RELATIONSHIP_ASSERTION_TTL_HOURS: "720",
    DOMAIN_RELATIONSHIP_ASSERTION_WARNING_HOURS: "72",
    DOMAIN_CONTROLLER_MAX_CLUSTER_SIZE: "8",
    ASH_PREFLIGHT_BACKUP_MANIFEST: backupDatabasePath + ".manifest.json",
    ASH_MAX_BACKUP_AGE_HOURS: "1",
    ASH_MAX_DIGEST_AGE_MINUTES: "10",
    ASH_MAINTENANCE_HEARTBEAT_PATH: maintenanceHeartbeatPath,
    ASH_MAX_MAINTENANCE_AGE_MINUTES: "10",
  };
  const preflight = JSON.parse(
    (
      await run(process.execPath, [join(repoRoot, "scripts", "production-preflight.mjs")], {
        env: preflightEnvironment,
      })
    ).stdout,
  );
  if (preflight.status !== "ok" || preflight.checks.some((entry) => entry.status !== "pass")) {
    throw new Error("production preflight did not pass all checks");
  }
  const policyDatabase = new DatabaseSync(databaseFiles[0]);
  const registeredPolicy = policyDatabase
    .prepare('SELECT id, documentHash FROM "HandoffPolicyVersionEvent" ORDER BY effectiveAt DESC, id DESC LIMIT 1')
    .get();
  if (!registeredPolicy) throw new Error("maintenance did not register the handoff policy before preflight");
  policyDatabase.prepare('UPDATE "HandoffPolicyVersionEvent" SET documentHash = ? WHERE id = ?').run("0".repeat(64), registeredPolicy.id);
  policyDatabase.close();
  let preflightRejectedStaleHandoffPolicy = false;
  try {
    await run(process.execPath, [join(repoRoot, "scripts", "production-preflight.mjs")], {
      env: preflightEnvironment,
    });
  } catch {
    preflightRejectedStaleHandoffPolicy = true;
  } finally {
    const restorePolicyDatabase = new DatabaseSync(databaseFiles[0]);
    restorePolicyDatabase.prepare('UPDATE "HandoffPolicyVersionEvent" SET documentHash = ? WHERE id = ?').run(registeredPolicy.documentHash, registeredPolicy.id);
    restorePolicyDatabase.close();
  }
  if (!preflightRejectedStaleHandoffPolicy) {
    throw new Error("production preflight accepted a stale handoff policy registration");
  }
  let preflightRejectedMissingBackup = false;
  try {
    await run(process.execPath, [join(repoRoot, "scripts", "production-preflight.mjs")], {
      env: { ...preflightEnvironment, ASH_PREFLIGHT_BACKUP_MANIFEST: "" },
    });
  } catch {
    preflightRejectedMissingBackup = true;
  }
  if (!preflightRejectedMissingBackup) throw new Error("production preflight accepted a missing backup manifest");
  let preflightRejectedDisabledInfrastructureProof = false;
  try {
    await run(process.execPath, [join(repoRoot, "scripts", "production-preflight.mjs")], {
      env: { ...preflightEnvironment, DIGEST_REQUIRE_VERIFIED_INFRASTRUCTURE: "false" },
    });
  } catch {
    preflightRejectedDisabledInfrastructureProof = true;
  }
  if (!preflightRejectedDisabledInfrastructureProof) {
    throw new Error("production preflight accepted disabled verified-infrastructure governance");
  }
  const healthyHeartbeatText = await readFile(maintenanceHeartbeatPath, "utf8");
  const heartbeatWithoutInfrastructureRefresh = JSON.parse(healthyHeartbeatText);
  delete heartbeatWithoutInfrastructureRefresh.last_infrastructure_refresh;
  await writeFile(maintenanceHeartbeatPath, JSON.stringify(heartbeatWithoutInfrastructureRefresh, null, 2) + "\n", "utf8");
  let preflightRejectedLegacyHeartbeat = false;
  try {
    await run(process.execPath, [join(repoRoot, "scripts", "production-preflight.mjs")], {
      env: preflightEnvironment,
    });
  } catch {
    preflightRejectedLegacyHeartbeat = true;
  } finally {
    await writeFile(maintenanceHeartbeatPath, healthyHeartbeatText, "utf8");
  }
  if (!preflightRejectedLegacyHeartbeat) {
    throw new Error("production preflight accepted a maintenance heartbeat without infrastructure refresh results");
  }
  let preflightRejectedInvalidDomainLifecycle = false;
  try {
    await run(process.execPath, [join(repoRoot, "scripts", "production-preflight.mjs")], {
      env: { ...preflightEnvironment, DOMAIN_RELATIONSHIP_ASSERTION_TTL_HOURS: "24", DOMAIN_RELATIONSHIP_ASSERTION_WARNING_HOURS: "24" },
    });
  } catch {
    preflightRejectedInvalidDomainLifecycle = true;
  }
  if (!preflightRejectedInvalidDomainLifecycle) {
    throw new Error("production preflight accepted an invalid domain relationship lifecycle window");
  }
  let preflightRejectedInvalidClusterLimit = false;
  try {
    await run(process.execPath, [join(repoRoot, "scripts", "production-preflight.mjs")], {
      env: { ...preflightEnvironment, DOMAIN_CONTROLLER_MAX_CLUSTER_SIZE: "51" },
    });
  } catch {
    preflightRejectedInvalidClusterLimit = true;
  }
  if (!preflightRejectedInvalidClusterLimit) {
    throw new Error("production preflight accepted an invalid domain controller cluster limit");
  }
  const opsLogText = await readFile(opsEventLogPath, "utf8");
  if (opsLogText.includes("integration-admin-token-32-characters")) {
    throw new Error("operations event log exposed the admin token");
  }
  const opsEvents = opsLogText
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (opsEvents.some((event) => event.format !== "agent-signal-hub-ops-event-v1")) {
    throw new Error("operations event log contains an unsupported event format");
  }
  const observedOpsEventTypes = new Set(opsEvents.map((event) => event.event_type));
  const requiredOpsEventTypes = [
    "bearer_missing",
    "self_validation_rejected",
    "agent_credentials_rotated",
    "agent_credentials_recovered",
    "credential_recovery_proof_invalid",
    "revoked_agent_recovery_rejected",
    "agent_credentials_revoked",
    "revoked_agent_credentials_rejected",
    "admin_digest_persist_unauthorized",
    "admin_maintenance_run_unauthorized",
    "digest_snapshot_persisted",
    "infrastructure_claim_auto_refresh_succeeded",
    "infrastructure_claim_auto_refresh_deferred",
    "infrastructure_claim_auto_refresh_failed",
    "maintenance_cycle_completed",
    "sqlite_backup_completed",
    "sqlite_restore_drill_completed",
    "maintenance_lock_acquired",
    "digest_maintenance_succeeded",
    "maintenance_lock_conflict",
    "production_preflight_passed",
    "production_preflight_failed",
  ];
  for (const eventType of requiredOpsEventTypes) {
    if (!observedOpsEventTypes.has(eventType)) throw new Error("operations event log is missing " + eventType);
  }
  let operationsAlertExitVerified = false;
  try {
    await run(process.execPath, [join(repoRoot, "scripts", "ops-alert-summary.mjs")], {
      env: { ASH_OPS_ALERT_MIN_SEVERITY: "error", ASH_OPS_ALERT_WINDOW_HOURS: "1" },
    });
  } catch {
    operationsAlertExitVerified = true;
  }
  if (!operationsAlertExitVerified) throw new Error("operations alert summary did not exit non-zero for error events");
  process.stdout.write(
    JSON.stringify(
      {
        status: "ok",
        database: "isolated SQLite database created from Prisma migrations",
        validator_cooldown_minutes: cooldownMinutes,
        expect_mature_validators: expectMatureValidators,
        bootstrap_quorum: testBootstrapQuorum,
        validation_integrity_migration: "verified against legacy duplicate validation data",
        production_config_fail_fast: "verified default admin secrets, non-HTTPS public URLs, and invalid bootstrap quorum are rejected",
        public_network_policy: publicNetworkPolicy,
        abuse_rate_limit: { ...abuseRateLimit, invalid_registration_budget_consumption: "none", invalid_auth_write_budget_consumption: "none", one_time_invite_reuse: "rejected" },
        edge_boundary_policy: edgeBoundaryPolicy,
        private_trial_monitor: { status: "ok", real_next_probe: "verified", event_cursor_persisted: true },
        external_agent_client: { status: "ok", registration: "verified", signed_signal_submission: "verified", independent_validation: "verified", private_event_consumption: "verified", infrastructure_proof_document: "verified", credential_rotation: "verified", pending_transition_resume: "verified", offline_recovery: "verified", recovery_key_separation: "verified", onboarding_doctor: "verified", identity_cleanup: "scheduled" },
        infrastructure_proof_success: infrastructureProofSuccess,
        base_url: baseUrl,
        operations_audit: {
          event_count: opsEvents.length,
          required_event_types: requiredOpsEventTypes,
          secret_redaction: "verified",
          alert_exit_status: "verified",
        },
        digest_maintenance_worker: {
          digest_id: maintenance.digest_id,
          heartbeat_status: maintenanceHeartbeat.status,
          infrastructure_refresh: maintenance.infrastructure_refresh,
          singleton_lock_rejection: "verified",
        },
        production_preflight: {
          checks: preflight.checks.map((entry) => entry.name),
          stale_handoff_policy_rejection: "verified",
          missing_backup_rejection: "verified",
        disabled_verified_infrastructure_rejection: "verified",
          missing_infrastructure_refresh_rejection: "verified",
          invalid_domain_relationship_lifecycle_rejection: "verified",
          invalid_domain_controller_cluster_limit_rejection: "verified",
        },
        sqlite_backup_restore: {
          sha256_verified: backup.sha256,
          counts: backup.inspection.counts,
          backup_overwrite_protection: "verified",
          restore_overwrite_protection: "verified",
        },
        demo: JSON.parse(demo.stdout),
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await stopServer(server);
  await removeFiles(databaseFiles, { ignoreBusy: true });
  await removeFiles(operationsFiles, { ignoreBusy: true });
}
