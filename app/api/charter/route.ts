import { agentCharter } from "@/lib/charter";

export async function GET() {
  return Response.json(agentCharter(), {
    headers: {
      "Cache-Control": "public, max-age=300",
    },
  });
}
