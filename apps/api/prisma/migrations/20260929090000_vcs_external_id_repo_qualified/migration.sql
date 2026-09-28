-- Track 3 Slice 4 (M11): tickets imported from VCS issues store a repo-qualified
-- externalVcsId (owner/repo#N). Backfill bare issue numbers from the project's
-- single VcsConnection. Rows in projects without a connection stay unchanged.
UPDATE "Ticket" AS t
SET "externalVcsId" = c."repoOwner" || '/' || c."repoName" || '#' || t."externalVcsId"
FROM "VcsConnection" AS c
WHERE c."projectId" = t."projectId"
  AND t."externalVcsId" ~ '^[0-9]+$';
