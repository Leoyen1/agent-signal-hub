import { requireAgent } from "@/lib/auth";
import { hashToken } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";
import { agentCredentialRotationSchema } from "@/lib/schemas";
import {
  normalizeEd25519PublicKey,
  publicKeyFingerprint,
  verifyCredentialRotationProof,
} from "@/lib/agent-credentials";
import { emitOpsEvent, requestOperation } from "@/lib/ops-events";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const agent = await requireAgent(request);
  if (agent instanceof Response) return agent;

  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = agentCredentialRotationSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid credential rotation payload.", details: parsed.error.flatten() }, { status: 400 });
  }
  if (id !== agent.id || parsed.data.agent_id !== agent.id) {
    return Response.json({ error: "Credential rotation is limited to the authenticated agent." }, { status: 403 });
  }

  let publicKey: string;
  try {
    publicKey = normalizeEd25519PublicKey(parsed.data.new_public_key);
  } catch {
    return Response.json({ error: "new_public_key must be a valid Ed25519 PEM or SPKI key." }, { status: 400 });
  }
  if (!verifyCredentialRotationProof(agent.id, parsed.data.new_api_key, publicKey, parsed.data.new_public_key_proof)) {
    await emitOpsEvent({
      severity: "warning",
      component: "agent-credentials",
      eventType: "credential_rotation_proof_invalid",
      outcome: "rejected",
      details: { ...requestOperation(request), agent_id: agent.id },
    });
    return Response.json({ error: "new_public_key_proof is invalid." }, { status: 401 });
  }

  const apiKeyHash = hashToken(parsed.data.new_api_key);
  if (apiKeyHash === agent.apiKeyHash && publicKey === agent.publicKey) {
    return Response.json({ error: "New credentials must differ from the active credentials." }, { status: 409 });
  }

  const rotatedAt = new Date();
  try {
    await prisma.$transaction([
      prisma.agent.update({
        where: { id: agent.id },
        data: {
          apiKeyHash,
          publicKey,
          credentialsRotatedAt: rotatedAt,
          lastSeenAt: rotatedAt,
        },
      }),
      prisma.agentInfrastructureClaim.updateMany({
        where: { agentId: agent.id },
        data: { status: "stale", expiresAt: null, failureReason: "Active public key changed; publish and verify a new proof document." },
      }),
    ]);
  } catch (error: any) {
    if (error?.code === "P2002") {
      return Response.json({ error: "The new API key or public key is already registered." }, { status: 409 });
    }
    throw error;
  }

  await emitOpsEvent({
    severity: "warning",
    component: "agent-credentials",
    eventType: "agent_credentials_rotated",
    outcome: "success",
    details: {
      ...requestOperation(request),
      agent_id: agent.id,
      rotated_at: rotatedAt.toISOString(),
      public_key_fingerprint: publicKeyFingerprint(publicKey),
    },
  });
  return Response.json({
    agent_id: agent.id,
    credential_status: "active",
    credentials_rotated_at: rotatedAt.toISOString(),
    public_key_fingerprint: publicKeyFingerprint(publicKey),
  });
}