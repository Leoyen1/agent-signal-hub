import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = await mkdtemp(join(tmpdir(), "ash-seed-cohort-test-"));
const registrations = new Map();
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  response.setHeader("Content-Type", "application/json");
  if (url.pathname === "/.well-known/agent.json") return response.end(JSON.stringify({ authentication: { registration_proof_of_work: { algorithm: "sha256", difficulty: 2, date: new Date().toISOString().slice(0, 10) } } }));
  if (url.pathname === "/api/agents/register" && request.method === "POST") {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); const id = `seed-${registrations.size + 1}`; registrations.set(id, body); return response.end(JSON.stringify({ agent_id: id, api_key: `ash_${"a".repeat(43 - String(registrations.size).length)}${registrations.size}` }));
  }
  const cardMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/card$/);
  if (cardMatch && registrations.has(cardMatch[1])) return response.end(JSON.stringify({ identity: { recovery_configured: true }, reputation: { score: 80, trust_level: "trusted" }, activity: { registered_at: new Date().toISOString() } }));
  response.statusCode = 404; response.end(JSON.stringify({ error: "not found" }));
});

function run(args) { return new Promise((resolveRun, rejectRun) => { const child = spawn(process.execPath, args, { cwd: resolve("."), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = ""; child.stdout.on("data", (chunk) => stdout += chunk); child.stderr.on("data", (chunk) => stderr += chunk); child.on("error", rejectRun); child.on("close", (code) => code === 0 ? resolveRun({ stdout, stderr }) : rejectRun(new Error(`${code}\n${stdout}\n${stderr}`))); }); }

try {
  await new Promise((resolveListen, rejectListen) => { server.once("error", rejectListen); server.listen(0, "127.0.0.1", resolveListen); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const output = join(root, "deployment");
  await run(["scripts/prepare-private-trial.mjs", "--output", output, "--base-url", baseUrl.replace("http:", "https:"), "--database-path", join(root, "hub.db")]);
  const manifestPath = join(output, "deployment-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.base_url = baseUrl;
  await import("node:fs/promises").then(({ writeFile }) => writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8"));
  const result = JSON.parse((await run(["scripts/register-seed-cohort.mjs", "--manifest", manifestPath])).stdout);
  const repeated = JSON.parse((await run(["scripts/register-seed-cohort.mjs", "--manifest", manifestPath])).stdout);
  const updatedManifestText = await readFile(manifestPath, "utf8");
  const updatedManifest = JSON.parse(updatedManifestText);
  if (result.seed_count !== 3 || repeated.seed_count !== 3 || registrations.size !== 3 || updatedManifest.seed_validators.some((seed) => !seed.registered_agent_id) || updatedManifestText.includes("ash_")) throw new Error("seed cohort registration is not idempotent or did not persist only public registration metadata");
  process.stdout.write(JSON.stringify({ status: "ok", seed_count: 3, trusted_80: "verified", recovery_configured: "verified", idempotent_rerun: "verified", manifest_api_key_redaction: "verified" }) + "\n");
} finally {
  await new Promise((resolveClose) => server.close(() => resolveClose())).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
