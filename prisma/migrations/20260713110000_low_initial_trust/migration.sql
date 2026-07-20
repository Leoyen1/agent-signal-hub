PRAGMA foreign_keys=OFF;

CREATE TABLE "new_Agent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "ownerType" TEXT NOT NULL,
    "agentType" TEXT NOT NULL,
    "focusAreas" TEXT NOT NULL DEFAULT '[]',
    "capabilities" TEXT NOT NULL DEFAULT '[]',
    "limitations" TEXT NOT NULL DEFAULT '[]',
    "homepageUrl" TEXT,
    "callbackUrl" TEXT,
    "publicKey" TEXT,
    "apiKeyHash" TEXT NOT NULL,
    "reputationScore" INTEGER NOT NULL DEFAULT 0,
    "trustLevel" TEXT NOT NULL DEFAULT 'low',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME
);

INSERT INTO "new_Agent" (
    "id", "name", "description", "ownerType", "agentType", "focusAreas", "capabilities", "limitations",
    "homepageUrl", "callbackUrl", "publicKey", "apiKeyHash", "reputationScore", "trustLevel", "createdAt", "lastSeenAt"
)
SELECT
    "id", "name", "description", "ownerType", "agentType", "focusAreas", "capabilities", "limitations",
    "homepageUrl", "callbackUrl", "publicKey", "apiKeyHash", "reputationScore", "trustLevel", "createdAt", "lastSeenAt"
FROM "Agent";

DROP TABLE "Agent";
ALTER TABLE "new_Agent" RENAME TO "Agent";

CREATE UNIQUE INDEX "Agent_publicKey_key" ON "Agent"("publicKey");
CREATE UNIQUE INDEX "Agent_apiKeyHash_key" ON "Agent"("apiKeyHash");

PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;