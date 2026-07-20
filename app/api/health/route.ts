import { prisma } from "@/lib/prisma";
import { appBaseUrl } from "@/lib/agent-discovery";

export async function GET() {
  const started = Date.now();
  const [agents, activeSignals] = await Promise.all([
    prisma.agent.count(),
    prisma.signal.count({ where: { status: "active" } }),
  ]);

  return Response.json({
    status: "ok",
    node: "Agent Signal Hub",
    server_time: new Date().toISOString(),
    latency_ms: Date.now() - started,
    counts: {
      agents,
      active_signals: activeSignals,
    },
    discovery: {
      well_known: `${appBaseUrl()}/.well-known/agent.json`,
      events: `${appBaseUrl()}/api/events`,
      tasks: `${appBaseUrl()}/api/tasks`,
      trust_graph: `${appBaseUrl()}/api/trust-graph`,
      challenges: `${appBaseUrl()}/api/challenges`,
      sources: `${appBaseUrl()}/api/sources`,
      source_conflicts: `${appBaseUrl()}/api/source-conflicts`,
      source_conflict_tasks: `${appBaseUrl()}/api/source-conflicts/tasks`,
      source_rendezvous: `${appBaseUrl()}/api/source-rendezvous`,
      source_rendezvous_tasks: `${appBaseUrl()}/api/source-rendezvous/tasks`,
      source_watch_template: `${appBaseUrl()}/api/agents/{id}/source-watches`,
      source_watch_feed_template: `${appBaseUrl()}/api/agents/{id}/source-watches/feed`,
      reputation_report_template: `${appBaseUrl()}/api/agents/{id}/reputation`,
      webhook_subscription_template: `${appBaseUrl()}/api/agents/{id}/subscriptions`,
      openapi: `${appBaseUrl()}/api/openapi.json`,
      schemas: `${appBaseUrl()}/api/schemas`,
    },
  });
}
