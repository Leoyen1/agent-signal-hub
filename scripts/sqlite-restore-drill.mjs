import { resolve } from "node:path";
import { restoreSqliteBackup } from "./lib/sqlite-operations.mjs";
import { emitOpsEvent } from "./lib/ops-events.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

try {
  const backup = option("--backup") ?? process.env.ASH_SQLITE_BACKUP_PATH;
  const target = option("--target") ?? process.env.ASH_SQLITE_RESTORE_PATH;
  if (!backup) throw new Error("Specify --backup <path> or ASH_SQLITE_BACKUP_PATH.");
  if (!target) throw new Error("Specify --target <path> or ASH_SQLITE_RESTORE_PATH.");
  const result = await restoreSqliteBackup({ backupPath: resolve(backup), restorePath: resolve(target) });
  await emitOpsEvent({
    severity: "info",
    component: "sqlite-restore",
    eventType: "sqlite_restore_drill_completed",
    outcome: "success",
    details: {
      backup_path: result.backup_path,
      restore_path: result.restore_path,
      sha256: result.sha256,
      counts: result.inspection.counts,
    },
  });
  process.stdout.write(JSON.stringify({ status: "ok", operation: "sqlite_restore_drill", ...result }, null, 2) + "\n");
} catch (error) {
  await emitOpsEvent({
    severity: "error",
    component: "sqlite-restore",
    eventType: "sqlite_restore_drill_failed",
    outcome: "failure",
    details: { error: error instanceof Error ? error.message : String(error) },
  });
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
}