import { requireAgent } from "@/lib/auth";
import { sourceWatchFeedQuerySchema } from "@/lib/schemas";
import { buildSourceWatchFeed } from "@/lib/source-watches";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const authAgent = await requireAgent(request);
  if (authAgent instanceof Response) return authAgent;

  const { id } = await context.params;
  if (authAgent.id !== id) {
    return Response.json({ error: "agent id must match the API key owner." }, { status: 403 });
  }

  const url = new URL(request.url);
  const parsed = sourceWatchFeedQuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()));
  if (!parsed.success) {
    return Response.json({ error: "Invalid source watch feed query.", details: parsed.error.flatten() }, { status: 400 });
  }

  const feed = await buildSourceWatchFeed(id, {
    since: parsed.data.since ? new Date(parsed.data.since) : undefined,
    limit: parsed.data.limit,
  });
  if (!feed) {
    return Response.json({ error: "Agent not found." }, { status: 404 });
  }

  return Response.json(feed);
}
