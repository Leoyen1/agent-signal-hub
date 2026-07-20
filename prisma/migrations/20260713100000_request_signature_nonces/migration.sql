CREATE TABLE "RequestNonce" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "RequestNonce_agentId_nonce_key" ON "RequestNonce"("agentId", "nonce");
CREATE INDEX "RequestNonce_expiresAt_idx" ON "RequestNonce"("expiresAt");