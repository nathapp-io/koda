-- Permissions P3 US-012: fleet asks live on the approval engine (`ApprovalRequest` + `FleetApprovalAsk`), so the
-- legacy `FleetApproval` row and its indexes are dropped. Settled history is not copied (no-data-copy ruling).
DROP TABLE "FleetApproval";
