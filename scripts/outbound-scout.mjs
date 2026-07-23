import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";

function argsMap(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = values[index + 1];
    result[key] = next && !next.startsWith("--") ? values[++index] : true;
  }
  return result;
}

function required(value, name) {
  if (!value || value === true) throw new Error(`--${name} is required`);
  return String(value);
}

function blockedAddress(address) {
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized === "::1" || normalized === "::" || /^(fc|fd|fe[89ab])/.test(normalized)) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = mapped ?? (isIP(normalized) === 4 ? normalized : null);
  if (!ipv4) return false;
  const [a, b] = ipv4.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168))
    || (a === 198 && (b === 18 || b === 19));
}

async function approvedAddress(url) {
  const allowLocal = process.env.ASH_SCOUT_ALLOW_HTTP_FOR_TEST === "true"
    && ["127.0.0.1", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !(allowLocal && url.protocol === "http:")) {
    throw new Error(`${url} must use HTTPS`);
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((item) => blockedAddress(item.address) && !allowLocal)) {
    throw new Error(`${url.hostname} does not resolve exclusively to public addresses`);
  }
  return addresses[0];
}

async function requestJson(urlValue, { method = "GET", body } = {}) {
  const url = new URL(urlValue);
  const address = await approvedAddress(url);
  const payload = body === undefined ? null : JSON.stringify(body);
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolveRequest, rejectRequest) => {
    const request = transport.request(url, {
      method,
      headers: {
        Accept: "application/json",
        "User-Agent": "Agent-Signal-Hub-Outbound-Scout/1",
        ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
      },
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      servername: url.hostname,
      timeout: 10_000,
    }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 1_000_000) request.destroy(new Error("response exceeded 1 MB"));
      });
      response.on("end", () => {
        if (response.statusCode >= 300 && response.statusCode < 400) {
          return rejectRequest(new Error(`${url} returned a redirect; redirects are not followed`));
        }
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch {
          return rejectRequest(new Error(`${url} returned non-JSON content`));
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          return rejectRequest(new Error(`${method} ${url} returned ${response.statusCode}`));
        }
        resolveRequest(parsed);
      });
    });
    request.on("timeout", () => request.destroy(new Error(`${url} timed out`)));
    request.on("error", rejectRequest);
    if (payload) request.write(payload);
    request.end();
  });
}

function strings(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => strings(item, output));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => strings(item, output));
  return output;
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

const args = argsMap(process.argv.slice(2));
const baseUrl = new URL(required(args["base-url"] ?? process.env.ASH_SCOUT_BASE_URL, "base-url"));
const candidatePath = resolve(required(args.candidates ?? process.env.ASH_SCOUT_CANDIDATES_PATH, "candidates"));
const statePath = resolve(String(args.state ?? process.env.ASH_SCOUT_STATE_PATH ?? "outbound-scout-state.json"));
const reportPath = resolve(String(args.report ?? process.env.ASH_SCOUT_REPORT_PATH ?? "outbound-scout-report.json"));
const send = args.send === true;
const maximumSends = Math.max(1, Math.min(10, Number(args["max-sends"] ?? 3)));
const candidateDocument = await readJson(candidatePath);
if (candidateDocument?.format !== "ash-outbound-scout-candidates-v1" || !Array.isArray(candidateDocument.candidates)) {
  throw new Error("candidate file must use ash-outbound-scout-candidates-v1");
}
const state = await readJson(statePath, { format: "ash-outbound-scout-state-v1", contacts: {} });
const taskDocument = await requestJson(new URL("/api/tasks", baseUrl));
const tasks = Array.isArray(taskDocument?.tasks) ? taskDocument.tasks : [];
const observations = [];
let sentCount = 0;

for (const candidate of candidateDocument.candidates.slice(0, 100)) {
  const observation = {
    id: String(candidate.id ?? candidate.card_url ?? "unknown"),
    card_url: candidate.card_url,
    approved: candidate.approved === true,
    outreach_authorized: candidate.outreach_authorized === true,
  };
  try {
    const card = await requestJson(required(candidate.card_url, "candidate.card_url"));
    const endpoint = candidate.a2a_url ?? card.url ?? card.endpoint ?? card.serviceEndpoint;
    const terms = (candidate.match_terms ?? []).map((term) => String(term).toLowerCase()).filter(Boolean);
    const matchedTasks = tasks.filter((task) => {
      if (!terms.length) return true;
      const haystack = strings({ task, card }).join(" ").toLowerCase();
      return terms.some((term) => haystack.includes(term));
    }).slice(0, 3);
    Object.assign(observation, {
      agent_name: card.name ?? null,
      a2a_url: endpoint ?? null,
      matched_task_count: matchedTasks.length,
      previously_contacted: Boolean(state.contacts[observation.id]),
    });
    if (!send) observation.status = "candidate_reported";
    else if (!candidate.approved || !candidate.outreach_authorized) observation.status = "awaiting_manual_approval";
    else if (!endpoint) observation.status = "no_public_a2a_endpoint";
    else if (!matchedTasks.length) observation.status = "no_matching_tasks";
    else if (observation.previously_contacted) observation.status = "already_contacted";
    else if (sentCount >= maximumSends) observation.status = "run_send_limit_reached";
    else {
      const messageId = randomUUID();
      const invitation = {
        jsonrpc: "2.0",
        id: messageId,
        method: "message/send",
        params: {
          message: {
            messageId,
            role: "user",
            parts: [{
              kind: "text",
              text: `Agent Signal Hub requests independent review of ${matchedTasks.length} public evidence tasks. Inspect ${new URL("/api/tasks", baseUrl)} and ${new URL("/.well-known/agent.json", baseUrl)}. Initial technical responses do not require registration. No invitation code or credential is included.`,
            }],
            metadata: {
              protocol: "agent-signal-hub-outreach-v1",
              hub: baseUrl.origin,
              tasks_url: new URL("/api/tasks", baseUrl).toString(),
            },
          },
        },
      };
      const response = await requestJson(endpoint, { method: "POST", body: invitation });
      state.contacts[observation.id] = {
        contacted_at: new Date().toISOString(),
        card_url: candidate.card_url,
        a2a_url: endpoint,
        message_id: messageId,
        response_received: response !== null,
      };
      observation.status = "invitation_sent";
      observation.message_id = messageId;
      sentCount += 1;
    }
  } catch (error) {
    observation.status = "failed";
    observation.error = error instanceof Error ? error.message : String(error);
  }
  observations.push(observation);
}

const report = {
  format: "ash-outbound-scout-report-v1",
  generated_at: new Date().toISOString(),
  mode: send ? "send" : "discover",
  hub: baseUrl.origin,
  task_count: tasks.length,
  candidate_count: observations.length,
  sent_count: sentCount,
  observations,
};
await Promise.all([mkdir(dirname(statePath), { recursive: true }), mkdir(dirname(reportPath), { recursive: true })]);
await Promise.all([
  writeFile(statePath, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 }),
  writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8"),
]);
process.stdout.write(JSON.stringify({
  status: "ok",
  mode: report.mode,
  task_count: report.task_count,
  candidate_count: report.candidate_count,
  sent_count: report.sent_count,
  report: reportPath,
  state: statePath,
}) + "\n");
