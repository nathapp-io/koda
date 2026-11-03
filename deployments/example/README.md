# Koda Deployment Example

This example deploys Koda from published Docker images and includes a dedicated migration step.

## Files

- `docker-compose.yml` — `postgres`, `api`, `web` services
- `deploy.sh` — one-command deploy wrapper (runs pre-deploy backup by default)
- `backup-db.sh` — backup the database before risky changes
- `rollback.sh` — rollback app version (optionally restore DB backup)

## Why `migrate` is separate

`prisma migrate deploy` is intentionally **not** in API container startup.

Benefits:
- Safer restarts (normal restart won’t trigger migration workflow)
- Clear failure point during deploy
- Easy to run migration-only troubleshooting

## Usage

1. Create `.env` next to `docker-compose.yml` (or export env vars):

```bash
KODA_VERSION=v0.4.0
POSTGRES_PASSWORD=replace-this   # required: compose fails closed without it
JWT_SECRET=replace-this          # required: openssl rand -hex 32
JWT_REFRESH_SECRET=replace-this  # required, must differ from JWT_SECRET
API_KEY_SECRET=replace-this      # required
```

The three secrets have no defaults: compose refuses to start without them, and the production image refuses a
value starting with `change-me` (the placeholders in `.env.example`). Tokens default to a 15-minute access JWT
and a 7-day refresh JWT (`JWT_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN`); the web refreshes the session on its own.

### Network exposure

- `web` (`WEB_PORT`, default 3101) is the public entry point. Browsers reach the API through it.
- `api` (`API_PORT`, default 3100) is published on `127.0.0.1` only. Remote runners, the CLI and MCP clients on
  other hosts need a TLS reverse proxy on this host that forwards to it; do not publish it on all interfaces, since
  that lets clients skip the web tier and pick their own rate-limit bucket through `x-client-ip`.

2. Deploy:

```bash
cd deployments/example
chmod +x deploy.sh backup-db.sh rollback.sh
./deploy.sh
```

This runs:
1) pre-deploy safety checks
2) backup the database volume (default)
3) `docker compose pull`
4) `chown -R 1001:1001 /data` on the data volume (the api image runs as uid 1001; volumes written by older root
   images need this once, later runs are no-ops)
5) `docker compose run --rm api bunx --package prisma@7.10.0 prisma migrate deploy`
6) `docker compose up -d --wait api web` (returns when the healthchecks pass)
7) post-deploy health checks

To skip backup explicitly:

```bash
./deploy.sh --no-backup
```

## Manual migration only

```bash
docker compose -f deployments/example/docker-compose.yml run --rm api bunx --package prisma@7.10.0 prisma migrate deploy
```

## Backup strategy (database volume)

Create backup before migrations/releases:

```bash
cd deployments/example
./backup-db.sh
```

Backup files are saved under `deployments/example/backups/`:
- `koda-db-<ts>.sql.gz` — Postgres dump (`pg_dump`)
- `koda_data-<ts>.tar.gz` — LanceDB volume tarball

`rollback.sh --restore-db` restores only the LanceDB volume tarball; restore the Postgres
dump with `gunzip -c koda-db-<ts>.sql.gz | docker compose exec -T postgres psql -U koda koda`.

## Rollback strategy

Rollback app image version only:

```bash
cd deployments/example
./rollback.sh v0.3.0
```

Rollback app + restore DB backup:

```bash
cd deployments/example
./rollback.sh v0.3.0 --restore-db ./backups/koda_data-YYYYMMDD-HHMMSS.tar.gz
```

## Notes

- PostgreSQL is Koda's only database. This example's compose file predates the Postgres-only
  switch and still carried the historical SQLite default; it now ships a `postgres:16` service.
  Set `DATABASE_URL` in `.env` to point at an external Postgres instead if you prefer.
  With TLS, `sslmode=require` verifies the server certificate (stricter than before the Prisma 7
  upgrade); for a private CA add `sslrootcert=<path>`, or opt out of the check with `uselibpqcompat=true`.
  `connection_limit=<n>` sets the connection pool size.
- Use immutable tags in production (e.g. `KODA_VERSION=v0.4.0`) rather than `latest`.
- `rollback.sh` updates `KODA_VERSION` in `deployments/example/.env`.
