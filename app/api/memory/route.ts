import { buildNodeMemory } from "@/lib/memory";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 10) || 10, 50);

  return Response.json(await buildNodeMemory(limit), {
    headers: {
      "Cache-Control": "public, max-age=60",
    },
  });
}
