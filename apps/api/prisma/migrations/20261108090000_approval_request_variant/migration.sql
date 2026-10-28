-- Permissions P3 approval gate (US-001): the registered command variant a request runs.
-- NULL is the key's primary command, so every row written before this migration keeps the command
-- it ran. No index change: the variant is read with the request row, never filtered on.
ALTER TABLE "ApprovalRequest" ADD COLUMN "variant" TEXT;
