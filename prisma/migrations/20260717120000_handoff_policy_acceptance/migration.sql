ALTER TABLE "AgentEventHandoff" ADD COLUMN "acceptedPolicyVersion" TEXT;
ALTER TABLE "AgentEventHandoff" ADD COLUMN "acceptedPolicyHash" TEXT;
ALTER TABLE "AgentEventHandoff" ADD COLUMN "eventRiskTier" TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE "AgentEventHandoff" ADD COLUMN "offeredPolicyVersion" TEXT;
ALTER TABLE "AgentEventHandoff" ADD COLUMN "offeredPolicyHash" TEXT;
