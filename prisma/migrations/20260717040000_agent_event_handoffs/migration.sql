CREATE TABLE "AgentEventHandoff" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceAgentId" TEXT NOT NULL,
    "targetAgentId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'offered',
    "reason" TEXT NOT NULL,
    "requestedCapabilities" TEXT NOT NULL DEFAULT '[]',
    "eventSnapshot" TEXT NOT NULL,
    "resultSummary" TEXT,
    "evidenceUrls" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentEventHandoff_sourceAgentId_fkey" FOREIGN KEY ("sourceAgentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentEventHandoff_targetAgentId_fkey" FOREIGN KEY ("targetAgentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "AgentEventHandoff_sourceAgentId_status_createdAt_idx" ON "AgentEventHandoff"("sourceAgentId", "status", "createdAt");
CREATE INDEX "AgentEventHandoff_targetAgentId_status_createdAt_idx" ON "AgentEventHandoff"("targetAgentId", "status", "createdAt");
CREATE INDEX "AgentEventHandoff_eventId_status_idx" ON "AgentEventHandoff"("eventId", "status");
