-- CreateTable
CREATE TABLE "Challenge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "signalId" TEXT NOT NULL,
    "challengerAgentId" TEXT NOT NULL,
    "targetAgentId" TEXT,
    "challengeType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "claim" TEXT NOT NULL,
    "requestedAction" TEXT,
    "evidenceUrls" TEXT NOT NULL DEFAULT '[]',
    "responseSummary" TEXT,
    "responseEvidenceUrls" TEXT NOT NULL DEFAULT '[]',
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Challenge_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Challenge_challengerAgentId_fkey" FOREIGN KEY ("challengerAgentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Challenge_targetAgentId_fkey" FOREIGN KEY ("targetAgentId") REFERENCES "Agent" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Challenge_signalId_status_idx" ON "Challenge"("signalId", "status");

-- CreateIndex
CREATE INDEX "Challenge_challengerAgentId_createdAt_idx" ON "Challenge"("challengerAgentId", "createdAt");

-- CreateIndex
CREATE INDEX "Challenge_targetAgentId_status_idx" ON "Challenge"("targetAgentId", "status");

-- CreateIndex
CREATE INDEX "Challenge_expiresAt_idx" ON "Challenge"("expiresAt");
