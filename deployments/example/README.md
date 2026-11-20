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
./rollback.sh v0.3.0 --restore-db ./backups/koda_data-YYYYMMDD-HHMMSS-PID.tar.gz
```

Before stopping any service, `rollback.sh` checks that the restore archive exists and is a valid `.tar.gz` (a plain tar with a `.tar.gz` name is refused), pulls the target images, and prepares and validates the updated `.env` with Compose. A preflight failure leaves running services untouched. The new `.env` replaces the old one only after any requested restore succeeds.

Before using `--restore-db`, stop all other containers or processes that can write to the named `/data` volume, including services in other Compose projects, and keep them stopped until rollback completes. The script stops this project's API and web, then checks the Docker daemon for any running containers with writable mounts of that volume. If any remain, it names them and aborts without replacing data or restarting services; stop those writers and retry. If the stop or writer check cannot be confirmed, no data is replaced. The check is a snapshot; the rollback lock does not prevent other tools from starting new writers.

The archive is copied to a staging directory next to the scripts and mounted from there, so a backup that is a symlink to a file outside its own directory still restores. The restore extracts the archive **once**, into a staging directory on the data volume itself: a backup that fits on the volume therefore does not also need room in Docker's storage, and the swap into `/data` only starts after that extraction has succeeded. Every top-level entry of the volume — dotfiles, names with two leading dots and symlinks whose target is gone included — is moved aside until the restored content is in place.

Before pulling or stopping services, `rollback.sh` compares Compose's resolved project and named `/data` volume under the current and target versions. It refuses any change, including one through an intermediate variable. Use version-independent names (for example `COMPOSE_PROJECT_NAME=koda-staging`). It then compares the whole rendered configuration of the replacement `.env`, by digest, against the target: a setting that interpolates `KODA_VERSION` before the version assignment (for example `JWT_EXPIRES_IN=${KODA_VERSION:-latest}`) would keep its fallback once only the file is read, so put `KODA_VERSION` on the first line. Before stopping services it takes a Docker container-name lock for the resolved volume, shared by version-only and data rollbacks; the lock is taken only after the replacement `.env` is validated. Do not prune or remove the lock container during a rollback. Do not run deploy, backup, or manual Compose operations against the volume while a rollback is in progress.

If the deployment has no local `.env` and keeps its configuration in files named by `COMPOSE_ENV_FILES`, `rollback.sh` refuses before touching anything: it can only persist the target version into a local `.env`, and all three scripts pin that file once it exists, so a rollback would change the resolved project and volume on the next run. Put those settings in `deployments/example/.env` (Compose accepts the same syntax) or unset `COMPOSE_ENV_FILES`, then retry.

`deploy.sh` resolves its health-check ports with `docker compose port` rather than sourcing `.env`, so an environment file using syntax bash cannot read — `KEY: value`, a quoted multiline value — is still deployable.

The restore refuses archives with either reserved top-level name (`.koda-restore-previous` or `.koda-restore-staging`). It applies and verifies the archived root owner and mode before discarding the saved data, or preserves the live root owner and mode if the archive lacks a root entry.

### Recover an interrupted restore

1. Keep the app stopped. On the same Docker daemon, check that no rollback is running and that the `koda-rollback-worker-<volume>` container is gone or stopped. Leave the `koda-rollback-lock-<volume>` container in place during recovery. On deployments with a shared volume, stop other services writing to it too.
2. Inspect the exact volume in a root maintenance shell with the same Compose project and environment, for example `docker compose --env-file .env -p <project> run --rm --no-deps --user root --entrypoint sh api`. Do not start the API. Preserve a separate copy or snapshot of the volume, including its hidden directories, before making changes.
3. If `/data/.koda-restore-previous/entries` exists, check for the `installing` marker alongside it:
   - **No marker:** the restore was still moving original entries aside. Leave the original entries still in `/data` in place. Check that none of the saved names already exists at the destination (count dangling symlinks as existing); investigate any conflict rather than overwriting it.
   - **`installing` exists:** all originals were moved aside. Move every remaining live top-level entry, including dotfiles and dangling symlinks, into a separate empty quarantine directory (for example inside `.koda-restore-previous`, beside `entries`). Leave the two reserved directories in place. This removes partial output, including files that were never in the original tree.
4. Copy the saved `entries` back preserving metadata and symlinks, without overwriting live entries, and restore the original numeric owner/group and mode of `/data` from `root-metadata`. Verify both the saved and the never-moved entries, the absence of restore-only entries, and the root metadata before moving the recovery and staging directories out of `/data`. Keep the saved copy and quarantined files until verification is complete. If only staging exists, do not copy it over the live tree: a `committed` subdirectory means the new tree was installed and verified by the script, otherwise extraction may have stopped before any moves. If the layout does not match these cases (including older rollback scripts), keep the copies and inspect them against a known-good backup rather than guessing.
5. If a restore failed before touching live data (for example, archive extraction failed), verify the original data is intact. After verifying the volume and confirming the worker is no longer active, remove the retained lock (`docker rm koda-rollback-lock-<volume>`) and retry or restart the verified stack.

## Notes

- This example deployment uses only its bundled `postgres` service. `deploy.sh` refuses a
  `DATABASE_URL` set in `.env`; external Postgres is not supported by these example scripts.
  With TLS, `sslmode=require` verifies the server certificate (stricter than before the Prisma 7
  upgrade); for a private CA add `sslrootcert=<path>`, or opt out of the check with `uselibpqcompat=true`.
  `connection_limit=<n>` sets the connection pool size.
- Use immutable tags in production (e.g. `KODA_VERSION=v0.4.0`) rather than `latest`.
- `rollback.sh` updates `KODA_VERSION` in `deployments/example/.env`.
