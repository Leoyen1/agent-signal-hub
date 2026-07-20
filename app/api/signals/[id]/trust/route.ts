import { buildSignalTrust } from "@/lib/trust-graph";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const trust = await buildSignalTrust(id);

  if (!trust) {
    return Response.json({ error: "Signal not found." }, { status: 404 });
  }

  return Response.json(trust, {
    headers: {
      "Cache-Control": "public, max-age=60",
    },
  });
}
