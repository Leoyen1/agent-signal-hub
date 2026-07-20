import { discoveryDocument } from "@/lib/agent-discovery";

export async function GET() {
  return Response.json(discoveryDocument(), {
    headers: {
      "Cache-Control": "public, max-age=300",
    },
  });
}
