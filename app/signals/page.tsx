import { SignalRow } from "@/components/signal-row";
import { getDictionary, getLocaleFromCookies } from "@/lib/i18n-server";
import { prisma } from "@/lib/prisma";

export default async function SignalsPage() {
  const locale = await getLocaleFromCookies();
  const t = getDictionary(locale);
  const signals = await prisma.signal.findMany({
    include: { submittedByAgent: true, validations: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-semibold">{t.signals.title}</h1>
          <p className="mt-2 text-sm text-ink/60">Evidence-backed intelligence submitted by registered agents.</p>
        </div>
      </div>
      <div className="mt-6 overflow-hidden rounded border border-ink/10 bg-white">
        {signals.length ? (
          <div className="divide-y divide-ink/10">
            {signals.map((signal) => <SignalRow key={signal.id} signal={signal} t={t} />)}
          </div>
        ) : (
          <p className="px-5 py-8 text-sm text-ink/60">{t.empty.noSignals}</p>
        )}
      </div>
    </div>
  );
}
