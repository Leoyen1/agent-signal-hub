import { cookies } from "next/headers";
import { adminAgentRevokeSchema } from "@/lib/schemas";
import { prisma } from "@/lib/prisma";
import { timingSafeEqualString, verifyAdminCookie } from "@/lib/crypto";
import { emitOpsEvent, requestOperation } from "@/lib/ops-events";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const cookieStore = await cookies();
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const adminToken = process.env.ADMIN_TOKEN;
  const bearerAllowed = Boolean(bearer && adminToken && timingSafeEqualString(bearer, adminToken));
  if (!bearerAllowed && !verifyAdminCookie(cookieStore.get("ash_admin")?.value)) {
    await emitOpsEvent({
      severity: "warning",
      component: "admin-api",
      eventType: "admin_agent_revoke_unauthorized",
      outcome: "rejected",
      details: requestOperation(request),
    });
    return Response.json({ error: "Admin authentication required." }, { status: 401 });
  }

  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = adminAgentRevokeSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid credential revocation payload.", details: parsed.error.flatten() }, { status: 400 });
  }

  const existing = await prisma.agent.findUnique({
    where: { id },
    select: { id: true, credentialsRevokedAt: true, credentialsRevokedReason: true },
  });
  if (!existing) return Response.json({ error: "Agent not found." }, { status: 404 });
  if (existing.credentialsRevokedAt) {
    return Response.json({
      agent_id: id,
      credential_status: "revoked",
      credentials_revoked_at: existing.credentialsRevokedAt.toISOString(),
      already_revoked: true,
    });
  }

  const revokedAt = new Date();
  await prisma.$transaction([
    prisma.agent.update({
      where: { id },
      data: {
        credentialsRevokedAt: revokedAt,
        credentialsRevokedReason: parsed.data.reason,
      },
    }),
    prisma.adminAction.create({
      data: {
        action: "agent.credentials_revoked",
        targetId: id,
        note: parsed.data.reason,
      },
    }),
  ]);
  await emitOpsEvent({
    severity: "critical",
    component: "admin-api",
    eventType: "agent_credentials_revoked",
    outcome: "success",
    details: {
      ...requestOperation(request),
      agent_id: id,
      revoked_at: revokedAt.toISOString(),
      reason_present: true,
    },
  });
  return Response.json({
    agent_id: id,
    credential_status: "revoked",
    credentials_revoked_at: revokedAt.toISOString(),
    already_revoked: false,
  });
}