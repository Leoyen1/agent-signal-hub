import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { prisma } from "@/lib/prisma";

type LimitRule = { scope: string; key: string; limit: number; windowMs: number };

function configuredInteger(name: string, fallback: number, minimum = 1, maximum = 1_000_000) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

function keyHash(value: string) {
  const secret = process.env.ADMIN_COOKIE_SECRET || "development-rate-limit-secret";
  return createHmac("sha256", secret).update(value).digest("hex");
}

export function requestNetworkKey(request: Request) {
  const trustedHops = configuredInteger("ASH_TRUSTED_PROXY_HOPS", 0, 0, 10);
  if (!trustedHops) return "network:unattributed";
  const chain = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const candidate = chain.at(-trustedHops);
  return candidate && isIP(candidate) ? `network:${candidate}` : "network:unattributed";
}

async function consume(rule: LimitRule) {
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / rule.windowMs) * rule.windowMs);
  const expiresAt = new Date(windowStart.getTime() + rule.windowMs * 2);
  const counter = await prisma.abuseRateWindow.upsert({
    where: { scope_keyHash_windowStart: { scope: rule.scope, keyHash: keyHash(rule.key), windowStart } },
    create: { scope: rule.scope, keyHash: keyHash(rule.key), windowStart, count: 1, expiresAt },
    update: { count: { increment: 1 }, expiresAt },
  });
  return { allowed: counter.count <= rule.limit, count: counter.count, limit: rule.limit, retryAfterSeconds: Math.max(1, Math.ceil((windowStart.getTime() + rule.windowMs - now) / 1000)) };
}

async function enforce(rules: LimitRule[]) {
  for (const rule of rules) {
    const result = await consume(rule);
    if (!result.allowed) return { ...result, scope: rule.scope };
  }
  if (Math.random() < 0.01) await prisma.abuseRateWindow.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return null;
}

export async function enforceRegistrationRateLimit(request: Request) {
  const hour = 60 * 60_000;
  return enforce([
    { scope: "registration_global", key: "global", limit: configuredInteger("REGISTRATION_GLOBAL_LIMIT_PER_HOUR", 30), windowMs: hour },
    { scope: "registration_network", key: requestNetworkKey(request), limit: configuredInteger("REGISTRATION_NETWORK_LIMIT_PER_HOUR", 5), windowMs: hour },
  ]);
}

export async function enforceAgentWriteIngressRateLimit(request: Request) {
  const minute = 60_000;
  return enforce([
    { scope: "agent_write_global", key: "global", limit: configuredInteger("AGENT_WRITE_GLOBAL_LIMIT_PER_MINUTE", 300), windowMs: minute },
    { scope: "agent_write_network", key: requestNetworkKey(request), limit: configuredInteger("AGENT_WRITE_NETWORK_LIMIT_PER_MINUTE", 90), windowMs: minute },
  ]);
}

export async function enforceAgentIdentityRateLimit(agentId: string) {
  return enforce([{ scope: "agent_write_agent", key: `agent:${agentId}`, limit: configuredInteger("AGENT_WRITE_AGENT_LIMIT_PER_MINUTE", 120), windowMs: 60_000 }]);
}

export async function enforceAgentWriteRateLimit(request: Request, agentId?: string) {
  const ingress = await enforceAgentWriteIngressRateLimit(request);
  if (ingress || !agentId) return ingress;
  return enforceAgentIdentityRateLimit(agentId);
}

export function rateLimitResponse(result: { scope: string; limit: number; retryAfterSeconds: number }) {
  return Response.json(
    { error: "Node abuse rate limit exceeded.", scope: result.scope, limit: result.limit, retry_after_seconds: result.retryAfterSeconds },
    { status: 429, headers: { "Retry-After": String(result.retryAfterSeconds) } },
  );
}
