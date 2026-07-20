import { cookies } from "next/headers";
import { timingSafeEqualString, verifyAdminCookie } from "@/lib/crypto";
import { persistDigestSnapshot } from "@/lib/digest";
import { refreshDueInfrastructureClaims } from "@/lib/infrastructure-maintenance";
import { syncHandoffPolicyVersion } from "@/lib/handoff-policy";
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
      eventType: "admin_maintenance_run_unauthorized",
      outcome: "rejected",
      details: requestOperation(request),
    });
    return Response.json({ error: "Admin authentication required." }, { status: 401 });
  }

  const policyVersion = await syncHandoffPolicyVersion();
  const infrastructure = await refreshDueInfrastructureClaims();
  const digest = await persistDigestSnapshot();
  await emitOpsEvent({
    severity: "info",
    component: "digest-maintenance",
    eventType: "digest_snapshot_persisted",
    outcome: "success",
    details: {
      ...requestOperation(request),
      digest_id: digest.digest.id,
      created: digest.created,
      bucket_start: digest.bucketStart.toISOString(),
    },
  });
  await emitOpsEvent({
    severity: infrastructure.failed > 0 ? "warning" : "info",
    component: "maintenance",
    eventType: "maintenance_cycle_completed",
    outcome: infrastructure.failed > 0 ? "observed" : "success",
    details: {
      ...requestOperation(request),
      digest_id: digest.digest.id,
      digest_created: digest.created,
      infrastructure_processed: infrastructure.processed,
      infrastructure_refreshed: infrastructure.refreshed,
      infrastructure_deferred: infrastructure.deferred,
      infrastructure_failed: infrastructure.failed,
      handoff_policy_version: policyVersion.event.version,
      handoff_policy_version_created: policyVersion.created,
    },
  });

  return Response.json(
    {
      infrastructure_refresh: infrastructure,
      handoff_policy: {
        version: policyVersion.event.version,
        document_hash: policyVersion.event.documentHash,
        previous_version: policyVersion.event.previousVersion,
        event_created: policyVersion.created,
      },
      digest: {
        id: digest.digest.id,
        title: digest.digest.title,
        generated_at: digest.digest.generatedAt.toISOString(),
        created: digest.created,
        bucket_start: digest.bucketStart.toISOString(),
      },
    },
    { status: digest.created ? 201 : 200 },
  );
}
