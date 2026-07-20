-- CreateTable
CREATE TABLE "WebhookSubscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "callbackUrl" TEXT NOT NULL,
    "eventTypes" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastCursorAt" DATETIME,
    "lastDeliveryAt" DATETIME,
    "lastDeliveryStatus" TEXT,
    "lastDeliveryResponse" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WebhookSubscription_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "WebhookSubscription_agentId_status_idx" ON "WebhookSubscription"("agentId", "status");

-- CreateIndex
CREATE INDEX "WebhookSubscription_updatedAt_idx" ON "WebhookSubscription"("updatedAt");
