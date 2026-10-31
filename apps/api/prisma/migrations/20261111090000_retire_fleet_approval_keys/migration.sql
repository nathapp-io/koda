-- Permissions P3 feature 7c (US-013): the three fleet approval adapter routes and the assistant fleet
-- alias are gone, so `fleet.approval.read` and the three `fleet.approval.decide.*` keys leave the
-- catalog. Each statement below rewrites data that still names one of them, and it must run before the
-- new code serves: the unlocked `developer` system role still stores `fleet.approval.decide.bash`, the
-- seeder never rewrites an unlocked role, and `PermissionService` drops a whole role — logging an
-- `invalid permission entry` — as soon as one stored entry names a key the catalog no longer holds.

-- Every entry containing `fleet.approval.` goes: exact keys, `.*` patterns, negations and
-- `approval.decide@fleet.approval.*` scopes. The survivors keep the order they were stored in, and a role
-- left with none stores `[]`, never NULL. Only a role that still names one is rewritten, so a second run
-- touches nothing.
UPDATE "Role"
SET "permissions" = COALESCE((SELECT jsonb_agg(e ORDER BY ord) FROM jsonb_array_elements("permissions") WITH ORDINALITY AS t(e, ord) WHERE position('fleet.approval.' in e #>> '{}') = 0), '[]'::jsonb),
    "updatedAt" = NOW()
WHERE EXISTS (SELECT 1 FROM jsonb_array_elements("permissions") AS t(e) WHERE position('fleet.approval.' in e #>> '{}') > 0);

-- A policy that names a retired key selects for nothing: no request can carry that key any more.
DELETE FROM "ApprovalPolicy" WHERE "permissionPattern" LIKE 'fleet.approval.%';

-- The route commands of these keys no longer exist, so the requests can never execute. A pending or
-- approved one is settled as cancelled; every other status (executed, rejected, expired, failed) is
-- history and stays as it was.
UPDATE "ApprovalRequest"
SET "status" = 'cancelled', "settledAt" = NOW(), "updatedAt" = NOW()
WHERE "permissionKey" LIKE 'fleet.approval.%' AND "status" IN ('pending', 'approved');

-- US-007 deleted the redirect pages, so a stored link to one is re-pointed at the approvals inbox. The
-- rows themselves stay: their `kind` and `sourceType` are unchanged and the notification is still read.
UPDATE "Notification" SET "link" = '/approvals' WHERE "link" = '/admin/fleet/approvals';
