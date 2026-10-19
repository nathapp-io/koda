-- Permissions P1 US-008: a project-admin agent may invite (`invite.create`), so the inviter of a
-- `ProjectInvite` is no longer always a user.
--
-- `invitedById` becomes nullable and keeps its `User` foreign key; the agent that invited is recorded in
-- the new `invitedByAgentId`, which has no foreign key and no index (like `TicketLink.createdByAgentId`
-- and `JobSchedule.repoId`, the value is read for a display name and never joined). Every existing row
-- keeps its `invitedById` and answers null for the agent, so nothing is backfilled. Before this, an
-- agent's invite reached the required `User` foreign key and failed with a P2003 instead of being
-- created.
ALTER TABLE "ProjectInvite" ALTER COLUMN "invitedById" DROP NOT NULL;
ALTER TABLE "ProjectInvite" ADD COLUMN "invitedByAgentId" TEXT;
