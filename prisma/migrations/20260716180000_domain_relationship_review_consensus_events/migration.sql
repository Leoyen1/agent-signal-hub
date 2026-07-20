CREATE TABLE "DomainRelationshipReviewConsensusEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "relationshipTargetId" TEXT NOT NULL,
    "domainA" TEXT NOT NULL,
    "domainB" TEXT NOT NULL,
    "previousState" TEXT,
    "currentState" TEXT NOT NULL,
    "conclusionCounts" TEXT NOT NULL DEFAULT '{}',
    "countedAgentIds" TEXT NOT NULL DEFAULT '{}',
    "triggeringClaimId" TEXT NOT NULL,
    "triggeringAgentId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "DomainRelationshipReviewConsensusEvent_relationshipTargetId_createdAt_idx" ON "DomainRelationshipReviewConsensusEvent"("relationshipTargetId", "createdAt");
CREATE INDEX "DomainRelationshipReviewConsensusEvent_createdAt_idx" ON "DomainRelationshipReviewConsensusEvent"("createdAt");
