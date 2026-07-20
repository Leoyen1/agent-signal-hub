import { optionalAgent } from "@/lib/auth";
import { buildAgentEvents } from "@/lib/events";
import { agentEventQuerySchema } from "@/lib/schemas";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const url = new URL(request.url);
  const parsed = agentEventQuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()));

  if (!parsed.success) {
    return Response.json({ error: "Invalid event query.", details: parsed.error.flatten() }, { status: 400 });
  }

  const authAgent = await optionalAgent(request);
  const includePrivateEvents = authAgent?.id === id;
  if (parsed.data.unacknowledged_only && !includePrivateEvents) {
    return Response.json({ error: "unacknowledged_only requires authentication as the requested agent." }, { status: 403 });
  }

  const events = await buildAgentEvents(
    id,
    {
    since: parsed.data.since ? new Date(parsed.data.since) : undefined,
    limit: parsed.data.limit,
    },
    {
      includePrivateSourceWatchEvents: includePrivateEvents,
      includeAcknowledgements: includePrivateEvents,
      unacknowledgedOnly: parsed.data.unacknowledged_only ?? false,
    },
  );

  if (!events) {
    return Response.json({ error: "Agent not found." }, { status: 404 });
  }

  return Response.json(events, {
    headers: {
      "Cache-Control": includePrivateEvents ? "private, no-store" : "public, max-age=15",
    },
  });
}
