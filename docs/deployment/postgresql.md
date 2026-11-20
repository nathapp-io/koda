# PostgreSQL Deployment Guide

PostgreSQL is the **only supported database** for Koda. It supports concurrent writes, horizontal read scaling, and enterprise-grade reliability.

---

## Prerequisites

- PostgreSQL 16 (the version shipped in the stock `docker-compose.yml`)
- Database and user created before running migrations (skip if using the bundled container)

```sql
-- Run as postgres superuser
CREATE DATABASE koda;
CREATE USER koda_user WITH PASSWORD 'your-strong-password';
GRANT ALL PRIVILEGES ON DATABASE koda TO koda_user;
-- PostgreSQL 15+: also grant schema privileges
\c koda
GRANT ALL ON SCHEMA public TO koda_user;
```

---

## Environment Variables

```env
DATABASE_URL=postgresql://koda_user:your-strong-password@localhost:5432/koda
```

Connection string format:
```
postgresql://<user>:<password>@<host>:<port>/<database>?schema=public
```

Optional parameters:
```env
# Connection pooling (recommended for production)
DATABASE_URL=postgresql://koda_user:password@localhost:5432/koda?connection_limit=10&pool_timeout=20
```

---

## Prisma Schema

The datasource provider is fixed to `postgresql` in `apps/api/prisma/schema.prisma`; no schema
changes are needed to run on Postgres. Apply migrations with:

```bash
cd apps/api
bunx prisma migrate deploy
```

---

## Docker Compose (stock)

The stock `docker-compose.yml` at the repo root already ships a `postgres:16` service with a
healthcheck, and the `api` service waits for it via `depends_on: { postgres: { condition:
service_healthy } }`. No override file is needed:

```bash
# .env — POSTGRES_PASSWORD is required (the compose file fails closed without it)
POSTGRES_PASSWORD=your-strong-password

docker compose up -d
```

Migrations run automatically in the dev compose file (`docker-compose.dev.yml`). For the
production compose, run them once after the stack is up:

```bash
docker compose exec api bunx prisma migrate deploy
```

The scripts in `deployments/example` support only their bundled `postgres` service; they do not
support pointing that deployment at an external Postgres. Other deployments can point the API at an
external Postgres by setting `DATABASE_URL` for the `api` service (e.g. via an override file or
environment).

---

## Connection Pooling (PgBouncer)

For high traffic, add PgBouncer in front of PostgreSQL:

```yaml
  pgbouncer:
    image: edoburu/pgbouncer:latest
    environment:
      DB_USER: koda_user
      DB_PASSWORD: ${POSTGRES_PASSWORD}
      DB_HOST: postgres
      DB_NAME: koda
      POOL_MODE: transaction
      MAX_CLIENT_CONN: 100
      DEFAULT_POOL_SIZE: 25
    ports:
      - "6432:5432"
    depends_on:
      postgres:
        condition: service_healthy
```

Then point `DATABASE_URL` at PgBouncer (`port 6432`).

---

## Backup

Write the dump as plain SQL, gzipped, and keep the two counts the restore procedure verifies against:

```bash
mkdir -p backups
stamp="$(date +%Y%m%d-%H%M%S)"
docker compose exec -T postgres pg_dump -U koda_user -d koda | gzip > "backups/koda-${stamp}.sql.gz"
```

The bundled deployment does the same through `deployments/example/backup-db.sh`, which also verifies the dump and
writes it as `deployments/example/backups/koda-db-<ts>.sql.gz` before any deploy or migration. It runs as the
`POSTGRES_USER` of that deployment's `postgres` service, so pass the same role if you run `pg_dump` by hand.

## Restore

**Do not replay a dump into the database the deployment is serving.** `psql < backups/koda-20260324.sql` (or
`gunzip -c … | docker compose exec -T postgres psql -U koda_user koda`) reports SQL errors and exits `0`
regardless: the snapshot is merged into the live database, rows written after the backup stay behind beside the
restored ones, and nothing tells the operator that the result is a mixture. A database created from
`template0` is the only form you can verify before anything reads it.

Use the recovery procedure in
[`deployments/example/README.md` § Restore PostgreSQL into a fresh database](../../deployments/example/README.md#restore-postgresql-into-a-fresh-database).
It takes the Compose file, the project, the environment file, the configured role, the gzip archive, the current
database and a **new** database name, creates the new database from `template0`, replays into it, verifies row
counts and `_prisma_migrations` records against the baseline captured for that backup, and only then flips
`POSTGRES_DB` (create and recreate the affected services with the same Compose project and the same volumes) —
and, as a separate operation, a reversal that puts the original back. Two details are worth repeating here:

- The project matters. Every `docker compose` call in the procedure is pinned with `-p <project>` and
  `--env-file <file>`, because the deployment's `POSTGRES_DB` lives in that environment file and Compose
  otherwise takes the project from `COMPOSE_PROJECT_NAME` in your shell. Get the project from
  `docker compose ls`. Because the same precedence lets an exported `POSTGRES_DB` override that file, the
  procedure drops it from Compose's environment and reads the resolved database back with
  `docker compose config --environment` before a service is recreated.
- The role matters. Use the deployment's `POSTGRES_USER` (`koda` in the example, `koda_user` above): it is the
  owner of the tables in the dump and the account the deployment connects as.

### An existing plain SQL dump

A dump you already have as plain text (`backups/koda-20260324.sql`) reaches the same fresh-target `psql` step.
Compress it so the integrity check can refuse a truncated copy, then run the documented procedure against it:

```bash
gzip -c backups/koda-20260324.sql > backups/koda-20260324.sql.gz
```

The replay it performs is exactly

```bash
gzip -dc backups/koda-20260324.sql.gz \
  | docker compose --env-file .env -p <project> exec -T postgres \
      psql -X -v ON_ERROR_STOP=1 -U koda_user -d <new database> -f -
```

with the target database created from `template0` first — never the database the deployment is serving.
`ON_ERROR_STOP=1` is what makes an error end the replay instead of scrolling past it, and the documented script
runs under `set -euo pipefail` so a decompression failure fails the step too.

The LanceDB directory under `/data` is not part of a database backup; `rollback.sh --restore-db` restores that
volume archive and does not touch PostgreSQL.

---

## Migrating from a historical SQLite installation

Koda's historical SQLite deployments stored all data in a single file. To bring that data forward:

```bash
# 1. Export the historical SQLite data (use a tool like pgloader or manual CSV export)
# 2. Deploy against PostgreSQL and run: bunx prisma migrate deploy
# 3. Import the data
```

See the [pgloader docs](https://pgloader.io/) for automating the historical SQLite → PostgreSQL export/import.
