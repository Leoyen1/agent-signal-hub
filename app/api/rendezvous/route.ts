import { buildRendezvous } from "@/lib/rendezvous";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 10) || 10, 50);

  return Response.json(await buildRendezvous(limit), {
    headers: {
      "Cache-Control": "public, max-age=60",
    },
  });
}
