-- Fleet S4b §2.1: the package owns the NotificationPreference name, so the S4a per-category table is renamed
-- (rows kept) and its channel values become nestjs-notify's lowercase NotificationChannel values.
ALTER TABLE "NotificationPreference" RENAME TO "NotificationCategoryPreference";
ALTER TABLE "NotificationCategoryPreference" RENAME CONSTRAINT "NotificationPreference_pkey" TO "NotificationCategoryPreference_pkey";
ALTER TABLE "NotificationCategoryPreference" RENAME CONSTRAINT "NotificationPreference_userId_fkey" TO "NotificationCategoryPreference_userId_fkey";
UPDATE "NotificationCategoryPreference" SET "channel" = 'in_app' WHERE "channel" = 'IN_APP';

-- @nathapp/nestjs-notify-prisma 1.1.1 prisma/notify.prisma
-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_logs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT,
    "channel" TEXT NOT NULL,
    "template_code" TEXT NOT NULL,
    "recipient" VARCHAR(512) NOT NULL,
    "status" TEXT NOT NULL,
    "provider_message_id" TEXT,
    "error_message" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_templates" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "channel" TEXT,
    "locale" TEXT NOT NULL,
    "subject" TEXT,
    "content" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_user_id_tenant_id_channel_key" ON "notification_preferences"("user_id", "tenant_id", "channel");

-- CreateIndex
CREATE INDEX "delivery_logs_tenant_id_idx" ON "delivery_logs"("tenant_id");

-- CreateIndex
CREATE INDEX "delivery_logs_recipient_tenant_id_idx" ON "delivery_logs"("recipient", "tenant_id");

-- CreateIndex
CREATE INDEX "delivery_logs_tenant_id_provider_message_id_idx" ON "delivery_logs"("tenant_id", "provider_message_id");

-- CreateIndex
CREATE INDEX "notification_templates_tenant_id_idx" ON "notification_templates"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_templates_tenant_id_code_locale_channel_key" ON "notification_templates"("tenant_id", "code", "locale", "channel");
