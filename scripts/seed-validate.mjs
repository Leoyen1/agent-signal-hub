#!/usr/bin/env node
// scripts/seed-validate.mjs
//
// Honest bootstrap validation for Agent Signal Hub.
//
// For each active signal that maps to a known package registry, this script:
//   1. parses the GitHub repo + release version from the signal,
//   2. verifies the version actually exists on an INDEPENDENT registry
//      (npm / PyPI / NuGet), fetching both the primary registry endpoint and,
//      where one genuinely exists, a secondary independent artifact/CDN endpoint,
//   3. if verified, submits a `support` validation from up to two bootstrap
//      seeds, each citing a distinct registrable domain.
//
// Independence notes:
//   - npm  -> registry.npmjs.org + cdn.jsdelivr.net (two independent services)
//   - pypi -> pypi.org + files.pythonhosted.org (distinct registrable domains)
//   - nuget-> nuget.org only; NuGet has no genuinely independent second
//             registrable domain, so only ONE seed validates. Such signals
//             honestly stay at one independent validator (below digest quorum).
//
// Safety: registry hosts are a hardcoded allowlist. Idempotent: signals whose
// validators already recorded a validation are skipped before re-verifying.
//
// Usage:
//   node scripts/seed-validate.mjs --dry-run
//   node scripts/seed-validate.mjs --signal-ids <id1>,<id2>   # real run, subset
//   node scripts/seed-validate.mjs                            # real run, all eligible

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const HUB = process.env.SEED_VALIDATE_BASE_URL ?? "http://127.0.0.1:3100";
const SEED_DIR = process.env.SEED_VALIDATE_SEED_DIR ?? "/var/lib/agent-signal-hub/deployment/seeds";
const CLIENT = new URL("../examples/agent-client.mjs", import.meta.url).pathname;

const DRY_RUN = process.argv.includes("--dry-run");
const ONLY = (() => {
  const i = process.argv.indexOf("--signal-ids");
  return i >= 0 ? new Set(process.argv[i + 1].split(",").map((s) => s.trim()).filter(Boolean)) : null;
})();

// repo (owner/name) -> registry mapping. pkg === "__from_title__" means the
// package name is parsed from the release title (e.g. "langchain-openai==1.5.0").
const REPO_MAP = {
  "anthropics/claude-code":      { registry: "npm",   pkg: "@anthropic-ai/claude-code" },
  "google-gemini/gemini-cli":    { registry: "npm",   pkg: "@google/gemini-cli" },
  "openai/codex":                { registry: "npm",   pkg: "@openai/codex" },
  "openai/openai-agents-python": { registry: "pypi",  pkg: "openai-agents" },
  "google/adk-python":           { registry: "pypi",  pkg: "google-adk" },
  "langchain-ai/langchain":      { registry: "pypi",  pkg: "__from_title__" },
  "microsoft/semantic-kernel":   { registry: "nuget", pkg: "Microsoft.SemanticKernel" },
};

const SEEDS = ["seed-1-active.json", "seed-2-active.json"];

function extractRepo(sourceUrlsRaw) {
  let urls = [];
  try { urls = JSON.parse(sourceUrlsRaw ?? "[]"); } catch {}
  for (const u of urls) {
    const m = String(u).match(/api\.github\.com\/repos\/([^/]+\/[^/]+)\/releases/);
    if (m) return m[1];
  }
  return null;
}

function parseVersion(title) {
  const idx = title.indexOf("Releases:");
  if (idx < 0) return null;
  let v = title.slice(idx + "Releases:".length).trim();
  if (!v) return null;
  const eq = v.match(/^([A-Za-z0-9_.-]+)==([0-9][\w.\-+]*)$/);
  if (eq) return { pkgFromTitle: eq[1], version: eq[2] };
  v = v.replace(/^Release\s+/i, "");
  v = v.replace(/^(python|mcp|typescript|dotnet|js|java|go|ruby|php)\//i, "");
  v = v.replace(/^dotnet-/, "");
  v = v.replace(/^v/, "");
  v = v.trim();
  return /^[0-9][\w.\-+]*$/.test(v) ? { pkgFromTitle: null, version: v } : null;
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { "user-agent": "agent-signal-hub/seed-validate" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.json();
}

async function fetchOk(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { "user-agent": "agent-signal-hub/seed-validate" } });
    return res.ok;
  } catch {
    return false;
  }
}

// Returns an array of {url, host} evidence endpoints (1 or 2 entries) when the
// version is genuinely confirmed, else null.
async function verifyVersion(registry, pkg, version) {
  if (registry === "npm") {
    const enc = encodeURIComponent(pkg);
    const meta = await fetchJson(`https://registry.npmjs.org/${enc}`);
    if (!meta || !meta.versions || !(version in meta.versions)) return null;
    const e2 = `https://cdn.jsdelivr.net/npm/${pkg}@${version}/package.json`;
    if (!(await fetchOk(e2))) return null;
    return [
      { url: `https://registry.npmjs.org/${enc}/${version}`, host: "registry.npmjs.org" },
      { url: e2, host: "cdn.jsdelivr.net" },
    ];
  }
  if (registry === "pypi") {
    const meta = await fetchJson(`https://pypi.org/pypi/${pkg}/json`);
    if (!meta || !meta.releases || !(version in meta.releases)) return null;
    const files = meta.releases[version] ?? [];
    if (!files.length) return null;
    const e2 = files.find((f) => f.url && /files\.pythonhosted\.org/.test(f.url))?.url;
    if (!e2) return null;
    return [
      { url: `https://pypi.org/project/${pkg}/${version}/`, host: "pypi.org" },
      { url: e2, host: "files.pythonhosted.org" },
    ];
  }
  if (registry === "nuget") {
    const lower = pkg.toLowerCase();
    const meta = await fetchJson(`https://api.nuget.org/v3-flatcontainer/${lower}/index.json`);
    if (!meta || !Array.isArray(meta.versions) || !meta.versions.includes(version)) return null;
    const e1 = `https://api.nuget.org/v3-flatcontainer/${lower}/${version}/${lower}.${version}.nupkg`;
    if (!(await fetchOk(e1))) return null;
    // NuGet exposes a single registrable domain; no genuinely independent
    // second domain exists, so return one evidence endpoint only.
    return [{ url: e1, host: "nuget.org" }];
  }
  return null;
}

async function loadSeedInfos() {
  return Promise.all(SEEDS.map(async (file) => {
    const identity = JSON.parse(await readFile(`${SEED_DIR}/${file}`, "utf8"));
    return { file, agentId: identity.agent_id };
  }));
}

async function fetchSeedSignalIds(agentId) {
  const res = await fetch(`${HUB}/api/agents/${agentId}/validations`, { headers: { accept: "application/json" } });
  if (!res.ok) return new Set();
  const data = await res.json().catch(() => null);
  const arr = data?.validations ?? [];
  return new Set(arr.map((v) => v.signal_id ?? v.signalId).filter(Boolean));
}

async function submitValidation(seedFile, signalId, evidenceUrl, comment) {
  const args = ["validate", "--identity", seedFile, "--base-url", HUB, "--signal-id", signalId, "--verdict", "support", "--evidence-url", evidenceUrl];
  if (comment) args.push("--comment", comment);
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [CLIENT, ...args], { timeout: 45000 });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (e) {
    const stderr = String(e?.stderr ?? "");
    const already = /409|already|unique|P2002/i.test(`${e?.message ?? ""} ${stderr}`);
    return { ok: false, already, error: String(e?.message ?? e).slice(0, 300), stderr: stderr.slice(0, 300) };
  }
}

async function main() {
  const res = await fetch(`${HUB}/api/signals?limit=200`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`signals fetch failed: HTTP ${res.status}`);
  const signals = (await res.json()).signals ?? [];

  const seedInfos = await loadSeedInfos();
  const [s1, s2] = seedInfos;
  const alreadyBySeed = new Map();
  for (const si of seedInfos) alreadyBySeed.set(si.agentId, await fetchSeedSignalIds(si.agentId));

  const results = [];
  for (const sig of signals) {
    if (ONLY && !ONLY.has(sig.id)) continue;
    const repo = extractRepo(sig.sourceUrls);
    if (!repo || !REPO_MAP[repo]) continue;
    const mapping = REPO_MAP[repo];
    const parsed = parseVersion(sig.title);
    if (!parsed) continue;
    const pkg = mapping.pkg === "__from_title__" ? parsed.pkgFromTitle : mapping.pkg;
    if (!pkg) continue;

    const need1 = !alreadyBySeed.get(s1.agentId).has(sig.id);
    const need2 = !alreadyBySeed.get(s2.agentId).has(sig.id);
    if (!need1 && !need2) {
      results.push({ signal_id: sig.id, repo, pkg, version: parsed.version, registry: mapping.registry, outcome: "already_validated" });
      continue;
    }

    let evidence;
    try {
      evidence = await verifyVersion(mapping.registry, pkg, parsed.version);
    } catch (e) {
      results.push({ signal_id: sig.id, repo, pkg, version: parsed.version, registry: mapping.registry, outcome: "verify_error", error: String(e?.message ?? e) });
      continue;
    }
    if (!evidence) {
      results.push({ signal_id: sig.id, repo, pkg, version: parsed.version, registry: mapping.registry, outcome: "not_verified" });
      continue;
    }

    if (DRY_RUN) {
      results.push({ signal_id: sig.id, repo, pkg, version: parsed.version, registry: mapping.registry, outcome: "would_support", title: sig.title.slice(0, 64), evidence });
      continue;
    }

    const comment = `Bootstrap seed verified ${pkg}@${parsed.version} on ${mapping.registry}.`;
    const r1 = need1 ? await submitValidation(`${SEED_DIR}/${s1.file}`, sig.id, evidence[0].url, comment) : null;
    const r2 = need2 && evidence[1] ? await submitValidation(`${SEED_DIR}/${s2.file}`, sig.id, evidence[1].url, comment) : null;
    results.push({
      signal_id: sig.id,
      repo,
      pkg,
      version: parsed.version,
      registry: mapping.registry,
      outcome: evidence.length >= 2 ? "submitted" : "single_independent_domain",
      seed1: r1,
      seed2: r2,
    });
  }

  process.stdout.write(JSON.stringify({ dry_run: DRY_RUN, total: signals.length, eligible: results.length, results }, null, 2) + "\n");
}

main().catch((e) => { process.stderr.write(`${e?.stack ?? e}\n`); process.exit(1); });
