CREATE TABLE "DomainRelationshipAssertion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "domainA" TEXT NOT NULL,
    "domainB" TEXT NOT NULL,
    "stance" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "evidenceUrls" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DomainRelationshipAssertion_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "DomainRelationshipAssertion_agentId_createdAt_idx" ON "DomainRelationshipAssertion"("agentId", "createdAt");
CREATE INDEX "DomainRelationshipAssertion_domainA_domainB_createdAt_idx" ON "DomainRelationshipAssertion"("domainA", "domainB", "createdAt");
