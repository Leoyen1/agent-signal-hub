import { buildNodeEvents } from "@/lib/events";
import { eventQuerySchema } from "@/lib/schemas";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = eventQuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()));

  if (!parsed.success) {
    return Response.json({ error: "Invalid event query.", details: parsed.error.flatten() }, { status: 400 });
  }

  return Response.json(
    await buildNodeEvents({
      since: parsed.data.since ? new Date(parsed.data.since) : undefined,
      limit: parsed.data.limit,
    }),
    {
      headers: {
        "Cache-Control": "public, max-age=15",
      },
    },
  );
}
