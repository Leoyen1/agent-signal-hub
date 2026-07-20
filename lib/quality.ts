import type { Prisma } from "@prisma/client";
import { getDomain } from "tldts";
import type { DomainControllerIndex } from "@/lib/domain-relationships";
import { prisma } from "@/lib/prisma";

function hostFromUrl(value: string): string | null {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; }
}

export function sourceHosts(urls: string[]): Set<string> {
  return new Set(urls.map(hostFromUrl).filter((host): host is string => Boolean(host)));
}

export function registrableDomain(host: string): string {
  return getDomain(host, { allowPrivateDomains: true }) ?? host;
}

export function sourceRegistrableDomains(urls: string[]): Set<string> {
  return new Set([...sourceHosts(urls)].map(registrableDomain));
}

export function independentSourceCount(urls: string[], controllerIndex?: DomainControllerIndex): number {
  const domains = sourceRegistrableDomains(urls);
  return controllerIndex ? controllerIndex.collapseDomains(domains).size : domains.size;
}

export function hasExternalSource(urls: string[]): boolean {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://127.0.0.1:3000";
  const ownHost = hostFromUrl(appUrl);
  return urls.some((url) => { const host = hostFromUrl(url); return host && host !== ownHost; });
}

export async function checkSignalQuality(input: { title: string; source_urls: string[]; confidence: number; submitted_by_agent_id: string }) {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!hasExternalSource(input.source_urls)) errors.push("source_urls cannot all point to this site.");
  const { buildDomainControllerIndex } = await import("@/lib/domain-relationships");
  const controllerIndex = await buildDomainControllerIndex();
  const sourceDomains = sourceRegistrableDomains(input.source_urls);
  const quarantinedDomains = controllerIndex.quarantinedDomainsFor(sourceDomains);
  const independentControllers = independentSourceCount(input.source_urls, controllerIndex);
  if (quarantinedDomains.length) errors.push(`source domains are in controller-relationship quarantine: ${quarantinedDomains.join(", ")}`);
  if (input.confidence > 0.95 && independentControllers < 2) errors.push("confidence above 0.95 requires at least 2 independently controlled source domains.");
  const linkedGroups = controllerIndex.linkedGroupsFor(sourceDomains);
  if (linkedGroups.length) warnings.push(`Source domains share established controller groups: ${linkedGroups.map((group) => group.domains.join("+")).join(", ")}`);
  const oneMinuteAgo = new Date(Date.now() - 60_000);
  const recentCount = await prisma.signal.count({ where: { submittedByAgentId: input.submitted_by_agent_id, createdAt: { gte: oneMinuteAgo } } });
  if (recentCount >= 5) errors.push("Rate limit exceeded: one agent can submit at most 5 signals per minute.");
  const titleMatch = await prisma.signal.findFirst({ where: { title: { equals: input.title } }, select: { id: true, title: true } });
  if (titleMatch) warnings.push(`Possible duplicate title: ${titleMatch.id}`);
  const sourceOverlap = await prisma.signal.findMany({ where: { OR: input.source_urls.map((url) => ({ sourceUrls: { contains: url } })) as Prisma.SignalWhereInput[] }, select: { id: true }, take: 3 });
  if (sourceOverlap.length) warnings.push(`Possible duplicate sources: ${sourceOverlap.map((item) => item.id).join(", ")}`);
  return { errors, warnings, source_independence: { registrable_domains: sourceDomains.size, controller_groups: independentControllers, linked_groups: linkedGroups, quarantined_domains: quarantinedDomains } };
}
