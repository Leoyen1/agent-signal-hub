import crypto from "node:crypto";
import { hashToken } from "@/lib/crypto";

export function normalizeEd25519PublicKey(publicKey: string) {
  const key = crypto.createPublicKey(publicKey.trim());
  if (key.asymmetricKeyType !== "ed25519") throw new Error("public key must use Ed25519");
  return key.export({ type: "spki", format: "pem" }).toString().trim();
}

export function publicKeyFingerprint(publicKey: string) {
  return crypto.createHash("sha256").update(publicKey.trim(), "utf8").digest("hex");
}

export function credentialRotationCanonical(agentId: string, newApiKey: string, normalizedPublicKey: string) {
  return [
    "ash-agent-credential-rotation-v1",
    agentId,
    hashToken(newApiKey),
    publicKeyFingerprint(normalizedPublicKey),
  ].join("\n");
}

export function verifyCredentialRotationProof(
  agentId: string,
  newApiKey: string,
  normalizedPublicKey: string,
  proof: string,
) {
  const key = crypto.createPublicKey(normalizedPublicKey);
  try {
    return crypto.verify(
      null,
      Buffer.from(credentialRotationCanonical(agentId, newApiKey, normalizedPublicKey), "utf8"),
      key,
      Buffer.from(proof, "base64"),
    );
  } catch {
    return false;
  }
}
export function credentialRecoveryCanonical(
  agentId: string,
  timestamp: string,
  nonce: string,
  newApiKey: string,
  normalizedPublicKey: string,
  normalizedRecoveryPublicKey: string,
) {
  return [
    "ash-agent-credential-recovery-v1",
    agentId,
    timestamp,
    nonce,
    hashToken(newApiKey),
    publicKeyFingerprint(normalizedPublicKey),
    publicKeyFingerprint(normalizedRecoveryPublicKey),
  ].join("\n");
}

export function verifyCredentialRecoveryProof(
  recoveryPublicKey: string,
  agentId: string,
  timestamp: string,
  nonce: string,
  newApiKey: string,
  normalizedPublicKey: string,
  normalizedRecoveryPublicKey: string,
  signature: string,
) {
  const key = crypto.createPublicKey(recoveryPublicKey);
  try {
    return crypto.verify(
      null,
      Buffer.from(
        credentialRecoveryCanonical(
          agentId,
          timestamp,
          nonce,
          newApiKey,
          normalizedPublicKey,
          normalizedRecoveryPublicKey,
        ),
        "utf8",
      ),
      key,
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}
