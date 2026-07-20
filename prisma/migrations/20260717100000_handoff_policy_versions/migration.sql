CREATE TABLE "HandoffPolicyVersionEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "policyKey" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "documentHash" TEXT NOT NULL,
    "previousVersion" TEXT,
    "effectiveAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "HandoffPolicyVersionEvent_policyKey_version_documentHash_key" ON "HandoffPolicyVersionEvent"("policyKey", "version", "documentHash");
CREATE INDEX "HandoffPolicyVersionEvent_policyKey_effectiveAt_idx" ON "HandoffPolicyVersionEvent"("policyKey", "effectiveAt");
CREATE INDEX "HandoffPolicyVersionEvent_effectiveAt_idx" ON "HandoffPolicyVersionEvent"("effectiveAt");
