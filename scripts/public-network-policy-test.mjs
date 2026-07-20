const { isBlockedAddress, isPublicHttpsUrl, publicOutboundRequestPolicy } = await import("../lib/public-network.ts");

const blockedAddresses = [
  "0.0.0.0",
  "10.0.0.1",
  "100.64.0.1",
  "127.0.0.1",
  "169.254.1.1",
  "172.16.0.1",
  "192.0.0.1",
  "192.0.2.1",
  "192.88.99.1",
  "192.168.1.1",
  "198.18.0.1",
  "198.51.100.1",
  "203.0.113.1",
  "224.0.0.1",
  "255.255.255.255",
  "::",
  "::1",
  "::ffff:127.0.0.1",
  "0:0:0:0:0:ffff:c0a8:1",
  "64:ff9b::c000:201",
  "64:ff9b:1::1",
  "100::1",
  "2001::1",
  "2001:db8::1",
  "2002::1",
  "3fff::1",
  "fc00::1",
  "fe80::1",
  "ff02::1",
];
const publicAddresses = [
  "1.1.1.1",
  "8.8.8.8",
  "192.0.8.1",
  "2606:4700:4700::1111",
  "2001:4860:4860::8888",
  "2a00:1450:4001::200e",
];

for (const address of blockedAddresses) {
  if (!isBlockedAddress(address)) throw new Error(`reserved or non-routable address was accepted: ${address}`);
}
for (const address of publicAddresses) {
  if (isBlockedAddress(address)) throw new Error(`public address was blocked: ${address}`);
}
if (isPublicHttpsUrl("https://[2001:db8::1]/callback")) {
  throw new Error("documentation IPv6 literal was accepted as a public callback URL");
}
if (!isPublicHttpsUrl("https://[2606:4700:4700::1111]/callback")) {
  throw new Error("public IPv6 literal was rejected as a callback URL");
}
const policy = publicOutboundRequestPolicy();
if (!Array.isArray(policy.blocked_address_classes) || policy.blocked_address_classes.length < 2) {
  throw new Error("public outbound request policy does not expose blocked IPv4 and IPv6 address classes");
}

process.stdout.write(
  JSON.stringify({
    status: "ok",
    blocked_address_cases: blockedAddresses.length,
    public_address_cases: publicAddresses.length,
    ipv6_special_ranges: ["mapped-private", "nat64", "discard-only", "protocol-assignment", "documentation", "6to4", "ula", "link-local", "multicast"],
  }) + "\n",
);
