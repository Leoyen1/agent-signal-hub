import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const values = process.argv.slice(2);
function option(name) { const index = values.indexOf(name); return index >= 0 ? values[index + 1] : undefined; }
function required(name) { const value = option(name); if (!value) throw new Error(`${name} is required`); return value; }
function fingerprint(publicKey) { return createHash("sha256").update(publicKey.trim(), "utf8").digest("hex"); }
function quoted(value) { return JSON.stringify(String(value)); }

const output = resolve(option("--output") ?? join(repoRoot, ".private-trial"));
const baseUrl = new URL(required("--base-url"));
if (baseUrl.protocol !== "https:") throw new Error("--base-url must use HTTPS");
const databasePath = resolve(required("--database-path"));
const internalPort = Number(option("--internal-port") ?? 3000);
if (!Number.isInteger(internalPort) || internalPort < 1024 || internalPort > 65535) throw new Error("--internal-port must be an integer between 1024 and 65535");
try { await stat(output); throw new Error(`Refusing to overwrite existing private-trial directory: ${output}`); } catch (error) { if (error?.code !== "ENOENT") throw error; }

const stateDirectory = join(output, "state");
const backupDirectory = join(output, "backups");
const seedDirectory = join(output, "seeds");
await Promise.all([mkdir(stateDirectory, { recursive: true }), mkdir(backupDirectory, { recursive: true }), mkdir(seedDirectory, { recursive: true }), mkdir(dirname(databasePath), { recursive: true })]);

const seeds = [];
for (let index = 1; index <= 3; index += 1) {
  const active = generateKeyPairSync("ed25519");
  const recovery = generateKeyPairSync("ed25519");
  const activePublicKey = active.publicKey.export({ type: "spki", format: "pem" }).toString().trim();
  const recoveryPublicKey = recovery.publicKey.export({ type: "spki", format: "pem" }).toString().trim();
  const activePath = join(seedDirectory, `seed-${index}-active.json`);
  const recoveryPath = join(seedDirectory, `seed-${index}-recovery.json`);
  await writeFile(activePath, JSON.stringify({ format: "ash-agent-identity-v1", active_public_key: activePublicKey, active_private_key: active.privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim(), recovery_public_key: recoveryPublicKey, created_at: new Date().toISOString() }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await writeFile(recoveryPath, JSON.stringify({ format: "ash-agent-recovery-identity-v1", recovery_public_key: recoveryPublicKey, recovery_private_key: recovery.privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim(), created_at: new Date().toISOString() }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await Promise.all([chmod(activePath, 0o600).catch(() => undefined), chmod(recoveryPath, 0o600).catch(() => undefined)]);
  seeds.push({ index, fingerprint: fingerprint(activePublicKey), active_identity: activePath, recovery_identity: recoveryPath });
}

const inviteCodes = Array.from({ length: 12 }, () => `ashi_${randomBytes(24).toString("base64url")}`);
const inviteHashes = inviteCodes.map((code) => createHash("sha256").update(`ash-registration-invite-v1:${code}`).digest("hex"));
const invitePath = join(output, "registration-invites.json");
await writeFile(invitePath, JSON.stringify({ format: "ash-registration-invites-v1", created_at: new Date().toISOString(), one_time_codes: inviteCodes }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
await chmod(invitePath, 0o600).catch(() => undefined);

const adminToken = randomBytes(32).toString("base64url");
const cookieSecret = randomBytes(48).toString("base64url");
const heartbeatPath = join(stateDirectory, "digest-maintenance-heartbeat.json");
const lockPath = join(stateDirectory, "digest-maintenance.lock");
const operationsPath = join(stateDirectory, "operations.jsonl");
const trialStatePath = join(stateDirectory, "private-trial-state.json");
const trialLogPath = join(stateDirectory, "private-trial-observations.jsonl");
const backupPath = join(backupDirectory, "agent-signal-hub.db");
const envPath = join(output, ".env.production");
const env = [
  "NODE_ENV=production", `DATABASE_URL=${quoted(`file:${databasePath.replace(/\\/g, "/")}`)}`, `NEXT_PUBLIC_APP_URL=${quoted(baseUrl.origin)}`,
  `ADMIN_TOKEN=${quoted(adminToken)}`, `ADMIN_COOKIE_SECRET=${quoted(cookieSecret)}`, `BOOTSTRAP_VALIDATOR_PUBLIC_KEY_FINGERPRINTS=${quoted(seeds.map((seed) => seed.fingerprint).join(","))}`,
  "ASH_PUBLIC_REGISTRATION_ENABLED=false", `REGISTRATION_INVITE_CODE_HASHES=${quoted(inviteHashes.join(","))}`, "ASH_TRUSTED_PROXY_HOPS=1", "REGISTRATION_POW_DIFFICULTY=5", "REGISTRATION_GLOBAL_LIMIT_PER_HOUR=30", "REGISTRATION_NETWORK_LIMIT_PER_HOUR=5", "AGENT_WRITE_GLOBAL_LIMIT_PER_MINUTE=300", "AGENT_WRITE_NETWORK_LIMIT_PER_MINUTE=90", "AGENT_WRITE_AGENT_LIMIT_PER_MINUTE=120",
  "DIGEST_VALIDATOR_COOLDOWN_MINUTES=60", "DIGEST_ESTABLISHED_VALIDATOR_MIN_HOURS=168", "DIGEST_ESTABLISHED_VALIDATOR_MIN_REPUTATION=55", "DIGEST_REQUIRE_VERIFIED_INFRASTRUCTURE=true", "DIGEST_SNAPSHOT_INTERVAL_MINUTES=60",
  "INFRASTRUCTURE_CLAIM_TTL_HOURS=168", "INFRASTRUCTURE_CLAIM_WARNING_HOURS=24", "INFRASTRUCTURE_REFRESH_BATCH_SIZE=25", "DOMAIN_RELATIONSHIP_ASSERTION_TTL_HOURS=720", "DOMAIN_RELATIONSHIP_ASSERTION_WARNING_HOURS=72", "DOMAIN_CONTROLLER_MAX_CLUSTER_SIZE=8",
  `ASH_MAINTENANCE_BASE_URL=${quoted(`http://127.0.0.1:${internalPort}`)}`, `ASH_MAINTENANCE_HEARTBEAT_PATH=${quoted(heartbeatPath)}`, `ASH_MAINTENANCE_LOCK_PATH=${quoted(lockPath)}`, "ASH_MAINTENANCE_RETRY_ATTEMPTS=4", "ASH_MAINTENANCE_RETRY_BASE_MS=1000", "ASH_MAINTENANCE_REQUEST_TIMEOUT_MS=15000", "ASH_MAX_MAINTENANCE_AGE_MINUTES=130", "ASH_MAX_DIGEST_AGE_MINUTES=130",
  `ASH_SQLITE_BACKUP_PATH=${quoted(backupPath)}`, `ASH_PREFLIGHT_BACKUP_MANIFEST=${quoted(`${backupPath}.manifest.json`)}`, "ASH_MAX_BACKUP_AGE_HOURS=25", `ASH_OPS_EVENT_LOG_PATH=${quoted(operationsPath)}`, "ASH_OPS_ALERT_MIN_SEVERITY=error", "ASH_OPS_ALERT_WINDOW_HOURS=24",
  `ASH_TRIAL_BASE_URL=${quoted(baseUrl.origin)}`, "ASH_TRIAL_DURATION_HOURS=72", "ASH_TRIAL_INTERVAL_SECONDS=300", `ASH_TRIAL_STATE_PATH=${quoted(trialStatePath)}`, `ASH_TRIAL_LOG_PATH=${quoted(trialLogPath)}`,
].join("\n") + "\n";
await writeFile(envPath, env, { encoding: "utf8", mode: 0o600 });
await chmod(envPath, 0o600).catch(() => undefined);

const manifest = {
  format: "ash-private-trial-deployment-v1", created_at: new Date().toISOString(), base_url: baseUrl.origin, internal_port: internalPort, database_path: databasePath, env_path: envPath,
  seed_validators: seeds, registration_invites: { path: invitePath, count: inviteCodes.length, one_time: true }, state_directory: stateDirectory, backup_directory: backupDirectory,
    next_steps: ["Configure deploy/nginx/agent-signal-hub.conf for the real domain and certificates.", "Load .env.production into the application and maintenance worker.", "Apply Prisma migrations, build, and start one Next writer process.", "Register the three seed active identities with their matching recovery public keys.", "Move recovery identity files to offline storage after seed registration succeeds.", "Distribute one registration invite to each approved external Agent through a separate secure channel.", "Run backup, maintenance, production preflight, Nginx checks, and one-cycle private trial monitor before admitting external Agents."],
  secrets_in_manifest: false,
};
await writeFile(join(output, "deployment-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
process.stdout.write(JSON.stringify({ status: "ok", output, env_path: envPath, seed_count: seeds.length, invite_count: inviteCodes.length, invite_path: invitePath, bootstrap_fingerprints: seeds.map((seed) => seed.fingerprint), manifest: join(output, "deployment-manifest.json"), warning: "The generated directory contains private keys, one-time invites, and Admin secrets." }) + "\n");
