import type { Agent } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/crypto";
import { verifyWriteSignature } from "@/lib/request-signature";
import { emitOpsEvent, requestOperation } from "@/lib/ops-events";
import { enforceAgentIdentityRateLimit, enforceAgentWriteIngressRateLimit, rateLimitResponse } from "@/lib/abuse-rate-limit";

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : null;
}

export async function requireAgent(request: Request): Promise<Agent | Response> {
  const isWrite = !["GET", "HEAD", "OPTIONS"].includes(request.method);
  const token = bearerToken(request);
  if (!token) {
    await emitOpsEvent({
      severity: "warning",
      component: "agent-auth",
      eventType: "bearer_missing",
      outcome: "rejected",
      details: requestOperation(request),
    });
    return Response.json({ error: "Missing Authorization: Bearer <api_key> header." }, { status: 401 });
  }
  const agent = await prisma.agent.findUnique({ where: { apiKeyHash: hashToken(token) } });
  if (!agent) {
    await emitOpsEvent({
      severity: "warning",
      component: "agent-auth",
      eventType: "api_key_invalid",
      outcome: "rejected",
      details: requestOperation(request),
    });
    return Response.json({ error: "Invalid API key." }, { status: 401 });
  }
  if (agent.credentialsRevokedAt) {
    await emitOpsEvent({
      severity: "warning",
      component: "agent-auth",
      eventType: "revoked_agent_credentials_rejected",
      outcome: "rejected",
      details: { ...requestOperation(request), agent_id: agent.id, revoked_at: agent.credentialsRevokedAt.toISOString() },
    });
    return Response.json({ error: "Agent credentials have been revoked." }, { status: 403 });
  }  if (isWrite) {
    const signature = await verifyWriteSignature(request, agent);
    if (!signature.ok) {
      await emitOpsEvent({
        severity: "warning",
        component: "agent-auth",
        eventType: "write_signature_invalid",
        outcome: "rejected",
        details: { ...requestOperation(request), agent_id: agent.id, status: signature.status, reason: signature.error },
      });
      return Response.json({ error: signature.error }, { status: signature.status });
    }
    try {
      await prisma.requestNonce.create({ data: { agentId: agent.id, nonce: signature.nonce, expiresAt: signature.expiresAt } });
    } catch (error: any) {
      if (error?.code === "P2002") {
        await emitOpsEvent({
          severity: "warning",
          component: "agent-auth",
          eventType: "request_replay_rejected",
          outcome: "rejected",
          details: { ...requestOperation(request), agent_id: agent.id },
        });
        return Response.json({ error: "Agent request nonce has already been used." }, { status: 409 });
      }
      throw error;
    }
    const ingressRateLimit = await enforceAgentWriteIngressRateLimit(request);
    if (ingressRateLimit) {
      await emitOpsEvent({ severity: "warning", component: "abuse-rate-limit", eventType: "agent_write_ingress_rate_limited", outcome: "rejected", details: { ...requestOperation(request), agent_id: agent.id, scope: ingressRateLimit.scope, limit: ingressRateLimit.limit, retry_after_seconds: ingressRateLimit.retryAfterSeconds } });
      return rateLimitResponse(ingressRateLimit);
    }
    const identityRateLimit = await enforceAgentIdentityRateLimit(agent.id);
    if (identityRateLimit) {
      await emitOpsEvent({ severity: "warning", component: "abuse-rate-limit", eventType: "agent_write_identity_rate_limited", outcome: "rejected", details: { ...requestOperation(request), agent_id: agent.id, scope: identityRateLimit.scope, limit: identityRateLimit.limit, retry_after_seconds: identityRateLimit.retryAfterSeconds } });
      return rateLimitResponse(identityRateLimit);
    }
    void prisma.requestNonce.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  }
  await prisma.agent.update({ where: { id: agent.id }, data: { lastSeenAt: new Date() } });
  return agent;
}

export async function optionalAgent(request: Request): Promise<Agent | null> {
  const token = bearerToken(request);
  if (!token) return null;
  const agent = await prisma.agent.findUnique({ where: { apiKeyHash: hashToken(token) } });
  return agent?.credentialsRevokedAt ? null : agent;
}
