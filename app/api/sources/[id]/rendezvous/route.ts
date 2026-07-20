import { sourceRendezvousQuerySchema } from "@/lib/schemas";
import { buildSourceRendezvousForSource } from "@/lib/source-rendezvous";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const url = new URL(request.url);
  const parsed = sourceRendezvousQuerySchema.omit({ source_id: true, target_type: true }).safeParse(Object.fromEntries(url.searchParams.entries()));
  if (!parsed.success) {
    return Response.json({ error: "Invalid source rendezvous query.", details: parsed.error.flatten() }, { status: 400 });
  }

  return Response.json(await buildSourceRendezvousForSource(id, parsed.data), {
    headers: {
      "Cache-Control": "public, max-age=30",
    },
  });
}

