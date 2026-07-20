import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";

export class PublicNetworkPolicyError extends Error {}

type ResolvedAddress = { address: string; family: number };

type PublicHttpsRequestOptions = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

export type PublicHttpsResponse = {
  status: number;
  statusText: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  connectedAddress: string;
};

function parseIpv4(address: string) {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

function blockedIpv4(parts: number[]) {
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || parts[0] >= 224 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && (parts[1] === 168 || (parts[1] === 0 && (parts[2] === 0 || parts[2] === 2)) || (parts[1] === 88 && parts[2] === 99))) ||
    (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19 || (parts[1] === 51 && parts[2] === 100))) ||
    (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
}

function ipv6ToBigInt(address: string) {
  let value = address;
  const embeddedIpv4 = value.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  if (embeddedIpv4) {
    const parts = parseIpv4(embeddedIpv4);
    if (!parts) return null;
    value = value.slice(0, -embeddedIpv4.length) + `${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const words = [...left, ...Array(missing).fill("0"), ...right];
  if (words.length !== 8 || words.some((word) => !/^[a-f0-9]{1,4}$/i.test(word))) return null;
  return words.reduce((result, word) => (result << BigInt(16)) | BigInt(Number.parseInt(word, 16)), BigInt(0));
}

function ipv6PrefixMatch(value: bigint, prefix: string, bits: number) {
  const prefixValue = ipv6ToBigInt(prefix);
  if (prefixValue === null) return false;
  const shift = BigInt(128 - bits);
  return value >> shift === prefixValue >> shift;
}

const blockedIpv6Prefixes: [string, number][] = [
  ["::", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
];

export function isBlockedAddress(address: string) {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const ipv4 = parseIpv4(normalized);
  if (ipv4) return blockedIpv4(ipv4);
  if (isIP(normalized) !== 6) return false;

  const ipv6 = ipv6ToBigInt(normalized);
  if (ipv6 === null) return true;
  if (ipv6 >> BigInt(32) === BigInt(0xffff)) {
    const mapped = Number(ipv6 & BigInt(0xffffffff));
    return blockedIpv4([(mapped >>> 24) & 255, (mapped >>> 16) & 255, (mapped >>> 8) & 255, mapped & 255]);
  }
  return blockedIpv6Prefixes.some(([prefix, bits]) => ipv6PrefixMatch(ipv6, prefix, bits));
}

export function isLocalhost(hostname: string) {
  return hostname === "localhost" || isBlockedAddress(hostname);
}

export function isPublicHttpsUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !isLocalhost(url.hostname);
  } catch {
    return false;
  }
}

export async function resolvePublicAddresses(value: string): Promise<ResolvedAddress[]> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PublicNetworkPolicyError("URL is invalid.");
  }
  const literalFamily = isIP(url.hostname);
  let addresses: ResolvedAddress[];
  try {
    addresses = literalFamily
      ? [{ address: url.hostname, family: literalFamily }]
      : await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new PublicNetworkPolicyError("Hostname could not be resolved.");
  }
  if (!addresses.length) throw new PublicNetworkPolicyError("Hostname resolved to no addresses.");
  if (addresses.some(({ address }) => isBlockedAddress(address))) {
    throw new PublicNetworkPolicyError("Hostname resolves to a private, local, reserved, or non-routable address.");
  }
  return addresses;
}

export async function resolvesToPublicAddress(value: string) {
  try {
    await resolvePublicAddresses(value);
    return true;
  } catch {
    return false;
  }
}

export async function requestPublicHttps(value: string, options: PublicHttpsRequestOptions = {}): Promise<PublicHttpsResponse> {
  if (!isPublicHttpsUrl(value)) {
    throw new PublicNetworkPolicyError("Outbound request requires a public HTTPS URL without embedded credentials.");
  }
  const url = new URL(value);
  const addresses = await resolvePublicAddresses(value);
  const selected = addresses[0];
  const lookupPinned: LookupFunction = (_hostname, _options, callback) => {
    callback(null, selected.address, selected.family);
  };
  const timeoutMs = Math.max(250, Math.min(options.timeoutMs ?? 5000, 30_000));
  const maxResponseBytes = Math.max(1, Math.min(options.maxResponseBytes ?? 32 * 1024, 1024 * 1024));
  const body = options.body ?? "";

  return await new Promise<PublicHttpsResponse>((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: options.method ?? "GET",
        headers: options.headers,
        lookup: lookupPinned,
        servername: isIP(url.hostname) ? undefined : url.hostname,
        rejectUnauthorized: true,
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let received = 0;
        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxResponseBytes) {
            response.destroy(new Error(`Response exceeds ${maxResponseBytes} bytes.`));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            statusText: response.statusMessage ?? "",
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            connectedAddress: response.socket.remoteAddress ?? selected.address,
          });
        });
        response.on("error", reject);
      },
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`Request timed out after ${timeoutMs}ms.`)));
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

export function publicOutboundRequestPolicy() {
  return {
    protocols: ["https:"],
    dns_policy: "resolve once; reject any private/local/reserved result; pin the connection to one approved address",
    tls_policy: "validate the certificate and SNI against the original URL hostname while connecting to the pinned IP",
    redirects_followed: false,
    default_timeout_ms: 5000,
    blocked_address_classes: [
      "IPv4 private, loopback, link-local, carrier-grade NAT, benchmarking, documentation, multicast, and reserved ranges",
      "IPv6 unspecified/compatible, mapped-private IPv4, NAT64, discard-only, protocol-assignment, documentation, 6to4, ULA, link-local, and multicast ranges",
    ],
  };
}
