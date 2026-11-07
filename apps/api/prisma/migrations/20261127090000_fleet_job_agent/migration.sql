-- Fleet AGENT job US-003: the immutable dispatch input of an AGENT job (`agentInput`) and the result its latest attempt
-- reported (`agentResult`), the `configResult` precedent. Both nullable and additive: every existing job — and every
-- job of another kind — keeps NULL. A requeue clears `agentResult` with the other per-attempt results and keeps the
-- input, which is dispatch-time only.
ALTER TABLE "FleetJob" ADD COLUMN "agentInput" JSONB;
ALTER TABLE "FleetJob" ADD COLUMN "agentResult" JSONB;
