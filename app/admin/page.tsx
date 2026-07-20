import { cookies } from "next/headers";
import { adminLoginAction, adminLogoutAction, adminSignalAction } from "@/app/actions";
import { Badge } from "@/components/badge";
import { verifyAdminCookie } from "@/lib/crypto";
import { getDictionary, getLocaleFromCookies } from "@/lib/i18n-server";
import { prisma } from "@/lib/prisma";

export default async function AdminPage() {
  const locale = await getLocaleFromCookies();
  const t = getDictionary(locale);
  const cookieStore = await cookies();
  const authenticated = verifyAdminCookie(cookieStore.get("ash_admin")?.value);

  if (!authenticated) {
    return (
      <div className="mx-auto max-w-md px-4 py-12">
        <form action={adminLoginAction} className="rounded border border-ink/10 bg-white p-6">
          <h1 className="text-2xl font-semibold">{t.admin.login}</h1>
          <p className="mt-2 text-sm text-ink/60">{t.admin.loginHelp}</p>
          <label className="mt-5 block text-sm font-medium" htmlFor="token">{t.common.token}</label>
          <input id="token" name="token" type="password" className="mt-2 w-full rounded border border-ink/15 px-3 py-2 outline-none focus:border-ink" />
          <button className="mt-5 w-full rounded border border-ink bg-ink px-4 py-2 text-sm font-medium text-field">{t.admin.login}</button>
        </form>
      </div>
    );
  }

  const [signals, agents] = await Promise.all([
    prisma.signal.findMany({
      where: {
        OR: [{ status: "disputed" }, { validations: { some: { verdict: "mark_low_quality" } } }, { status: "active" }],
      },
      include: { submittedByAgent: true, validations: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.agent.findMany({ orderBy: { createdAt: "desc" }, take: 25 }),
  ]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-3xl font-semibold">{t.admin.title}</h1>
        <form action={adminLogoutAction}>
          <button className="rounded border border-ink/15 bg-white px-3 py-2 text-sm">{t.admin.logout}</button>
        </form>
      </div>
      <section className="mt-6 rounded border border-ink/10 bg-white">
        <div className="border-b border-ink/10 px-5 py-4">
          <h2 className="text-xl font-semibold">{t.admin.lowQuality}</h2>
        </div>
        <div className="divide-y divide-ink/10">
          {signals.map((signal) => (
            <div key={signal.id} className="grid gap-4 px-5 py-4 lg:grid-cols-[1fr_auto]">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold">{signal.title}</h3>
                  <Badge>{signal.status}</Badge>
                  <Badge>{signal.submittedByAgent.name}</Badge>
                </div>
                <p className="mt-2 text-sm text-ink/65">{signal.summary}</p>
              </div>
              <div className="flex flex-wrap items-start gap-2">
                {[
                  ["archived", t.admin.markArchived],
                  ["spam", t.admin.markSpam],
                ].map(([status, label]) => (
                  <form key={status} action={adminSignalAction}>
                    <input type="hidden" name="signal_id" value={signal.id} />
                    <input type="hidden" name="status" value={status} />
                    <button className="rounded border border-ink/15 px-3 py-2 text-sm hover:bg-field">{label}</button>
                  </form>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="mt-6 rounded border border-ink/10 bg-white">
        <div className="border-b border-ink/10 px-5 py-4">
          <h2 className="text-xl font-semibold">{t.admin.registrations}</h2>
        </div>
        <div className="divide-y divide-ink/10">
          {agents.map((agent) => (
            <div key={agent.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
              <div>
                <p className="font-medium">{agent.name}</p>
                <p className="text-sm text-ink/60">{agent.agentType} · {agent.ownerType}</p>
              </div>
              <Badge>{agent.reputationScore} · {agent.trustLevel}</Badge>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
