"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminLoginSchema, adminSignalActionSchema } from "@/lib/schemas";
import { signAdminCookie, timingSafeEqualString, verifyAdminCookie } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";
import { emitOpsEvent } from "@/lib/ops-events";

export async function setLocaleAction(formData: FormData) {
  const locale = String(formData.get("locale") || "en");
  const cookieStore = await cookies();
  cookieStore.set("ash_locale", locale, {
    httpOnly: false,
    sameSite: "lax",
    path: "/",
    maxAge: 365 * 24 * 60 * 60,
  });
}

export async function adminLoginAction(formData: FormData) {
  const parsed = adminLoginSchema.safeParse({ token: formData.get("token") });
  if (!parsed.success) {
    await emitOpsEvent({ severity: "warning", component: "admin-auth", eventType: "admin_login_invalid", outcome: "rejected" });
    redirect("/admin?error=invalid");
  }

  const expected = process.env.ADMIN_TOKEN;
  if (!expected || !timingSafeEqualString(parsed.data.token, expected)) {
    await emitOpsEvent({ severity: "warning", component: "admin-auth", eventType: "admin_login_denied", outcome: "rejected" });
    redirect("/admin?error=denied");
  }

  const cookieStore = await cookies();
  cookieStore.set("ash_admin", signAdminCookie(parsed.data.token), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 8 * 60 * 60,
  });
  await emitOpsEvent({ severity: "info", component: "admin-auth", eventType: "admin_login_succeeded", outcome: "success" });
  redirect("/admin");
}

export async function adminLogoutAction() {
  const cookieStore = await cookies();
  cookieStore.delete("ash_admin");
  await emitOpsEvent({ severity: "info", component: "admin-auth", eventType: "admin_logout", outcome: "success" });
  redirect("/admin");
}

export async function adminSignalAction(formData: FormData) {
  const cookieStore = await cookies();
  if (!verifyAdminCookie(cookieStore.get("ash_admin")?.value)) {
    await emitOpsEvent({ severity: "warning", component: "admin-actions", eventType: "admin_signal_action_unauthorized", outcome: "rejected" });
    redirect("/admin?error=denied");
  }

  const parsed = adminSignalActionSchema.safeParse({
    signal_id: formData.get("signal_id"),
    status: formData.get("status"),
    note: formData.get("note"),
  });
  if (!parsed.success) {
    await emitOpsEvent({ severity: "warning", component: "admin-actions", eventType: "admin_signal_action_invalid", outcome: "rejected" });
    redirect("/admin?error=invalid-action");
  }

  await prisma.signal.update({
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
    component: "admin-actions",
    eventType: "admin_signal_status_changed",
    outcome: "success",
    details: { signal_id: parsed.data.signal_id, status: parsed.data.status, note_present: Boolean(parsed.data.note) },
  });
  redirect("/admin");
}