-- auth-passwords US-005: bind lost-response refresh recovery to the token's first-use User-Agent.
--
-- `usedUaHash` is the lowercase sha256 hex of the User-Agent header the first use presented (the empty
-- header hashes the empty string) and `usedIp` is the IP Fastify resolved for it. Both are written by the
-- first use of a token only: a recovery inside the 20-minute window must present the same `usedUaHash`,
-- so a stolen newest-used token replayed by another browser is revoked as reuse instead.
--
-- Additive and nullable: rows written before this migration carry no binding, and a null `usedUaHash`
-- never matches — such a token can no longer be recovered, only rotated on first use or refused.

-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN     "usedUaHash" TEXT,
ADD COLUMN     "usedIp" TEXT;
