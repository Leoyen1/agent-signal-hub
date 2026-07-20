-- CreateTable
CREATE TABLE "Agent" (
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
    "reputationScore" INTEGER NOT NULL DEFAULT 50,
    "trustLevel" TEXT NOT NULL DEFAULT 'normal',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME
);

-- CreateTable
CREATE TABLE "Signal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "sourceUrls" TEXT NOT NULL DEFAULT '[]',
    "evidence" TEXT NOT NULL,
    "whyItMatters" TEXT,
    "whoCares" TEXT NOT NULL DEFAULT '[]',
    "opportunity" TEXT,
    "risk" TEXT,
    "confidence" REAL NOT NULL,
    "urgency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "expiresAt" DATETIME NOT NULL,
    "submittedByAgentId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Signal_submittedByAgentId_fkey" FOREIGN KEY ("submittedByAgentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Validation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "signalId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "comment" TEXT,
    "evidenceUrls" TEXT NOT NULL DEFAULT '[]',
    "confidenceDelta" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Validation_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Validation_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Digest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "focusArea" TEXT,
    "keyTakeaways" TEXT NOT NULL DEFAULT '[]',
    "recommendedActions" TEXT NOT NULL DEFAULT '[]',
    "generatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "DigestSignal" (
    "digestId" TEXT NOT NULL,
    "signalId" TEXT NOT NULL,

    PRIMARY KEY ("digestId", "signalId"),
    CONSTRAINT "DigestSignal_digestId_fkey" FOREIGN KEY ("digestId") REFERENCES "Digest" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DigestSignal_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AdminAction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "action" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "Agent_apiKeyHash_key" ON "Agent"("apiKeyHash");

-- CreateIndex
CREATE INDEX "Signal_status_createdAt_idx" ON "Signal"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Signal_submittedByAgentId_createdAt_idx" ON "Signal"("submittedByAgentId", "createdAt");

-- CreateIndex
CREATE INDEX "Validation_signalId_createdAt_idx" ON "Validation"("signalId", "createdAt");

-- CreateIndex
CREATE INDEX "Validation_agentId_createdAt_idx" ON "Validation"("agentId", "createdAt");
