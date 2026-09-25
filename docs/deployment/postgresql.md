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

To point the API at an external Postgres instead of the bundled container, set `DATABASE_URL`
for the `api` service (e.g. via an override file or environment) — no other changes required.

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

```bash
# Dump
docker compose exec postgres pg_dump -U koda_user koda > backups/koda-$(date +%Y%m%d).sql

# Restore
docker compose exec -T postgres psql -U koda_user koda < backups/koda-20260324.sql
```

---

## Migrating from a historical SQLite installation

Koda's historical SQLite deployments stored all data in a single file. To bring that data forward:

```bash
# 1. Export the historical SQLite data (use a tool like pgloader or manual CSV export)
# 2. Deploy against PostgreSQL and run: bunx prisma migrate deploy
# 3. Import the data
```

See the [pgloader docs](https://pgloader.io/) for automating the historical SQLite → PostgreSQL export/import.
