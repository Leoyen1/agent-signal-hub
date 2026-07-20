import { open, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { emitOpsEvent } from "./lib/ops-events.mjs";

function positiveInteger(value, fallback, name) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number <= 0) throw new Error(name + " must be a positive integer.");
  return number;
}

function maintenanceUrl() {
  const raw = process.env.ASH_MAINTENANCE_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL;
  if (!raw) throw new Error("ASH_MAINTENANCE_BASE_URL or NEXT_PUBLIC_APP_URL is required.");
  const base = new URL(raw);
  const localHttp =
    base.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1"].includes(base.hostname.replace(/^\[|\]$/g, ""));
  if (base.protocol !== "https:" && !localHttp) {
    throw new Error("Maintenance worker requires HTTPS or loopback HTTP.");
  }
  return new URL("/api/admin/maintenance/run", base);
}

const once = process.argv.includes("--once");
const adminToken = process.env.ADMIN_TOKEN?.trim();
if (!adminToken) throw new Error("ADMIN_TOKEN is required.");
const endpoint = maintenanceUrl();
const heartbeatValue = process.env.ASH_MAINTENANCE_HEARTBEAT_PATH?.trim();
if (!heartbeatValue) throw new Error("ASH_MAINTENANCE_HEARTBEAT_PATH is required.");
const heartbeatPath = resolve(heartbeatValue);
const lockPath = resolve(process.env.ASH_MAINTENANCE_LOCK_PATH?.trim() || heartbeatPath + ".lock");
const intervalMinutes = positiveInteger(process.env.DIGEST_SNAPSHOT_INTERVAL_MINUTES, 60, "DIGEST_SNAPSHOT_INTERVAL_MINUTES");
const retryAttempts = positiveInteger(process.env.ASH_MAINTENANCE_RETRY_ATTEMPTS, 4, "ASH_MAINTENANCE_RETRY_ATTEMPTS");
const retryBaseMs = positiveInteger(process.env.ASH_MAINTENANCE_RETRY_BASE_MS, 1000, "ASH_MAINTENANCE_RETRY_BASE_MS");
const requestTimeoutMs = positiveInteger(process.env.ASH_MAINTENANCE_REQUEST_TIMEOUT_MS, 15000, "ASH_MAINTENANCE_REQUEST_TIMEOUT_MS");
const startedAt = new Date().toISOString();
let stopping = false;
let lockHandle;
let ownsLock = false;
let heartbeat = {
  format: "agent-signal-hub-digest-maintenance-v1",
  worker_started_at: startedAt,
  worker_pid: process.pid,
  status: "starting",
  endpoint_origin: endpoint.origin,
  interval_minutes: intervalMinutes,
  last_attempt_at: null,
  last_success_at: null,
  last_digest_id: null,
  last_infrastructure_refresh: null,
  last_http_status: null,
  consecutive_failures: 0,
  last_error: null,
  next_run_at: null,
};

function sleep(milliseconds) {
  return new Promise((resolveSleep) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearInterval(poll);
      resolveSleep();
    };
    const timeout = setTimeout(finish, milliseconds);
    const poll = setInterval(() => {
      if (stopping) finish();
    }, Math.min(milliseconds, 250));
  });
}

async function writeHeartbeat() {
  await mkdir(dirname(heartbeatPath), { recursive: true });
  const temporaryPath = heartbeatPath + "." + process.pid + ".tmp";
  await writeFile(temporaryPath, JSON.stringify(heartbeat, null, 2) + "\n", "utf8");
  await rename(temporaryPath, heartbeatPath);
}

async function acquireLock() {
  await mkdir(dirname(lockPath), { recursive: true });
  try {
    lockHandle = await open(lockPath, "wx");
    ownsLock = true;
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error("Digest maintenance lock already exists: " + lockPath);
    }
    throw error;
  }
  await emitOpsEvent({
    severity: "info",
    component: "digest-maintenance-worker",
    eventType: "maintenance_lock_acquired",
    outcome: "success",
    details: { lock_path: lockPath, heartbeat_path: heartbeatPath, worker_pid: process.pid },
  });
  await lockHandle.writeFile(
    JSON.stringify(
      {
        format: "agent-signal-hub-digest-maintenance-lock-v1",
        pid: process.pid,
        started_at: startedAt,
        heartbeat_path: heartbeatPath,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

async function releaseLock() {
  if (!ownsLock) return;
  if (lockHandle) {
    await lockHandle.close().catch(() => undefined);
    lockHandle = undefined;
  }
  await rm(lockPath, { force: true }).catch(() => undefined);
  ownsLock = false;
}

async function persistWithRetry() {
  let lastError;
  for (let attempt = 1; attempt <= retryAttempts && !stopping; attempt += 1) {
    heartbeat = {
      ...heartbeat,
      status: "running",
      last_attempt_at: new Date().toISOString(),
      next_run_at: null,
    };
    await writeHeartbeat();
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + adminToken,
          Accept: "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error("maintenance endpoint returned " + response.status + ": " + JSON.stringify(body));
      }
      if (!body.digest?.id) throw new Error("maintenance endpoint response did not include digest.id");
      if (!body.infrastructure_refresh || !Number.isInteger(body.infrastructure_refresh.processed)) {
        throw new Error("maintenance endpoint response did not include infrastructure_refresh summary");
      }
      heartbeat = {
        ...heartbeat,
        status: "healthy",
        last_success_at: new Date().toISOString(),
        last_digest_id: body.digest.id,
        last_infrastructure_refresh: {
          processed: body.infrastructure_refresh.processed,
          refreshed: body.infrastructure_refresh.refreshed,
          deferred: body.infrastructure_refresh.deferred,
          failed: body.infrastructure_refresh.failed,
        },
        last_http_status: response.status,
        consecutive_failures: 0,
        last_error: null,
      };
      await writeHeartbeat();
      await emitOpsEvent({
        severity: "info",
        component: "digest-maintenance-worker",
        eventType: "digest_maintenance_succeeded",
        outcome: "success",
        details: {
          digest_id: body.digest.id,
          created: body.digest.created,
          attempt,
          http_status: response.status,
          infrastructure_refresh: heartbeat.last_infrastructure_refresh,
        },
      });      process.stdout.write(
        JSON.stringify({
          status: "ok",
          operation: "digest_maintenance",
          attempt,
          created: body.digest.created,
          digest_id: body.digest.id,
          infrastructure_refresh: heartbeat.last_infrastructure_refresh,
          heartbeat_path: heartbeatPath,
        }) + "\n",
      );
      return body;
    } catch (error) {
      lastError = error;
      heartbeat = {
        ...heartbeat,
        status: "degraded",
        last_http_status: null,
        consecutive_failures: heartbeat.consecutive_failures + 1,
        last_error: error instanceof Error ? error.message : String(error),
      };
      await writeHeartbeat();
      await emitOpsEvent({
        severity: attempt < retryAttempts ? "warning" : "error",
        component: "digest-maintenance-worker",
        eventType: "digest_maintenance_attempt_failed",
        outcome: "failure",
        details: { attempt, retry_attempts: retryAttempts, error: heartbeat.last_error },
      });      if (attempt < retryAttempts && !stopping) {
        await sleep(Math.min(retryBaseMs * 2 ** (attempt - 1), 30000));
      }
    }
  }
  throw lastError ?? new Error("Digest maintenance stopped before a successful attempt.");
}

function requestStop() {
  stopping = true;
}

process.once("SIGINT", requestStop);
process.once("SIGTERM", requestStop);

try {
  await acquireLock();
  await writeHeartbeat();
  do {
    await persistWithRetry();
    if (once || stopping) break;
    const nextRun = new Date(Date.now() + intervalMinutes * 60_000);
    heartbeat = { ...heartbeat, next_run_at: nextRun.toISOString() };
    await writeHeartbeat();
    await sleep(intervalMinutes * 60_000);
  } while (!stopping);
  heartbeat = { ...heartbeat, status: stopping ? "stopped" : "healthy", next_run_at: null };
  await writeHeartbeat();
} catch (error) {
  heartbeat = {
    ...heartbeat,
    status: "failed",
    last_error: error instanceof Error ? error.message : String(error),
    next_run_at: null,
  };
  if (lockHandle) await writeHeartbeat().catch(() => undefined);
  await emitOpsEvent({
    severity: heartbeat.last_error?.startsWith("Digest maintenance lock already exists") ? "warning" : "critical",
    component: "digest-maintenance-worker",
    eventType: heartbeat.last_error?.startsWith("Digest maintenance lock already exists") ? "maintenance_lock_conflict" : "digest_maintenance_worker_failed",
    outcome: "failure",
    details: { error: heartbeat.last_error, lock_path: lockPath },
  }).catch(() => undefined);  process.stderr.write(heartbeat.last_error + "\n");
  process.exitCode = 1;
} finally {
  await releaseLock();
}
