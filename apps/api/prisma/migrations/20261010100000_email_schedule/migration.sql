-- Fleet S4b §2.2: delayed email work. One row per notification (unique notificationId) plus invite/member rows.

-- CreateTable
CREATE TABLE "EmailSchedule" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "notificationId" TEXT,
    "inviteId" TEXT,
    "userId" TEXT,
    "projectId" TEXT,
    "toEmail" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "skipReason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "lockedUntil" TIMESTAMP(3),
    "lastError" VARCHAR(500),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailSchedule_notificationId_key" ON "EmailSchedule"("notificationId");

-- CreateIndex
CREATE INDEX "EmailSchedule_status_dueAt_idx" ON "EmailSchedule"("status", "dueAt");

-- AddForeignKey
ALTER TABLE "EmailSchedule" ADD CONSTRAINT "EmailSchedule_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;
