import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type OpsSeverity = "info" | "warning" | "error" | "critical";

type OpsEventInput = {
  severity: OpsSeverity;
  component: string;
  eventType: string;
  outcome: "success" | "rejected" | "failure" | "observed";
  details?: Record<string, unknown>;
};

const SENSITIVE_KEY = /(authorization|cookie|token|secret|api.?key|public.?key|private.?key|signature|nonce)/i;

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (typeof value === "string") return value.length > 512 ? value.slice(0, 512) + "[truncated]" : value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[redacted]" : sanitize(item, depth + 1),
    ]),
  );
}

export async function emitOpsEvent(input: OpsEventInput) {
  const event = {
    format: "agent-signal-hub-ops-event-v1",
    timestamp: new Date().toISOString(),
    severity: input.severity,
    component: input.component,
    event_type: input.eventType,
    outcome: input.outcome,
    details: sanitize(input.details ?? {}),
  };
  const line = JSON.stringify(event);
  if (input.severity === "critical" || input.severity === "error") console.error(line);
  else if (input.severity === "warning") console.warn(line);
  else console.info(line);

  const logPath = process.env.ASH_OPS_EVENT_LOG_PATH?.trim();
  if (logPath) {
    try {
      const absolutePath = resolve(logPath);
      await mkdir(dirname(absolutePath), { recursive: true });
      await appendFile(absolutePath, line + "\n", "utf8");
    } catch (error) {
      console.error(
        JSON.stringify({
          format: "agent-signal-hub-ops-event-v1",
          timestamp: new Date().toISOString(),
          severity: "error",
          component: "ops-events",
          event_type: "ops_event_log_write_failed",
          outcome: "failure",
          details: { error: error instanceof Error ? error.message : String(error) },
        }),
      );
    }
  }
  return event;
}

export function requestOperation(request: Request) {
  return {
    method: request.method,
    path: new URL(request.url).pathname,
  };
}