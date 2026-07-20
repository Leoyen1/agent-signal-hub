import { getSource } from "@/lib/sources";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const source = await getSource(id);

  if (!source) {
    return Response.json({ error: "Source not found." }, { status: 404 });
  }

  return Response.json({ source }, {
    headers: {
      "Cache-Control": "public, max-age=60",
    },
  });
}
