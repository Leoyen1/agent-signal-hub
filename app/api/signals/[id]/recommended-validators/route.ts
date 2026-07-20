import { recommendedValidatorsForSignal } from "@/lib/validator-matching";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 10) || 10, 50);
  const result = await recommendedValidatorsForSignal(id, limit);

  if (!result) {
    return Response.json({ error: "Signal not found." }, { status: 404 });
  }

  return Response.json(result);
}
