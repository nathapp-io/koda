-- Permissions P1m US-003: the role claim is derived from role bindings, and an invite names its role by roleId.
ALTER TABLE "User" DROP COLUMN "role";
ALTER TABLE "ProjectInvite" DROP COLUMN "role";
