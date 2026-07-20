import type { InfrastructureProofTransport } from "@/lib/infrastructure-proof";
import {
  fetchAndVerifyInfrastructureProof,
  infrastructureClaimIsActive,
  infrastructureClaimWarningHours,
} from "@/lib/infrastructure-proof";
import { emitOpsEvent } from "@/lib/ops-events";
import { prisma } from "@/lib/prisma";

function refreshBatchSize(override?: number) {
  const configured = override ?? Number(process.env.INFRASTRUCTURE_REFRESH_BATCH_SIZE ?? 25);
  return Number.isInteger(configured) ? Math.min(100, Math.max(1, configured)) : 25;
}

export async function refreshDueInfrastructureClaims(
  options: { transport?: InfrastructureProofTransport; now?: Date; batchSize?: number } = {},
) {
  const now = options.now ? new Date(options.now) : new Date();
  const dueBefore = new Date(now.getTime() + infrastructureClaimWarningHours() * 3_600_000);
  const claims = await prisma.agentInfrastructureClaim.findMany({
    where: { status: "verified", expiresAt: { lte: dueBefore } },
    include: { agent: true },
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    take: refreshBatchSize(options.batchSize),
  });
  const results: Array<{
    claim_id: string;
    agent_id: string;
    target: string;
    outcome: "refreshed" | "deferred" | "failed";
    expires_at?: string;
    error?: string;
  }> = [];

  for (const claim of claims) {
    const verification = await fetchAndVerifyInfrastructureProof(claim.agent, claim.target, {
      transport: options.transport,
      now,
    });
    if (verification.ok) {
      const refreshed = await prisma.agentInfrastructureClaim.update({
        where: { id: claim.id },
        data: {
          declaredUrl: verification.descriptor.declaredUrl,
          origin: verification.descriptor.origin,
          registrableDomain: verification.descriptor.registrableDomain,
          proofUrl: verification.descriptor.proofUrl,
          publicKeyFingerprint: verification.publicKeyFingerprint,
          proofDocumentHash: verification.proofDocumentHash,
          status: "verified",
          verifiedAt: verification.verifiedAt,
          expiresAt: verification.expiresAt,
          lastCheckedAt: verification.verifiedAt,
          failureReason: null,
        },
      });
      results.push({
        claim_id: claim.id,
        agent_id: claim.agentId,
        target: claim.target,
        outcome: "refreshed",
        expires_at: refreshed.expiresAt?.toISOString(),
      });
      await emitOpsEvent({
        severity: "info",
        component: "infrastructure-maintenance",
        eventType: "infrastructure_claim_auto_refresh_succeeded",
        outcome: "success",
        details: {
          claim_id: claim.id,
          agent_id: claim.agentId,
          target: claim.target,
          registrable_domain: refreshed.registrableDomain,
          expires_at: refreshed.expiresAt?.toISOString(),
        },
      });
      continue;
    }

    const remainsActive = infrastructureClaimIsActive(claim, claim.agent.publicKey, now.getTime());
    await prisma.agentInfrastructureClaim.update({
      where: { id: claim.id },
      data: {
        status: remainsActive ? "verified" : "failed",
        lastCheckedAt: now,
        failureReason: verification.error,
      },
    });
    const outcome = remainsActive ? "deferred" : "failed";
    results.push({
      claim_id: claim.id,
      agent_id: claim.agentId,
      target: claim.target,
      outcome,
      expires_at: claim.expiresAt?.toISOString(),
      error: verification.error,
    });
    await emitOpsEvent({
      severity: remainsActive ? "warning" : "error",
      component: "infrastructure-maintenance",
      eventType: remainsActive ? "infrastructure_claim_auto_refresh_deferred" : "infrastructure_claim_auto_refresh_failed",
      outcome: remainsActive ? "observed" : "failure",
      details: {
        claim_id: claim.id,
        agent_id: claim.agentId,
        target: claim.target,
        expires_at: claim.expiresAt?.toISOString(),
        error: verification.error,
      },
    });
  }

  return {
    checked_at: now.toISOString(),
    due_before: dueBefore.toISOString(),
    batch_limit: refreshBatchSize(options.batchSize),
    processed: results.length,
    refreshed: results.filter((result) => result.outcome === "refreshed").length,
    deferred: results.filter((result) => result.outcome === "deferred").length,
    failed: results.filter((result) => result.outcome === "failed").length,
    results,
  };
}
