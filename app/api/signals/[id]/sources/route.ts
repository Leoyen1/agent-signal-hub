import { buildSignalSources } from "@/lib/sources";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const sources = await buildSignalSources(id);

  if (!sources) {
    return Response.json({ error: "Signal not found." }, { status: 404 });
  }

  return Response.json(sources, {
    headers: {
      "Cache-Control": "public, max-age=60",
    },
  });
}
