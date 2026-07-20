import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const severityRank = { info: 0, warning: 1, error: 2, critical: 3 };
const logValue = process.env.ASH_OPS_EVENT_LOG_PATH?.trim();
if (!logValue) throw new Error("ASH_OPS_EVENT_LOG_PATH is required.");
const logPath = resolve(logValue);
const minimumSeverity = process.env.ASH_OPS_ALERT_MIN_SEVERITY?.trim() || "error";
if (!(minimumSeverity in severityRank)) throw new Error("ASH_OPS_ALERT_MIN_SEVERITY must be info, warning, error, or critical.");
const windowHours = Number(process.env.ASH_OPS_ALERT_WINDOW_HOURS ?? 24);
if (!Number.isFinite(windowHours) || windowHours <= 0) throw new Error("ASH_OPS_ALERT_WINDOW_HOURS must be positive.");

const raw = await readFile(logPath, "utf8");
const malformedLines = [];
const parsed = [];
for (const [index, line] of raw.split(/\r?\n/).entries()) {
  if (!line.trim()) continue;
  try {
    const event = JSON.parse(line);
    if (event.format !== "agent-signal-hub-ops-event-v1") throw new Error("unsupported format");
    parsed.push(event);
  } catch (error) {
    malformedLines.push({ line: index + 1, error: error instanceof Error ? error.message : String(error) });
  }
}

const cutoff = Date.now() - windowHours * 3_600_000;
const events = parsed.filter((event) => {
  const timestamp = new Date(event.timestamp).getTime();
  return Number.isFinite(timestamp) && timestamp >= cutoff;
});
const countsBySeverity = { info: 0, warning: 0, error: 0, critical: 0 };
const countsByEventType = {};
for (const event of events) {
  if (event.severity in countsBySeverity) countsBySeverity[event.severity] += 1;
  countsByEventType[event.event_type] = (countsByEventType[event.event_type] ?? 0) + 1;
}
const alerts = events.filter((event) => severityRank[event.severity] >= severityRank[minimumSeverity]);
const status = alerts.length || malformedLines.length ? "alert" : "ok";
process.stdout.write(
  JSON.stringify(
    {
      status,
      checked_at: new Date().toISOString(),
      event_log_path: logPath,
      window_hours: windowHours,
      minimum_severity: minimumSeverity,
      event_count: events.length,
      counts_by_severity: countsBySeverity,
      counts_by_event_type: countsByEventType,
      alert_count: alerts.length,
      latest_alerts: alerts.slice(-20).reverse(),
      malformed_lines: malformedLines,
    },
    null,
    2,
  ) + "\n",
);
if (status === "alert") process.exitCode = 2;