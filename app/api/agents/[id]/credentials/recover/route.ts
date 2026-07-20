import { hashToken } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";
import { agentCredentialRecoverySchema } from "@/lib/schemas";
import {
  normalizeEd25519PublicKey,
  publicKeyFingerprint,
  verifyCredentialRecoveryProof,
} from "@/lib/agent-credentials";
import { emitOpsEvent, requestOperation } from "@/lib/ops-events";

const recoveryWindowMs = 5 * 60_000;

class RecoverySupersededError extends Error {}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = agentCredentialRecoverySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid credential recovery payload.", details: parsed.error.flatten() }, { status: 400 });
  }
  if (parsed.data.agent_id !== id) {
    return Response.json({ error: "agent_id must match the recovery route." }, { status: 403 });
  }

  const agent = await prisma.agent.findUnique({
    where: { id },
    select: {
      id: true,
      apiKeyHash: true,
      publicKey: true,
      recoveryPublicKey: true,
      credentialsRevokedAt: true,
    },
  });
  if (!agent) return Response.json({ error: "Agent not found." }, { status: 404 });
  if (agent.credentialsRevokedAt) {
    await emitOpsEvent({
      severity: "warning",
      component: "agent-credentials",
      eventType: "revoked_agent_recovery_rejected",
      outcome: "rejected",
      details: { ...requestOperation(request), agent_id: agent.id, revoked_at: agent.credentialsRevokedAt.toISOString() },
    });
    return Response.json({ error: "Admin-revoked agent credentials cannot be recovered." }, { status: 403 });
  }
  if (!agent.recoveryPublicKey) {
    return Response.json({ error: "This legacy agent has no recovery public key." }, { status: 409 });
  }

  const issuedAt = new Date(parsed.data.recovery_timestamp);
  if (Number.isNaN(issuedAt.getTime()) || Math.abs(Date.now() - issuedAt.getTime()) > recoveryWindowMs) {
    return Response.json({ error: "Recovery timestamp is outside the five-minute window." }, { status: 401 });
  }

  let publicKey: string;
  let recoveryPublicKey: string;
  try {
    publicKey = normalizeEd25519PublicKey(parsed.data.new_public_key);
    recoveryPublicKey = normalizeEd25519PublicKey(parsed.data.new_recovery_public_key);
  } catch {
    return Response.json({ error: "Replacement active and recovery keys must be valid Ed25519 PEM or SPKI keys." }, { status: 400 });
  }
  if (publicKey === recoveryPublicKey) {
    return Response.json({ error: "Replacement active and recovery keys must differ." }, { status: 400 });
  }
  if (
    !verifyCredentialRecoveryProof(
      agent.recoveryPublicKey,
      agent.id,
      parsed.data.recovery_timestamp,
      parsed.data.recovery_nonce,
      parsed.data.new_api_key,
      publicKey,
      recoveryPublicKey,
      parsed.data.recovery_signature,
    )
  ) {
    await emitOpsEvent({
      severity: "warning",
      component: "agent-credentials",
      eventType: "credential_recovery_proof_invalid",
      outcome: "rejected",
      details: { ...requestOperation(request), agent_id: agent.id },
    });
    return Response.json({ error: "recovery_signature is invalid." }, { status: 401 });
  }

  const apiKeyHash = hashToken(parsed.data.new_api_key);
  if (apiKeyHash === agent.apiKeyHash && publicKey === agent.publicKey && recoveryPublicKey === agent.recoveryPublicKey) {
    return Response.json({ error: "Recovered credentials must differ from the active credentials." }, { status: 409 });
  }

  const nonce = "recovery:" + parsed.data.recovery_nonce;
  const recoveredAt = new Date();
  try {
    await prisma.$transaction(async (transaction) => {
      await transaction.requestNonce.create({
        data: {
          agentId: agent.id,
          nonce,
          expiresAt: new Date(issuedAt.getTime() + recoveryWindowMs),
        },
      });
      const updated = await transaction.agent.updateMany({
        where: {
          id: agent.id,
          recoveryPublicKey: agent.recoveryPublicKey,
          credentialsRevokedAt: null,
        },
        data: {
          apiKeyHash,
          publicKey,
          recoveryPublicKey,
          credentialsRotatedAt: recoveredAt,
          credentialsRecoveredAt: recoveredAt,
          lastSeenAt: recoveredAt,
        },
      });
      if (updated.count !== 1) throw new RecoverySupersededError("Recovery key changed before this request committed.");
      await transaction.agentInfrastructureClaim.updateMany({
        where: { agentId: agent.id },
        data: { status: "stale", expiresAt: null, failureReason: "Active public key changed during recovery; publish and verify a new proof document." },
      });
    });
  } catch (error: any) {
    if (error instanceof RecoverySupersededError) {
      return Response.json({ error: "Recovery request was superseded by another credential change." }, { status: 409 });
    }
    if (error?.code === "P2002") {
      const replay = await prisma.requestNonce.findUnique({
        where: { agentId_nonce: { agentId: agent.id, nonce } },
        select: { id: true },
      });
      return Response.json(
        { error: replay ? "Recovery nonce has already been used." : "Replacement API key or public key is already registered." },
        { status: 409 },
      );
    }
    throw error;
  }
  void prisma.requestNonce.deleteMany({ where: { expiresAt: { lt: new Date() } } });

  await emitOpsEvent({
    severity: "warning",
    component: "agent-credentials",
    eventType: "agent_credentials_recovered",
    outcome: "success",
    details: {
      ...requestOperation(request),
      agent_id: agent.id,
      recovered_at: recoveredAt.toISOString(),
      public_key_fingerprint: publicKeyFingerprint(publicKey),
      recovery_key_fingerprint: publicKeyFingerprint(recoveryPublicKey),
    },
  });
  return Response.json({
    agent_id: agent.id,
    credential_status: "active",
    credentials_recovered_at: recoveredAt.toISOString(),
    public_key_fingerprint: publicKeyFingerprint(publicKey),
    recovery_key_fingerprint: publicKeyFingerprint(recoveryPublicKey),
  });
}