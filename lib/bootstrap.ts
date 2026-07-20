import { createHash } from "node:crypto";
export const BOOTSTRAP_VALIDATOR_REPUTATION = 80;
export function isBootstrapValidator(publicKey: string) {
  const fingerprints = (process.env.BOOTSTRAP_VALIDATOR_PUBLIC_KEY_FINGERPRINTS ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  return fingerprints.includes(createHash("sha256").update(publicKey.trim(), "utf8").digest("hex"));
}