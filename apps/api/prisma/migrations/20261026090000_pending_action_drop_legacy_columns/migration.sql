-- S5b-3 contract step: actor and approver replace requestedById and decidedById (expand: 20261025090000).
-- A decision recorded only in decidedById moves to the approver first, so the drop never loses a decider.
UPDATE "PendingAction" SET "approverType" = 'user', "approverId" = "decidedById"
  WHERE "decidedById" IS NOT NULL AND "approverId" IS NULL;

ALTER TABLE "PendingAction"
  DROP COLUMN "requestedById",
  DROP COLUMN "decidedById";
