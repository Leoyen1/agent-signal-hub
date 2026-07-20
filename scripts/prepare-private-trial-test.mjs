import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = await mkdtemp(join(tmpdir(), "ash-private-trial-prepare-test-"));
const output = join(root, "deployment");
const databasePath = join(root, "persistent", "hub.db");
function run() { return new Promise((resolveRun, rejectRun) => { const child = spawn(process.execPath, ["scripts/prepare-private-trial.mjs", "--output", output, "--base-url", "https://hub.example.test", "--database-path", databasePath], { cwd: resolve("."), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = ""; child.stdout.on("data", (chunk) => stdout += chunk); child.stderr.on("data", (chunk) => stderr += chunk); child.on("error", rejectRun); child.on("close", (code) => code === 0 ? resolveRun({ stdout, stderr }) : rejectRun(Object.assign(new Error(`${code}\n${stdout}\n${stderr}`), { code }))); }); }
try {
  await run();
  const env = await readFile(join(output, ".env.production"), "utf8");
  const manifestText = await readFile(join(output, "deployment-manifest.json"), "utf8");
  const manifest = JSON.parse(manifestText);
  const active = JSON.parse(await readFile(join(output, "seeds", "seed-1-active.json"), "utf8"));
  const recovery = JSON.parse(await readFile(join(output, "seeds", "seed-1-recovery.json"), "utf8"));
  const invites = JSON.parse(await readFile(join(output, "registration-invites.json"), "utf8"));
  const adminToken = JSON.parse(env.match(/^ADMIN_TOKEN=(.+)$/m)?.[1] ?? '""');
  const cookieSecret = JSON.parse(env.match(/^ADMIN_COOKIE_SECRET=(.+)$/m)?.[1] ?? '""');
  let overwriteRejected = false;
  try { await run(); } catch { overwriteRejected = true; }
  if (manifest.seed_validators.length !== 3 || invites.one_time_codes.length !== 12 || manifest.secrets_in_manifest !== false || !adminToken || !cookieSecret || manifestText.includes(adminToken) || manifestText.includes(cookieSecret) || invites.one_time_codes.some((code) => manifestText.includes(code)) || !env.includes("BOOTSTRAP_VALIDATOR_PUBLIC_KEY_FINGERPRINTS=") || !env.includes("REGISTRATION_INVITE_CODE_HASHES=") || active.recovery_private_key || recovery.active_private_key || !recovery.recovery_private_key || !overwriteRejected) throw new Error("private trial deployment package is incomplete, leaks secrets, or permits overwrite");
  process.stdout.write(JSON.stringify({ status: "ok", seed_count: 3, invite_count: 12, secret_env: "verified", manifest_secret_redaction: "verified", invite_secret_redaction: "verified", recovery_separation: "verified", overwrite_protection: "verified" }) + "\n");
} finally { await rm(root, { recursive: true, force: true }); }
