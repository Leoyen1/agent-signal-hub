CREATE TABLE "AgentEventReceipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "acknowledgedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentEventReceipt_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "AgentEventReceipt_agentId_eventId_key" ON "AgentEventReceipt"("agentId", "eventId");
CREATE INDEX "AgentEventReceipt_agentId_acknowledgedAt_idx" ON "AgentEventReceipt"("agentId", "acknowledgedAt");
