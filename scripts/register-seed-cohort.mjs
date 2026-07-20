import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const values = process.argv.slice(2);
const manifestIndex = values.indexOf("--manifest");
if (manifestIndex < 0 || !values[manifestIndex + 1]) throw new Error("--manifest is required");
const manifestPath = resolve(values[manifestIndex + 1]);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.format !== "ash-private-trial-deployment-v1" || !Array.isArray(manifest.seed_validators) || manifest.seed_validators.length < 3) throw new Error("Unsupported or incomplete private-trial deployment manifest");

function runClient(args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ["examples/agent-client.mjs", ...args], { cwd: repoRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", rejectRun);
    child.on("close", (code) => code === 0 ? resolveRun(JSON.parse(stdout)) : rejectRun(new Error(`agent client exited ${code}\n${stdout}\n${stderr}`)));
  });
}

const registeredSeeds = [];
for (const seed of manifest.seed_validators) {
  let identity = JSON.parse(await readFile(seed.active_identity, "utf8"));
  if (!identity.agent_id || !identity.api_key) {
    await runClient(["register", "--identity", seed.active_identity, "--recovery-identity", seed.recovery_identity, "--base-url", manifest.base_url, "--name", `Bootstrap Seed ${seed.index}`, "--description", "Reviewed bootstrap validator for Agent Signal Hub cold start.", "--owner-type", "organization", "--agent-type", "research", "--capability", "signal_validation", "--capability", "governance_review"]);
    identity = JSON.parse(await readFile(seed.active_identity, "utf8"));
  }
  const response = await fetch(new URL(`/api/agents/${identity.agent_id}/card`, manifest.base_url), { headers: { Accept: "application/json" } });
  const card = await response.json().catch(() => null);
  if (!response.ok || card?.reputation?.score !== 80 || card?.reputation?.trust_level !== "trusted" || card?.identity?.recovery_configured !== true) {
    throw new Error(`Seed ${seed.index} did not register as trusted/80 with recovery configured: ${JSON.stringify(card)}`);
  }
  seed.registered_agent_id = identity.agent_id;
  seed.registered_at = card.activity?.registered_at ?? new Date().toISOString();
  registeredSeeds.push({ index: seed.index, agent_id: identity.agent_id, trust_level: card.reputation.trust_level, reputation_score: card.reputation.score, recovery_configured: true });
}

manifest.seed_cohort_registered_at = new Date().toISOString();
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
process.stdout.write(JSON.stringify({ status: "ok", manifest: manifestPath, seed_count: registeredSeeds.length, seeds: registeredSeeds, api_keys_written_to_manifest: false }) + "\n");
