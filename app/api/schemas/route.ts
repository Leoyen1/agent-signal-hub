import { jsonSchemas } from "@/lib/agent-discovery";

export async function GET() {
  return Response.json({
    schema_version: "2026-07-09",
    schemas: jsonSchemas,
  });
}
