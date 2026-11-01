-- The system-role seeder deliberately preserves permissions on unlocked stored roles. Upgrade only
-- the deployed developer role that lacks the new permission, preserving its stored order and every
-- other role/permission. Insert immediately after memory.decision.record when present; otherwise append.
WITH developer_role AS (
  SELECT "id", "permissions"
  FROM "Role"
  WHERE "key" = 'developer'
    AND NOT ("permissions" @> '["memory.decision.retire"]'::jsonb)
), ordered_permissions AS (
  SELECT d."id", entry.permission, entry.ordinality::numeric AS position
  FROM developer_role d
  CROSS JOIN LATERAL jsonb_array_elements_text(d."permissions") WITH ORDINALITY AS entry(permission, ordinality)
  UNION ALL
  SELECT d."id", 'memory.decision.retire',
    COALESCE(
      (SELECT entry.ordinality::numeric + 0.5
       FROM jsonb_array_elements_text(d."permissions") WITH ORDINALITY AS entry(permission, ordinality)
       WHERE entry.permission = 'memory.decision.record'
       LIMIT 1),
      jsonb_array_length(d."permissions")::numeric + 1
    )
  FROM developer_role d
)
UPDATE "Role" role
SET "permissions" = (
      SELECT jsonb_agg(permission ORDER BY position)
      FROM ordered_permissions
      WHERE ordered_permissions."id" = role."id"
    ),
    "updatedAt" = NOW()
WHERE role."key" = 'developer'
  AND NOT (role."permissions" @> '["memory.decision.retire"]'::jsonb);
