import { cookies } from "next/headers";
import { verifyAdminCookie } from "@/lib/crypto";
import { adminSignalActionSchema } from "@/lib/schemas";
import { prisma } from "@/lib/prisma";
import { emitOpsEvent, requestOperation } from "@/lib/ops-events";

export async function POST(request: Request) {
  const cookieStore = await cookies();
  if (!verifyAdminCookie(cookieStore.get("ash_admin")?.value)) {
    await emitOpsEvent({
      severity: "warning",
      component: "admin-api",
      eventType: "admin_signal_action_unauthorized",
      outcome: "rejected",
      details: requestOperation(request),
    });
    return Response.json({ error: "Admin authentication required." }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  const parsed = adminSignalActionSchema.safeParse(body);
  if (!parsed.success) {
    await emitOpsEvent({
      severity: "warning",
      component: "admin-api",
      eventType: "admin_signal_action_invalid",
      outcome: "rejected",
      details: requestOperation(request),
    });
    return Response.json({ error: "Invalid admin action.", details: parsed.error.flatten() }, { status: 400 });
  }
  const signal = await prisma.signal.update({
    where: { id: parsed.data.signal_id },
    data: { status: parsed.data.status },
  });
  await prisma.adminAction.create({
    data: {
      action: "signal." + parsed.data.status,
      targetId: parsed.data.signal_id,
      note: parsed.data.note,
    },
  });
  await emitOpsEvent({
    severity: "info",
    component: "admin-api",
    eventType: "admin_signal_status_changed",
    outcome: "success",
    details: {
      ...requestOperation(request),
      signal_id: parsed.data.signal_id,
      status: parsed.data.status,
      note_present: Boolean(parsed.data.note),
    },
  });
  return Response.json({ signal });
}