import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(repoRoot, "dist");
const output = join(dist, "agent-signal-hub-alinux.tar.gz");
const checksumPath = output + ".sha256";
await mkdir(dist, { recursive: true });
await rm(output, { force: true });
await rm(checksumPath, { force: true });
const excludes = [".git", ".agents", ".codex", "node_modules", ".next", ".env", ".env.local", ".tools", ".private-trial", "dist", "tsconfig.tsbuildinfo", "prisma/dev.db", "prisma/dev.db-journal", "*.log"];
await new Promise((resolveRun, rejectRun) => {
  const args = ["-czf", output, ...excludes.flatMap((value) => ["--exclude", value]), "."];
  const child = spawn("tar", args, { cwd: repoRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.on("error", rejectRun);
  child.on("close", (code) => code === 0 ? resolveRun() : rejectRun(new Error(`tar exited ${code}\n${stderr}`)));
});
const checksum = createHash("sha256").update(await readFile(output)).digest("hex");
await writeFile(checksumPath, `${checksum}  agent-signal-hub-alinux.tar.gz\n`, "utf8");
process.stdout.write(JSON.stringify({ status: "ok", bundle: output, checksum, checksum_file: checksumPath, install_command: "bash deploy/alinux/install.sh", excluded: excludes }) + "\n");
