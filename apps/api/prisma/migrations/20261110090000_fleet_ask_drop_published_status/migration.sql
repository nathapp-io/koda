-- Fleet activity deduplication keeps recordedStatus; fleet-only live publication is retired.
ALTER TABLE "FleetApprovalAsk" DROP COLUMN "publishedStatus";
