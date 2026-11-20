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
- `koda-db-<ts>.sql.gz` — Postgres dump (`pg_dump`), plain SQL gzipped
- `koda_data-<ts>.tar.gz` — LanceDB volume tarball

The two artifacts have separate recoveries. The LanceDB archive is restored by `rollback.sh --restore-db`,
which never touches PostgreSQL; the database dump is restored with the
[recovery procedure below](#restore-postgresql-into-a-fresh-database), which never touches `/data`. A database
backup on its own is enough to recover the tickets; a volume archive on its own is not.

## Restore PostgreSQL into a fresh database

**Do not replay a dump into the database the deployment is serving.** A pipeline such as
`gunzip -c backups/koda-db-<ts>.sql.gz | docker compose exec -T postgres psql -U koda koda` exits `0` while
merging the snapshot into the live database: `psql` reports each SQL error and carries on, rows written after
the backup stay behind next to the restored ones, and an operator sees a successful command. Recover into a
**newly created database**, verify it against a baseline captured for that backup, and only then point the
deployment at it. The original database is never written during recovery, so it stays available as the
fallback and as the target of a reversal.

### The procedure

The procedure is one Bash script. The fenced blocks below are marked `restore-step-*`, they are in the order
to run them, and the first one begins with `set -euo pipefail`, so the first failing step ends the script and
nothing after it runs. Copy them into `restore.sh` in this order and run `bash restore.sh`.
`apps/api/test/integration/db/documented-restore.integration.spec.ts` runs exactly these blocks, in this
order, against a disposable PostgreSQL 16 project, so this guide and the exercised procedure cannot drift
apart.

Inputs (export them in the shell that runs the script):

| Variable | Value |
| --- | --- |
| `KODA_RESTORE_COMPOSE_FILE` | the deployment's Compose file, e.g. `deployments/example/docker-compose.yml` |
| `KODA_RESTORE_PROJECT` | the Compose project the deployment runs under (`docker compose ls`) |
| `KODA_RESTORE_ENV_FILE` | the environment file that persists `POSTGRES_DB`, e.g. `deployments/example/.env` |
| `KODA_RESTORE_ROLE` | `POSTGRES_USER`: the role the dump was taken as |
| `KODA_RESTORE_ARCHIVE` | the dump to restore, e.g. `deployments/example/backups/koda-db-20260101-000000-1.sql.gz` |
| `KODA_RESTORE_ORIGINAL_DB` | the database the deployment serves now (`POSTGRES_DB` in the environment file) |
| `KODA_RESTORE_TARGET_DB` | a **new** database name for the restored copy |
| `KODA_RESTORE_BASELINE_TABLE` | a table this backup always contains, e.g. `User` |
| `KODA_RESTORE_BASELINE_ROWS` | that table's row count in **this** backup |
| `KODA_RESTORE_BASELINE_MIGRATIONS` | `SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL` in **this** backup |

For example:

```bash
export KODA_RESTORE_COMPOSE_FILE=deployments/example/docker-compose.yml
export KODA_RESTORE_PROJECT=koda-local
export KODA_RESTORE_ENV_FILE=deployments/example/.env
export KODA_RESTORE_ROLE=koda
export KODA_RESTORE_ARCHIVE=deployments/example/backups/koda-db-20260101-000000-1.sql.gz
export KODA_RESTORE_ORIGINAL_DB=koda
export KODA_RESTORE_TARGET_DB=koda_restore_20260101
export KODA_RESTORE_BASELINE_TABLE=User
export KODA_RESTORE_BASELINE_ROWS=42
export KODA_RESTORE_BASELINE_MIGRATIONS=48
```

Capture the baseline while the database still matches the backup — right after `backup-db.sh` wrote it.
A count taken later describes the live database, not the dump, and the verification step below would compare
the restored copy against the wrong numbers.

#### 1. Inputs and helpers

```bash restore-step-1-inputs
set -euo pipefail

# Every input is required: a recovery must never fall back to a developer's shell, an inherited DATABASE_URL or
# Compose's ambient project.
compose_file="${KODA_RESTORE_COMPOSE_FILE:?set KODA_RESTORE_COMPOSE_FILE to the Compose file of the deployment}"
compose_project="${KODA_RESTORE_PROJECT:?set KODA_RESTORE_PROJECT to the project the deployment runs under}"
env_file="${KODA_RESTORE_ENV_FILE:?set KODA_RESTORE_ENV_FILE to the environment file that persists POSTGRES_DB}"
role="${KODA_RESTORE_ROLE:?set KODA_RESTORE_ROLE to POSTGRES_USER}"
archive="${KODA_RESTORE_ARCHIVE:?set KODA_RESTORE_ARCHIVE to the database dump to restore}"
original_db="${KODA_RESTORE_ORIGINAL_DB:?set KODA_RESTORE_ORIGINAL_DB to the database the deployment serves now}"
target_db="${KODA_RESTORE_TARGET_DB:?set KODA_RESTORE_TARGET_DB to a new database name for the restored copy}"
baseline_table="${KODA_RESTORE_BASELINE_TABLE:?set KODA_RESTORE_BASELINE_TABLE to a table this backup contains}"
baseline_rows="${KODA_RESTORE_BASELINE_ROWS:?set KODA_RESTORE_BASELINE_ROWS to the row count of that table in this backup}"
baseline_migrations="${KODA_RESTORE_BASELINE_MIGRATIONS:?set KODA_RESTORE_BASELINE_MIGRATIONS to the applied migration count of this backup}"

# Every Compose call is pinned to the file, the environment file and the project. Without the project,
# COMPOSE_PROJECT_NAME in the operator's shell decides which deployment a step addresses.
compose=( docker compose --env-file "$env_file" -f "$compose_file" -p "$compose_project" )

# psql as the configured role, inside this deployment's own postgres service. -X ignores the container's
# psqlrc, and ON_ERROR_STOP turns the first SQL error into a nonzero exit instead of a report the script
# carries on past.
psql_deployment() {
  "${compose[@]}" exec -T postgres psql -X -v ON_ERROR_STOP=1 -U "$role" "$@"
}

# Points the persistent setting at another database. The api service derives its DATABASE_URL from
# POSTGRES_DB, so that one line is the deployment's database selection. The environment file is rewritten in
# place, so its owner and mode survive.
set_persistent_db() {
  local db="$1" rendered
  rendered="$(mktemp "${env_file}.XXXXXX")"
  sed -E "s/^POSTGRES_DB=.*$/POSTGRES_DB=${db}/" "$env_file" > "$rendered"
  cat "$rendered" > "$env_file"
  rm -f "$rendered"
  if ! grep -qx "POSTGRES_DB=${db}" "$env_file"; then
    echo "❌ ${env_file} no longer selects ${db}" >&2
    exit 1
  fi
}
```

#### 2. Preflight: stop the writers, check the inputs, test the archive

```bash restore-step-2-preflight
echo "==> Stopping the writers: the database must not change while it is recovered"
"${compose[@]}" up -d --wait postgres
"${compose[@]}" stop api web

# The recovery needs a dump, a distinct name for the copy, and an environment file that really selects the
# database meant to stay live. Anything else has to stop the procedure before a database is created.
if [[ ! -f "${archive}" ]]; then
  echo "❌ No such archive: ${archive}" >&2
  exit 1
fi
if [[ ! "${target_db}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
  echo "❌ ${target_db} is not a plain database name" >&2
  exit 1
fi
if [[ ! "${baseline_table}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
  echo "❌ ${baseline_table} is not a plain table name" >&2
  exit 1
fi
if [[ "${target_db}" == "${original_db}" ]]; then
  echo "❌ ${target_db} is the database the deployment serves: name the copy of the snapshot something new" >&2
  exit 1
fi
if ! grep -qx "POSTGRES_DB=${original_db}" "${env_file}"; then
  echo "❌ ${env_file} does not set POSTGRES_DB=${original_db}: refusing to guess which database is live" >&2
  exit 1
fi

# The archive has to be a complete gzip before a database exists for it: a decompression failure discovered
# halfway through a replay leaves a half-restored staging database behind, and the operator has to work out
# how far it got. Testing it here keeps the staging database from being created at all.
if ! gzip -t "${archive}"; then
  echo "❌ ${archive} is not a complete gzip archive: no database was created and nothing was replayed" >&2
  exit 1
fi

# A restore into an existing database silently merges the snapshot with whatever is already there, so the name
# has to be free before anything is created. Names travel to psql as variables and are quoted there as a
# literal (`:'target_db'`) or an identifier (`:"target_db"`), never pasted into SQL text. psql interpolates them
# only for input it reads, so the statements arrive on stdin rather than through `-c`.
existing=$(psql_deployment -tA -d postgres -v target_db="${target_db}" -f - <<'SQL'
SELECT count(*) FROM pg_database WHERE datname = :'target_db';
SQL
)
if [[ "${existing}" != "0" ]]; then
  echo "❌ ${target_db} already exists: refusing to replay the snapshot into it" >&2
  exit 1
fi
```

A preflight failure stops the procedure with the original database untouched and nothing replayed: fix the
input (or stop the other writer) and start the script again. Do not start `api`/`web` to "check" the
deployment in the meantime — a writer that starts can change the database the backup came from. The original
database is never the target of a step here, so it stays exactly as it was.

The block stops this project's `api` and `web`. Everything else that can write to the database has to be stopped
too before you start: a CLI or MCP client pointed at the API, a fleet runner, a service in another Compose
project on the same cluster. `docker compose ls` and `docker ps` are the cheap checks; a writer that starts
during recovery is a row the restored copy will not have.

#### 3. Create the fresh database and replay the snapshot into it

```bash restore-step-3-replay
echo "==> Creating ${target_db} from template0"
psql_deployment -d postgres -v target_db="${target_db}" -f - <<'SQL'
CREATE DATABASE :"target_db" TEMPLATE template0;
SQL

echo "==> Replaying ${archive} into ${target_db}"
gzip -dc "${archive}" | psql_deployment -d "${target_db}" -f -
```

`ON_ERROR_STOP` ends the replay at the first SQL error and `pipefail` turns either a decompression failure or
a psql failure into a failing step, so the script stops there instead of carrying the remaining statements of
the dump into the database. A failed replay leaves the new database with whatever the dump had already
created: it is not usable and nothing reads it. `POSTGRES_DB` still names the original database. Keep the
failed database for inspection — query it in the stopped service the way step 4 does — or remove it with
`DROP DATABASE` once you have looked. Never cut over to it.

#### 4. Verify the restored database against the baseline

```bash restore-step-4-verify
echo "==> Checking ${target_db} against the baseline captured for ${archive}"
restored_rows=$(psql_deployment -tA -d "${target_db}" -v table_name="${baseline_table}" -f - <<'SQL'
SELECT count(*) FROM :"table_name";
SQL
)
restored_migrations=$(psql_deployment -tA -d "${target_db}" -f - <<'SQL'
SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;
SQL
)

# These two counts are gates, not a report: the procedure has to stop here when the replay did not reproduce
# the backup, because nothing after this point would notice. Printing a different number and offering the
# cutover anyway is how a mismatched restore gets its traffic.
if [[ "${restored_rows}" != "${baseline_rows}" ]]; then
  echo "❌ ${baseline_table} holds ${restored_rows} rows in ${target_db}, expected ${baseline_rows} for ${archive}" >&2
  exit 1
fi
if [[ "${restored_migrations}" != "${baseline_migrations}" ]]; then
  echo "❌ ${target_db} holds ${restored_migrations} applied migrations, expected ${baseline_migrations} for ${archive}" >&2
  exit 1
fi

echo "✅ ${target_db} verified: ${restored_rows} rows in ${baseline_table}, ${restored_migrations} applied migrations"
```

A mismatch stops the procedure before the cutover, which is the whole point: a staging database that does not
reproduce the backup must never receive traffic. Deciding what a missing or extra row means — take another
backup, accept the loss, recover the rest by hand — is a human decision, so the script refuses to make it. The
original database is still the live one and still the fallback.

The two numbers have to be properties of **this backup**, captured when it was written. If you only have the
dump, they are the counts it restores to, so their source is the same run that produced it; a count taken from
the live database later describes the live database and would make the gate compare against the wrong target.

#### 5. Cut over

```bash restore-step-5-cutover
echo "==> Cutover: ${compose_project} now selects ${target_db}"
set_persistent_db "${target_db}"
# A restart does not reread the environment: the containers have to be recreated, in the same project and on the
# same named volumes. postgres is recreated too, so its healthcheck checks the database the deployment now
# serves; its volume keeps the data.
"${compose[@]}" up -d --force-recreate --wait postgres api web
echo "✅ The deployment reads ${target_db}. Keep ${original_db} untouched: it is the fallback."
```

`--force-recreate` is the part that matters: `docker compose restart` reuses the container it already has, so
the api keeps the `DATABASE_URL` it was created with and the deployment silently keeps reading the original
database. Recreating rereads the environment file while keeping the same Compose project and the same named
volumes (`koda_pg` holds every database of the cluster, `koda_data` is the LanceDB volume; a new database is
created inside the existing cluster, not on a new volume). `--wait` returns only when the recreated services are
healthy, so a database the api cannot use fails here instead of serving errors.

If the recreate or the healthchecks fail, the environment file already selects `${target_db}`: run the reversal
below to put the deployment back on `${original_db}` before investigating.

#### 6. Reversal

```bash restore-step-6-reversal
echo "==> Reversal: ${compose_project} selects ${original_db} again"
set_persistent_db "${original_db}"
"${compose[@]}" up -d --force-recreate --wait postgres api web
echo "✅ The deployment reads ${original_db} again. ${target_db} stays for inspection."
```

Reversal is the cutover of step 5 in the other direction, and it is the same two operations: put the original
name back in the environment file and recreate the services. The original database was never written by any
step above, so the deployment resumes exactly where it was. The restored `${target_db}` is left in place,
offline: nobody reads it while `POSTGRES_DB` names another database, so it can be inspected or dropped after a
fresh backup of it.

Run the whole script again with a different `${target_db}` to retry a restore. Delete a failed staging database
with `DROP DATABASE` only after the deployment is serving from the database it should.

### Restoring a plain SQL dump

The procedure above restores the gzip dump `backup-db.sh` writes. A plain `.sql` dump — an older
`koda-20260324.sql`, a `pg_dump` run by hand with the gzip step omitted — reaches the same fresh-target psql
step; compress it first and the procedure is unchanged:

```bash
gzip -c backups/koda-20260324.sql > backups/koda-20260324-complete.sql.gz
# then set KODA_RESTORE_ARCHIVE to that file and run the procedure
```

The compression is what makes the integrity check in step 2 possible: a truncated or text-mangled copy fails
there, before a database exists for it. Do not skip it and pipe the plain file into the live database — that is
the shortcut this page exists to replace.

### What this procedure does not restore

The LanceDB directory (`/data/lancedb`) is a separate artifact with a separate recovery: `rollback.sh --restore-db`
restores `koda_data-<ts>.tar.gz` into the `koda_data` volume and does not touch PostgreSQL, and the procedure
above never touches `/data`. A database restore and a volume restore are therefore two independent operations,
and neither authorizes the other. The API rebuilds its embeddings from PostgreSQL on demand, so a database
restore followed by a knowledge-base re-index also works; see
[Rollback strategy](#rollback-strategy) for the volume side.

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
