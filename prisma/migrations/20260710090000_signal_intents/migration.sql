-- CreateTable
CREATE TABLE "SignalIntent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "signalId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "intentType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "summary" TEXT NOT NULL,
    "evidenceUrls" TEXT NOT NULL DEFAULT '[]',
    "targetAgentId" TEXT,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SignalIntent_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SignalIntent_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SignalIntent_signalId_createdAt_idx" ON "SignalIntent"("signalId", "createdAt");

-- CreateIndex
CREATE INDEX "SignalIntent_agentId_createdAt_idx" ON "SignalIntent"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "SignalIntent_intentType_status_idx" ON "SignalIntent"("intentType", "status");
