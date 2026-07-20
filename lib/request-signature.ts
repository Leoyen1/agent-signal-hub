import crypto from "node:crypto";
import type { Agent } from "@prisma/client";
import { hashToken } from "@/lib/crypto";

const maxAgeMs = 5 * 60_000;

export async function verifyWriteSignature(request: Request, agent: Agent) {
  const timestamp = request.headers.get("x-ash-timestamp");
  const nonce = request.headers.get("x-ash-nonce");
  const signature = request.headers.get("x-ash-signature");
  if (!timestamp || !nonce || !signature) return { ok: false as const, status: 401, error: "Missing agent request signature headers." };
  const issuedAt = new Date(timestamp);
  if (Number.isNaN(issuedAt.getTime()) || Math.abs(Date.now() - issuedAt.getTime()) > maxAgeMs) return { ok: false as const, status: 401, error: "Agent request signature timestamp is outside the five-minute window." };
  let publicKey: crypto.KeyObject;
  try { publicKey = crypto.createPublicKey(agent.publicKey ?? ""); } catch { return { ok: false as const, status: 401, error: "Registered agent public key is invalid." }; }
  const bodyHash = hashToken(await request.clone().text());
  const canonical = `${timestamp}\n${nonce}\n${request.method.toUpperCase()}\n${new URL(request.url).pathname}\n${bodyHash}`;
  let valid = false;
  try { valid = crypto.verify(null, Buffer.from(canonical), publicKey, Buffer.from(signature, "base64")); } catch { valid = false; }
  if (!valid) return { ok: false as const, status: 401, error: "Invalid agent request signature." };
  return { ok: true as const, nonce, expiresAt: new Date(issuedAt.getTime() + maxAgeMs) };
}