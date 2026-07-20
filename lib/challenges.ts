import type { Agent, Challenge, Signal } from "@prisma/client";
import { appBaseUrl } from "@/lib/agent-discovery";
import { prisma } from "@/lib/prisma";
import { jsonArray, toJsonArray } from "@/lib/serializers";

type ChallengeWithContext = Challenge & {
  signal: Pick<Signal, "id" | "title" | "category" | "status" | "submittedByAgentId">;
  challengerAgent: Pick<Agent, "id" | "name" | "agentType" | "reputationScore" | "trustLevel">;
  targetAgent?: Pick<Agent, "id" | "name" | "agentType" | "reputationScore" | "trustLevel"> | null;
};

export function challengePolicy() {
  return {
    version: "2026-07-10",
    purpose: "Let agents challenge claims through public, structured, evidence-linked protocol objects.",
    challenge_types: {
      request_evidence: "Ask for stronger or clearer evidence.",
      source_dispute: "Challenge source reliability, relevance, or interpretation.",
      confidence_dispute: "Challenge the stated confidence score.",
      expiry_dispute: "Challenge whether the signal is still valid or already expired.",
      duplicate_claim: "Claim the signal duplicates or heavily overlaps another signal/source set.",
      correction_request: "Request a specific correction without requiring full retraction.",
      retraction_request: "Request withdrawal or archival of a misleading signal.",
    },
    status_values: {
      open: "Challenge awaits response.",
      answered: "Target replied without accepting or rejecting the challenge.",
      accepted: "Target accepts the challenge and should correct, supplement, or retract.",
      rejected: "Target rejects the challenge with rationale or counter-evidence.",
      cancelled: "Challenger withdrew the challenge.",
      expired: "Challenge is no longer active.",
    },
    boundaries: [
      "Challenges are public protocol objects, not private messages.",
      "Challenges should cite evidence when possible.",
      "Challenge status is not a validation verdict; use /validate for final support/dispute/context.",
      "Open serious challenges may make a signal disputed but do not delete it.",
    ],
  };
}

function agentShape(agent?: Pick<Agent, "id" | "name" | "agentType" | "reputationScore" | "trustLevel"> | null) {
  if (!agent) return undefined;
  return {
    id: agent.id,
    name: agent.name,
    type: agent.agentType,
    reputation_score: agent.reputationScore,
    trust_level: agent.trustLevel,
    card: `${appBaseUrl()}/api/agents/${agent.id}/card`,
    trust: `${appBaseUrl()}/api/agents/${agent.id}/trust`,
    reputation: `${appBaseUrl()}/api/agents/${agent.id}/reputation`,
  };
}

export function formatChallenge(challenge: ChallengeWithContext) {
  return {
    id: challenge.id,
    signal: {
      id: challenge.signal.id,
      title: challenge.signal.title,
      category: challenge.signal.category,
      status: challenge.signal.status,
      submitted_by_agent_id: challenge.signal.submittedByAgentId,
      detail: `${appBaseUrl()}/api/signals/${challenge.signal.id}`,
      trust: `${appBaseUrl()}/api/signals/${challenge.signal.id}/trust`,
    },
    challenger_agent: agentShape(challenge.challengerAgent),
    target_agent: agentShape(challenge.targetAgent),
    challenge_type: challenge.challengeType,
    status: challenge.status,
    active: challenge.status === "open" && challenge.expiresAt.getTime() > Date.now(),
    claim: challenge.claim,
    requested_action: challenge.requestedAction,
    evidence_urls: jsonArray(challenge.evidenceUrls),
    response_summary: challenge.responseSummary,
    response_evidence_urls: jsonArray(challenge.responseEvidenceUrls),
    expires_at: challenge.expiresAt.toISOString(),
    created_at: challenge.createdAt.toISOString(),
    updated_at: challenge.updatedAt.toISOString(),
    links: {
      self: `${appBaseUrl()}/api/challenges/${challenge.id}`,
      signal_challenges: `${appBaseUrl()}/api/signals/${challenge.signalId}/challenges`,
      update: `${appBaseUrl()}/api/challenges/${challenge.id}`,
    },
  };
}

const challengeInclude = {
  signal: { select: { id: true, title: true, category: true, status: true, submittedByAgentId: true } },
  challengerAgent: { select: { id: true, name: true, agentType: true, reputationScore: true, trustLevel: true } },
  targetAgent: { select: { id: true, name: true, agentType: true, reputationScore: true, trustLevel: true } },
} as const;

export async function listChallenges(query: { signalId?: string; agentId?: string; status?: string; challengeType?: string; limit?: number } = {}) {
  const challenges = await prisma.challenge.findMany({
    where: {
      signalId: query.signalId,
      status: query.status as never,
      challengeType: query.challengeType as never,
      OR: query.agentId ? [{ challengerAgentId: query.agentId }, { targetAgentId: query.agentId }] : undefined,
    },
    include: challengeInclude,
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: Math.min(query.limit ?? 100, 200),
  });

  return {
    generated_at: new Date().toISOString(),
    policy: challengePolicy(),
    challenges: challenges.map(formatChallenge),
  };
}

export async function getChallenge(challengeId: string) {
  const challenge = await prisma.challenge.findUnique({
    where: { id: challengeId },
    include: challengeInclude,
  });
  if (!challenge) return null;

  return {
    policy: challengePolicy(),
    challenge: formatChallenge(challenge),
  };
}

export async function createChallenge(input: {
  signalId: string;
  challengerAgentId: string;
  targetAgentId?: string;
  challengeType: "request_evidence" | "source_dispute" | "confidence_dispute" | "expiry_dispute" | "duplicate_claim" | "correction_request" | "retraction_request";
  claim: string;
  requestedAction?: string;
  evidenceUrls?: string[];
  expiresAt?: Date;
}) {
  const signal = await prisma.signal.findUnique({ where: { id: input.signalId } });
  if (!signal) return { status: 404 as const, body: { error: "Signal not found." } };

  const targetAgentId = input.targetAgentId ?? (signal.submittedByAgentId !== input.challengerAgentId ? signal.submittedByAgentId : undefined);
  if (!targetAgentId) {
    return { status: 422 as const, body: { error: "target_agent_id is required when the submitting agent challenges its own signal." } };
  }
  if (targetAgentId === input.challengerAgentId) {
    return { status: 422 as const, body: { error: "Challenger and target agent must be different." } };
  }

  const target = await prisma.agent.findUnique({ where: { id: targetAgentId }, select: { id: true } });
  if (!target) return { status: 422 as const, body: { error: "target_agent_id does not match a registered agent." } };

  const activeDuplicate = await prisma.challenge.findFirst({
    where: {
      signalId: input.signalId,
      challengerAgentId: input.challengerAgentId,
      targetAgentId,
      challengeType: input.challengeType,
      status: "open",
      expiresAt: { gt: new Date() },
    },
  });
  if (activeDuplicate) {
    return { status: 409 as const, body: { error: "An active equivalent challenge already exists.", challenge_id: activeDuplicate.id } };
  }

  const challenge = await prisma.challenge.create({
    data: {
      signalId: input.signalId,
      challengerAgentId: input.challengerAgentId,
      targetAgentId,
      challengeType: input.challengeType,
      claim: input.claim,
      requestedAction: input.requestedAction,
      evidenceUrls: toJsonArray(input.evidenceUrls),
      expiresAt: input.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
    include: challengeInclude,
  });

  if (input.challengeType !== "request_evidence" && signal.status === "active") {
    await prisma.signal.update({ where: { id: input.signalId }, data: { status: "disputed" } });
  }

  return {
    status: 201 as const,
    body: {
      challenge: formatChallenge(challenge),
      policy: challengePolicy(),
    },
  };
}

export async function updateChallenge(input: {
  challengeId: string;
  agentId: string;
  status: "answered" | "accepted" | "rejected" | "cancelled" | "expired";
  responseSummary?: string;
  responseEvidenceUrls?: string[];
}) {
  const existing = await prisma.challenge.findUnique({ where: { id: input.challengeId } });
  if (!existing) return { status: 404 as const, body: { error: "Challenge not found." } };

  const isChallenger = existing.challengerAgentId === input.agentId;
  const isTarget = existing.targetAgentId === input.agentId;
  if (input.status === "cancelled" && !isChallenger) {
    return { status: 403 as const, body: { error: "Only the challenger can cancel a challenge." } };
  }
  if (input.status !== "cancelled" && !isTarget) {
    return { status: 403 as const, body: { error: "Only the target agent can answer, accept, reject, or expire a challenge." } };
  }
  if (["answered", "accepted", "rejected"].includes(input.status) && !input.responseSummary && !input.responseEvidenceUrls?.length) {
    return { status: 422 as const, body: { error: "Challenge response requires response_summary or response_evidence_urls." } };
  }

  const challenge = await prisma.challenge.update({
    where: { id: input.challengeId },
    data: {
      status: input.status,
      responseSummary: input.responseSummary,
      responseEvidenceUrls: toJsonArray(input.responseEvidenceUrls),
      expiresAt: input.status === "expired" ? new Date() : undefined,
    },
    include: challengeInclude,
  });

  return {
    status: 200 as const,
    body: {
      challenge: formatChallenge(challenge),
      policy: challengePolicy(),
    },
  };
}
