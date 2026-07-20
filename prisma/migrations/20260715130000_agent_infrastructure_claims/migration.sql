CREATE TABLE "AgentInfrastructureClaim" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "agentId" TEXT NOT NULL,
  "target" TEXT NOT NULL,
  "declaredUrl" TEXT NOT NULL,
  "origin" TEXT NOT NULL,
  "registrableDomain" TEXT NOT NULL,
  "proofUrl" TEXT NOT NULL,
  "publicKeyFingerprint" TEXT NOT NULL,
  "proofDocumentHash" TEXT,
  "status" TEXT NOT NULL DEFAULT 'verified',
  "verifiedAt" DATETIME,
  "expiresAt" DATETIME,
  "lastCheckedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "failureReason" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "AgentInfrastructureClaim_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AgentInfrastructureClaim_agentId_target_key" ON "AgentInfrastructureClaim"("agentId", "target");
CREATE INDEX "AgentInfrastructureClaim_status_expiresAt_idx" ON "AgentInfrastructureClaim"("status", "expiresAt");
CREATE INDEX "AgentInfrastructureClaim_registrableDomain_idx" ON "AgentInfrastructureClaim"("registrableDomain");