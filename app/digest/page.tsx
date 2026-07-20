import Link from "next/link";
import { Badge } from "@/components/badge";
import { buildDigest } from "@/lib/digest";
import { getDictionary, getLocaleFromCookies } from "@/lib/i18n-server";

export default async function DigestPage() {
  const locale = await getLocaleFromCookies();
  const t = getDictionary(locale);
  const digest = await buildDigest();

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="rounded border border-ink/10 bg-white p-6">
        <p className="text-sm font-semibold uppercase tracking-[0.16em] text-steel">{digest.generatedAt.toLocaleString()}</p>
        <h1 className="mt-2 text-3xl font-semibold">{t.digest.title}</h1>
        <p className="mt-3 text-ink/60">{digest.signals.length} {t.digest.signalsIncluded}</p>
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section className="rounded border border-ink/10 bg-white p-5">
          <h2 className="text-xl font-semibold">{t.digest.takeaways}</h2>
          <ul className="mt-4 space-y-3">
            {digest.keyTakeaways.map((item) => (
              <li key={item} className="rounded border border-ink/10 bg-field p-3 text-sm">{item}</li>
            ))}
          </ul>
        </section>
        <section className="rounded border border-ink/10 bg-white p-5">
          <h2 className="text-xl font-semibold">{t.digest.recommendations}</h2>
          <ul className="mt-4 space-y-3">
            {digest.recommendedActions.map((item) => (
              <li key={item} className="rounded border border-ink/10 bg-field p-3 text-sm">{item}</li>
            ))}
          </ul>
        </section>
      </div>
      <section className="mt-6 rounded border border-ink/10 bg-white">
        <div className="border-b border-ink/10 px-5 py-4">
          <h2 className="text-xl font-semibold">{t.nav.signals}</h2>
        </div>
        <div className="divide-y divide-ink/10">
          {digest.signals.length ? digest.signals.map((signal) => (
            <Link key={signal.id} href={`/signals/${signal.id}`} className="block px-5 py-4 hover:bg-field">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold">{signal.title}</h3>
                <Badge>{signal.category}</Badge>
                <Badge tone="good">{Math.round(signal.confidence * 100)}%</Badge>
              </div>
              <p className="mt-2 text-sm text-ink/65">{signal.summary}</p>
            </Link>
          )) : (
            <p className="px-5 py-8 text-sm text-ink/60">{t.empty.noSignals}</p>
          )}
        </div>
      </section>
    </div>
  );
}
