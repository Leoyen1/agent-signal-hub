import { sourceConflictQuerySchema } from "@/lib/schemas";
import { buildSourceConflicts } from "@/lib/source-conflicts";
import { buildSourceRegistry } from "@/lib/sources";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = sourceConflictQuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()));
  if (!parsed.success) {
    return Response.json({ error: "Invalid source conflict query.", details: parsed.error.flatten() }, { status: 400 });
  }

  const registry = await buildSourceRegistry({
    host: parsed.data.host,
    url: parsed.data.url,
    limit: parsed.data.limit ?? 200,
  });

  return Response.json(await buildSourceConflicts(registry.sources, parsed.data), {
    headers: {
      "Cache-Control": "public, max-age=30",
    },
  });
}
