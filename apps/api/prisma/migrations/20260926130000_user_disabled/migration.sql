-- Slice 4: disabling replaces user deletion (tickets, comments and activity reference users).
ALTER TABLE "User" ADD COLUMN "disabled" BOOLEAN NOT NULL DEFAULT false;
