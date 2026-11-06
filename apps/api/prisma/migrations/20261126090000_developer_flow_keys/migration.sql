-- #401: fleet_flows added these keys to the developer system role in code only. Unlocked system roles
-- keep local edits, so append each key the role lacks, and skip a key the installation denied with "!".
UPDATE "Role"
SET "permissions" = "permissions" || COALESCE((
      SELECT jsonb_agg(k ORDER BY ord)
      FROM jsonb_array_elements_text('["fleet.flow.create","fleet.flow.stop","fleet.flow.start","fleet.thread.preapprove"]'::jsonb) WITH ORDINALITY AS t(k, ord)
      WHERE NOT "Role"."permissions" @> jsonb_build_array(k)
        AND NOT "Role"."permissions" @> jsonb_build_array('!' || k)
    ), '[]'::jsonb),
    "updatedAt" = NOW()
WHERE "key" = 'developer'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text('["fleet.flow.create","fleet.flow.stop","fleet.flow.start","fleet.thread.preapprove"]'::jsonb) AS t(k)
    WHERE NOT "Role"."permissions" @> jsonb_build_array(k)
      AND NOT "Role"."permissions" @> jsonb_build_array('!' || k)
  );
