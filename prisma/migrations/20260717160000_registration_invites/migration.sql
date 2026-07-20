CREATE TABLE "RegistrationInviteUse" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "codeHash" TEXT NOT NULL,
  "usedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "RegistrationInviteUse_codeHash_key" ON "RegistrationInviteUse"("codeHash");
CREATE INDEX "RegistrationInviteUse_usedAt_idx" ON "RegistrationInviteUse"("usedAt");
