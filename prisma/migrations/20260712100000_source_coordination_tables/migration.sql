CREATE TABLE "SourceWatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "sourceId" TEXT,
    "url" TEXT,
    "host" TEXT,
    "label" TEXT,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "rendezvousOptIn" BOOLEAN NOT NULL DEFAULT true,
    "lastCheckedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SourceWatch_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "SourceWatch_agentId_status_idx" ON "SourceWatch"("agentId", "status");
CREATE INDEX "SourceWatch_sourceId_idx" ON "SourceWatch"("sourceId");
CREATE INDEX "SourceWatch_host_idx" ON "SourceWatch"("host");

CREATE TABLE "SourceTaskClaim" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "sourceId" TEXT,
    "host" TEXT,
    "taskType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'claimed',
    "claimUntil" DATETIME NOT NULL,
    "summary" TEXT,
    "resultSummary" TEXT,
    "evidenceUrls" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SourceTaskClaim_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "SourceTaskClaim_agentId_status_idx" ON "SourceTaskClaim"("agentId", "status");
CREATE INDEX "SourceTaskClaim_targetType_sourceId_taskType_status_idx" ON "SourceTaskClaim"("targetType", "sourceId", "taskType", "status");
CREATE INDEX "SourceTaskClaim_targetType_host_taskType_status_idx" ON "SourceTaskClaim"("targetType", "host", "taskType", "status");
CREATE INDEX "SourceTaskClaim_claimUntil_idx" ON "SourceTaskClaim"("claimUntil");