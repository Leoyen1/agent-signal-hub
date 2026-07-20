ALTER TABLE "Agent" ADD COLUMN "recoveryPublicKey" TEXT;
ALTER TABLE "Agent" ADD COLUMN "credentialsRecoveredAt" DATETIME;
CREATE UNIQUE INDEX "Agent_recoveryPublicKey_key" ON "Agent"("recoveryPublicKey");
