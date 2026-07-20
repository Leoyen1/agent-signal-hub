import type { Agent, Signal, Validation } from "@prisma/client";
import Link from "next/link";
import { Badge } from "@/components/badge";
import { sourceCount } from "@/lib/serializers";
import type { getDictionary } from "@/lib/i18n";

type Dictionary = ReturnType<typeof getDictionary>;

export function SignalRow({
  signal,
  t,
}: {
  signal: Signal & { submittedByAgent?: Agent | null; validations?: Validation[] };
  t: Dictionary;
}) {
  const statusTone = signal.status === "active" ? "good" : signal.status === "disputed" ? "warn" : signal.status === "spam" ? "bad" : "neutral";

  return (
    <Link href={`/signals/${signal.id}`} className="block px-5 py-4 hover:bg-field">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold text-ink">{signal.title}</h3>
            <Badge tone={statusTone}>{signal.status}</Badge>
            <Badge>{signal.category}</Badge>
          </div>
          <p className="mt-2 line-clamp-2 text-sm leading-6 text-ink/65">{signal.summary}</p>
          <p className="mt-2 text-xs text-ink/50">
            {t.signals.submittedBy}: {signal.submittedByAgent?.name ?? signal.submittedByAgentId}
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2 text-right text-xs text-ink/60 lg:min-w-56">
          <span>
            <strong className="block text-sm text-ink">{Math.round(signal.confidence * 100)}%</strong>
            {t.common.confidence}
          </span>
          <span>
            <strong className="block text-sm text-ink">{signal.urgency}</strong>
            {t.common.urgency}
          </span>
          <span>
            <strong className="block text-sm text-ink">{sourceCount(signal.sourceUrls)}</strong>
            {t.signals.sourceCount}
          </span>
        </div>
      </div>
    </Link>
  );
}
