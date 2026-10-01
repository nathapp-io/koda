-- Fleet S1 slice 4a (D131): when the runner's current daemon boot started. NULL until its next boot.
ALTER TABLE "Runner" ADD COLUMN "bootedAt" TIMESTAMP(3);
