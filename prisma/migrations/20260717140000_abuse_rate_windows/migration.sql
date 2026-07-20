CREATE TABLE "AbuseRateWindow" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "scope" TEXT NOT NULL,
  "keyHash" TEXT NOT NULL,
  "windowStart" DATETIME NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" DATETIME NOT NULL,
  "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "AbuseRateWindow_scope_keyHash_windowStart_key" ON "AbuseRateWindow"("scope", "keyHash", "windowStart");
CREATE INDEX "AbuseRateWindow_expiresAt_idx" ON "AbuseRateWindow"("expiresAt");
CREATE INDEX "AbuseRateWindow_scope_windowStart_idx" ON "AbuseRateWindow"("scope", "windowStart");
