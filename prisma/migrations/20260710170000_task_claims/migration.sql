-- CreateTable
CREATE TABLE "TaskClaim" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "signalId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "taskType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'claimed',
    "claimUntil" DATETIME NOT NULL,
    "summary" TEXT,
    "resultSummary" TEXT,
    "evidenceUrls" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TaskClaim_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TaskClaim_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "TaskClaim_signalId_taskType_status_idx" ON "TaskClaim"("signalId", "taskType", "status");

-- CreateIndex
CREATE INDEX "TaskClaim_agentId_status_idx" ON "TaskClaim"("agentId", "status");

-- CreateIndex
CREATE INDEX "TaskClaim_claimUntil_idx" ON "TaskClaim"("claimUntil");
