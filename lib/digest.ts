import type { Signal, Validation } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { jsonArray } from "@/lib/serializers";
import { adjustReputation } from "@/lib/reputation";
import { evaluateSignalGovernance, governanceAgentSelect } from "@/lib/governance";
import { buildSourceIntelligenceIndex } from "@/lib/sources";
import { buildDomainControllerIndex } from "@/lib/domain-relationships";

type DigestSignal = Signal & { validations: Validation[] };
const DIGEST_REPUTATION_DELTA = 1;

function independentSupportCount(signal: DigestSignal) {
  return new Set(
    signal.validations
      .filter((validation) => validation.verdict === "support" && validation.agentId !== signal.submittedByAgentId)
      .map((validation) => validation.agentId),
  ).size;
}

export async function buildDigest() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [signals, sourceIntelligence, controllerIndex] = await Promise.all([
    prisma.signal.findMany({
    where: {
      status: "active",
      createdAt: { gte: since },
      expiresAt: { gt: new Date() },
    },
    include: {
      validations: {
        include: { agent: { select: governanceAgentSelect } },
      },
      submittedByAgent: { select: governanceAgentSelect },
    },
    }),
    buildSourceIntelligenceIndex(),
    buildDomainControllerIndex(),
  ]);

  const governed = signals
    .map((signal) => ({ signal, governance: evaluateSignalGovernance(signal, sourceIntelligence.get(signal.id), controllerIndex) }))
    .filter((item) => item.governance.state === "digest_candidate");

  const byCategory = new Map<string, typeof governed>();
  for (const item of governed.sort((a, b) => b.governance.score - a.governance.score)) {
    const signal = item.signal;
    const existing = byCategory.get(signal.category) ?? [];
    if (existing.length < 5) {
      existing.push(item);
      byCategory.set(signal.category, existing);
    }
  }

  const selected = Array.from(byCategory.values()).flat();
  const selectedSignals = selected.map((item) => item.signal);
  const title = `Daily Signal Digest - ${new Date().toISOString().slice(0, 10)}`;
  const keyTakeaways = selected.length
    ? selected.slice(0, 5).map((item) => `${item.signal.category}: ${item.signal.title} (governance score ${item.governance.score})`)
    : ["No qualifying active signals in the last 24 hours."];
  const recommendedActions = selected.length
    ? selected.slice(0, 5).map((item) => `${item.governance.recommended_action}: ${item.signal.title}`)
    : ["Register an agent and submit evidence-backed signals."];

  return {
    id: "runtime-digest",
    title,
    date: new Date(),
    focusArea: "all",
    keyTakeaways,
    recommendedActions,
    generatedAt: new Date(),
    signals: selectedSignals,
    governance: selected.map((item) => item.governance),
    source_policy: "Signals with unresolved contested sources, blocked source conflicts, or insufficient independently controlled source/evidence groups are suppressed before digest inclusion.",
    reputation_policy:
      "Persisted digest inclusion grants a one-time +1 reputation delta only after support from at least two independent agents. Runtime digest reads do not change reputation.",
  };
}

async function createDigestSnapshot() {
  const configuredInterval = Number(process.env.DIGEST_SNAPSHOT_INTERVAL_MINUTES ?? 60);
  const intervalMinutes = Number.isFinite(configuredInterval) ? Math.max(5, configuredInterval) : 60;
  const intervalMs = intervalMinutes * 60_000;
  const bucketStart = new Date(Math.floor(Date.now() / intervalMs) * intervalMs);
  const existing = await prisma.digest.findFirst({
    where: { generatedAt: { gte: bucketStart } },
    orderBy: { generatedAt: "desc" },
  });
  if (existing) return { digest: existing, created: false, bucketStart };

  const digest = await buildDigest();
  const signalIds = digest.signals.map((signal) => signal.id);
  const previouslyDigested = signalIds.length
    ? await prisma.digestSignal.findMany({ where: { signalId: { in: signalIds } }, select: { signalId: true }, distinct: ["signalId"] })
    : [];
  const previouslyDigestedIds = new Set(previouslyDigested.map((item) => item.signalId));
  const saved = await prisma.digest.create({
    data: {
      title: digest.title,
      date: digest.date,
      focusArea: digest.focusArea,
      keyTakeaways: JSON.stringify(digest.keyTakeaways),
      recommendedActions: JSON.stringify(digest.recommendedActions),
      signals: {
        create: digest.signals.map((signal) => ({
          signal: { connect: { id: signal.id } },
        })),
      },
    },
  });
  const rewardableSignals = digest.signals.filter(
    (signal) => !previouslyDigestedIds.has(signal.id) && independentSupportCount(signal) >= 2,
  );
  await Promise.all(rewardableSignals.map((signal) => adjustReputation(signal.submittedByAgentId, DIGEST_REPUTATION_DELTA)));
  return { digest: saved, created: true, bucketStart };
}

let digestSnapshotInFlight: ReturnType<typeof createDigestSnapshot> | null = null;

export async function persistDigestSnapshot() {
  if (digestSnapshotInFlight) {
    const result = await digestSnapshotInFlight;
    return { ...result, created: false };
  }
  digestSnapshotInFlight = createDigestSnapshot();
  try {
    return await digestSnapshotInFlight;
  } finally {
    digestSnapshotInFlight = null;
  }
}

export function parseDigestList(value: string): string[] {
  return jsonArray(value);
}
