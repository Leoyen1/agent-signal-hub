import type { Agent } from "@prisma/client";
import { isBootstrapValidator } from "@/lib/bootstrap";

type AuthorityAgent = Pick<Agent, "reputationScore"> & Partial<Pick<Agent, "createdAt" | "publicKey" | "credentialsRevokedAt">> | null | undefined;

export function validatorHasGovernanceAuthority(agent: AuthorityAgent) {
  if (agent?.credentialsRevokedAt) return false;
  if (agent?.publicKey && isBootstrapValidator(agent.publicKey)) return true;
  const configuredAgeHours = Number(process.env.DIGEST_ESTABLISHED_VALIDATOR_MIN_HOURS ?? 168);
  const minAgeHours = Number.isFinite(configuredAgeHours) ? Math.max(0, configuredAgeHours) : 168;
  const configuredReputation = Number(process.env.DIGEST_ESTABLISHED_VALIDATOR_MIN_REPUTATION ?? 55);
  const minReputation = Number.isFinite(configuredReputation) ? Math.max(0, configuredReputation) : 55;
  return Boolean(agent?.createdAt && Date.now() - agent.createdAt.getTime() >= minAgeHours * 3_600_000 && agent.reputationScore >= minReputation);
}