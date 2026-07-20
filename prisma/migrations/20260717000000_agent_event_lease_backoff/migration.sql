ALTER TABLE "AgentEventLease" ADD COLUMN "failureCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AgentEventLease" ADD COLUMN "nextAvailableAt" DATETIME;
ALTER TABLE "AgentEventLease" ADD COLUMN "lastExpiredLeaseUntil" DATETIME;

CREATE INDEX "AgentEventLease_agentId_nextAvailableAt_idx" ON "AgentEventLease"("agentId", "nextAvailableAt");
