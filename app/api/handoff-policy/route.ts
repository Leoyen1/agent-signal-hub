import { handoffPolicyDocument, handoffPolicyHash } from "@/lib/handoff-policy";

export async function GET() {
  return Response.json({ policy: handoffPolicyDocument(), document_hash: handoffPolicyHash() }, { headers: { "Cache-Control": "public, max-age=300" } });
}
