process.env.ADMIN_COOKIE_SECRET ||= "integration-cookie-secret-at-least-32-characters";

const { enforceAgentWriteRateLimit, enforceRegistrationRateLimit, requestNetworkKey } = await import("../lib/abuse-rate-limit.ts");
const { prisma } = await import("../lib/prisma.ts");

try {
  await prisma.abuseRateWindow.deleteMany();

  process.env.ASH_TRUSTED_PROXY_HOPS = "0";
  const spoofedOne = new Request("https://hub.example/api/agents/register", { headers: { "x-forwarded-for": "198.51.100.10" } });
  const spoofedTwo = new Request("https://hub.example/api/agents/register", { headers: { "x-forwarded-for": "203.0.113.20" } });
  if (requestNetworkKey(spoofedOne) !== requestNetworkKey(spoofedTwo) || requestNetworkKey(spoofedOne) !== "network:unattributed") {
    throw new Error("untrusted forwarded addresses changed the network rate-limit identity");
  }

  process.env.ASH_TRUSTED_PROXY_HOPS = "1";
  const trustedRequest = new Request("https://hub.example/api/agents/register", { headers: { "x-forwarded-for": "198.51.100.10, 192.0.2.5" } });
  if (requestNetworkKey(trustedRequest) !== "network:192.0.2.5") throw new Error("trusted proxy hop extraction did not select the configured address");

  process.env.REGISTRATION_GLOBAL_LIMIT_PER_HOUR = "2";
  process.env.REGISTRATION_NETWORK_LIMIT_PER_HOUR = "2";
  const registrationResults = [];
  for (let index = 0; index < 3; index += 1) registrationResults.push(await enforceRegistrationRateLimit(trustedRequest));
  if (registrationResults[0] || registrationResults[1] || registrationResults[2]?.scope !== "registration_global") {
    throw new Error(`registration rate limit was not enforced atomically: ${JSON.stringify(registrationResults)}`);
  }

  await prisma.abuseRateWindow.deleteMany();
  process.env.AGENT_WRITE_GLOBAL_LIMIT_PER_MINUTE = "2";
  process.env.AGENT_WRITE_NETWORK_LIMIT_PER_MINUTE = "10";
  const ingressResults = [];
  for (let index = 0; index < 3; index += 1) ingressResults.push(await enforceAgentWriteRateLimit(trustedRequest));
  if (ingressResults[0] || ingressResults[1] || ingressResults[2]?.scope !== "agent_write_global") {
    throw new Error(`unauthenticated write ingress limit was not enforced: ${JSON.stringify(ingressResults)}`);
  }

  await prisma.abuseRateWindow.deleteMany();
  process.env.AGENT_WRITE_GLOBAL_LIMIT_PER_MINUTE = "10";
  process.env.AGENT_WRITE_AGENT_LIMIT_PER_MINUTE = "2";
  const writeResults = [];
  for (let index = 0; index < 3; index += 1) writeResults.push(await enforceAgentWriteRateLimit(trustedRequest, "rate-limit-test-agent"));
  if (writeResults[0] || writeResults[1] || writeResults[2]?.scope !== "agent_write_agent") {
    throw new Error(`agent write rate limit was not enforced atomically: ${JSON.stringify(writeResults)}`);
  }

  process.stdout.write(JSON.stringify({ status: "ok", untrusted_forwarded_headers: "ignored", trusted_proxy_hops: "verified", registration_limit: "verified", unauthenticated_write_ingress_limit: "verified", agent_write_limit: "verified" }) + "\n");
} finally {
  await prisma.abuseRateWindow.deleteMany().catch(() => undefined);
  await prisma.$disconnect();
}
