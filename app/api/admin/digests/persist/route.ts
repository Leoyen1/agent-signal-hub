import { cookies } from "next/headers";
import { persistDigestSnapshot } from "@/lib/digest";
import { timingSafeEqualString, verifyAdminCookie } from "@/lib/crypto";
import { emitOpsEvent, requestOperation } from "@/lib/ops-events";

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const adminToken = process.env.ADMIN_TOKEN;
  const bearerAllowed = Boolean(bearer && adminToken && timingSafeEqualString(bearer, adminToken));
  if (!bearerAllowed && !verifyAdminCookie(cookieStore.get("ash_admin")?.value)) {
    await emitOpsEvent({
      severity: "warning",
      component: "admin-api",
      eventType: "admin_digest_persist_unauthorized",
      outcome: "rejected",
      details: requestOperation(request),
    });
    return Response.json({ error: "Admin authentication required." }, { status: 401 });
  }
  const result = await persistDigestSnapshot();
  await emitOpsEvent({
    severity: "info",
    component: "digest-maintenance",
    eventType: "digest_snapshot_persisted",
    outcome: "success",
    details: {
      ...requestOperation(request),
      digest_id: result.digest.id,
      created: result.created,
      bucket_start: result.bucketStart.toISOString(),
    },
  });
  return Response.json(
    {
      created: result.created,
      bucket_start: result.bucketStart.toISOString(),
      digest: {
        id: result.digest.id,
        title: result.digest.title,
        generated_at: result.digest.generatedAt.toISOString(),
      },
    },
    { status: result.created ? 201 : 200 },
  );
}