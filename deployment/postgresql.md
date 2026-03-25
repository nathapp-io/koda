# PostgreSQL Deployment Guide

PostgreSQL is the **recommended production database** for Koda. It supports concurrent writes, horizontal read scaling, and enterprise-grade reliability.

---

## Prerequisites

- PostgreSQL 14+ (15 or 16 recommended)
- Database and user created before running migrations

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
DATABASE_PROVIDER=postgresql
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

## Prisma Schema Change

Switch the datasource provider in `apps/api/prisma/schema.prisma`:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

Then regenerate the Prisma client and run migrations:

```bash
cd apps/api
bunx prisma generate
bunx prisma migrate deploy
```

> **Important:** SQLite and PostgreSQL migrations are not compatible. If migrating an existing SQLite database, export data first and reimport after running PostgreSQL migrations.

---

## Docker Compose Override

Create `docker-compose.postgres.yml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: koda
      POSTGRES_USER: koda_user
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U koda_user -d koda"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  api:
    environment:
      DATABASE_PROVIDER: postgresql
      DATABASE_URL: postgresql://koda_user:${POSTGRES_PASSWORD}@postgres:5432/koda
    depends_on:
      postgres:
        condition: service_healthy

volumes:
  postgres_data:
    driver: local
```

Start with the override:

```bash
# .env — add your password
POSTGRES_PASSWORD=your-strong-password

docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d

# Run migrations
docker compose exec api bunx prisma migrate deploy
```

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

## Migrating from SQLite

```bash
# 1. Export SQLite data (use a tool like pgloader or manual CSV export)
# 2. Switch schema provider to postgresql and generate client
# 3. Run: bunx prisma migrate deploy
# 4. Import data
```

See the [pgloader docs](https://pgloader.io/) for automated SQLite → PostgreSQL migration.
