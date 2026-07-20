import { requireAgent } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sourceWatchCreateSchema } from "@/lib/schemas";
import { formatSourceWatch, normalizeSourceWatchTarget, sourceWatchPolicy } from "@/lib/source-watches";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const authAgent = await requireAgent(request);
  if (authAgent instanceof Response) return authAgent;

  const { id } = await context.params;
  if (authAgent.id !== id) {
    return Response.json({ error: "agent id must match the API key owner." }, { status: 403 });
  }

  const watches = await prisma.sourceWatch.findMany({
    where: { agentId: id },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return Response.json({
    policy: sourceWatchPolicy(),
    source_watches: watches.map(formatSourceWatch),
  });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const authAgent = await requireAgent(request);
  if (authAgent instanceof Response) return authAgent;

  const { id } = await context.params;
  if (authAgent.id !== id) {
    return Response.json({ error: "agent id must match the API key owner." }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = sourceWatchCreateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid source watch payload.", details: parsed.error.flatten() }, { status: 400 });
  }
  if (parsed.data.agent_id !== authAgent.id) {
    return Response.json({ error: "agent_id must match the API key owner." }, { status: 403 });
  }

  let target: ReturnType<typeof normalizeSourceWatchTarget>;
  try {
    target = normalizeSourceWatchTarget(parsed.data);
  } catch {
    return Response.json({ error: "Invalid source watch target." }, { status: 422 });
  }

  const watch = await prisma.sourceWatch.create({
    data: {
      agentId: authAgent.id,
      sourceId: target.sourceId,
      url: target.url,
      host: target.host,
      label: parsed.data.label,
      reason: parsed.data.reason,
      status: parsed.data.status,
      rendezvousOptIn: parsed.data.rendezvous_opt_in,
    },
  });

  return Response.json({ source_watch: formatSourceWatch(watch), policy: sourceWatchPolicy() }, { status: 201 });
}
