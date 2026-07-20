ALTER TABLE "AgentEventHandoff" ADD COLUMN "acceptedAt" DATETIME;
ALTER TABLE "AgentEventHandoff" ADD COLUMN "completedAt" DATETIME;
ALTER TABLE "AgentEventHandoff" ADD COLUMN "declinedAt" DATETIME;
ALTER TABLE "AgentEventHandoff" ADD COLUMN "cancelledAt" DATETIME;

CREATE INDEX "AgentEventHandoff_targetAgentId_completedAt_idx" ON "AgentEventHandoff"("targetAgentId", "completedAt");
