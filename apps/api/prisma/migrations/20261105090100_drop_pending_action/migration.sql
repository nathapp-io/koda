-- Legacy assistant actions are intentionally discarded, not migrated to requests.
DELETE FROM "FleetApproval" WHERE "type" = 'assistant_action';
DROP TABLE "PendingAction";
