# Releasing koda

One version is shared by the root `package.json` and the api, cli and web apps. One `vX.Y.Z` tag publishes:

- `@nathapp/koda-cli` to npm
- `nathapp/koda-api` and `nathapp/koda-web` to Docker Hub (linux/amd64 and linux/arm64)
- a GitHub Release with generated notes

The runner (`apps/runner`) is versioned on its own and is not published by a release. Its version is what
`koda-runner --version` and the sync `daemonVersion` report, so a release never changes it.

Releases are maintainer-initiated only, and every tag push needs its own approval.

## Prepare

On clean, up-to-date main, from the repo root:

```sh
bun run release --dry-run minor
bun run release minor
```

The command accepts `patch`, `minor`, `major`, `canary`, `promote`, or an explicit `X.Y.Z` / `X.Y.Z-canary.N`
above the current version:

| Argument | From 0.4.2 | From 0.5.0-canary.1 |
|---|---|---|
| `patch` | 0.4.3 | 0.5.1 |
| `minor` | 0.5.0 | 0.6.0 |
| `canary` | 0.4.3-canary.1 | 0.5.0-canary.2 |
| `promote` | refused | 0.5.0 |
| `0.5.0-canary.1` | 0.5.0-canary.1 | refused (not above) |

Before asking for confirmation it checks that the tag and the `release/vX.Y.Z` branch exist neither locally nor on
`origin`, and that `gh` is signed in. It then sets the version in the four manifests, refreshes `bun.lock`, commits
`chore: release vX.Y.Z` on `release/vX.Y.Z`, pushes that branch, opens a PR labelled `skip-changelog` (so
`.github/release.yml` leaves it out of the release notes) and returns to main. It never tags.
main is protected, so the version only lands through that reviewed PR. If a step fails partway, the error says
what state it left and the command to finish or start over.

A test (`apps/api/test/unit/tooling/release-lockstep.spec.ts`) fails any commit whose manifests or `bun.lock`
disagree on the version. Never bump one manifest alone.

## Publish

After the PR merges, on clean main:

```sh
bun run release --dry-run tag
bun run release tag
```

Tag once main's CI run for the merge commit is green (`gh run list --workflow ci.yml --branch main -L 1`):
the release's CI gate otherwise waits for it, about 8 minutes.

The command reads `origin` before pushing: it refuses when `origin` already holds the tag, and it refuses unless
`origin/main` is the commit it is about to tag, so an unpushed local commit cannot be released. It creates and
pushes the tag at exactly that commit. If the tag push itself fails, rerunning `bun run release tag` on the same
clean main pushes the existing local tag.

`.github/workflows/release.yml` then runs:

1. `info`: validates the tag and checks that all four manifests carry its version. The release runs no tests
   itself, so it then requires the tagged commit to be on main and to have a passing CI run, waiting up to 45
   minutes for one. Only push and manual CI runs count: a pull_request run tests the PR's merge ref, not this
   commit. A run cancelled by main's CI concurrency (a later merge) is not a result, so it keeps waiting for a
   re-run. It then works out the release channels below from the tags on `origin`.
2. `cli`: publishes `@nathapp/koda-cli` with provenance. A version already on npm is skipped.
3. `docker-build`: builds each image once per platform, each on its native runner (`ubuntu-latest` for amd64,
   `ubuntu-24.04-arm` for arm64; no QEMU), and pushes it by digest only. These jobs start only after the CLI job
   succeeded. No layer cache is kept: Actions caches are scoped to the ref that wrote them, so a tag's cache could
   never serve the next tag.
4. `docker`: per app, publishes the tags below as one multi-arch image over the two platform digests, then checks
   that the published image has both platforms. It refuses unless both digests arrived and every tag names that
   app's image. The digests are kept 7 days: re-running a failed `docker` job later finds none, so re-dispatch.
5. `release`: creates the GitHub Release.
6. `notify`: posts to Telegram for stable releases, when the `release` environment has `TELEGRAM_BOT_TOKEN` and
   `TELEGRAM_CHAT_ID`.

| Tag | Docker | npm dist-tag |
|---|---|---|
| `vX.Y.Z`, newest release | `:vX.Y.Z`, `:X.Y`, `:latest` | `latest` |
| `vX.Y.Z`, newest of its minor only | `:vX.Y.Z`, `:X.Y` | `release-X.Y` |
| `vX.Y.Z`, older patch | `:vX.Y.Z` | `backport-X.Y.Z` |
| `vX.Y.Z-canary.N` | `:canary` | `canary` |

Docker tags keep the `v` (`nathapp/koda-api:v0.5.0`); the `X.Y` alias does not. Each image is labelled with
koda's own OCI labels (`org.opencontainers.image.version`, `.revision` = the tagged commit, `.created` = its commit
time, `.source`), replacing the ones it would inherit from the bun base image. Deployments pin the exact
`:vX.Y.Z` tag, never `:latest` or `:canary`.

A canary is the safe way to exercise the whole pipeline: it moves only `:canary` and npm `canary`.

## When something fails

- **CI gate: not on main.** The tag points at an unmerged commit. Delete the tag, merge, and tag main.
- **CI gate: CI did not pass.** Fix main and release a new version, or re-run CI on exactly the tagged commit
  with `gh workflow run ci.yml --ref vX.Y.Z` and re-dispatch the release.
- **CI gate: no passing run before the deadline.** The run was cancelled by a later merge, or CI's push trigger
  skipped a commit that changes no code path. Run `gh workflow run ci.yml --ref vX.Y.Z` (its own concurrency
  group, so later merges do not cancel it), then re-dispatch.
- **Any later job.** Re-run the failed jobs, or dispatch the workflow with the tag (Actions -> Release ->
  "Run workflow", or `gh workflow run release.yml -f tag=vX.Y.Z`). A re-publish builds the tag's commit, skips an
  npm version that is already out and pushes the same Docker tags again.

## Trusted publishing and secrets

The CLI publishes through npm trusted publishing (OIDC), with no token. The npm settings of `@nathapp/koda-cli`
must list this trusted publisher:

| Field | Value |
|---|---|
| Organization | `nathapp-io` |
| Repository | `koda` |
| Workflow filename | `release.yml` |
| Environment | `release` |

The `release` environment holds `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`,
`TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. Its deployment policy allows `main` and `v*` tags.
