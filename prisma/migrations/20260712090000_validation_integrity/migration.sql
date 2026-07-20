-- Preserve the first validation recorded for each agent/signal pair before
-- enforcing the database-level invariant on existing SQLite deployments.
DELETE FROM "Validation"
WHERE "rowid" NOT IN (
  SELECT MIN("rowid")
  FROM "Validation"
  GROUP BY "signalId", "agentId"
);

CREATE UNIQUE INDEX "Validation_signalId_agentId_key" ON "Validation"("signalId", "agentId");