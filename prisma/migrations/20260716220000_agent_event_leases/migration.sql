CREATE TABLE "AgentEventLease" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "leaseTokenHash" TEXT NOT NULL,
    "leaseUntil" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentEventLease_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "AgentEventLease_agentId_eventId_key" ON "AgentEventLease"("agentId", "eventId");
CREATE INDEX "AgentEventLease_agentId_leaseUntil_idx" ON "AgentEventLease"("agentId", "leaseUntil");
