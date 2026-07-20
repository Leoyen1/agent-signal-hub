import { requireAgent } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sourceWatchUpdateSchema } from "@/lib/schemas";
import { formatSourceWatch, normalizeSourceWatchTarget, sourceWatchPolicy } from "@/lib/source-watches";

export async function GET(request: Request, context: { params: Promise<{ id: string; watchId: string }> }) {
  const authAgent = await requireAgent(request);
  if (authAgent instanceof Response) return authAgent;

  const { id, watchId } = await context.params;
  if (authAgent.id !== id) {
    return Response.json({ error: "agent id must match the API key owner." }, { status: 403 });
  }

  const watch = await prisma.sourceWatch.findFirst({ where: { id: watchId, agentId: id } });
  if (!watch) {
    return Response.json({ error: "Source watch not found." }, { status: 404 });
  }

  return Response.json({ source_watch: formatSourceWatch(watch), policy: sourceWatchPolicy() });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string; watchId: string }> }) {
  const authAgent = await requireAgent(request);
  if (authAgent instanceof Response) return authAgent;

  const { id, watchId } = await context.params;
  if (authAgent.id !== id) {
    return Response.json({ error: "agent id must match the API key owner." }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = sourceWatchUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid source watch update.", details: parsed.error.flatten() }, { status: 400 });
  }

  const existing = await prisma.sourceWatch.findFirst({ where: { id: watchId, agentId: id } });
  if (!existing) {
    return Response.json({ error: "Source watch not found." }, { status: 404 });
  }

  let target: ReturnType<typeof normalizeSourceWatchTarget> | null = null;
  if (parsed.data.source_id || parsed.data.url || parsed.data.host) {
    try {
      target = normalizeSourceWatchTarget(parsed.data);
    } catch {
      return Response.json({ error: "Invalid source watch target." }, { status: 422 });
    }
  }

  const watch = await prisma.sourceWatch.update({
    where: { id: watchId },
    data: {
      sourceId: target ? (target.sourceId ?? null) : undefined,
      url: target ? (target.url ?? null) : undefined,
      host: target ? (target.host ?? null) : undefined,
      label: parsed.data.label,
      reason: parsed.data.reason,
      status: parsed.data.status,
      rendezvousOptIn: parsed.data.rendezvous_opt_in,
    },
  });

  return Response.json({ source_watch: formatSourceWatch(watch), policy: sourceWatchPolicy() });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string; watchId: string }> }) {
  const authAgent = await requireAgent(request);
  if (authAgent instanceof Response) return authAgent;

  const { id, watchId } = await context.params;
  if (authAgent.id !== id) {
    return Response.json({ error: "agent id must match the API key owner." }, { status: 403 });
  }

  const existing = await prisma.sourceWatch.findFirst({ where: { id: watchId, agentId: id } });
  if (!existing) {
    return Response.json({ error: "Source watch not found." }, { status: 404 });
  }

  const watch = await prisma.sourceWatch.update({
    where: { id: watchId },
    data: { status: "revoked" },
  });

  return Response.json({ source_watch: formatSourceWatch(watch), policy: sourceWatchPolicy() });
}
