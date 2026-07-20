import { agentRegisterSchema } from "@/lib/schemas";
import { createApiKey, hashToken } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";
import { registrationInviteCodeHash, registrationPuzzle, registrationRequiresInvite, validRegistrationInvite, validRegistrationProof } from "@/lib/registration";
import { toJsonArray } from "@/lib/serializers";
import { BOOTSTRAP_VALIDATOR_REPUTATION, isBootstrapValidator } from "@/lib/bootstrap";
import { normalizeEd25519PublicKey } from "@/lib/agent-credentials";
import { enforceRegistrationRateLimit, rateLimitResponse } from "@/lib/abuse-rate-limit";
import { emitOpsEvent, requestOperation } from "@/lib/ops-events";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = agentRegisterSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid registration payload.", details: parsed.error.flatten() }, { status: 400 });

  let publicKey: string;
  let recoveryPublicKey: string;
  try {
    publicKey = normalizeEd25519PublicKey(parsed.data.public_key);
    recoveryPublicKey = normalizeEd25519PublicKey(parsed.data.recovery_public_key);
  } catch {
    return Response.json({ error: "public_key and recovery_public_key must be valid Ed25519 PEM or SPKI keys." }, { status: 400 });
  }
  if (publicKey === recoveryPublicKey) {
    return Response.json({ error: "recovery_public_key must differ from the active public_key." }, { status: 400 });
  }
  if (!validRegistrationProof(parsed.data.public_key, parsed.data.proof_of_work)) {
    return Response.json({ error: "Invalid registration proof of work.", puzzle: registrationPuzzle() }, { status: 422 });
  }

  const apiKey = createApiKey();
  const bootstrapValidator = isBootstrapValidator(publicKey);
  const inviteRequired = registrationRequiresInvite() && !bootstrapValidator;
  if (inviteRequired && !validRegistrationInvite(parsed.data.invite_code)) {
    return Response.json({ error: "A valid one-time registration invite is required for this private trial." }, { status: 403 });
  }
  const inviteCodeHash = inviteRequired ? registrationInviteCodeHash(parsed.data.invite_code!) : null;
  if (inviteCodeHash && await prisma.registrationInviteUse.findUnique({ where: { codeHash: inviteCodeHash } })) {
    return Response.json({ error: "Registration invite has already been used." }, { status: 409 });
  }
  const rateLimit = await enforceRegistrationRateLimit(request);
  if (rateLimit) {
    await emitOpsEvent({ severity: "warning", component: "abuse-rate-limit", eventType: "registration_rate_limited", outcome: "rejected", details: { ...requestOperation(request), scope: rateLimit.scope, limit: rateLimit.limit, retry_after_seconds: rateLimit.retryAfterSeconds } });
    return rateLimitResponse(rateLimit);
  }
  try {
    const agent = await prisma.$transaction(async (transaction) => {
      if (inviteCodeHash) await transaction.registrationInviteUse.create({ data: { codeHash: inviteCodeHash } });
      return transaction.agent.create({ data: {
        name: parsed.data.name,
        description: parsed.data.description,
        ownerType: parsed.data.owner_type,
        agentType: parsed.data.agent_type,
        focusAreas: toJsonArray(parsed.data.focus_areas),
        capabilities: toJsonArray(parsed.data.capabilities),
        limitations: toJsonArray(parsed.data.limitations),
        homepageUrl: parsed.data.homepage_url,
        callbackUrl: parsed.data.callback_url,
        publicKey,
        recoveryPublicKey,
        apiKeyHash: hashToken(apiKey),
        reputationScore: bootstrapValidator ? BOOTSTRAP_VALIDATOR_REPUTATION : 0,
        trustLevel: bootstrapValidator ? "trusted" : "low",
        lastSeenAt: new Date(),
      } });
    });
    return Response.json({ agent_id: agent.id, api_key: apiKey });
  } catch (error: any) {
    if (error?.code === "P2002" && String(error?.meta?.target ?? "").includes("codeHash")) return Response.json({ error: "Registration invite has already been used." }, { status: 409 });
    if (error?.code === "P2002") return Response.json({ error: "public_key or recovery_public_key is already registered." }, { status: 409 });
    throw error;
  }
}
