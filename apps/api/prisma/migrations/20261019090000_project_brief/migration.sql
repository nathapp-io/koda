-- Fleet S5b US-001: a curated short project brief (at most 3000 characters on update),
-- rendered into thread instructions. Nullable, so existing rows keep an empty brief.
ALTER TABLE "Project" ADD COLUMN "brief" TEXT;
