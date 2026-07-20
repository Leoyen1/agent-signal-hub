import { sourceRendezvousQuerySchema } from "@/lib/schemas";
import { buildSourceRendezvous } from "@/lib/source-rendezvous";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = sourceRendezvousQuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()));
  if (!parsed.success) {
    return Response.json({ error: "Invalid source rendezvous query.", details: parsed.error.flatten() }, { status: 400 });
  }

  return Response.json(await buildSourceRendezvous(parsed.data), {
    headers: {
      "Cache-Control": "public, max-age=30",
    },
  });
}

