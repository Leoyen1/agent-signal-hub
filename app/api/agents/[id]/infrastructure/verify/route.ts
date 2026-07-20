import { publicKeyFingerprint } from "@/lib/agent-credentials";
import { requireAgent } from "@/lib/auth";
import { fetchAndVerifyInfrastructureProof, formatInfrastructureClaim, infrastructureClaimDescriptor, infrastructureProofCanonical, INFRASTRUCTURE_PROOF_SCHEMA_VERSION } from "@/lib/infrastructure-proof";
import { emitOpsEvent, requestOperation } from "@/lib/ops-events";
import { prisma } from "@/lib/prisma";
import { agentInfrastructureVerifySchema } from "@/lib/schemas";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const agent = await requireAgent(request);
  if (agent instanceof Response) return agent;
  const { id } = await context.params;
  if (id !== agent.id) return Response.json({ error: "Infrastructure proof preparation is limited to the authenticated agent." }, { status: 403 });
  if (!agent.publicKey) return Response.json({ error: "Agent has no active public key." }, { status: 409 });

  const target = new URL(request.url).searchParams.get("target");
  if (target !== "homepage" && target !== "callback") {
    return Response.json({ error: "target must be homepage or callback." }, { status: 400 });
  }
  const described = infrastructureClaimDescriptor(agent, target);
  if (!described.ok) return Response.json({ error: described.error }, { status: 422 });
  const fingerprint = publicKeyFingerprint(agent.publicKey);
  const canonicalPayload = infrastructureProofCanonical({
    agentId: agent.id,
    target,
    origin: described.descriptor.origin,
    registrableDomain: described.descriptor.registrableDomain,
    publicKeyFingerprint: fingerprint,
  });
  return Response.json({
    proof_url: described.descriptor.proofUrl,
    canonical_payload: canonicalPayload,
    document: {
      schema_version: INFRASTRUCTURE_PROOF_SCHEMA_VERSION,
      agent_id: agent.id,
      target,
      origin: described.descriptor.origin,
      registrable_domain: described.descriptor.registrableDomain,
      public_key_fingerprint: fingerprint,
      signature: "<base64 Ed25519 signature over canonical_payload>",
    },
  });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const agent = await requireAgent(request);
  if (agent instanceof Response) return agent;

  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = agentInfrastructureVerifySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid infrastructure verification payload.", details: parsed.error.flatten() }, { status: 400 });
  }
  if (id !== agent.id || parsed.data.agent_id !== agent.id) {
    return Response.json({ error: "Infrastructure verification is limited to the authenticated agent." }, { status: 403 });
  }
  if (!agent.publicKey) return Response.json({ error: "Agent has no active public key." }, { status: 409 });

  const checkedAt = new Date();
  const verification = await fetchAndVerifyInfrastructureProof(agent, parsed.data.target);
  if (!verification.ok) {
    const fallbackDescriptor = infrastructureClaimDescriptor(agent, parsed.data.target);
    const described = verification.descriptor ?? (fallbackDescriptor.ok ? fallbackDescriptor.descriptor : undefined);
    if (described) {
      await prisma.agentInfrastructureClaim.upsert({
        where: { agentId_target: { agentId: agent.id, target: parsed.data.target } },
        create: {
          agentId: agent.id,
          target: parsed.data.target,
          declaredUrl: described.declaredUrl,
          origin: described.origin,
          registrableDomain: described.registrableDomain,
          proofUrl: described.proofUrl,
          publicKeyFingerprint: publicKeyFingerprint(agent.publicKey),
          status: "failed",
          lastCheckedAt: checkedAt,
          failureReason: verification.error,
        },
        update: {
          declaredUrl: described.declaredUrl,
          origin: described.origin,
          registrableDomain: described.registrableDomain,
          proofUrl: described.proofUrl,
          publicKeyFingerprint: publicKeyFingerprint(agent.publicKey),
          proofDocumentHash: null,
          status: "failed",
          verifiedAt: null,
          expiresAt: null,
          lastCheckedAt: checkedAt,
          failureReason: verification.error,
        },
      });
    }
    await emitOpsEvent({
      severity: "warning",
      component: "agent-infrastructure",
      eventType: "infrastructure_claim_verification_failed",
      outcome: "rejected",
      details: { ...requestOperation(request), agent_id: agent.id, target: parsed.data.target, reason: verification.error },
    });
    return Response.json({ error: verification.error, proof_url: described?.proofUrl }, { status: 422 });
  }

  const claim = await prisma.agentInfrastructureClaim.upsert({
    where: { agentId_target: { agentId: agent.id, target: parsed.data.target } },
    create: {
      agentId: agent.id,
      target: parsed.data.target,
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
    },
    update: {
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

  await emitOpsEvent({
    severity: "info",
    component: "agent-infrastructure",
    eventType: "infrastructure_claim_verified",
    outcome: "success",
    details: {
      ...requestOperation(request),
      agent_id: agent.id,
      target: claim.target,
      registrable_domain: claim.registrableDomain,
      expires_at: claim.expiresAt?.toISOString(),
    },
  });
  return Response.json({ claim: formatInfrastructureClaim(claim, agent.publicKey) });
}