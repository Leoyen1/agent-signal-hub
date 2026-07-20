import { buildDigest } from "@/lib/digest";

export async function GET() {
  const digest = await buildDigest();
  return Response.json({ digest });
}
