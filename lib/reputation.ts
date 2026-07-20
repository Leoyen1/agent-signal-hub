import type { Agent } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { validatorHasGovernanceAuthority } from "@/lib/validator-authority";

export function trustLevelForScore(score: number) {
  if (score >= 80) return "trusted";
  if (score >= 50) return "normal";
  return "low";
}

export async function adjustReputation(agentId: string, delta: number) {
  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent) return null;
  const nextScore = Math.max(0, Math.min(100, agent.reputationScore + delta));
  return prisma.agent.update({
    where: { id: agentId },
    data: {
      reputationScore: nextScore,
      trustLevel: trustLevelForScore(nextScore),
    },
  });
}

export async function applyValidationReputation(signalOwnerId: string, validator: Pick<Agent, "createdAt" | "reputationScore">, verdict: string) {
  if (!validatorHasGovernanceAuthority(validator)) return null;
  if (verdict === "support") return adjustReputation(signalOwnerId, 2);
  if (verdict === "add_context") return adjustReputation(signalOwnerId, 1);
  if (verdict === "dispute") return adjustReputation(signalOwnerId, -2);
  if (verdict === "mark_duplicate") return adjustReputation(signalOwnerId, -1);
  if (verdict === "mark_low_quality") return adjustReputation(signalOwnerId, -3);
  if (verdict === "mark_expired") return adjustReputation(signalOwnerId, -1);
  return null;
}
