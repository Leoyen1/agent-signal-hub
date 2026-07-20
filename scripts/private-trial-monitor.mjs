import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function numberSetting(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

const baseUrl = new URL(process.env.ASH_TRIAL_BASE_URL ?? "");
if (baseUrl.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(baseUrl.hostname)) {
  throw new Error("ASH_TRIAL_BASE_URL must use HTTPS except for localhost tests");
}
const once = process.env.ASH_TRIAL_ONCE === "true";
const durationHours = numberSetting("ASH_TRIAL_DURATION_HOURS", 72, 1, 168);
const intervalSeconds = numberSetting("ASH_TRIAL_INTERVAL_SECONDS", 300, 30, 3600);
const timeoutMs = numberSetting("ASH_TRIAL_TIMEOUT_MS", 10_000, 1000, 60_000);
const maximumLatencyMs = numberSetting("ASH_TRIAL_MAX_LATENCY_MS", 5000, 100, 60_000);
const statePath = resolve(process.env.ASH_TRIAL_STATE_PATH ?? "private-trial-state.json");
const logPath = resolve(process.env.ASH_TRIAL_LOG_PATH ?? "private-trial-observations.jsonl");

async function readState() {
  try { return JSON.parse(await readFile(statePath, "utf8")); } catch (error) { if (error?.code === "ENOENT") return { started_at: new Date().toISOString(), event_cursor: null, successful_cycles: 0, failed_cycles: 0, consecutive_failures: 0 }; throw error; }
}

async function requestJson(path) {
  const started = Date.now();
  const response = await fetch(new URL(path, baseUrl), { headers: { Accept: "application/json", "User-Agent": "Agent-Signal-Hub-Private-Trial-Monitor/1" }, signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return { body, latency_ms: Date.now() - started };
}

async function probe(state) {
  const eventPath = `/api/events?limit=100${state.event_cursor ? `&since=${encodeURIComponent(state.event_cursor)}` : ""}`;
  const [health, discovery, openapi, schemas, digest, events] = await Promise.all([
    requestJson("/api/health"),
    requestJson("/.well-known/agent.json"),
    requestJson("/api/openapi.json"),
    requestJson("/api/schemas"),
    requestJson("/api/digests/latest"),
    requestJson(eventPath),
  ]);
  const checks = {
    health_ok: health.body?.status === "ok",
    discovery_core_stable: discovery.body?.protocol_layers?.core_stable?.includes("signals") && discovery.body?.protocol_layers?.core_stable?.includes("digest"),
    openapi_core_paths: Boolean(openapi.body?.paths?.["/api/signals"] && openapi.body?.paths?.["/api/signals/{id}/validate"] && openapi.body?.paths?.["/api/digests/latest"]),
    schemas_present: Boolean(schemas.body?.schemas?.signal_create && schemas.body?.schemas?.validation_create),
    digest_present: Boolean(digest.body?.digest?.generatedAt || digest.body?.digest?.generated_at),
    events_cursor_present: typeof events.body?.cursor?.next_since === "string",
  };
  const latencies = { health: health.latency_ms, discovery: discovery.latency_ms, openapi: openapi.latency_ms, schemas: schemas.latency_ms, digest: digest.latency_ms, events: events.latency_ms };
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  const slowEndpoints = Object.entries(latencies).filter(([, latency]) => latency > maximumLatencyMs).map(([name]) => name);
  if (failedChecks.length || slowEndpoints.length) throw new Error(`probe failed: checks=${failedChecks.join(",") || "none"}; slow=${slowEndpoints.join(",") || "none"}`);
  return { checked_at: new Date().toISOString(), status: "ok", checks, latencies_ms: latencies, event_count: events.body.events?.length ?? 0, next_event_cursor: events.body.cursor.next_since, digest_signal_count: digest.body.digest?.signals?.length ?? 0, node_counts: health.body.counts ?? null };
}

await Promise.all([mkdir(dirname(statePath), { recursive: true }), mkdir(dirname(logPath), { recursive: true })]);
let state = await readState();
const deadline = new Date(state.started_at).getTime() + durationHours * 60 * 60_000;

do {
  let observation;
  try {
    observation = await probe(state);
    state = { ...state, event_cursor: observation.next_event_cursor, successful_cycles: state.successful_cycles + 1, consecutive_failures: 0, last_success_at: observation.checked_at, last_error: null };
  } catch (error) {
    observation = { checked_at: new Date().toISOString(), status: "failed", error: error instanceof Error ? error.message : String(error) };
    state = { ...state, failed_cycles: state.failed_cycles + 1, consecutive_failures: state.consecutive_failures + 1, last_failure_at: observation.checked_at, last_error: observation.error };
  }
  state.updated_at = observation.checked_at;
  await appendFile(logPath, JSON.stringify(observation) + "\n", "utf8");
  await writeFile(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
  process.stdout.write(JSON.stringify({ observation, state }) + "\n");
  if (once) {
    if (observation.status !== "ok") process.exitCode = 1;
    break;
  }
  if (Date.now() >= deadline) break;
  await new Promise((resolveWait) => setTimeout(resolveWait, intervalSeconds * 1000));
} while (true);
