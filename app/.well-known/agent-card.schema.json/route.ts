import { agentCardSchema } from "@/lib/agent-card";

export async function GET() {
  return Response.json(agentCardSchema, {
    headers: {
      "Cache-Control": "public, max-age=3600",
    },
  });
}
