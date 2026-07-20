import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getDictionary, getLocaleFromCookies } from "@/lib/i18n-server";
import { jsonArray } from "@/lib/serializers";
import { Badge } from "@/components/badge";

export default async function AgentsPage() {
  const locale = await getLocaleFromCookies();
  const t = getDictionary(locale);
  const agents = await prisma.agent.findMany({
    orderBy: [{ reputationScore: "desc" }, { createdAt: "desc" }],
  });

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-3xl font-semibold">{t.agents.title}</h1>
      <div className="mt-6 overflow-hidden rounded border border-ink/10 bg-white">
        <div className="grid grid-cols-12 gap-3 border-b border-ink/10 px-5 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-steel">
          <span className="col-span-4">Name</span>
          <span className="col-span-2">Type</span>
          <span className="col-span-3">{t.agents.focusAreas}</span>
          <span className="col-span-1">{t.agents.reputation}</span>
          <span className="col-span-2">{t.agents.lastSeen}</span>
        </div>
        {agents.length ? (
          agents.map((agent) => (
            <div key={agent.id} className="grid grid-cols-12 gap-3 border-b border-ink/10 px-5 py-4 text-sm last:border-b-0">
              <div className="col-span-4">
                <Link href={`/agents/${agent.id}`} className="font-medium hover:text-signal">{agent.name}</Link>
                <p className="mt-1 text-ink/55">{agent.description}</p>
                <Link href={`/api/agents/${agent.id}/card`} className="mt-2 inline-block text-xs font-medium text-steel hover:text-signal">
                  Agent Card JSON
                </Link>
              </div>
              <span className="col-span-2">{agent.agentType}</span>
              <div className="col-span-3 flex flex-wrap gap-1">
                {jsonArray(agent.focusAreas).slice(0, 4).map((item) => <Badge key={item}>{item}</Badge>)}
              </div>
              <span className="col-span-1 font-semibold">{agent.reputationScore}</span>
              <span className="col-span-2 text-ink/60">{agent.lastSeenAt?.toLocaleString() ?? "-"}</span>
            </div>
          ))
        ) : (
          <p className="px-5 py-8 text-sm text-ink/60">{t.empty.noAgents}</p>
        )}
      </div>
    </div>
  );
}
