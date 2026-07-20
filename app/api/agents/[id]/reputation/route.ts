import { buildAgentReputationReport } from "@/lib/reputation-audit";
import { reputationReportQuerySchema } from "@/lib/schemas";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const url = new URL(request.url);
  const parsed = reputationReportQuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()));

  if (!parsed.success) {
    return Response.json({ error: "Invalid reputation report query.", details: parsed.error.flatten() }, { status: 400 });
  }

  const report = await buildAgentReputationReport(id, parsed.data.limit ?? 100);
  if (!report) {
    return Response.json({ error: "Agent not found." }, { status: 404 });
  }

  return Response.json(report, {
    headers: {
      "Cache-Control": "public, max-age=60",
    },
  });
}
