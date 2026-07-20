ALTER TABLE "AgentEventLease" ADD COLUMN "needsReevaluation" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AgentEventLease" ADD COLUMN "failureReason" TEXT;
ALTER TABLE "AgentEventLease" ADD COLUMN "failureDetail" TEXT;
ALTER TABLE "AgentEventLease" ADD COLUMN "reevaluationReportedAt" DATETIME;

CREATE INDEX "AgentEventLease_agentId_needsReevaluation_idx" ON "AgentEventLease"("agentId", "needsReevaluation");
