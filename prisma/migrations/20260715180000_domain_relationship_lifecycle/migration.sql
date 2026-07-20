PRAGMA foreign_keys=OFF;

CREATE TABLE "new_DomainRelationshipAssertion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "domainA" TEXT NOT NULL,
    "domainB" TEXT NOT NULL,
    "stance" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "summary" TEXT NOT NULL,
    "evidenceUrls" TEXT NOT NULL DEFAULT '[]',
    "expiresAt" DATETIME NOT NULL,
    "withdrawnAt" DATETIME,
    "supersedesAssertionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DomainRelationshipAssertion_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_DomainRelationshipAssertion" ("id", "agentId", "domainA", "domainB", "stance", "status", "summary", "evidenceUrls", "expiresAt", "createdAt", "updatedAt")
SELECT "id", "agentId", "domainA", "domainB", "stance", 'active', "summary", "evidenceUrls", datetime("createdAt", '+30 days'), "createdAt", "updatedAt"
FROM "DomainRelationshipAssertion";

DROP TABLE "DomainRelationshipAssertion";
ALTER TABLE "new_DomainRelationshipAssertion" RENAME TO "DomainRelationshipAssertion";

CREATE INDEX "DomainRelationshipAssertion_agentId_createdAt_idx" ON "DomainRelationshipAssertion"("agentId", "createdAt");
CREATE INDEX "DomainRelationshipAssertion_domainA_domainB_createdAt_idx" ON "DomainRelationshipAssertion"("domainA", "domainB", "createdAt");
CREATE INDEX "DomainRelationshipAssertion_status_expiresAt_idx" ON "DomainRelationshipAssertion"("status", "expiresAt");
CREATE INDEX "DomainRelationshipAssertion_supersedesAssertionId_idx" ON "DomainRelationshipAssertion"("supersedesAssertionId");

PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
