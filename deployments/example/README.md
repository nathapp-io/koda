# Koda Deployment Example

This example deploys Koda from published Docker images and includes a dedicated migration step.

## Files

- `docker-compose.yml` — `migrate`, `api`, `web` services
- `deploy.sh` — one-command deploy wrapper
- `backup-db.sh` — backup SQLite data volume before risky changes
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
JWT_SECRET=replace-this
JWT_REFRESH_SECRET=replace-this
API_KEY_SECRET=replace-this
```

2. Deploy:

```bash
cd deployments/example
chmod +x deploy.sh backup-db.sh rollback.sh
./deploy.sh
```

This runs:
1) `docker compose pull`
2) `docker compose run --rm migrate`
3) `docker compose up -d api web`

## Manual migration only

```bash
docker compose -f deployments/example/docker-compose.yml run --rm migrate
```

## Backup strategy (SQLite volume)

Create backup before migrations/releases:

```bash
cd deployments/example
./backup-db.sh
```

Backup files are saved under `deployments/example/backups/`.

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

- Default DB is SQLite persisted in Docker volume `koda_data`.
- For PostgreSQL/MySQL, set `DATABASE_PROVIDER` and `DATABASE_URL` in `.env`.
- Use immutable tags in production (e.g. `KODA_VERSION=v0.4.0`) rather than `latest`.
- `rollback.sh` updates `KODA_VERSION` in `deployments/example/.env`.
