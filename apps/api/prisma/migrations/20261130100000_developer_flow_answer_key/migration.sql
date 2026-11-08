-- US-009: unlocked developer roles preserve local edits; add the answer key only when it is not
-- already granted or explicitly denied.
UPDATE "Role"
SET "permissions" = "permissions" || jsonb_build_array('fleet.flow.answer'),
    "updatedAt" = NOW()
WHERE "key" = 'developer'
  AND NOT "permissions" @> jsonb_build_array('fleet.flow.answer')
  AND NOT "permissions" @> jsonb_build_array('!fleet.flow.answer');
