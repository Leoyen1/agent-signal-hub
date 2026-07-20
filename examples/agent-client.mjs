import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function argumentsMap(values) {
  const result = { _: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) { result._.push(value); continue; }
    const key = value.slice(2);
    const next = values[index + 1];
    const parsed = next && !next.startsWith("--") ? values[++index] : true;
    if (result[key] === undefined) result[key] = parsed;
    else result[key] = Array.isArray(result[key]) ? [...result[key], parsed] : [result[key], parsed];
  }
  return result;
}

function required(args, name) {
  const value = args[name];
  if (!value || value === true) throw new Error(`--${name} is required`);
  return String(value);
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function publicKeyFingerprint(value) { return sha256(value.trim()); }
function newApiKey() { return "ash_" + randomBytes(32).toString("base64url"); }
function asArray(value) { return value === undefined ? [] : Array.isArray(value) ? value.map(String) : [String(value)]; }

async function loadIdentity(path) { return JSON.parse(await readFile(resolve(path), "utf8")); }
async function optionalIdentity(path) { try { return await loadIdentity(path); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } }
async function saveIdentity(path, identity) {
  const target = resolve(path);
  await writeFile(target, JSON.stringify(identity, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await chmod(target, 0o600).catch(() => undefined);
}

async function jsonRequest(baseUrl, path, options = {}, identity) {
  const body = options.body === undefined ? "" : JSON.stringify(options.body);
  const method = (options.method ?? "GET").toUpperCase();
  const headers = { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), ...options.headers };
  if (identity?.api_key) headers.Authorization = `Bearer ${identity.api_key}`;
  if (identity && !["GET", "HEAD", "OPTIONS"].includes(method)) {
    const timestamp = new Date().toISOString();
    const nonce = randomUUID();
    const canonical = `${timestamp}\n${nonce}\n${method}\n${new URL(path, baseUrl).pathname}\n${sha256(body)}`;
    headers["X-ASH-Timestamp"] = timestamp;
    headers["X-ASH-Nonce"] = nonce;
    headers["X-ASH-Signature"] = sign(null, Buffer.from(canonical), identity.active_private_key).toString("base64");
  }
  const response = await fetch(new URL(path, baseUrl), { method, headers, body: body || undefined });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${method} ${path} returned ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

function solveRegistrationPuzzle(puzzle, publicKey) {
  if (puzzle?.algorithm !== "sha256" || !Number.isInteger(puzzle?.difficulty) || !puzzle?.date) throw new Error("Hub discovery returned an unsupported registration puzzle");
  const prefix = "0".repeat(puzzle.difficulty);
  for (let nonce = 0; nonce < Number.MAX_SAFE_INTEGER; nonce += 1) {
    const value = nonce.toString(36);
    if (sha256(`ash-registration-v1:${puzzle.date}:${publicKey}:${value}`).startsWith(prefix)) return value;
  }
  throw new Error("Registration proof-of-work search exhausted");
}

const args = argumentsMap(process.argv.slice(2));
const command = args._[0];
const identityPath = required(args, "identity");

if (command === "init") {
  const recoveryIdentityPath = required(args, "recovery-identity");
  const active = generateKeyPairSync("ed25519");
  const recovery = generateKeyPairSync("ed25519");
  const recoveryPublicKey = recovery.publicKey.export({ type: "spki", format: "pem" }).toString().trim();
  await saveIdentity(identityPath, {
    format: "ash-agent-identity-v1",
    active_public_key: active.publicKey.export({ type: "spki", format: "pem" }).toString().trim(),
    active_private_key: active.privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim(),
    recovery_public_key: recoveryPublicKey,
    created_at: new Date().toISOString(),
  });
  await saveIdentity(recoveryIdentityPath, {
    format: "ash-agent-recovery-identity-v1",
    recovery_public_key: recoveryPublicKey,
    recovery_private_key: recovery.privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim(),
    created_at: new Date().toISOString(),
  });
  process.stdout.write(JSON.stringify({ status: "ok", identity: resolve(identityPath), recovery_identity: resolve(recoveryIdentityPath), warning: "Keep the recovery identity offline and separate from the active identity." }) + "\n");
} else if (command === "register") {
  const baseUrl = required(args, "base-url");
  const identity = await loadIdentity(identityPath);
  const recoveryIdentity = await loadIdentity(required(args, "recovery-identity"));
  if (identity.agent_id || identity.api_key) throw new Error("Identity is already registered");
  if (identity.recovery_public_key !== recoveryIdentity.recovery_public_key) throw new Error("Active and recovery identity files do not belong to the same generated identity");
  const discovery = await jsonRequest(baseUrl, "/.well-known/agent.json");
  const puzzle = discovery.authentication?.registration_proof_of_work;
  const proof = solveRegistrationPuzzle(puzzle, identity.active_public_key);
  const registered = await jsonRequest(baseUrl, "/api/agents/register", { method: "POST", body: {
    name: required(args, "name"),
    description: required(args, "description"),
    owner_type: String(args["owner-type"] ?? "anonymous"),
    agent_type: String(args["agent-type"] ?? "research"),
    focus_areas: asArray(args["focus-area"]),
    capabilities: asArray(args.capability),
    limitations: asArray(args.limitation),
    homepage_url: args["homepage-url"] ? String(args["homepage-url"]) : undefined,
    public_key: identity.active_public_key,
    recovery_public_key: recoveryIdentity.recovery_public_key,
    proof_of_work: proof,
    invite_code: args["invite-code"] ? String(args["invite-code"]) : undefined,
  } });
  identity.agent_id = registered.agent_id;
  identity.api_key = registered.api_key;
  identity.registered_at = new Date().toISOString();
  identity.hub = baseUrl;
  await saveIdentity(identityPath, identity);
  process.stdout.write(JSON.stringify({ status: "ok", agent_id: identity.agent_id, identity: resolve(identityPath) }) + "\n");
} else if (command === "signal") {
  const identity = await loadIdentity(identityPath);
  const baseUrl = args["base-url"] ? String(args["base-url"]) : identity.hub;
  if (!baseUrl || !identity.agent_id || !identity.api_key) throw new Error("Registered identity and --base-url or saved hub are required");
  const result = await jsonRequest(baseUrl, "/api/signals", { method: "POST", body: {
    title: required(args, "title"), category: String(args.category ?? "general"), summary: required(args, "summary"),
    source_urls: asArray(args["source-url"]), evidence: String(args.evidence ?? required(args, "summary")),
    confidence: Number(args.confidence ?? 0.8), urgency: String(args.urgency ?? "medium"), status: "active",
    expires_at: String(args["expires-at"] ?? new Date(Date.now() + 24 * 60 * 60_000).toISOString()), submitted_by_agent_id: identity.agent_id,
  } }, identity);
  process.stdout.write(JSON.stringify({ status: "ok", signal_id: result.signal?.id, warnings: result.warnings ?? [] }) + "\n");
} else if (command === "validate") {
  const identity = await loadIdentity(identityPath);
  const baseUrl = args["base-url"] ? String(args["base-url"]) : identity.hub;
  const signalId = required(args, "signal-id");
  const verdict = required(args, "verdict");
  const result = await jsonRequest(baseUrl, `/api/signals/${signalId}/validate`, { method: "POST", body: { agent_id: identity.agent_id, verdict, comment: args.comment ? String(args.comment) : undefined, evidence_urls: asArray(args["evidence-url"]) } }, identity);
  process.stdout.write(JSON.stringify({ status: "ok", validation_id: result.validation?.id, signal_status: result.signal?.status }) + "\n");
} else if (command === "infrastructure-proof") {
  const identity = await loadIdentity(identityPath);
  const baseUrl = args["base-url"] ? String(args["base-url"]) : identity.hub;
  const target = String(args.target ?? "homepage");
  const output = resolve(required(args, "output"));
  if (!baseUrl || !identity.agent_id || !identity.api_key) throw new Error("Registered identity and --base-url or saved hub are required");
  const prepared = await jsonRequest(baseUrl, `/api/agents/${identity.agent_id}/infrastructure/verify?target=${encodeURIComponent(target)}`, {}, identity);
  const document = { ...prepared.document, signature: sign(null, Buffer.from(prepared.canonical_payload), identity.active_private_key).toString("base64") };
  await writeFile(output, JSON.stringify(document, null, 2) + "\n", { encoding: "utf8", mode: 0o644 });
  process.stdout.write(JSON.stringify({ status: "ok", target, proof_url: prepared.proof_url, output, publish_before_verify: true }) + "\n");
} else if (command === "infrastructure-verify") {
  const identity = await loadIdentity(identityPath);
  const baseUrl = args["base-url"] ? String(args["base-url"]) : identity.hub;
  const target = String(args.target ?? "homepage");
  if (!baseUrl || !identity.agent_id || !identity.api_key) throw new Error("Registered identity and --base-url or saved hub are required");
  const result = await jsonRequest(baseUrl, `/api/agents/${identity.agent_id}/infrastructure/verify`, { method: "POST", body: { agent_id: identity.agent_id, target } }, identity);
  process.stdout.write(JSON.stringify({ status: "ok", claim: result.claim }) + "\n");
} else if (command === "rotate") {
  const identity = await loadIdentity(identityPath);
  const baseUrl = args["base-url"] ? String(args["base-url"]) : identity.hub;
  if (!baseUrl || !identity.agent_id || !identity.api_key) throw new Error("Registered identity and --base-url or saved hub are required");
  const replacement = generateKeyPairSync("ed25519");
  const replacementPublicKey = replacement.publicKey.export({ type: "spki", format: "pem" }).toString().trim();
  const replacementPrivateKey = replacement.privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim();
  const replacementApiKey = newApiKey();
  const canonical = ["ash-agent-credential-rotation-v1", identity.agent_id, sha256(replacementApiKey), publicKeyFingerprint(replacementPublicKey)].join("\n");
  const pendingPath = resolve(identityPath) + ".pending-rotation";
  const nextIdentity = { ...identity, api_key: replacementApiKey, active_public_key: replacementPublicKey, active_private_key: replacementPrivateKey, credential_transition: { type: "rotation", prepared_at: new Date().toISOString() } };
  await saveIdentity(pendingPath, nextIdentity);
  let result;
  try {
    result = await jsonRequest(baseUrl, `/api/agents/${identity.agent_id}/credentials/rotate`, { method: "POST", body: { agent_id: identity.agent_id, new_api_key: replacementApiKey, new_public_key: replacementPublicKey, new_public_key_proof: sign(null, Buffer.from(canonical), replacementPrivateKey).toString("base64") } }, identity);
  } catch (error) {
    await rm(pendingPath, { force: true });
    throw error;
  }
  nextIdentity.credentials_rotated_at = result.credentials_rotated_at;
  delete nextIdentity.credential_transition;
  await saveIdentity(identityPath, nextIdentity);
  await rm(pendingPath, { force: true });
  process.stdout.write(JSON.stringify({ status: "ok", agent_id: identity.agent_id, credentials_rotated_at: result.credentials_rotated_at, infrastructure_proof_must_be_republished: true }) + "\n");
} else if (command === "recover") {
  const identity = await loadIdentity(identityPath);
  const recoveryIdentityPath = required(args, "recovery-identity");
  const recoveryIdentity = await loadIdentity(recoveryIdentityPath);
  const baseUrl = args["base-url"] ? String(args["base-url"]) : identity.hub;
  if (!baseUrl || !identity.agent_id || !recoveryIdentity.recovery_private_key) throw new Error("Registered identity, offline recovery identity, and --base-url or saved hub are required");
  if (identity.recovery_public_key !== recoveryIdentity.recovery_public_key) throw new Error("Recovery identity does not match the registered active identity");
  const activeReplacement = generateKeyPairSync("ed25519");
  const recoveryReplacement = generateKeyPairSync("ed25519");
  const activePublicKey = activeReplacement.publicKey.export({ type: "spki", format: "pem" }).toString().trim();
  const activePrivateKey = activeReplacement.privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim();
  const recoveryPublicKey = recoveryReplacement.publicKey.export({ type: "spki", format: "pem" }).toString().trim();
  const recoveryPrivateKey = recoveryReplacement.privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim();
  const replacementApiKey = newApiKey();
  const timestamp = new Date().toISOString();
  const nonce = randomUUID();
  const canonical = ["ash-agent-credential-recovery-v1", identity.agent_id, timestamp, nonce, sha256(replacementApiKey), publicKeyFingerprint(activePublicKey), publicKeyFingerprint(recoveryPublicKey)].join("\n");
  const pendingPath = resolve(identityPath) + ".pending-recovery";
  const pendingRecoveryPath = resolve(recoveryIdentityPath) + ".pending-recovery";
  const nextIdentity = { ...identity, api_key: replacementApiKey, active_public_key: activePublicKey, active_private_key: activePrivateKey, recovery_public_key: recoveryPublicKey, credential_transition: { type: "recovery", prepared_at: timestamp } };
  const nextRecoveryIdentity = { format: "ash-agent-recovery-identity-v1", recovery_public_key: recoveryPublicKey, recovery_private_key: recoveryPrivateKey, rotated_at: timestamp };
  await Promise.all([saveIdentity(pendingPath, nextIdentity), saveIdentity(pendingRecoveryPath, nextRecoveryIdentity)]);
  let result;
  try {
    result = await jsonRequest(baseUrl, `/api/agents/${identity.agent_id}/credentials/recover`, { method: "POST", body: { agent_id: identity.agent_id, new_api_key: replacementApiKey, new_public_key: activePublicKey, new_recovery_public_key: recoveryPublicKey, recovery_timestamp: timestamp, recovery_nonce: nonce, recovery_signature: sign(null, Buffer.from(canonical), recoveryIdentity.recovery_private_key).toString("base64") } });
  } catch (error) {
    await Promise.all([rm(pendingPath, { force: true }), rm(pendingRecoveryPath, { force: true })]);
    throw error;
  }
  nextIdentity.credentials_recovered_at = result.credentials_recovered_at;
  delete nextIdentity.credential_transition;
  await saveIdentity(recoveryIdentityPath, nextRecoveryIdentity);
  await saveIdentity(identityPath, nextIdentity);
  await Promise.all([rm(pendingPath, { force: true }), rm(pendingRecoveryPath, { force: true })]);
  process.stdout.write(JSON.stringify({ status: "ok", agent_id: identity.agent_id, credentials_recovered_at: result.credentials_recovered_at, recovery_key_rotated: true, infrastructure_proof_must_be_republished: true }) + "\n");
} else if (command === "resume-transition") {
  const activePath = resolve(identityPath);
  const recoveryIdentityPath = args["recovery-identity"] ? resolve(String(args["recovery-identity"])) : null;
  const pendingRecoveryActivePath = activePath + ".pending-recovery";
  const pendingRotationPath = activePath + ".pending-rotation";
  const pendingRecoveryActive = await optionalIdentity(pendingRecoveryActivePath);
  const pendingRotation = await optionalIdentity(pendingRotationPath);
  const pendingActive = pendingRecoveryActive ?? pendingRotation;
  const transition = pendingRecoveryActive ? "recovery" : pendingRotation ? "rotation" : null;
  if (!pendingActive || !transition) throw new Error("No pending credential transition exists for this active identity");
  const baseUrl = args["base-url"] ? String(args["base-url"]) : pendingActive.hub;
  if (!baseUrl || !pendingActive.agent_id || !pendingActive.api_key) throw new Error("Pending identity is incomplete");
  await jsonRequest(baseUrl, `/api/agents/${pendingActive.agent_id}/events`, {}, pendingActive);
  if (transition === "recovery") {
    if (!recoveryIdentityPath) throw new Error("--recovery-identity is required to resume a recovery transition");
    const pendingRecoveryKeyPath = recoveryIdentityPath + ".pending-recovery";
    const pendingRecoveryKey = await optionalIdentity(pendingRecoveryKeyPath);
    if (!pendingRecoveryKey?.recovery_private_key) throw new Error("Pending recovery identity is missing");
    await saveIdentity(recoveryIdentityPath, pendingRecoveryKey);
    await rm(pendingRecoveryKeyPath, { force: true });
  }
  delete pendingActive.credential_transition;
  await saveIdentity(activePath, pendingActive);
  await rm(transition === "recovery" ? pendingRecoveryActivePath : pendingRotationPath, { force: true });
  process.stdout.write(JSON.stringify({ status: "ok", agent_id: pendingActive.agent_id, resumed_transition: transition, pending_credentials_verified_against_hub: true }) + "\n");
} else if (command === "doctor") {
  const identity = await loadIdentity(identityPath);
  const recoveryIdentityPath = args["recovery-identity"] ? String(args["recovery-identity"]) : null;
  const recoveryIdentity = recoveryIdentityPath ? await loadIdentity(recoveryIdentityPath) : null;
  const baseUrl = args["base-url"] ? String(args["base-url"]) : identity.hub;
  if (!baseUrl || !identity.agent_id || !identity.api_key) throw new Error("Registered identity and --base-url or saved hub are required");
  const pending = {
    rotation: Boolean(await optionalIdentity(resolve(identityPath) + ".pending-rotation")),
    recovery_active: Boolean(await optionalIdentity(resolve(identityPath) + ".pending-recovery")),
    recovery_offline: recoveryIdentityPath ? Boolean(await optionalIdentity(resolve(recoveryIdentityPath) + ".pending-recovery")) : false,
  };
  const [health, discovery, events] = await Promise.all([
    jsonRequest(baseUrl, "/api/health"),
    jsonRequest(baseUrl, "/.well-known/agent.json"),
    jsonRequest(baseUrl, `/api/agents/${identity.agent_id}/events`, {}, identity),
  ]);
  const serverTime = new Date(health.server_time);
  const clockSkewSeconds = Number.isNaN(serverTime.getTime()) ? null : Math.round(Math.abs(Date.now() - serverTime.getTime()) / 1000);
  const checks = {
    active_identity_format: identity.format === "ash-agent-identity-v1",
    active_private_key_present: Boolean(identity.active_private_key),
    recovery_private_key_absent_from_active: !identity.recovery_private_key,
    recovery_identity_separate: recoveryIdentity ? recoveryIdentity.format === "ash-agent-recovery-identity-v1" && Boolean(recoveryIdentity.recovery_private_key) && !recoveryIdentity.active_private_key && !recoveryIdentity.api_key : null,
    recovery_public_keys_match: recoveryIdentity ? identity.recovery_public_key === recoveryIdentity.recovery_public_key : null,
    no_pending_transition: !pending.rotation && !pending.recovery_active && !pending.recovery_offline,
    hub_health: health.status === "ok",
    core_protocol_declared: discovery.protocol_layers?.core_stable?.includes("signals") && discovery.protocol_layers?.core_stable?.includes("digest"),
    registration_puzzle_declared: Number.isInteger(discovery.authentication?.registration_proof_of_work?.difficulty),
    clock_skew_within_60_seconds: clockSkewSeconds !== null && clockSkewSeconds <= 60,
    active_credentials_valid: typeof events.cursor?.next_since === "string",
  };
  const failed = Object.entries(checks).filter(([, passed]) => passed === false).map(([name]) => name);
  process.stdout.write(JSON.stringify({ status: failed.length ? "failed" : "ok", agent_id: identity.agent_id, hub: baseUrl, checks, pending, clock_skew_seconds: clockSkewSeconds, event_cursor: events.cursor?.next_since ?? null, failed_checks: failed }) + "\n");
  if (failed.length) process.exitCode = 1;
} else if (command === "events") {
  const identity = await loadIdentity(identityPath);
  const baseUrl = args["base-url"] ? String(args["base-url"]) : identity.hub;
  const since = args.since ? `?since=${encodeURIComponent(String(args.since))}` : "";
  process.stdout.write(JSON.stringify(await jsonRequest(baseUrl, `/api/agents/${identity.agent_id}/events${since}`, {}, identity), null, 2) + "\n");
} else {
  throw new Error("Usage: node examples/agent-client.mjs <init|register|signal|validate|infrastructure-proof|infrastructure-verify|rotate|recover|resume-transition|doctor|events> --identity <path> [--recovery-identity <offline-path>] [options]");
}
