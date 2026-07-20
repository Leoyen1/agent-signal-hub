import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executable = process.env.NGINX_BIN || join(repoRoot, ".tools", "nginx-1.28.0", "nginx.exe");
const sourcePath = join(repoRoot, "deploy", "nginx", "agent-signal-hub.conf");
const temporaryRoot = await mkdtemp(join(tmpdir(), "ash-nginx-edge-"));

function listen(server) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen(server.address().port));
  });
}

function close(server) {
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

async function waitForEdge(url) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("temporary Nginx edge did not become ready");
}

async function burst(url, count, init) {
  return Promise.all(Array.from({ length: count }, () => fetch(url, init)));
}

const upstream = createServer((request, response) => {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ method: request.method, path: request.url, forwarded_for: request.headers["x-forwarded-for"] ?? null }));
});

let nginx;
try {
  const upstreamPort = await listen(upstream);
  const portProbe = createServer();
  const edgePort = await listen(portProbe);
  await close(portProbe);
  await Promise.all(["logs", "temp/client_body_temp", "temp/proxy_temp", "temp/fastcgi_temp", "temp/uwsgi_temp", "temp/scgi_temp"].map((path) => mkdir(join(temporaryRoot, path), { recursive: true })));

  const source = await readFile(sourcePath, "utf8");
  const testable = source
    .replace("listen 443 ssl http2;", `listen ${edgePort};`)
    .replace("127.0.0.1:3000", `127.0.0.1:${upstreamPort}`)
    .replace(/^\s*ssl_certificate\s+.*;\s*$/m, "")
    .replace(/^\s*ssl_certificate_key\s+.*;\s*$/m, "");
  const configPath = join(temporaryRoot, "nginx.conf");
  await writeFile(configPath, `daemon off;\nmaster_process off;\nevents {}\nhttp {\n${testable}\n}\n`, "utf8");

  nginx = spawn(executable, ["-p", temporaryRoot, "-c", configPath], { cwd: repoRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let nginxError = "";
  nginx.stderr.on("data", (chunk) => (nginxError += chunk));
  nginx.once("exit", (code) => { if (code && !nginx.killed) process.stderr.write(nginxError); });

  const baseUrl = `http://127.0.0.1:${edgePort}`;
  await waitForEdge(baseUrl + "/api/health");

  const forwarded = await fetch(baseUrl + "/api/echo", { headers: { "X-Forwarded-For": "198.51.100.10, 203.0.113.20" } });
  const forwardedBody = await forwarded.json();
  if (forwardedBody.forwarded_for !== "127.0.0.1") throw new Error(`Nginx did not replace the untrusted forwarding chain: ${JSON.stringify(forwardedBody)}`);

  const registrationResponses = await burst(baseUrl + "/api/agents/register", 8, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const writeResponses = await burst(baseUrl + "/api/test-write", 60, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const readResponses = await burst(baseUrl + "/api/test-read", 140);
  for (const [name, responses] of [["registration", registrationResponses], ["write", writeResponses], ["read", readResponses]]) {
    const limited = responses.filter((response) => response.status === 429);
    if (!limited.length) throw new Error(`${name} burst was not rate limited by Nginx`);
    if (!limited.some((response) => response.headers.get("retry-after") === "60")) throw new Error(`${name} edge limit did not expose Retry-After`);
  }

  process.stdout.write(JSON.stringify({ status: "ok", forwarded_chain_replacement: forwardedBody.forwarded_for, registration_429: registrationResponses.filter((response) => response.status === 429).length, write_429: writeResponses.filter((response) => response.status === 429).length, read_429: readResponses.filter((response) => response.status === 429).length }) + "\n");
} finally {
  if (nginx && !nginx.killed) nginx.kill("SIGKILL");
  await close(upstream).catch(() => undefined);
  await rm(temporaryRoot, { recursive: true, force: true });
}
