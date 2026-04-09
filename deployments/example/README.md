# Koda Local Deployment (Example)

This example deploys Koda from published Docker images and includes a dedicated migration step.

## Files

- `docker-compose.yml` — `migrate`, `api`, `web` services
- `deploy.sh` — one-command deploy wrapper

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
cd deployments/koda-local
chmod +x deploy.sh
./deploy.sh
```

This runs:
1) `docker compose pull`
2) `docker compose run --rm migrate`
3) `docker compose up -d api web`

## Manual migration only

```bash
docker compose -f deployments/koda-local/docker-compose.yml run --rm migrate
```

## Notes

- Default DB is SQLite persisted in Docker volume `koda_data`.
- For PostgreSQL/MySQL, set `DATABASE_PROVIDER` and `DATABASE_URL` in `.env`.
- Use immutable tags in production (e.g. `KODA_VERSION=v0.4.0`) rather than `latest`.
