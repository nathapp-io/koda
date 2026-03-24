# SQLite Deployment Guide

SQLite is the **default database** for Koda. It requires zero infrastructure — just a single file on disk. Ideal for personal use, small teams, and local development.

---

## Environment Variables

```env
DATABASE_PROVIDER=sqlite
DATABASE_URL=file:/data/koda.db
```

- `DATABASE_URL` path is relative to the Prisma schema file in production, but when running in Docker it is an absolute path mounted to the `/data` volume.
- The default Docker Compose setup uses `/data/koda.db` inside the container, backed by a named volume (`koda_data`).

---

## Docker Compose (default)

No changes needed — the stock `docker-compose.yml` already uses SQLite:

```bash
# Copy and fill in secrets
cp .env.example .env

# Start
docker compose up -d

# Run migrations on first start
docker compose exec api bunx prisma migrate deploy
```

The `koda_data` named volume persists the database across container restarts.

---

## Bare Metal / Local Dev

```bash
# Install dependencies
bun install

# Set DATABASE_URL in .env
echo 'DATABASE_URL=file:./apps/api/prisma/koda.db' >> .env

# Run migrations
cd apps/api && bunx prisma migrate deploy

# Start API
bun run dev --filter=@nathapp/koda-api
```

> **Note:** `DATABASE_URL=file:./koda.db` resolves relative to `apps/api/prisma/schema.prisma`, so the DB file will be at `apps/api/prisma/koda.db`.

---

## Backup

```bash
# Stop writes first (optional but recommended)
docker compose stop api

# Copy the DB file out of the volume
docker run --rm \
  -v koda_koda_data:/data \
  -v $(pwd)/backups:/backups \
  alpine cp /data/koda.db /backups/koda-$(date +%Y%m%d).db

docker compose start api
```

---

## Limitations

- Single writer at a time (WAL mode mitigates read contention).
- Not suitable for multi-instance / horizontal scaling.
- For teams > 10 users or high-throughput workloads, use [PostgreSQL](./postgresql.md).
