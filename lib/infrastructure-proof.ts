import crypto from "node:crypto";
import type { Agent, AgentInfrastructureClaim, InfrastructureClaimTarget } from "@prisma/client";
import { z } from "zod";
import { publicKeyFingerprint } from "@/lib/agent-credentials";
import { registrableDomain } from "@/lib/quality";
import { isPublicHttpsUrl, PublicNetworkPolicyError, requestPublicHttps } from "@/lib/public-network";

export const INFRASTRUCTURE_PROOF_SCHEMA_VERSION = "ash-agent-infrastructure-proof-v1";
export const INFRASTRUCTURE_PROOF_PATH = "/.well-known/ash-agent-signal-hub.json";
const MAX_PROOF_BYTES = 32 * 1024;

const infrastructureProofSchema = z.object({
  schema_version: z.literal(INFRASTRUCTURE_PROOF_SCHEMA_VERSION),
  agent_id: z.string().min(1),
  target: z.enum(["homepage", "callback"]),
  origin: z.string().url(),
  registrable_domain: z.string().min(1).max(255),
  public_key_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  signature: z.string().min(32).max(512),
});

export type InfrastructureProofDocument = z.infer<typeof infrastructureProofSchema>;
export type InfrastructureProofTransport = typeof requestPublicHttps;

export function infrastructureClaimTtlHours() {
  const configured = Number(process.env.INFRASTRUCTURE_CLAIM_TTL_HOURS ?? 168);
  return Number.isFinite(configured) ? Math.min(720, Math.max(1, configured)) : 168;
}

export function infrastructureClaimWarningHours() {
  const configured = Number(process.env.INFRASTRUCTURE_CLAIM_WARNING_HOURS ?? 24);
  return Number.isFinite(configured) ? Math.min(720, Math.max(1, configured)) : 24;
}

type InfrastructureAgent = Pick<Agent, "id" | "homepageUrl" | "callbackUrl" | "publicKey">;

export function infrastructureClaimDescriptor(agent: InfrastructureAgent, target: InfrastructureClaimTarget) {
  const declaredUrl = target === "homepage" ? agent.homepageUrl : agent.callbackUrl;
  if (!declaredUrl) return { ok: false as const, error: `Agent has no declared ${target} URL.` };

  let url: URL;
  try {
    url = new URL(declaredUrl);
  } catch {
    return { ok: false as const, error: `Declared ${target} URL is invalid.` };
  }
  if (!isPublicHttpsUrl(url.toString())) {
    return { ok: false as const, error: "Infrastructure ownership verification requires a public HTTPS URL without embedded credentials." };
  }

  const origin = url.origin;
  const domain = registrableDomain(url.hostname.toLowerCase());
  return {
    ok: true as const,
    descriptor: {
      target,
      declaredUrl: url.toString(),
      origin,
      registrableDomain: domain,
      proofUrl: new URL(INFRASTRUCTURE_PROOF_PATH, origin).toString(),
    },
  };
}

export function infrastructureProofCanonical(input: {
  agentId: string;
  target: InfrastructureClaimTarget;
  origin: string;
  registrableDomain: string;
  publicKeyFingerprint: string;
}) {
  return [
    INFRASTRUCTURE_PROOF_SCHEMA_VERSION,
    input.agentId,
    input.target,
    input.origin,
    input.registrableDomain,
    input.publicKeyFingerprint,
  ].join("\n");
}

export function verifyInfrastructureProofDocument(
  document: unknown,
  agent: Pick<Agent, "id" | "publicKey">,
  descriptor: { target: InfrastructureClaimTarget; origin: string; registrableDomain: string },
) {
  const parsed = infrastructureProofSchema.safeParse(document);
  if (!parsed.success) return { ok: false as const, error: "Proof document does not match ash-agent-infrastructure-proof-v1." };
  if (!agent.publicKey) return { ok: false as const, error: "Agent has no active public key." };

  const fingerprint = publicKeyFingerprint(agent.publicKey);
  const proof = parsed.data;
  if (
    proof.agent_id !== agent.id ||
    proof.target !== descriptor.target ||
    proof.origin !== descriptor.origin ||
    proof.registrable_domain !== descriptor.registrableDomain ||
    proof.public_key_fingerprint !== fingerprint
  ) {
    return { ok: false as const, error: "Proof document is not bound to the current agent, target, origin, registrable domain, and active key." };
  }

  try {
    const valid = crypto.verify(
      null,
      Buffer.from(
        infrastructureProofCanonical({
          agentId: agent.id,
          target: descriptor.target,
          origin: descriptor.origin,
          registrableDomain: descriptor.registrableDomain,
          publicKeyFingerprint: fingerprint,
        }),
        "utf8",
      ),
      crypto.createPublicKey(agent.publicKey),
      Buffer.from(proof.signature, "base64"),
    );
    return valid
      ? { ok: true as const, document: proof, publicKeyFingerprint: fingerprint }
      : { ok: false as const, error: "Proof document signature is invalid." };
  } catch {
    return { ok: false as const, error: "Proof document signature is invalid." };
  }
}

export async function fetchAndVerifyInfrastructureProof(
  agent: InfrastructureAgent,
  target: InfrastructureClaimTarget,
  options: { transport?: InfrastructureProofTransport; now?: Date } = {},
) {
  const described = infrastructureClaimDescriptor(agent, target);
  if (!described.ok) return described;
  const { descriptor } = described;
  let response;
  try {
    response = await (options.transport ?? requestPublicHttps)(descriptor.proofUrl, {
      method: "GET",
      timeoutMs: 5000,
      maxResponseBytes: MAX_PROOF_BYTES,
      headers: { Accept: "application/json", "User-Agent": "Agent-Signal-Hub/0.1 infrastructure-proof" },
    });
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof PublicNetworkPolicyError ? error.message : "Proof document could not be fetched through the pinned public HTTPS transport.",
      descriptor,
    };
  }
  if (response.status < 200 || response.status >= 300) {
    return { ok: false as const, error: `Proof endpoint returned HTTP ${response.status}.`, descriptor };
  }
  const declaredLengthValue = response.headers["content-length"];
  const declaredLength = Number(Array.isArray(declaredLengthValue) ? declaredLengthValue[0] : declaredLengthValue ?? 0);
  if (declaredLength > MAX_PROOF_BYTES) return { ok: false as const, error: "Proof document exceeds 32 KiB.", descriptor };

  const raw = response.body;
  if (!raw || Buffer.byteLength(raw, "utf8") > MAX_PROOF_BYTES) {
    return { ok: false as const, error: "Proof document is empty or exceeds 32 KiB.", descriptor };
  }
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    return { ok: false as const, error: "Proof endpoint did not return valid JSON.", descriptor };
  }

  const verified = verifyInfrastructureProofDocument(document, agent, descriptor);
  if (!verified.ok) return { ...verified, descriptor };
  const verifiedAt = options.now ? new Date(options.now) : new Date();
  return {
    ok: true as const,
    descriptor,
    publicKeyFingerprint: verified.publicKeyFingerprint,
    proofDocumentHash: crypto.createHash("sha256").update(raw, "utf8").digest("hex"),
    verifiedAt,
    expiresAt: new Date(verifiedAt.getTime() + infrastructureClaimTtlHours() * 3_600_000),
  };
}

export function infrastructureClaimIsActive(
  claim: Pick<AgentInfrastructureClaim, "status" | "publicKeyFingerprint" | "expiresAt">,
  publicKey: string | null | undefined,
  now = Date.now(),
) {
  return Boolean(
    publicKey &&
      claim.status === "verified" &&
      claim.expiresAt &&
      claim.expiresAt.getTime() > now &&
      claim.publicKeyFingerprint === publicKeyFingerprint(publicKey),
  );
}

export function formatInfrastructureClaim(claim: AgentInfrastructureClaim, publicKey?: string | null) {
  return {
    id: claim.id,
    agent_id: claim.agentId,
    target: claim.target,
    declared_url: claim.declaredUrl,
    origin: claim.origin,
    registrable_domain: claim.registrableDomain,
    proof_url: claim.proofUrl,
    status: infrastructureClaimIsActive(claim, publicKey) ? "verified" : claim.status === "verified" ? "stale" : claim.status,
    public_key_fingerprint: claim.publicKeyFingerprint,
    proof_document_hash: claim.proofDocumentHash,
    verified_at: claim.verifiedAt?.toISOString(),
    expires_at: claim.expiresAt?.toISOString(),
    last_checked_at: claim.lastCheckedAt.toISOString(),
    failure_reason: claim.failureReason,
  };
}
