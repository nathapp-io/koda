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
POSTGRES_PASSWORD=replace-this   # required: only A-Z, a-z, 0-9, ., _, ~, -; deploy.sh refuses other characters
JWT_SECRET=change-me-jwt-secret              # required: set a real secret of at least 32 characters
JWT_REFRESH_SECRET=change-me-refresh-secret  # required: at least 32 characters, must differ from JWT_SECRET
API_KEY_SECRET=change-me-api-key-secret      # required: set a real secret of at least 32 characters
```

The three values above are placeholders, not secrets: the production image refuses any value starting with
`change-me`, and refuses one shorter than 32 characters, so this example cannot boot unchanged. Replace all three
with independent secrets before deploying, for example:

```bash
openssl rand -hex 32   # JWT_SECRET
openssl rand -hex 32   # JWT_REFRESH_SECRET (must differ from JWT_SECRET)
openssl rand -hex 32   # API_KEY_SECRET
```

The three secrets have no defaults: compose refuses to start without them. Tokens
default to a 15-minute access JWT and a 7-day refresh JWT (`JWT_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN`); the web
refreshes the session on its own.

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

`backup-db.sh` starts the bundled Postgres service if it is stopped, then takes and verifies a Postgres dump. It fails if it cannot take a valid dump. Backup files are saved under `deployments/example/backups/`:
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

Before stopping any service, `rollback.sh` checks that the restore archive exists and is a valid `.tar.gz` (the gzip stream is checked explicitly, so a plain tar with a `.tar.gz` name is refused), then pulls the target images. If either preflight check fails, the running services are left untouched. A stop that cannot be confirmed also aborts before any data is replaced.

The archive is copied to a staging directory next to the scripts and mounted from there, so a backup that is a symlink to a file outside its own directory still restores. The restore extracts the archive **once**, into a staging directory on the data volume itself: a backup that fits on the volume therefore does not also need room in Docker's storage, and the swap into `/data` only starts after that extraction has succeeded. Every top-level entry of the volume — dotfiles, names with two leading dots and symlinks whose target is gone included — is moved aside until the restored content is in place.

If a restore is interrupted after it moved the old content aside, `/data/.koda-restore-previous` holds the only copy. The next run refuses to continue rather than delete it and prints how to put that content back, so the rollback fails loudly instead of starting a restore over data that was never replaced.

The Compose project name must not depend on `KODA_VERSION`: a rollback stops the services under the version `.env` holds and restores under the target one, so a project name such as `COMPOSE_PROJECT_NAME=koda-${KODA_VERSION}` would stop one project and restore into another. `rollback.sh` refuses such a name before it touches Docker. Pin a version-independent name (for example `COMPOSE_PROJECT_NAME=koda-staging`).

## Notes

- This example deployment uses only its bundled `postgres` service. `deploy.sh` refuses a
  `DATABASE_URL` set in `.env`; external Postgres is not supported by these example scripts.
  With TLS, `sslmode=require` verifies the server certificate (stricter than before the Prisma 7
  upgrade); for a private CA add `sslrootcert=<path>`, or opt out of the check with `uselibpqcompat=true`.
  `connection_limit=<n>` sets the connection pool size.
- Use immutable tags in production (e.g. `KODA_VERSION=v0.4.0`) rather than `latest`.
- `rollback.sh` updates `KODA_VERSION` in `deployments/example/.env`.
