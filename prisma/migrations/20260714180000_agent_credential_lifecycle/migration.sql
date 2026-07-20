ALTER TABLE "Agent" ADD COLUMN "credentialsRotatedAt" DATETIME;
ALTER TABLE "Agent" ADD COLUMN "credentialsRevokedAt" DATETIME;
ALTER TABLE "Agent" ADD COLUMN "credentialsRevokedReason" TEXT;
