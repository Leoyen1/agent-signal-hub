import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = await mkdtemp(join(tmpdir(), "ash-outbound-scout-test-"));
let received = 0;
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  response.setHeader("Content-Type", "application/json");
  if (url.pathname === "/api/tasks") {
    return response.end(JSON.stringify({ tasks: [{ task_type: "validate_signal", signal: { id: "signal-1", title: "MCP interoperability" } }] }));
  }
  if (url.pathname === "/agent-card.json") {
    return response.end(JSON.stringify({ name: "Independent MCP Agent", description: "MCP protocol interoperability validator", url: `http://127.0.0.1:${server.address().port}/a2a` }));
  }
  if (url.pathname === "/a2a" && request.method === "POST") {
    received += 1;
    return response.end(JSON.stringify({ jsonrpc: "2.0", result: { accepted: true } }));
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "not found" }));
});

function run(args, env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ["scripts/outbound-scout.mjs", ...args], {
      cwd: resolve("."),
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", rejectRun);
    child.on("close", (code) => code === 0 ? resolveRun({ stdout, stderr }) : rejectRun(new Error(`${code}\n${stdout}\n${stderr}`)));
  });
}

try {
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const port = server.address().port;
  const candidates = join(root, "candidates.json");
  const state = join(root, "state.json");
  const report = join(root, "report.json");
  await writeFile(candidates, JSON.stringify({
    format: "ash-outbound-scout-candidates-v1",
    candidates: [
      { id: "mcp-agent", card_url: `http://127.0.0.1:${port}/agent-card.json`, approved: true, outreach_authorized: true, match_terms: ["mcp"] },
      { id: "unapproved", card_url: `http://127.0.0.1:${port}/agent-card.json`, approved: false, outreach_authorized: false },
    ],
  }), "utf8");
  const common = ["--base-url", `http://127.0.0.1:${port}`, "--candidates", candidates, "--state", state, "--report", report];
  const env = { ASH_SCOUT_ALLOW_HTTP_FOR_TEST: "true" };
  await run(common, env);
  if (received !== 0) throw new Error("discovery mode sent an invitation");
  await run([...common, "--send"], env);
  if (received !== 1) throw new Error(`send mode expected one invitation, received ${received}`);
  const firstReport = JSON.parse(await readFile(report, "utf8"));
  if (firstReport.sent_count !== 1 || firstReport.observations.find((item) => item.id === "unapproved")?.status !== "awaiting_manual_approval") throw new Error("approval boundary was not enforced");
  await run([...common, "--send"], env);
  if (received !== 1) throw new Error("scout repeated an invitation");
  const secondReport = JSON.parse(await readFile(report, "utf8"));
  if (secondReport.observations.find((item) => item.id === "mcp-agent")?.status !== "already_contacted") throw new Error("contact ledger did not suppress duplicate outreach");
  process.stdout.write(JSON.stringify({ status: "ok", discovery_is_read_only: true, approval_required: true, duplicate_outreach_suppressed: true }) + "\n");
} finally {
  await new Promise((resolveClose) => server.close(resolveClose)).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
