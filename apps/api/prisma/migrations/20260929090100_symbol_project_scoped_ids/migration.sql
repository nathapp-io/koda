-- Track 3 Slice 4 (M13): symbol ids now start with the project id. Symbols are
-- derived data rebuilt on the next index, so the old rows are deleted instead of
-- rewriting ids embedded in the callers/callees JSON arrays.
DELETE FROM "Symbol";
