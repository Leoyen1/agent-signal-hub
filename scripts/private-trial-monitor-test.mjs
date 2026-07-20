import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temporaryRoot = await mkdtemp(join(tmpdir(), "ash-private-trial-test-"));
const server = createServer((request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  const bodies = {
    "/api/health": { status: "ok", counts: { agents: 3, active_signals: 1 } },
    "/.well-known/agent.json": { protocol_layers: { core_stable: ["signals", "digest"] } },
    "/api/openapi.json": { paths: { "/api/signals": {}, "/api/signals/{id}/validate": {}, "/api/digests/latest": {} } },
    "/api/schemas": { schemas: { signal_create: {}, validation_create: {} } },
    "/api/digests/latest": { digest: { generatedAt: new Date().toISOString(), signals: [{ id: "signal-1" }] } },
    "/api/events": { events: [{ id: "event-1" }], cursor: { since: new Date(0).toISOString(), next_since: new Date().toISOString() } },
  };
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(bodies[path] ?? { error: "not found" }));
});

function run(command, args, env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: resolve("."), env: { ...process.env, ...env }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", rejectRun);
    child.on("close", (code) => code === 0 ? resolveRun({ stdout, stderr }) : rejectRun(new Error(`${command} exited ${code}\n${stdout}\n${stderr}`)));
  });
}

try {
  await new Promise((resolveListen, rejectListen) => { server.once("error", rejectListen); server.listen(0, "127.0.0.1", resolveListen); });
  const port = server.address().port;
  const statePath = join(temporaryRoot, "state.json");
  const logPath = join(temporaryRoot, "observations.jsonl");
  const result = await run(process.execPath, ["scripts/private-trial-monitor.mjs"], { ASH_TRIAL_BASE_URL: `http://127.0.0.1:${port}`, ASH_TRIAL_ONCE: "true", ASH_TRIAL_STATE_PATH: statePath, ASH_TRIAL_LOG_PATH: logPath });
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const observations = (await readFile(logPath, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  if (state.successful_cycles !== 1 || !state.event_cursor || observations[0]?.status !== "ok") throw new Error(`private trial monitor did not persist successful state: ${result.stdout}`);
  process.stdout.write(JSON.stringify({ status: "ok", successful_cycles: state.successful_cycles, event_cursor_persisted: true, observation_log: "verified" }) + "\n");
} finally {
  await new Promise((resolveClose) => server.close(() => resolveClose())).catch(() => undefined);
  await rm(temporaryRoot, { recursive: true, force: true });
}
