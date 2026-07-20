import { sourceQuerySchema } from "@/lib/schemas";
import { buildSourceRegistry } from "@/lib/sources";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = sourceQuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()));

  if (!parsed.success) {
    return Response.json({ error: "Invalid source query.", details: parsed.error.flatten() }, { status: 400 });
  }

  return Response.json(await buildSourceRegistry(parsed.data), {
    headers: {
      "Cache-Control": "public, max-age=60",
    },
  });
}
