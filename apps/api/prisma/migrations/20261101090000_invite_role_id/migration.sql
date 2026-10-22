-- Permissions P1 web US-005: an invite names the role it binds by id, so any role key (not only the
-- three legacy names) can be invited. `role` stays for the legacy enum and becomes nullable: a new
-- invite stores it only when its key maps to ADMIN, DEVELOPER or VIEWER.
--
-- No backfill: a pending invite created before this migration keeps `roleId` null and is accepted
-- through its legacy `role`. Deleting a custom role before the invite is accepted nulls `roleId`.

ALTER TABLE "ProjectInvite" ALTER COLUMN "role" DROP NOT NULL;
ALTER TABLE "ProjectInvite" ADD COLUMN "roleId" TEXT;

ALTER TABLE "ProjectInvite" ADD CONSTRAINT "ProjectInvite_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE SET NULL ON UPDATE CASCADE;
