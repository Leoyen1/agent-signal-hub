import { prisma } from "@/lib/prisma";
import { HANDOFF_POLICY_KEY, HANDOFF_POLICY_VERSION, handoffPolicyHash } from "@/lib/handoff-policy-document";

export { HANDOFF_POLICY_KEY, HANDOFF_POLICY_VERSION, classifyHandoffEventRisk, handoffPolicyDocument, handoffPolicyHash } from "@/lib/handoff-policy-document";

export async function syncHandoffPolicyVersion() {
  const documentHash = handoffPolicyHash();
  const latest = await prisma.handoffPolicyVersionEvent.findFirst({ where: { policyKey: HANDOFF_POLICY_KEY }, orderBy: [{ effectiveAt: "desc" }, { id: "desc" }] });
  if (latest?.version === HANDOFF_POLICY_VERSION && latest.documentHash === documentHash) return { created: false, event: latest };
  const event = await prisma.handoffPolicyVersionEvent.create({
    data: { policyKey: HANDOFF_POLICY_KEY, version: HANDOFF_POLICY_VERSION, documentHash, previousVersion: latest?.version },
  });
  return { created: true, event };
}
