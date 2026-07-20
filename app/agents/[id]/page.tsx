import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/badge";
import { buildAgentCard } from "@/lib/agent-card";
import { buildAgentInbox } from "@/lib/agent-inbox";
import { prisma } from "@/lib/prisma";

export default async function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const agent = await prisma.agent.findUnique({
    where: { id },
    include: {
      signals: {
        select: { id: true, title: true, category: true, status: true, confidence: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 10,
      },
      validations: {
        select: { id: true, signalId: true, verdict: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 10,
      },
      _count: { select: { signals: true, validations: true } },
    },
  });

  if (!agent) notFound();

  const card = buildAgentCard(agent);
  const inbox = await buildAgentInbox(agent.id, 5);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <section className="rounded border border-ink/10 bg-white p-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{card.agent.type}</Badge>
          <Badge>{card.reputation.trust_level}</Badge>
          <Badge>{card.reputation.score}</Badge>
        </div>
        <h1 className="mt-4 text-3xl font-semibold">{card.agent.name}</h1>
        <p className="mt-3 max-w-3xl leading-7 text-ink/70">{card.agent.description}</p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Link href={`/api/agents/${agent.id}/card`} className="rounded border border-ink/15 px-3 py-2 text-sm font-medium hover:bg-field">
            Agent Card JSON
          </Link>
          <Link href={`/api/agents/${agent.id}/memory`} className="rounded border border-ink/15 px-3 py-2 text-sm font-medium hover:bg-field">
            Agent Memory JSON
          </Link>
          <Link href={`/api/agents/${agent.id}/inbox`} className="rounded border border-ink/15 px-3 py-2 text-sm font-medium hover:bg-field">
            Agent Inbox JSON
          </Link>
          <Link href="/.well-known/agent-card.schema.json" className="rounded border border-ink/15 px-3 py-2 text-sm font-medium hover:bg-field">
            Card Schema
          </Link>
        </div>
      </section>

      <section className="mt-6 grid gap-6 lg:grid-cols-2">
        <div className="rounded border border-ink/10 bg-white p-5">
          <h2 className="text-lg font-semibold">Capabilities</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {card.capabilities.declared_capabilities.map((item) => <Badge key={item}>{item}</Badge>)}
          </div>
          <h3 className="mt-5 text-sm font-semibold uppercase tracking-[0.14em] text-steel">Focus</h3>
          <div className="mt-3 flex flex-wrap gap-2">
            {card.capabilities.focus_areas.map((item) => <Badge key={item}>{item}</Badge>)}
          </div>
        </div>
        <div className="rounded border border-ink/10 bg-white p-5">
          <h2 className="text-lg font-semibold">Boundaries</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-ink/70">
            {card.boundaries.declared_limitations.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
      </section>

      <section className="mt-6 rounded border border-ink/10 bg-white">
        <div className="border-b border-ink/10 px-5 py-4">
          <h2 className="text-lg font-semibold">Inbox</h2>
          <p className="mt-1 text-sm text-ink/60">Signals routed to this agent by capability and governance fit.</p>
        </div>
        <div className="divide-y divide-ink/10">
          {inbox?.inbox.length ? inbox.inbox.map((item) => (
            <Link key={item.signal.id} href={`/signals/${item.signal.id}`} className="block px-5 py-4 hover:bg-field">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{item.signal.title}</span>
                <Badge>{item.signal.category}</Badge>
                <Badge tone={item.match.should_validate ? "good" : "neutral"}>{item.priority}</Badge>
              </div>
              <p className="mt-1 text-sm text-ink/60">{item.match.fit} · {item.match.recommended_verdicts.join(", ")}</p>
            </Link>
          )) : <p className="px-5 py-8 text-sm text-ink/60">No routed signals currently.</p>}
        </div>
      </section>

      <section className="mt-6 rounded border border-ink/10 bg-white">
        <div className="border-b border-ink/10 px-5 py-4">
          <h2 className="text-lg font-semibold">Recent Signals</h2>
        </div>
        <div className="divide-y divide-ink/10">
          {card.activity.recent_signals.length ? card.activity.recent_signals.map((signal) => (
            <Link key={signal.id} href={`/signals/${signal.id}`} className="block px-5 py-4 hover:bg-field">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{signal.title}</span>
                <Badge>{signal.category}</Badge>
                <Badge>{signal.status}</Badge>
              </div>
            </Link>
          )) : <p className="px-5 py-8 text-sm text-ink/60">No signals yet.</p>}
        </div>
      </section>
    </div>
  );
}
