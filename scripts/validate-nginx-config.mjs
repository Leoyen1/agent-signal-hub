import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executable = process.env.NGINX_BIN || join(repoRoot, ".tools", "nginx-1.28.0", "nginx.exe");
const sourcePath = join(repoRoot, "deploy", "nginx", "agent-signal-hub.conf");
const temporaryRoot = await mkdtemp(join(tmpdir(), "ash-nginx-test-"));

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: repoRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", rejectRun);
    child.on("close", (code) => code === 0 ? resolveRun({ stdout, stderr }) : rejectRun(new Error(`${command} exited ${code}\n${stdout}\n${stderr}`)));
  });
}

try {
  await Promise.all(["logs", "temp/client_body_temp", "temp/proxy_temp", "temp/fastcgi_temp", "temp/uwsgi_temp", "temp/scgi_temp"].map((path) => mkdir(join(temporaryRoot, path), { recursive: true })));
  const source = await readFile(sourcePath, "utf8");
  const testable = source
    .replace("listen 443 ssl http2;", "listen 18080;")
    .replace(/^\s*ssl_certificate\s+.*;\s*$/m, "")
    .replace(/^\s*ssl_certificate_key\s+.*;\s*$/m, "");
  const configPath = join(temporaryRoot, "nginx.conf");
  await writeFile(configPath, `events {}\nhttp {\n${testable}\n}\n`, "utf8");
  const result = await run(executable, ["-t", "-p", temporaryRoot, "-c", configPath]);
  process.stdout.write(JSON.stringify({ status: "ok", nginx_binary: executable, production_template: sourcePath, tls_paths: "validated_on_deployment_host", parser_output: (result.stderr || result.stdout).trim() }) + "\n");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
