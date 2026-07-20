import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSqliteBackup, resolvePrismaSqlitePath } from "./lib/sqlite-operations.mjs";
import { emitOpsEvent } from "./lib/ops-events.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

try {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const databaseUrl = process.env.DATABASE_URL;
  const output = option("--output") ?? process.env.ASH_SQLITE_BACKUP_PATH;
  if (!output) throw new Error("Specify --output <path> or ASH_SQLITE_BACKUP_PATH.");
  const result = await createSqliteBackup({
    sourcePath: resolvePrismaSqlitePath(databaseUrl, repoRoot),
    backupPath: resolve(output),
  });
  await emitOpsEvent({
    severity: "info",
    component: "sqlite-backup",
    eventType: "sqlite_backup_completed",
    outcome: "success",
    details: {
      backup_path: result.backup_path,
      manifest_path: result.manifest_path,
      sha256: result.sha256,
      counts: result.inspection.counts,
    },
  });
  process.stdout.write(JSON.stringify({ status: "ok", operation: "sqlite_backup", ...result }, null, 2) + "\n");
} catch (error) {
  await emitOpsEvent({
    severity: "error",
    component: "sqlite-backup",
    eventType: "sqlite_backup_failed",
    outcome: "failure",
    details: { error: error instanceof Error ? error.message : String(error) },
  });
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
}