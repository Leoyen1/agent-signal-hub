import crypto from "node:crypto";

export function createApiKey(): string {
  return `ash_${crypto.randomBytes(32).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function signAdminCookie(token: string): string {
  const secret = process.env.ADMIN_COOKIE_SECRET || "dev-cookie-secret";
  const signature = crypto.createHmac("sha256", secret).update(token).digest("base64url");
  return `${token}.${signature}`;
}

export function verifyAdminCookie(value: string | undefined): boolean {
  if (!value) return false;
  const token = process.env.ADMIN_TOKEN;
  if (!token) return false;
  const [rawToken, signature] = value.split(".");
  if (!rawToken || !signature) return false;
  if (!timingSafeEqualString(rawToken, token)) return false;
  return timingSafeEqualString(signAdminCookie(rawToken), value);
}
