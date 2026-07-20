import { hashToken } from "@/lib/crypto";

const prefix = "ash-registration-v1";

export function registrationPuzzle() {
  const publicRegistration = process.env.ASH_PUBLIC_REGISTRATION_ENABLED === "true";
  const fallback = publicRegistration ? 5 : 3;
  const difficulty = Math.max(2, Math.min(8, Number(process.env.REGISTRATION_POW_DIFFICULTY ?? fallback)) || fallback);
  return { date: new Date().toISOString().slice(0, 10), difficulty, algorithm: "sha256", format: `${prefix}:<UTC date>:<public key>:<nonce>` };
}

export function validRegistrationProof(publicKey: string, nonce: string) {
  const puzzle = registrationPuzzle();
  const digest = hashToken(`${prefix}:${puzzle.date}:${publicKey}:${nonce}`);
  return digest.startsWith("0".repeat(puzzle.difficulty));
}

export function registrationInviteHashes() {
  return new Set((process.env.REGISTRATION_INVITE_CODE_HASHES ?? "").split(",").map((value) => value.trim().toLowerCase()).filter((value) => /^[a-f0-9]{64}$/.test(value)));
}

export function registrationInviteCodeHash(code: string) {
  return hashToken(`ash-registration-invite-v1:${code}`);
}

export function registrationRequiresInvite() {
  return process.env.ASH_PUBLIC_REGISTRATION_ENABLED !== "true" && (process.env.NODE_ENV === "production" || registrationInviteHashes().size > 0);
}

export function validRegistrationInvite(code: string | undefined) {
  return Boolean(code && registrationInviteHashes().has(registrationInviteCodeHash(code)));
}
