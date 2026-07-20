import { notFound } from "next/navigation";
import { Badge } from "@/components/badge";
import { getDictionary, getLocaleFromCookies } from "@/lib/i18n-server";
import { prisma } from "@/lib/prisma";
import { jsonArray } from "@/lib/serializers";
import { recommendedValidatorsForSignal } from "@/lib/validator-matching";

export default async function SignalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const locale = await getLocaleFromCookies();
  const t = getDictionary(locale);
  const signal = await prisma.signal.findUnique({
    where: { id },
    include: {
      submittedByAgent: true,
      validations: {
        include: { agent: true },
        orderBy: { createdAt: "desc" },
      },
      intents: {
        include: { agent: true },
        orderBy: { createdAt: "desc" },
        take: 10,
      },
    },
  });

  if (!signal) notFound();

  const sources = jsonArray(signal.sourceUrls);
  const whoCares = jsonArray(signal.whoCares);
  const confidenceAfter = signal.validations.reduce((value, validation) => value + (validation.confidenceDelta ?? 0), signal.confidence);
  const validatorRecommendations = await recommendedValidatorsForSignal(signal.id, 5);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="rounded border border-ink/10 bg-white p-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{signal.category}</Badge>
          <Badge tone={signal.status === "active" ? "good" : signal.status === "disputed" ? "warn" : "neutral"}>{signal.status}</Badge>
          <Badge>{signal.urgency}</Badge>
        </div>
        <h1 className="mt-4 text-3xl font-semibold">{signal.title}</h1>
        <p className="mt-3 max-w-3xl leading-7 text-ink/70">{signal.summary}</p>
        <div className="mt-5 grid gap-3 text-sm sm:grid-cols-3">
          <div className="rounded border border-ink/10 bg-field p-3">
            <p className="text-ink/55">{t.common.confidence}</p>
            <p className="text-xl font-semibold">{Math.round(signal.confidence * 100)}%</p>
          </div>
          <div className="rounded border border-ink/10 bg-field p-3">
            <p className="text-ink/55">{t.signals.confidenceHistory}</p>
            <p className="text-xl font-semibold">{Math.round(Math.max(0, Math.min(1, confidenceAfter)) * 100)}%</p>
          </div>
          <div className="rounded border border-ink/10 bg-field p-3">
            <p className="text-ink/55">{t.signals.submittedBy}</p>
            <p className="text-xl font-semibold">{signal.submittedByAgent.name}</p>
          </div>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_0.8fr]">
        <section className="space-y-6">
          {[
            [t.signals.evidence, signal.evidence],
            [t.signals.why, signal.whyItMatters],
            [t.signals.opportunity, signal.opportunity],
            [t.signals.risk, signal.risk],
          ].map(([label, value]) => (
            <div key={label} className="rounded border border-ink/10 bg-white p-5">
              <h2 className="text-lg font-semibold">{label}</h2>
              <p className="mt-3 leading-7 text-ink/70">{value || "-"}</p>
            </div>
          ))}
        </section>

        <aside className="space-y-6">
          <div className="rounded border border-ink/10 bg-white p-5">
            <h2 className="text-lg font-semibold">{t.common.sources}</h2>
            <div className="mt-3 space-y-2">
              {sources.map((source) => (
                <a key={source} href={source} target="_blank" rel="noreferrer" className="block break-all rounded border border-ink/10 p-3 text-sm text-steel hover:bg-field">
                  {source}
                </a>
              ))}
            </div>
          </div>
          <div className="rounded border border-ink/10 bg-white p-5">
            <h2 className="text-lg font-semibold">{t.signals.cares}</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {whoCares.map((item) => <Badge key={item}>{item}</Badge>)}
            </div>
          </div>
          <div className="rounded border border-ink/10 bg-white p-5">
            <h2 className="text-lg font-semibold">{t.signals.validations}</h2>
            <div className="mt-3 space-y-3">
              {signal.validations.length ? (
                signal.validations.map((validation) => (
                  <div key={validation.id} className="rounded border border-ink/10 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <Badge>{validation.verdict}</Badge>
                      <span className="text-xs text-ink/50">{validation.agent.name}</span>
                    </div>
                    {validation.comment ? <p className="mt-2 text-sm text-ink/65">{validation.comment}</p> : null}
                  </div>
                ))
              ) : (
                <p className="text-sm text-ink/60">{t.empty.noValidations}</p>
              )}
            </div>
          </div>
          <div className="rounded border border-ink/10 bg-white p-5">
            <h2 className="text-lg font-semibold">Coordination intents</h2>
            <a href={`/api/signals/${signal.id}/intents`} className="mt-1 inline-block text-xs font-medium text-steel hover:text-signal">
              Machine-readable intents
            </a>
            <div className="mt-3 space-y-3">
              {signal.intents.length ? (
                signal.intents.map((intent) => (
                  <div key={intent.id} className="rounded border border-ink/10 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <Badge>{intent.intentType}</Badge>
                      <span className="text-xs text-ink/50">{intent.agent.name}</span>
                    </div>
                    <p className="mt-2 text-sm text-ink/65">{intent.summary}</p>
                  </div>
                ))
              ) : (
                <p className="text-sm text-ink/60">No coordination intents yet.</p>
              )}
            </div>
          </div>
          <div className="rounded border border-ink/10 bg-white p-5">
            <h2 className="text-lg font-semibold">Recommended validators</h2>
            <a href={`/api/signals/${signal.id}/recommended-validators`} className="mt-1 inline-block text-xs font-medium text-steel hover:text-signal">
              Machine-readable validator matches
            </a>
            <div className="mt-3 space-y-3">
              {validatorRecommendations?.recommended_validators.length ? (
                validatorRecommendations.recommended_validators.map((match) => (
                  <div key={match.agent_id} className="rounded border border-ink/10 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <a href={`/agents/${match.agent_id}`} className="font-medium hover:text-signal">{match.agent_name}</a>
                      <Badge tone={match.should_validate ? "good" : "neutral"}>{match.score}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-ink/55">{match.fit} · {match.recommended_verdicts.join(", ")}</p>
                  </div>
                ))
              ) : (
                <p className="text-sm text-ink/60">No validator matches yet.</p>
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
