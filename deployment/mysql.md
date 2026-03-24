# MySQL / MariaDB Deployment Guide

MySQL and MariaDB are alternative production databases for Koda. Use this guide if your infrastructure already runs MySQL or if you prefer it over PostgreSQL.

> **Recommendation:** PostgreSQL is preferred for new deployments. Use MySQL only if you have an existing MySQL infrastructure or a specific operational reason.

---

## Prerequisites

- MySQL 8.0+ or MariaDB 10.6+
- Database and user created before running migrations

```sql
-- Run as MySQL root
CREATE DATABASE koda CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'koda_user'@'%' IDENTIFIED BY 'your-strong-password';
GRANT ALL PRIVILEGES ON koda.* TO 'koda_user'@'%';
FLUSH PRIVILEGES;
```

> **Important:** Use `utf8mb4` charset — MySQL's `utf8` does not support all Unicode characters.

---

## Environment Variables

```env
DATABASE_PROVIDER=mysql
DATABASE_URL=mysql://koda_user:your-strong-password@localhost:3306/koda
```

Connection string format:
```
mysql://<user>:<password>@<host>:<port>/<database>
```

---

## Prisma Schema Change

Switch the datasource provider in `apps/api/prisma/schema.prisma`:

```prisma
datasource db {
  provider = "mysql"
  url      = env("DATABASE_URL")
}
```

> **Note:** MySQL does not support Prisma's `String[]` array type. The `Webhook.events` field uses `String[]` in the schema — you must change it to a `String` (JSON-serialized array) or a separate join table when using MySQL:

```prisma
model Webhook {
  // Change: events String[] → store as JSON string
  events String @default("[]") // store as JSON: '["STATUS_CHANGE","ASSIGNMENT"]'
}
```

After changing the schema:

```bash
cd apps/api
bunx prisma generate
bunx prisma migrate deploy
```

---

## Docker Compose Override

Create `docker-compose.mysql.yml`:

```yaml
services:
  mysql:
    image: mysql:8.0
    environment:
      MYSQL_DATABASE: koda
      MYSQL_USER: koda_user
      MYSQL_PASSWORD: ${MYSQL_PASSWORD}
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD}
    command: --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci
    volumes:
      - mysql_data:/var/lib/mysql
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost", "-u", "koda_user", "-p${MYSQL_PASSWORD}"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  api:
    environment:
      DATABASE_PROVIDER: mysql
      DATABASE_URL: mysql://koda_user:${MYSQL_PASSWORD}@mysql:3306/koda
    depends_on:
      mysql:
        condition: service_healthy

volumes:
  mysql_data:
    driver: local
```

Start with the override:

```bash
# .env — add passwords
MYSQL_PASSWORD=your-strong-password
MYSQL_ROOT_PASSWORD=your-root-password

docker compose -f docker-compose.yml -f docker-compose.mysql.yml up -d

# Run migrations
docker compose exec api bunx prisma migrate deploy
```

---

## MariaDB

MariaDB is fully compatible with the MySQL provider. Use the same connection string format but point at your MariaDB host:

```env
DATABASE_URL=mysql://koda_user:password@mariadb:3306/koda
```

For Docker:

```yaml
  mariadb:
    image: mariadb:10.11
    environment:
      MARIADB_DATABASE: koda
      MARIADB_USER: koda_user
      MARIADB_PASSWORD: ${MYSQL_PASSWORD}
      MARIADB_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD}
    command: --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci
    volumes:
      - mysql_data:/var/lib/mysql
```

---

## Backup

```bash
# Dump
docker compose exec mysql mysqldump -u koda_user -p${MYSQL_PASSWORD} koda > backups/koda-$(date +%Y%m%d).sql

# Restore
docker compose exec -T mysql mysql -u koda_user -p${MYSQL_PASSWORD} koda < backups/koda-20260324.sql
```

---

## Known Limitations vs PostgreSQL

| Feature | MySQL | PostgreSQL |
|---------|-------|------------|
| Native array columns | ❌ (JSON workaround) | ✅ |
| Full-text search | Limited | pgvector / full-text |
| JSONB operations | Limited | ✅ rich operators |
| Concurrent writes | Good | Better |
| Prisma support | Full | Full |
