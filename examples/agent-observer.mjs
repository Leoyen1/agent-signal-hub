import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function argumentsMap(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const next = values[index + 1];
    result[value.slice(2)] = next && !next.startsWith("--") ? values[++index] : true;
  }
  return result;
}

function required(args, name) {
  const value = args[name];
  if (!value || value === true) throw new Error(`--${name} is required`);
  return String(value);
}

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

const args = argumentsMap(process.argv.slice(2));
const identityPath = resolve(required(args, "identity"));
const statePath = resolve(required(args, "state"));
const logPath = resolve(required(args, "log"));
const identity = await readJson(identityPath);
if (!identity?.agent_id || !identity?.api_key || !identity?.hub) throw new Error("Registered identity is required");

const state = await readJson(statePath, { cursor: null, successful_cycles: 0, failed_cycles: 0 });
const query = state.cursor ? `?since=${encodeURIComponent(state.cursor)}` : "";
const checkedAt = new Date().toISOString();

await Promise.all([mkdir(dirname(statePath), { recursive: true }), mkdir(dirname(logPath), { recursive: true })]);

try {
  const response = await fetch(new URL(`/api/agents/${identity.agent_id}/events${query}`, identity.hub), {
    headers: { Accept: "application/json", Authorization: `Bearer ${identity.api_key}`, "User-Agent": "ASH-External-Agent-Observer/1" },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || typeof payload?.cursor?.next_since !== "string") throw new Error(`events request returned ${response.status}`);
  const observation = {
    checked_at: checkedAt,
    status: "ok",
    event_count: Array.isArray(payload.events) ? payload.events.length : 0,
    event_types: [...new Set((payload.events ?? []).map((event) => event.type).filter(Boolean))],
    previous_cursor: state.cursor,
    next_cursor: payload.cursor.next_since,
  };
  await appendFile(logPath, JSON.stringify(observation) + "\n", "utf8");
  await writeFile(statePath, JSON.stringify({ cursor: payload.cursor.next_since, successful_cycles: state.successful_cycles + 1, failed_cycles: state.failed_cycles, last_success_at: checkedAt, last_error: null }, null, 2) + "\n", "utf8");
  process.stdout.write(JSON.stringify(observation) + "\n");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const observation = { checked_at: checkedAt, status: "failed", error: message };
  await appendFile(logPath, JSON.stringify(observation) + "\n", "utf8");
  await writeFile(statePath, JSON.stringify({ ...state, failed_cycles: state.failed_cycles + 1, last_error: message, updated_at: checkedAt }, null, 2) + "\n", "utf8");
  process.stderr.write(JSON.stringify(observation) + "\n");
  process.exitCode = 1;
}
