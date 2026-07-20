import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

function normalizeSqliteFileValue(databaseUrl) {
  if (!databaseUrl?.startsWith("file:")) {
    throw new Error("DATABASE_URL must be a Prisma file: SQLite URL.");
  }
  let value = decodeURIComponent(databaseUrl.slice("file:".length).split("?")[0]);
  if (!value || value === ":memory:") throw new Error("SQLite operations require a persistent database file.");
  if (/^\/[A-Za-z]:[\\/]/.test(value)) value = value.slice(1);
  return value;
}

export function resolvePrismaSqlitePath(databaseUrl, repoRoot) {
  const value = normalizeSqliteFileValue(databaseUrl);
  return resolve(isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) ? value : join(repoRoot, "prisma", value));
}

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function inspectSqliteDatabase(path) {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA busy_timeout = 10000");
    const integrityRows = database.prepare("PRAGMA integrity_check").all();
    const integrityCheck = integrityRows.map((row) => row.integrity_check);
    const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row.name);
    const countTables = ["Agent", "Signal", "Validation", "Digest", "AgentInfrastructureClaim", "DomainRelationshipAssertion"];
    const counts = {};
    for (const table of countTables) {
      if (tables.includes(table)) counts[table] = database.prepare('SELECT COUNT(*) AS count FROM "' + table + '"').get().count;
    }
    return {
      integrity_check: integrityCheck,
      foreign_key_violation_count: foreignKeyViolations.length,
      tables,
      counts,
    };
  } finally {
    database.close();
  }
}

function assertHealthyInspection(inspection, label) {
  if (inspection.integrity_check.length !== 1 || inspection.integrity_check[0] !== "ok") {
    throw new Error(label + " failed SQLite integrity_check: " + JSON.stringify(inspection.integrity_check));
  }
  if (inspection.foreign_key_violation_count !== 0) {
    throw new Error(label + " has " + inspection.foreign_key_violation_count + " foreign key violations.");
  }
}

export async function createSqliteBackup({ sourcePath, backupPath }) {
  const source = resolve(sourcePath);
  const backup = resolve(backupPath);
  const manifestPath = backup + ".manifest.json";
  if (source === backup) throw new Error("Backup path must differ from the source database.");
  if (!(await fileExists(source))) throw new Error("Source SQLite database does not exist: " + source);
  if (await fileExists(backup)) throw new Error("Backup target already exists: " + backup);
  if (await fileExists(manifestPath)) throw new Error("Backup manifest already exists: " + manifestPath);
  await mkdir(dirname(backup), { recursive: true });

  const database = new DatabaseSync(source);
  try {
    database.exec("PRAGMA busy_timeout = 10000");
    const escapedBackup = backup.replaceAll("'", "''");
    database.exec("VACUUM INTO '" + escapedBackup + "'");
  } catch (error) {
    await unlink(backup).catch(() => undefined);
    throw error;
  } finally {
    database.close();
  }

  const inspection = inspectSqliteDatabase(backup);
  assertHealthyInspection(inspection, "Backup");
  const sha256 = await sha256File(backup);
  const manifest = {
    format: "agent-signal-hub-sqlite-backup-v1",
    created_at: new Date().toISOString(),
    source_database: source,
    backup_database: backup,
    sha256,
    inspection,
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  return { backup_path: backup, manifest_path: manifestPath, sha256, inspection };
}

export async function restoreSqliteBackup({ backupPath, restorePath }) {
  const backup = resolve(backupPath);
  const restore = resolve(restorePath);
  const manifestPath = backup + ".manifest.json";
  if (backup === restore) throw new Error("Restore target must differ from the backup database.");
  if (!(await fileExists(backup))) throw new Error("Backup SQLite database does not exist: " + backup);
  if (await fileExists(restore)) throw new Error("Restore target already exists: " + restore);

  const backupInspection = inspectSqliteDatabase(backup);
  assertHealthyInspection(backupInspection, "Backup");
  const backupSha256 = await sha256File(backup);
  if (await fileExists(manifestPath)) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.sha256 !== backupSha256) throw new Error("Backup SHA-256 does not match its manifest.");
  }

  await mkdir(dirname(restore), { recursive: true });
  await copyFile(backup, restore, constants.COPYFILE_EXCL);
  try {
    const restoreInspection = inspectSqliteDatabase(restore);
    assertHealthyInspection(restoreInspection, "Restored database");
    const restoreSha256 = await sha256File(restore);
    if (restoreSha256 !== backupSha256) throw new Error("Restored database SHA-256 differs from the verified backup.");
    return {
      backup_path: backup,
      restore_path: restore,
      sha256: restoreSha256,
      inspection: restoreInspection,
    };
  } catch (error) {
    await unlink(restore).catch(() => undefined);
    throw error;
  }
}
