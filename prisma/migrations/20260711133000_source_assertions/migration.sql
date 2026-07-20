CREATE TABLE "SourceAssertion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "sourceId" TEXT,
    "host" TEXT,
    "stance" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "evidenceUrls" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SourceAssertion_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "SourceAssertion_agentId_createdAt_idx" ON "SourceAssertion"("agentId", "createdAt");
CREATE INDEX "SourceAssertion_targetType_sourceId_createdAt_idx" ON "SourceAssertion"("targetType", "sourceId", "createdAt");
CREATE INDEX "SourceAssertion_targetType_host_createdAt_idx" ON "SourceAssertion"("targetType", "host", "createdAt");
