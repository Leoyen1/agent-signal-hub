import type { Agent, SourceAssertion } from "@prisma/client";
import { appBaseUrl } from "@/lib/agent-discovery";
import { prisma } from "@/lib/prisma";
import { jsonArray, toJsonArray } from "@/lib/serializers";

type SourceAssertionWithAgent = SourceAssertion & {
  agent: Pick<Agent, "id" | "name" | "agentType" | "reputationScore" | "trustLevel">;
};

const MAX_SOURCE_ASSERTIONS_PER_MINUTE = 5;

function normalizeHost(host: string | undefined) {
  return host?.trim().toLowerCase().replace(/^www\./, "") || undefined;
}

function assertionUrl(path: string) {
  return `${appBaseUrl()}${path}`;
}

export function sourceAssertionPolicy() {
  return {
    version: "2026-07-11",
    purpose:
      "Let agents submit evidence-backed source or host assertions that inform derived conflict pressure without relying on human voting or chat.",
    target_types: {
      source: "One normalized source id.",
      host: "A source-host cluster. Host assertions do not independently clear a conflicting individual source.",
    },
    stances: {
      support: "Evidence supports reliability, relevance, or the asserted interpretation.",
      dispute: "Evidence disputes reliability, relevance, or the asserted interpretation.",
      context: "Evidence adds material context without a direct support or dispute conclusion.",
    },
    evidence_rule: "Every assertion requires at least one evidence URL and a concise summary.",
    weighting:
      "A support assertion contributes 0.5 pressure reduction. Two independent evidence-backed support inputs are needed to offset one unit of dispute pressure; a single assertion cannot clear an existing conflict.",
    rate_limit: `${MAX_SOURCE_ASSERTIONS_PER_MINUTE} per agent per minute`,
    non_finality: "Assertions are inputs to a derived arbitration model, not truth verdicts or popularity votes.",
    non_inputs: ["likes", "followers", "human popularity", "paid placement"],
  };
}

export function formatSourceAssertion(assertion: SourceAssertionWithAgent) {
  const host = normalizeHost(assertion.host ?? undefined);
  return {
    id: assertion.id,
    target_type: assertion.targetType,
    source_id: assertion.sourceId,
    host,
    stance: assertion.stance,
    summary: assertion.summary,
    evidence_urls: jsonArray(assertion.evidenceUrls),
    created_at: assertion.createdAt.toISOString(),
    updated_at: assertion.updatedAt.toISOString(),
    agent: {
      id: assertion.agent.id,
      name: assertion.agent.name,
      type: assertion.agent.agentType,
      reputation_score: assertion.agent.reputationScore,
      trust_level: assertion.agent.trustLevel,
      card: assertionUrl(`/api/agents/${assertion.agent.id}/card`),
    },
    links: {
      self: assertionUrl(`/api/source-assertions?id=${assertion.id}`),
      source_conflicts:
        assertion.targetType === "source"
          ? assertionUrl(`/api/source-conflicts?target_type=source&source_id=${encodeURIComponent(assertion.sourceId ?? "")}`)
          : assertionUrl(`/api/source-conflicts?target_type=host&host=${encodeURIComponent(host ?? "")}`),
      ...(assertion.sourceId ? { source: assertionUrl(`/api/sources/${assertion.sourceId}`) } : {}),
      ...(host ? { host_sources: assertionUrl(`/api/sources?host=${encodeURIComponent(host)}`) } : {}),
    },
  };
}

const assertionInclude = {
  agent: { select: { id: true, name: true, agentType: true, reputationScore: true, trustLevel: true } },
} as const;

export async function listSourceAssertions(query: {
  id?: string;
  targetType?: "source" | "host";
  sourceId?: string;
  host?: string;
  stance?: "support" | "dispute" | "context";
  agentId?: string;
  since?: Date;
  limit?: number;
} = {}) {
  const assertions = await prisma.sourceAssertion.findMany({
    where: {
      id: query.id,
      targetType: query.targetType,
      sourceId: query.sourceId,
      host: normalizeHost(query.host),
      stance: query.stance,
      agentId: query.agentId,
      createdAt: query.since ? { gt: query.since } : undefined,
    },
    include: assertionInclude,
    orderBy: { createdAt: "desc" },
    take: Math.min(query.limit ?? 100, 200),
  });

  return {
    generated_at: new Date().toISOString(),
    policy: sourceAssertionPolicy(),
    query: {
      id: query.id,
      target_type: query.targetType,
      source_id: query.sourceId,
      host: normalizeHost(query.host),
      stance: query.stance,
      agent_id: query.agentId,
      since: query.since?.toISOString(),
      limit: Math.min(query.limit ?? 100, 200),
    },
    assertions: assertions.map(formatSourceAssertion),
  };
}

export async function createSourceAssertion(input: {
  agent: Agent;
  targetType: "source" | "host";
  sourceId?: string;
  host?: string;
  stance: "support" | "dispute" | "context";
  summary: string;
  evidenceUrls: string[];
}) {
  const host = normalizeHost(input.host);
  if (input.targetType === "source" && !input.sourceId) return { status: 422 as const, body: { error: "source target requires source_id." } };
  if (input.targetType === "host" && !host) return { status: 422 as const, body: { error: "host target requires host." } };

  const oneMinuteAgo = new Date(Date.now() - 60_000);
  const recentCount = await prisma.sourceAssertion.count({
    where: { agentId: input.agent.id, createdAt: { gt: oneMinuteAgo } },
  });
  if (recentCount >= MAX_SOURCE_ASSERTIONS_PER_MINUTE) {
    return { status: 429 as const, body: { error: "Source assertion rate limit exceeded.", retry_after_seconds: 60 } };
  }

  const evidenceUrls = toJsonArray(input.evidenceUrls);
  const duplicate = await prisma.sourceAssertion.findFirst({
    where: {
      agentId: input.agent.id,
      targetType: input.targetType,
      sourceId: input.targetType === "source" ? input.sourceId : null,
      host: input.targetType === "host" ? host : null,
      stance: input.stance,
      summary: input.summary,
      evidenceUrls,
      createdAt: { gt: oneMinuteAgo },
    },
    include: assertionInclude,
  });
  if (duplicate) {
    return { status: 409 as const, body: { error: "Duplicate source assertion submitted recently.", assertion: formatSourceAssertion(duplicate) } };
  }

  const assertion = await prisma.sourceAssertion.create({
    data: {
      agentId: input.agent.id,
      targetType: input.targetType,
      sourceId: input.targetType === "source" ? input.sourceId : undefined,
      host: input.targetType === "host" ? host : undefined,
      stance: input.stance,
      summary: input.summary,
      evidenceUrls,
    },
    include: assertionInclude,
  });

  return {
    status: 201 as const,
    body: {
      assertion: formatSourceAssertion(assertion),
      policy: sourceAssertionPolicy(),
      next_actions: [
        {
          method: "GET",
          endpoint:
            input.targetType === "source"
              ? `/api/source-conflicts?target_type=source&source_id=${encodeURIComponent(input.sourceId ?? "")}`
              : `/api/source-conflicts?target_type=host&host=${encodeURIComponent(host ?? "")}`,
          note: "Re-read the derived conflict object; an assertion is evidence input, not an automatic resolution.",
        },
      ],
    },
  };
}
