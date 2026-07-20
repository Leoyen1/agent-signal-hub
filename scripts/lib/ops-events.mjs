import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const SENSITIVE_KEY = /(authorization|cookie|token|secret|api.?key|public.?key|private.?key|signature|nonce)/i;

function sanitize(value, depth = 0) {
  if (depth > 4) return "[truncated]";
  if (typeof value === "string") return value.length > 512 ? value.slice(0, 512) + "[truncated]" : value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[redacted]" : sanitize(item, depth + 1),
    ]),
  );
}

export async function emitOpsEvent({ severity, component, eventType, outcome, details = {} }) {
  const event = {
    format: "agent-signal-hub-ops-event-v1",
    timestamp: new Date().toISOString(),
    severity,
    component,
    event_type: eventType,
    outcome,
    details: sanitize(details),
  };
  const logPath = process.env.ASH_OPS_EVENT_LOG_PATH?.trim();
  if (logPath) {
    const absolutePath = resolve(logPath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await appendFile(absolutePath, JSON.stringify(event) + "\n", "utf8");
  }
  return event;
}