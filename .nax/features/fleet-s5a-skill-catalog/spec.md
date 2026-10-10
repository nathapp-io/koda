# SPEC: Fleet S5a-A — Skill Catalog (Global Skill Sources, Per-Project Enablement)

## Summary

koda gains a global catalog of agent skills. A global admin registers a skill source — a public GitHub repository,
a ref (branch or tag) and a directory path — and koda resolves it through the GitHub REST API to a pinned commit SHA
and the list of skills found under the path (each a directory holding a `SKILL.md` whose frontmatter names and
describes it). A source is re-resolved only when the admin clicks Update. A project admin enables individual catalog
skills for the project. The catalog is managed in a new `/admin/skills` page and a new Skills tab in project
settings. Nothing in this feature runs on a fleet runner: the runner-side fetch and the agent's skill tools arrive with
brainstorm threads (feature `fleet-s5a-native-chat`), which read the project's enabled skills as a pinned snapshot.

Umbrella design: `docs/superpowers/specs/2026-10-10-fleet-s5a-chat-threads-design.md` §1 (phase A).

## Motivation

- Brainstorm threads (fleet S5a, design doc §3 (e)) load the spec-writing and spec-review skills. Those skills live in
  git (`nathapp-io/nax-spec-kit-skills`), and every runner would otherwise need its own hand-maintained copy, with no
  way for koda to know which version a thread ran.
- Ruling D540: skills are managed centrally as source records kept in koda, pinned to a commit, fetched by runners,
  and enabled per project. Ruling D546: v1 sources are public GitHub repositories only (no credential path exists for
  a repository that is not a fleet repo).
- koda has no skill concept today: no model, route or page mentions skills.

## Design

### Rulings that bind every story (user, 2026-10-10)

- D540: a global catalog of skill **source records** (GitHub URL + ref + path), each pinned to a commit SHA; projects
  enable individual skills.
- D546: sources must be public `https://github.com/<owner>/<repo>` repositories; calls are anonymous.
- A source is resolved on create and on an explicit Update only — never in the background — so a skill name means the
  same content until an admin updates it.
- Skill names are unique across the whole catalog.
- Global ADMIN manages sources; project ADMIN or global ADMIN manages a project's enabled skills; any project member
  reads them; agent principals (API keys) are refused on every skill route.

### Integration

Read-only (verified on main `3162822d`):

- `FleetHttpClient.request(method: 'GET' | 'POST', url: string, headers: Record<string, string>, body?: unknown):
  Promise<{ status: number; body: unknown }>` (`apps/api/src/fleet/git-broker/fleet-http-client.ts:13`) — bounded by
  `FLEET_HTTP_TIMEOUT_MS`, never follows redirects, parses JSON, throws `RepoCheckException('provider_unreachable')`
  on network failure or redirect and `RepoCheckException('provider_error')` on a non-JSON body.
- `GitHubAppClient` (`apps/api/src/fleet/git-broker/github-app-client.ts`) — pattern to mirror for GitHub calls:
  `getTree` (`:143`, `GET {api}/repos/{o}/{r}/git/trees/{sha}?recursive=1`, drops non blob/tree entries, reports
  `truncated`) and `getFile` (`:158`, contents API, base64). Its methods require an App token, so the resolver does
  not call them; it issues the same requests anonymously.
- `VCS_CFG` / `IVcsConfig.githubApiUrl` (`apps/api/src/config/vcs.config.ts:5,32`) — the GitHub API base URL.
- `FleetReposController` (`apps/api/src/fleet/repos/fleet-repos.controller.ts:15-50`) — global-admin CRUD pattern:
  `@RequiredPermission('ADMIN')`, `@Principal() principal: KodaPrincipal`, `JsonResponse.Ok(...)`.
- `ProjectsController.addProjectAgent` (`apps/api/src/projects/projects.controller.ts:185-204`) — project-admin route
  pattern: `@UseGuards(ProjectMembershipGuard)`, `@CurrentProject() ctx`, then
  `projectsService.assertProjectAdmin(ctx.project.id, principal)`.
- `assertUser(principal)` helpers in `apps/api/src/fleet/logs/fleet-job-logs.controller.ts:17` — refuse non-user
  principals with 403.
- Web: `pages/admin/fleet/repos.vue` + `composables/useFleetRepos.ts` (admin table pattern);
  `pages/[project]/settings.vue:76-110` (Tabs: `project`, `vcs`); `layouts/default.vue:175-186` (ADMIN section links,
  `v-if="isGlobalAdmin"`); `components/CommandPalette.vue:27` (global entries).

Changed (baseline locates the code only; implement the target):

- `GitBrokerModule` (`apps/api/src/fleet/git-broker/git-broker.module.ts`)
  - Baseline: `exports: [GitHubAppClient, GitLabAccessChecker, GitLabTokenSource, GitTokenBroker]`.
  - Target: `exports` also includes `FleetHttpClient`.
- `Project` model (`apps/api/prisma/schema.prisma:~110-131`)
  - Target: gains the back-relation `skills ProjectSkill[]`.
- `pages/[project]/settings.vue`
  - Target: a third tab `skills` rendering `ProjectSkillsPanel`; the `TabsList` class changes from `grid-cols-2` to
    `grid-cols-3`.
- `layouts/default.vue` / `components/CommandPalette.vue`
  - Target: an ADMIN link `/admin/skills` (label `nav.skills`) after the fleet admin links, shown only to global
    admins; a palette entry `skills` to `/admin/skills` listed only for global admins (`CommandPalette` reads
    `useAuth().user.value?.role === 'ADMIN'`, as `layouts/default.vue:51` does).

### New data (US-001)

```prisma
model SkillSource {
  id           String    @id @default(cuid())
  gitUrl       String    // normalized https://github.com/<owner>/<repo>
  owner        String    // lowercase
  repo         String    // lowercase
  ref          String    // branch or tag as entered
  path         String    // repo-relative directory holding skill directories; "" = repo root
  resolvedSha  String?
  resolvedAt   DateTime?
  status       String    // OK | RESOLVE_FAILED
  statusReason String?
  createdById  String
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
  skills       Skill[]
  @@unique([owner, repo, ref, path])
}

model Skill {
  id          String         @id @default(cuid())
  sourceId    String
  name        String         @unique
  description String
  dir         String
  source      SkillSource    @relation(fields: [sourceId], references: [id], onDelete: Cascade)
  projects    ProjectSkill[]
  @@index([sourceId])
}

model ProjectSkill {
  projectId   String
  skillId     String
  enabledById String?
  createdAt   DateTime @default(now())
  skill       Skill    @relation(fields: [skillId], references: [id], onDelete: Cascade)
  project     Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  @@id([projectId, skillId])
  @@index([skillId])
}
```

Statuses are string constants in `src/common/enums.ts` (no Prisma enums, rule api-core).

Errors use the existing App exceptions with the key as prefix, so the message key is `<key>.<status>` in
`apps/api/src/i18n/{en,zh}/skills.json` (as `invites.json` and `fleet.json` do): `ValidationAppException(args,
'skills.unsupportedHost')` carries code `-2` → key `unsupportedHost.-2` (as `fleet.json` `dispatchInput.-2`); `ConflictAppException(args, 'skills.nameConflict' | 'skills.sourceExists')` → `.409`;
`NotFoundAppException(args, 'skills.notFound' | 'skills.sourceNotFound')` → `.404`.

### Resolver (US-001 parsers, US-002 resolver)

```ts
// apps/api/src/skills/skill-resolver.ts
export interface ResolvedSkill { name: string; description: string; dir: string }
export interface SkillResolution { sha: string; skills: ResolvedSkill[] }
export type SkillResolveReason =
  | 'not_public_or_missing' | 'ref_not_found' | 'rate_limited' | 'tree_truncated' | 'no_skills' | 'too_many_skills'
  | 'invalid_skill' | 'duplicate_name' | 'provider_error' | 'provider_unreachable';
export class SkillResolveError extends Error { constructor(readonly reason: SkillResolveReason, readonly detail?: string) { super(reason); } }
export interface SkillResolver { resolve(input: { owner: string; repo: string; ref: string; path: string }): Promise<SkillResolution> }
export const SKILL_RESOLVER = Symbol('SKILL_RESOLVER');
```

`GitHubSkillResolver implements SkillResolver`, through `FleetHttpClient` with headers
`{ accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }` and no `authorization`:

1. `GET {api}/repos/{owner}/{repo}/commits/{ref}` → `sha` (the ref is URL-encoded per path segment).
2. `GET {api}/repos/{owner}/{repo}/git/trees/{sha}?recursive=1`; `truncated: true` → `tree_truncated`.
3. A skill = a `tree` entry whose parent directory equals `path` (repo root when `path` is `""`) and for which a
   `blob` entry `<dir>/SKILL.md` exists. Zero skills → `no_skills`; more than 50 → `too_many_skills`. Skills are
   ordered by `dir`.
4. A `SKILL.md` whose tree entry `size` exceeds 262144 → `invalid_skill` with detail `<dir>`, before any contents
   call. For each remaining skill, `GET {api}/repos/{owner}/{repo}/contents/{dir}/SKILL.md?ref={sha}` (`dir`
   URL-encoded per path segment); a response whose `type` is not `file` (for example a symlink) or whose `size`
   exceeds 262144 → `invalid_skill` with detail `<dir>`; otherwise its base64 `content`, decoded as UTF-8 and passed to `parseSkillFrontmatter`.
5. Two skills in one source with the same `name` → `duplicate_name` (detail: the name).
6. `statusReason` is stored as `reason` or `reason:detail`, truncated to 300 characters.

HTTP mapping for every call: 404 → `not_public_or_missing`; on the commits call only, 422 (GitHub's answer for a ref
that resolves to no commit) → `ref_not_found`; 403 or 429 → `rate_limited`; any other non-200 or a body of
the wrong shape → `provider_error`; a `RepoCheckException` from `FleetHttpClient` maps to its own reason
(`provider_unreachable` or `provider_error`).

`parseSkillFrontmatter(text): { name, description }` (`apps/api/src/skills/skill-frontmatter.ts`): a leading UTF-8 BOM
is stripped and `\r\n` is normalized to `\n` first; the file must then start with a line `---`; the block ends at the next line `---`; within it, `name:` and `description:` are single-line
scalars (optional surrounding single or double quotes are stripped; other keys are ignored). `name` must match
`^[a-z0-9][a-z0-9-]{0,63}$`; a missing block, a missing or invalid `name`, a missing or empty `description`, or a block scalar
(`description: >` / `|`) → `invalid_skill` with the skill's `dir` as detail. `description` longer than 1024 characters
is truncated to 1024. No YAML dependency is added.

`parseGitHubUrl(url): { owner, repo, gitUrl }` (`apps/api/src/skills/github-url.ts`): accepts only
`https://github.com/<owner>/<repo>` with an optional trailing `.git` or `/`; owner and repo match
`^[A-Za-z0-9_.-]{1,100}$` and are not `.` or `..` (a repo of only `.git` is rejected); returns them lowercased and `gitUrl = https://github.com/<owner>/<repo>`, built by concatenating a
`GITHUB_WEB_BASE = 'https://github.com/'` constant with `owner + '/' + repo` — never a template literal containing
`github.com/${`, which the existing tripwire `apps/api/src/vcs/provider-construction-sites.spec.ts` forbids in `src/`. Anything else
throws `ValidationAppException({}, 'skills.unsupportedHost')`.

`path` validation (in the create DTO): `""` or 1-200 characters of `/`-separated segments, each matching
`^[A-Za-z0-9_.-]+$`, none `.` or `..`, no leading or trailing `/`. `ref`: 1-200 characters, no whitespace, no `..`.

### Catalog service and admin routes (US-003 create/list, US-004 update/delete)

`SkillsModule` (`apps/api/src/skills/`) follows repository → service → public (rule api-data):
`PrismaSkillCatalogRepository` (module-private), `SkillsService` (exported), `AdminSkillsController`,
`ProjectSkillsController` (US-005). It imports `GitBrokerModule` (for `FleetHttpClient`) and `ProjectAccessModule` (for
`ProjectMembershipGuard` and `ProjectAccessService.assertProjectAdmin`, as `fleet-repos.module.ts` does), binds
`SKILL_RESOLVER` to `GitHubSkillResolver`, and keeps the repository behind a module-private
`SKILL_CATALOG_REPOSITORY` token returning service-owned domain types from `skill-catalog.domain.ts` (rule api-data).
Multi-row writes (create insert, update replacement) run inside `txManager.run()` (rule api-data). `SkillsModule` is
added to `AppModule.imports`. Controllers carry
`@ApiTags('skills')`, `@ApiBearerAuth()`, and `@ApiOperation({ summary })` plus `@ApiResponse` per status on every route
(rule api-controllers; `spec-integrity.integration.spec.ts`).
List queries are bounded (rule api-data): sources `take: 200` ordered by `createdAt`; project skills `take: 10000`
(200 sources × 50 skills). `Skill` has `@@index([sourceId])`; `ProjectSkill` has `@@index([skillId])`.

| Route | Who | Behaviour |
|---|---|---|
| `GET /admin/skills/sources` | global ADMIN | `{ items: SkillSourceDto[] }`, sources ordered by `createdAt` (at most 200), each with its skills ordered by `name` |
| `POST /admin/skills/sources` `{ gitUrl, ref, path }` | global ADMIN | parse URL; 409 `skills.sourceExists` when `(owner, repo, ref, path)` is registered; resolve; on success insert source `OK` + skills; on `SkillResolveError` insert source `RESOLVE_FAILED` with `statusReason = reason[:detail]` and no skills; 201 `SkillSourceDto` |
| `POST /admin/skills/sources/:id/update` | global ADMIN | re-resolve; success → replace the source's skills (§ below), `status OK`, new `resolvedSha`/`resolvedAt`; failure → `status RESOLVE_FAILED` + reason, existing pin and skills kept; 200 `SkillSourceDto`; 404 unknown id |
| `DELETE /admin/skills/sources/:id` | global ADMIN | delete source (skills and project enablements cascade); 204; 404 unknown id |

Name conflicts: when a resolution contains a name owned by a skill of **another** source, create returns 409
`skills.nameConflict` (params: name, other source's `gitUrl`) and writes nothing; update returns the same 409 and
changes nothing (status and pin untouched).

Update replacement, in one transaction: skills whose name survives are updated in place (same `Skill.id`, new
`description` and `dir`), so their `ProjectSkill` rows survive; new names are inserted; vanished names are deleted
(their `ProjectSkill` rows cascade).

`SkillSourceDto`: `{ id, gitUrl, ref, path, resolvedSha, resolvedAt, status, statusReason, createdAt, skills:
SkillDto[] }`; `SkillDto`: `{ id, name, description, dir }`.

### Project skill routes (US-005)

| Route | Who | Behaviour |
|---|---|---|
| `GET /projects/:slug/skills` | project member, global ADMIN | `{ items: ProjectSkillDto[] }`, every catalog skill ordered by `name`: `{ id, name, description, enabled, source: { id, gitUrl, ref, resolvedSha, status } }` |
| `PUT /projects/:slug/skills/:skillId` | project ADMIN, global ADMIN | upsert the `ProjectSkill` row (`enabledById` = caller); 200 `ProjectSkillDto`; idempotent; 404 `skills.notFound` for an unknown skill |
| `DELETE /projects/:slug/skills/:skillId` | project ADMIN, global ADMIN | delete the row if present; 204; idempotent; 404 `skills.notFound` for an unknown skill |

Membership and admin checks follow the `addProjectAgent` pattern (see Integration). Each handler also refuses a
non-user principal with `ForbiddenAppException` (403) when `isUserPrincipal` is false (`apps/api/src/auth/principal/koda-principal.types.ts`): with
`AGENT_PROJECT_SCOPING=off` the membership guard admits agents, and the `assertUser` helpers in the fleet controllers
are module-private.

### Web (US-006, US-007)

- `composables/useSkillCatalog.ts`: `list()`, `create({ gitUrl, ref, path })`, `update(id)`, `remove(id)` via
  `useApi()` on the admin routes; `composables/useProjectSkills.ts`: `list(slug)`, `enable(slug, skillId)`,
  `disable(slug, skillId)`.
- `pages/admin/skills.vue` (global admins; a 403 from `list()` sets `adminOnly` and renders the `skills.adminOnly`
  note, as `pages/admin/fleet/repos.vue` does): table of sources (URL, ref,
  short SHA or `—` when `resolvedSha` is null, path, status badge with reason, skill count) with Add (dialog, vee-validate + zod: `gitUrl` must match
  `https://github.com/<owner>/<repo>`, `ref` required, `path` optional), Update, Remove (confirm), and an expandable
  row listing each skill's name and description.
- `components/ui/switch/` (new, `Switch.vue` + `index.ts`): the shadcn-vue Switch, hand-written over radix-vue's
  `SwitchRoot` / `SwitchThumb` following the existing `components/ui/*` layout (no shadcn CLI, no network).
- `components/ProjectSkillsPanel.vue` in the new settings tab (trigger label key `skills.project.tab`): one row per catalog skill (name, description, source
  URL + short SHA or `—` when `resolvedSha` is null, status warning when the source is `RESOLVE_FAILED`) with a switch; switches are disabled unless `useProjectViewerRole(slug)` reports `canManage`
  (project ADMIN or global ADMIN); toggling calls enable/disable and shows a toast on failure
  (reverting the switch).
- i18n keys in `i18n/locales/en.json` and `zh.json` (namespace `skills`, plus `nav.skills`), including
  `skills.form.gitUrlInvalid` (add-dialog URL validation) and `skills.project.sourceFailed` (panel warning).

### Failure Handling

| Case | Behaviour |
|---|---|
| Non-GitHub or malformed URL | 400 `skills.unsupportedHost`, nothing written |
| Private, deleted or misspelled repo | source stored `RESOLVE_FAILED` / `not_public_or_missing` (create) or status set, pin kept (update) |
| Unknown ref (commits call 422) | `RESOLVE_FAILED` / `ref_not_found`, same create/update split |
| GitHub rate limit (403/429) | `RESOLVE_FAILED` / `rate_limited`, same create/update split |
| GitHub unreachable or timeout | `RESOLVE_FAILED` / `provider_unreachable` |
| Tree truncated | `RESOLVE_FAILED` / `tree_truncated` |
| No skill directories under the path | `RESOLVE_FAILED` / `no_skills` |
| Bad `SKILL.md` (no frontmatter, bad name, block scalar, > 256 KiB) | `RESOLVE_FAILED` / `invalid_skill:<dir>` |
| Name owned by another source | 409 `skills.nameConflict`, nothing changed |
| Same source registered twice | 409 `skills.sourceExists` |
| Web toggle fails | toast with `extractApiError`, switch reverts |
| Renamed repo (GitHub answers 301) | `FleetHttpClient` refuses redirects → `RESOLVE_FAILED` / `provider_unreachable`; the admin registers the new URL |

Anonymous GitHub calls are limited to about 60 per hour per IP; a resolve costs 2 calls plus one per skill, so a
50-skill source is close to the hourly ceiling.

A failed create still stores the source (`RESOLVE_FAILED`), so re-posting the same source returns 409
`skills.sourceExists`; the admin fixes the upstream repo and clicks Update instead.

Tests never call GitHub: integration and e2e suites spy on the booted app's resolver
(`jest.spyOn(app.get(SKILL_RESOLVER), 'resolve')`, the pattern of `fleet-pr-refresher.integration.spec.ts:57`).

After the API contract changes, `bun run generate` (which runs `api:export-spec`) regenerates `openapi.json` and the
untracked CLI client; the CLI gains no commands.

## Out of Scope

- US-003 only: two concurrent creates of the same source, or two concurrent writes that both introduce the same skill
  name, may return 500 to the losing request instead of 409; the
  `(owner, repo, ref, path)` and `Skill.name` unique indexes still guarantee consistent rows.
- US-001 only: a `git@github.com:` SSH URL and a URL with extra path segments are rejected by the same validation as
  any non-matching URL; only the GitLab case is pinned by an acceptance criterion.
- US-001 only: frontmatter keys other than `name` and `description`, duplicate keys and trailing `#` comments are not
  interpreted (the first `name:` / `description:` line wins).
- US-004 only: rollback of a partially applied Update after a database failure is not covered by an acceptance
  criterion; the replacement runs in one transaction.
- US-005 only: deleting a skill that is not enabled returns 204 (idempotent) without a dedicated acceptance criterion.
- US-003 only: more than 200 registered sources — the admin list shows the first 200 by creation time.
- Private skill sources and any credential use for skill repositories (ruling D546); a later feature adds them.
- Skill hosts other than github.com (GitLab, generic git URLs).
- Editing, uploading or authoring skill content in koda.
- Background or scheduled re-resolution of sources; a source changes only on an admin's Update.
- The runner-side skill fetch, the thread skill snapshot, and the `load_skill` / `read_skill_file` agent tools — they
  belong to feature `fleet-s5a-native-chat`.
- CLI commands for skills.
- Per-thread skill selection.
- Using a GitHub App or personal token to raise the anonymous GitHub rate limit.

## Stories

1. **US-001: Skill catalog data and parsers** — `Workdir: apps/api` — no dependencies.
2. **US-002: GitHub skill resolver** — `Workdir: apps/api` — depends on US-001.
3. **US-003: Skill source create and list routes** — `Workdir: apps/api` — depends on US-002.
4. **US-004: Skill source update and delete routes** — `Workdir: apps/api` — depends on US-003.
5. **US-005: Project skill enablement routes** — `Workdir: apps/api` — depends on US-004 (both edit
   `skills.service.ts`, `endpoint.e2e.spec.ts` and `openapi.json`).
6. **US-006: Web skill catalog admin page** — `Workdir: apps/web` — depends on US-004.
7. **US-007: Web project Skills tab and admin navigation** — `Workdir: apps/web` — depends on US-005 and US-006 (both
   edit the web locale files).

### Context Files

> Existing files to read, or files an upstream dependency creates (annotated).

**US-001**

- `apps/api/src/common/enums.ts` — string constants pattern for `SkillSourceStatus`
- `apps/api/src/webhook/webhook.service.ts` — `ValidationAppException(args, prefix)` usage (`:53`)
- `apps/api/test/helpers/test-prisma.ts` — `createTestPrismaClient()` for the PG schema tests
- `apps/api/test/helpers/migration-schema.ts` — `scratchSchemaBefore`, `applyMigration`

**US-002**

- `apps/api/src/fleet/git-broker/fleet-http-client.ts` — `FleetHttpClient.request`, reused
- `apps/api/src/fleet/git-broker/github-app-client.ts` — GitHub request and parsing pattern (`getTree`, `getFile`)
- `apps/api/src/fleet/git-broker/git-broker.module.ts` — gains the `FleetHttpClient` export
- `apps/api/src/config/vcs.config.ts` — `VCS_CFG`, `githubApiUrl`
- `apps/api/src/skills/skill-frontmatter.ts` — created by US-001, called per `SKILL.md`

**US-003**

- `apps/api/src/app.module.ts` — gains `SkillsModule` in `imports`
- `apps/api/src/fleet/repos/prisma-fleet-repo.repository.ts` — `AbstractPrismaRepository` pattern
- `apps/api/src/common/test-helpers/global-stubs.module.ts` — `GlobalStubsModule` for the DI spec
- `apps/api/test/integration/fleet/fleet-pr-refresher.integration.spec.ts` — spying on a booted app's provider
- `apps/api/src/skills/github-skill-resolver.ts` — created by US-002, bound to `SKILL_RESOLVER`

**US-004**

- `apps/api/src/skills/skills.service.ts` — created by US-003, gains update and delete
- `apps/api/src/skills/admin-skills.controller.ts` — created by US-003, gains the update and delete routes
- `apps/api/src/skills/prisma-skill-catalog.repository.ts` — created by US-003, gains the replacement transaction

**US-005**

- `apps/api/src/projects/projects.controller.ts` — `addProjectAgent` project-admin pattern
- `apps/api/src/projects/project-access.service.ts` — `assertProjectAdmin`
- `apps/api/src/projects/project-membership.guard.ts` — `ProjectMembershipGuard`
- `apps/api/src/auth/principal/koda-principal.types.ts` — `isUserPrincipal`
- `apps/api/src/skills/skills.service.ts` — created by US-003, gains the project methods

**US-006**

- `apps/web/pages/admin/fleet/repos.vue` — admin table page pattern
- `apps/web/composables/useFleetRepos.ts` — composable pattern over `useApi()`
- `apps/web/components/ProjectMembersPanel.vue` — confirm-dialog and toast patterns

**US-007**

- `apps/web/pages/[project]/settings.vue` — Tabs, gains the `skills` tab
- `apps/web/composables/useProjectViewerRole.ts` — `canManage` source
- `apps/web/layouts/default.vue` — ADMIN section, gains the Skills link
- `apps/web/components/CommandPalette.vue` — gains the admin-only Skills entry
- `apps/web/tests/layouts/default-fleet-nav.spec.ts` — layout test pattern for admin links

### Creates

> New files each story authors.

**US-001**

- `apps/api/prisma/migrations/20261012090000_skill_catalog/migration.sql` — `SkillSource`, `Skill`, `ProjectSkill`
- `apps/api/src/skills/skill-resolver.ts` — `SkillResolver`, `SkillResolution`, `SkillResolveError`, `SKILL_RESOLVER`
- `apps/api/src/skills/skill-frontmatter.ts` — `parseSkillFrontmatter`
- `apps/api/src/skills/github-url.ts` — `parseGitHubUrl`
- `apps/api/src/skills/skill-frontmatter.spec.ts`
- `apps/api/src/skills/github-url.spec.ts`
- `apps/api/test/integration/skills/skill-catalog-schema.integration.spec.ts` — constraints and the migration on PG

**US-002**

- `apps/api/src/skills/github-skill-resolver.ts` — `GitHubSkillResolver`
- `apps/api/src/skills/github-skill-resolver.spec.ts` — resolver over a stubbed `FleetHttpClient`

**US-003**

- `apps/api/src/skills/skills.module.ts` — `SkillsModule`
- `apps/api/src/skills/skills.module.spec.ts` — DI wiring (unit, no DB)
- `apps/api/src/skills/prisma-skill-catalog.repository.ts` — module-private repository (`SKILL_CATALOG_REPOSITORY`)
- `apps/api/src/skills/skill-catalog.domain.ts` — domain types and the repository token
- `apps/api/src/skills/skills.service.ts` — `SkillsService`
- `apps/api/src/skills/admin-skills.controller.ts` — `AdminSkillsController`
- `apps/api/src/skills/dto/skill-source.dto.ts` — `SkillSourceDto`, `SkillSourceListDto`, `SkillDto`, `CreateSkillSourceDto`
- `apps/api/src/i18n/en/skills.json`
- `apps/api/src/i18n/zh/skills.json`
- `apps/api/test/integration/skills/admin-skills.integration.spec.ts` — create and list over HTTP on PG

**US-004**

- `apps/api/test/integration/skills/admin-skills-update.integration.spec.ts` — update and delete over HTTP on PG

**US-005**

- `apps/api/src/skills/project-skills.controller.ts` — `ProjectSkillsController`
- `apps/api/src/skills/dto/project-skill.dto.ts` — `ProjectSkillDto`, `ProjectSkillListDto`
- `apps/api/test/integration/skills/project-skills.integration.spec.ts`

**US-006**

- `apps/web/composables/useSkillCatalog.ts`
- `apps/web/pages/admin/skills.vue`
- `apps/web/components/AddSkillSourceDialog.vue`
- `apps/web/tests/composables/useSkillCatalog.spec.ts`
- `apps/web/tests/pages/admin-skills-page.spec.ts`
- `apps/web/tests/components/AddSkillSourceDialog.spec.ts`

**US-007**

- `apps/web/composables/useProjectSkills.ts`
- `apps/web/components/ui/switch/Switch.vue`
- `apps/web/components/ui/switch/index.ts`
- `apps/web/components/ProjectSkillsPanel.vue`
- `apps/web/tests/components/ProjectSkillsPanel.spec.ts`
- `apps/web/tests/layouts/default-skills-nav.spec.ts`
- `apps/web/tests/components/CommandPalette.spec.ts`

### Modifies

**US-001**

- `apps/api/prisma/schema.prisma` — gains the SkillSource, Skill and ProjectSkill models and the Project.skills back-relation; integration suites build their schema from this file.

**US-002**

None. The story adds `FleetHttpClient` to `GitBrokerModule.exports` (a read Context File) and creates new files only; no existing test asserts on that module's export list.

**US-003**

- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the endpoint lifecycle suite must cover every endpoint (rule api-testing); this story adds GET /api/admin/skills/sources (200) and POST /api/admin/skills/sources (201 with the booted app's SKILL_RESOLVER resolve spied through jest.spyOn(app.get(SKILL_RESOLVER), 'resolve'), and 400 for a GitLab URL), so the suite never calls GitHub. Existing expectations unchanged.
- `openapi.json` — regenerated by `bun run api:export-spec` for the new admin routes and DTOs.

**US-004**

- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the endpoint lifecycle suite must cover every endpoint (rule api-testing); this story adds POST /api/admin/skills/sources/:id/update (200 with the resolver spied as in US-003, 404 for an unknown id) and DELETE /api/admin/skills/sources/:id (204, 404 for an unknown id). Existing expectations unchanged.
- `openapi.json` — regenerated by `bun run api:export-spec` for the update and delete routes.

**US-005**

- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the endpoint lifecycle suite must cover every endpoint (rule api-testing); this story adds the three project skill routes (happy path plus one error each). Existing expectations unchanged.
- `openapi.json` — regenerated by `bun run api:export-spec` for the new project routes and DTOs.

**US-006**

- `apps/web/i18n/locales/en.json` — gains the `skills` admin keys; the locale-parity tests compare key sets between en and zh, so both files change together.
- `apps/web/i18n/locales/zh.json` — gains the same keys as en.json, keeping the locale-parity tests green.

**US-007**

- `apps/web/i18n/locales/en.json` — gains the project Skills tab keys and `nav.skills`; the locale-parity tests compare key sets between en and zh, so both files change together.
- `apps/web/i18n/locales/zh.json` — gains the same keys as en.json, keeping the locale-parity tests green.

### Seams

- SEAM-1 (US-001 -> US-002): `GitHubSkillResolver` passes each `SKILL.md` through `parseSkillFrontmatter`; US-002 ACs
  feed real frontmatter text through the stubbed HTTP client.
- SEAM-2 (US-001, US-002 -> US-003): `SkillsService` parses the request with `parseGitHubUrl` and resolves through the
  `SKILL_RESOLVER` token bound to `GitHubSkillResolver`; US-003 ACs spy on the booted app's resolver, trigger
  `POST /api/admin/skills/sources`, and prove the binding with a DI spec.
- SEAM-3 (US-003, US-004 -> US-006): the admin routes are consumed by `useSkillCatalog`; US-006 ACs assert the request
  path and the JSON body `{ gitUrl, ref, path }`.
- SEAM-4 (US-005 -> US-007): the project routes are consumed by `useProjectSkills`; US-007 ACs assert `PUT` and
  `DELETE` on `/projects/<slug>/skills/<skillId>`.

## Acceptance Criteria

### US-001: Skill catalog data and parsers (`Workdir: apps/api`)

1. [unit] `parseGitHubUrl('https://github.com/NathApp-IO/Nax-Spec-Kit-Skills.git')` deep-equals `{ owner: 'nathapp-io', repo: 'nax-spec-kit-skills', gitUrl: 'https://github.com/nathapp-io/nax-spec-kit-skills' }`.
2. [unit] `parseGitHubUrl('https://gitlab.com/nathapp-io/skills')` throws `ValidationAppException` with prefix `skills.unsupportedHost`.
3. [unit] `parseGitHubUrl('https://github.com/nathapp-io/..')` throws `ValidationAppException` with prefix `skills.unsupportedHost`.
4. [unit] `parseSkillFrontmatter` on text `---` / `name: spec-review` / `description: "Review a spec"` / `---` / `# Body` deep-equals `{ name: 'spec-review', description: 'Review a spec' }`.
5. [unit] `parseSkillFrontmatter` on the same frontmatter with `\r\n` line endings deep-equals `{ name: 'spec-review', description: 'Review a spec' }`.
6. [unit] `parseSkillFrontmatter` on the same frontmatter preceded by a UTF-8 BOM deep-equals `{ name: 'spec-review', description: 'Review a spec' }`.
7. [unit] `parseSkillFrontmatter` with a `description` value of 1500 characters returns a `description` equal to the first 1024 characters of the value.
8. [unit] `parseSkillFrontmatter` on text whose first line is not `---` throws `SkillResolveError` with `reason` `invalid_skill`.
9. [unit] `parseSkillFrontmatter` with `name: Spec_Review` throws `SkillResolveError` with `reason` `invalid_skill`.
10. [unit] `parseSkillFrontmatter` with `description: >` followed by an indented line throws `SkillResolveError` with `reason` `invalid_skill`.
11. [unit] `parseSkillFrontmatter` with a `name` line and no `description` line throws `SkillResolveError` with `reason` `invalid_skill`.
12. [unit] `parseSkillFrontmatter` with `description:` followed by no value throws `SkillResolveError` with `reason` `invalid_skill`.
13. [integration] Inserting a second `SkillSource` row with the same `owner`, `repo`, `ref` and `path` as an existing row fails with a unique-constraint violation.
14. [integration] Inserting a `Skill` row whose `name` equals the `name` of a `Skill` under another source fails with a unique-constraint violation.
15. [integration] Applying the `20261012090000_skill_catalog` migration with `applyMigration` to a scratch schema from `scratchSchemaBefore` creates the `SkillSource`, `Skill` and `ProjectSkill` tables, after which inserting two `SkillSource` rows with the same `owner`, `repo`, `ref` and `path` fails with a unique-constraint violation.

### US-002: GitHub skill resolver (`Workdir: apps/api`)

1. [unit] `GitHubSkillResolver.resolve({ owner: 'o', repo: 'r', ref: 'release/v1', path: 'skills' })` sends its first `FleetHttpClient.request` as `GET <githubApiUrl>/repos/o/r/commits/release/v1`.
2. [unit] Every `FleetHttpClient.request` the resolver sends carries headers with no `authorization` key.
3. [unit] With the commits call returning `{ sha: 'abc' }` and the tree for `abc` (requested with `recursive=1`) holding `skills/a` (tree), `skills/a/SKILL.md` (blob), `skills/b` (tree without `SKILL.md`) and `other/c/SKILL.md` (blob), `resolve` deep-equals `{ sha: 'abc', skills: [{ name: 'alpha', description: 'First', dir: 'skills/a' }] }` when `skills/a/SKILL.md` carries `name: alpha` and `description: First`.
4. [unit] For a skill directory `skills/my skill`, the resolver fetches `GET <githubApiUrl>/repos/o/r/contents/skills/my%20skill/SKILL.md?ref=abc`.
5. [unit] For path `""` and a tree listing tree entries `b`, `a`, `x`, `x/y` and blobs `b/SKILL.md`, `a/SKILL.md`, `x/y/SKILL.md` in that order, with each `SKILL.md` carrying a distinct valid `name`, `resolve` returns skills whose `dir` values are exactly `['a', 'b']`.
6. [unit] A 404 from the commits call rejects with `SkillResolveError` whose `reason` is `not_public_or_missing`.
7. [unit] A 422 from the commits call rejects with `SkillResolveError` whose `reason` is `ref_not_found`.
8. [unit] A 403 from the tree call rejects with `SkillResolveError` whose `reason` is `rate_limited`.
9. [unit] A tree response with `truncated: true` rejects with `SkillResolveError` whose `reason` is `tree_truncated`.
10. [unit] A tree with no directory under `path` holding a `SKILL.md` rejects with `SkillResolveError` whose `reason` is `no_skills`.
11. [unit] A tree with 51 skill directories under `path` rejects with `SkillResolveError` whose `reason` is `too_many_skills`.
12. [unit] Two skill directories whose `SKILL.md` frontmatter carries the same `name` `dup` reject with an error deep-equal to `new SkillResolveError('duplicate_name', 'dup')`.
13. [unit] A tree whose `skills/a/SKILL.md` entry has `size` 262145 rejects with an error deep-equal to `new SkillResolveError('invalid_skill', 'skills/a')`.
14. [unit] When `FleetHttpClient.request` throws `RepoCheckException('provider_unreachable')`, `resolve` rejects with `SkillResolveError` whose `reason` is `provider_unreachable`.
15. [unit] A 500 from the commits call rejects with `SkillResolveError` whose `reason` is `provider_error`.

### US-003: Skill source create and list routes (`Workdir: apps/api`)

1. [unit] `Test.createTestingModule({ imports: [GlobalStubsModule, SkillsModule] })` compiles and `get(SKILL_RESOLVER)` returns an instance of `GitHubSkillResolver`.
2. [integration] `POST /api/admin/skills/sources` by a global ADMIN with body `{ gitUrl: 'https://github.com/NathApp-IO/nax-spec-kit-skills.git', ref: 'main', path: 'skills' }` calls the spied `resolve` once with `{ owner: 'nathapp-io', repo: 'nax-spec-kit-skills', ref: 'main', path: 'skills' }`.
3. [integration] With the spied `resolve` returning `{ sha: 's1', skills: [{ name: 'spec-review', description: 'd', dir: 'skills/spec-review' }] }`, the same request returns 201 with a body matching `{ status: 'OK', resolvedSha: 's1', skills: [{ name: 'spec-review', description: 'd', dir: 'skills/spec-review' }] }`.
4. [integration] With the spied `resolve` rejecting `new SkillResolveError('rate_limited')`, `POST /api/admin/skills/sources` returns 201 with a body matching `{ status: 'RESOLVE_FAILED', statusReason: 'rate_limited', skills: [] }`.
5. [integration] `POST /api/admin/skills/sources` with `gitUrl: 'https://gitlab.com/a/b'` returns 400.
6. [integration] After `POST /api/admin/skills/sources` with `gitUrl: 'https://gitlab.com/a/b'`, the `SkillSource` row count is unchanged.
7. [integration] `POST /api/admin/skills/sources` whose resolution contains a name owned by a skill of an existing source returns 409.
8. [integration] After a `POST /api/admin/skills/sources` rejected with 409 because its resolution contains a name owned by another source, the `SkillSource` row count is unchanged.
9. [integration] A second `POST /api/admin/skills/sources` with the same owner, repo, ref and path as a registered source returns 409 without calling the spied `resolve`.
10. [integration] `POST /api/admin/skills/sources` by an authenticated user who is not a global ADMIN returns 403.
11. [integration] `GET /api/admin/skills/sources` with an agent API key returns 403.
12. [integration] `GET /api/admin/skills/sources` by a global ADMIN returns `{ items }` holding every source ordered by `createdAt`.
13. [integration] Each source in `GET /api/admin/skills/sources` carries its `skills` ordered by `name`.
14. [integration] `POST /api/admin/skills/sources` with `path: '../x'` returns 400 without calling the spied `resolve`.
15. [integration] `POST /api/admin/skills/sources` with `ref: 'a..b'` returns 400 without calling the spied `resolve`.

### US-004: Skill source update and delete routes (`Workdir: apps/api`)

1. [integration] `POST /api/admin/skills/sources/:id/update` for a source holding skills `a` and `b`, with the spied `resolve` returning skills `a` (description `new`) and `c`, returns 200 whose `skills` deep-equal `[{ id: <a's previous id>, name: 'a', description: 'new', dir: <a's dir> }, { id: <any>, name: 'c', description: <c's>, dir: <c's dir> }]`.
2. [integration] For a source holding skills `a` and `b`, both enabled for a project, `POST /api/admin/skills/sources/:id/update` with the spied `resolve` returning skills `a` and `c` leaves the `ProjectSkill` row for `a` in place.
3. [integration] For a source holding skills `a` and `b`, both enabled for a project, `POST /api/admin/skills/sources/:id/update` with the spied `resolve` returning skills `a` and `c` removes the `ProjectSkill` row for `b`.
4. [integration] `POST /api/admin/skills/sources/:id/update` with the spied `resolve` rejecting `new SkillResolveError('not_public_or_missing')` returns 200 with a body matching `{ status: 'RESOLVE_FAILED', statusReason: 'not_public_or_missing', resolvedSha: <previous sha>, skills: <previous skills> }`.
5. [integration] `POST /api/admin/skills/sources/:id/update` whose resolution contains a name owned by another source returns 409.
6. [integration] After a `POST /api/admin/skills/sources/:id/update` rejected with 409 because its resolution contains a name owned by another source, the source's stored `status`, `resolvedSha` and skills equal their values before the request.
7. [integration] `POST /api/admin/skills/sources/:id/update` with an id that does not exist returns 404.
8. [integration] `DELETE /api/admin/skills/sources/:id` by a global ADMIN returns 204.
9. [integration] After `DELETE /api/admin/skills/sources/:id`, no `Skill` row and no `ProjectSkill` row of that source remains.
10. [integration] `DELETE /api/admin/skills/sources/:id` with an id that does not exist returns 404.
11. [integration] `DELETE /api/admin/skills/sources/:id` by an authenticated user who is not a global ADMIN returns 403.
12. [integration] `POST /api/admin/skills/sources/:id/update` by an authenticated user who is not a global ADMIN returns 403.
13. [integration] `POST /api/admin/skills/sources/:id/update` with an agent API key returns 403.
14. [integration] `POST /api/admin/skills/sources/:id/update` with the spied `resolve` rejecting `new SkillResolveError('invalid_skill', 'skills/x')` stores `statusReason` `invalid_skill:skills/x`.
15. [integration] `POST /api/admin/skills/sources/:id/update` with the spied `resolve` rejecting a `SkillResolveError('invalid_skill', <a 400-character detail>)` stores a `statusReason` of exactly 300 characters.

### US-005: Project skill enablement routes (`Workdir: apps/api`)

1. [integration] `GET /api/projects/:slug/skills` by a DEVELOPER member, with catalog skills `beta` (enabled for the project) and `alpha` (not enabled), returns `items` whose `[name, enabled]` pairs are exactly `[['alpha', false], ['beta', true]]`.
2. [integration] Each item of `GET /api/projects/:slug/skills` carries `source` deep-equal to `{ id, gitUrl, ref, resolvedSha, status }` of the skill's source.
3. [integration] `GET /api/projects/:slug/skills` by an authenticated user who is not a member of the project and not a global ADMIN returns 403.
4. [integration] `GET /api/projects/:slug/skills` with an agent API key returns 403 even when the agent is on the project's roster.
5. [integration] `PUT /api/projects/:slug/skills/:skillId` by a project ADMIN returns 200 with `enabled: true`.
6. [integration] After `PUT /api/projects/:slug/skills/:skillId` by a project ADMIN, the stored `ProjectSkill` row's `enabledById` is the caller's user id.
7. [integration] Calling `PUT /api/projects/:slug/skills/:skillId` twice for the same skill leaves exactly one `ProjectSkill` row.
8. [integration] `PUT /api/projects/:slug/skills/:skillId` by a global ADMIN who is not a member of the project returns 200.
9. [integration] `PUT /api/projects/:slug/skills/:skillId` by a DEVELOPER member returns 403.
10. [integration] `PUT /api/projects/:slug/skills/:skillId` with an agent API key returns 403.
11. [integration] `PUT /api/projects/:slug/skills/:skillId` with a `skillId` that does not exist returns 404.
12. [integration] `DELETE /api/projects/:slug/skills/:skillId` by a project ADMIN returns 204 and the `ProjectSkill` row no longer exists.
13. [integration] `DELETE /api/projects/:slug/skills/:skillId` with a `skillId` that does not exist returns 404.
14. [integration] After `PUT /api/projects/a/skills/:skillId` by project A's ADMIN, `GET /api/projects/b/skills` returns that skill with `enabled: false`.
15. [integration] `PUT /api/projects/b/skills/:skillId` by a user who is ADMIN of project A and DEVELOPER of project B returns 403.

### US-006: Web skill catalog admin page (`Workdir: apps/web`)

1. [unit] `useSkillCatalog().create({ gitUrl: 'https://github.com/o/r', ref: 'main', path: 'skills' })` sends `POST /admin/skills/sources` through `useApi()` with the JSON body `{ "gitUrl": "https://github.com/o/r", "ref": "main", "path": "skills" }`.
2. [unit] `useSkillCatalog().list()` sends `GET /admin/skills/sources` and returns the response's `items` array.
3. [unit] `useSkillCatalog().update('src1')` sends `POST /admin/skills/sources/src1/update`.
4. [unit] `useSkillCatalog().remove('src1')` sends `DELETE /admin/skills/sources/src1`.
5. [unit] `pages/admin/skills.vue` with a source whose `resolvedSha` is `0123456789abcdef` renders `0123456` in that source's row.
6. [unit] A row for a source whose `resolvedSha` is null renders `—` in the SHA column.
7. [unit] A row for a source with `status: 'RESOLVE_FAILED'` and `statusReason: 'rate_limited'` renders a failure badge whose text includes `rate_limited`.
8. [unit] Expanding a source row renders each of its skills' `name` and `description`.
9. [unit] Clicking Update on a row calls `useSkillCatalog().update` with that row's id and re-renders the row from the returned `SkillSourceDto`.
10. [unit] Clicking Remove calls `useSkillCatalog().remove` after the confirmation is accepted.
11. [unit] When `useSkillCatalog().list()` rejects with a 403 API error, `pages/admin/skills.vue` renders the `skills.adminOnly` note and no Add button.
12. [unit] On `pages/admin/skills.vue`, clicking Add opens `AddSkillSourceDialog`, and a successful `create` closes the dialog and renders a row for the returned `SkillSourceDto`.
13. [unit] `AddSkillSourceDialog` submitted with `gitUrl` `https://gitlab.com/a/b` shows the validation message for the `skills.form.gitUrlInvalid` key and does not call `create`.
14. [unit] `AddSkillSourceDialog` submitted with a valid `gitUrl`, `ref` `main` and an empty path field calls `create` with `path: ''`.
15. [unit] When `create` rejects with a 409 API error, `AddSkillSourceDialog` shows a toast with the message from `extractApiError` and stays open.

### US-007: Web project Skills tab and admin navigation (`Workdir: apps/web`)

1. [unit] `pages/[project]/settings.vue` renders three tab triggers, `project`, `vcs` and `skills`, and the `skills` content is `ProjectSkillsPanel` receiving the project slug.
2. [unit] `ProjectSkillsPanel` with two items renders two rows, each showing the skill's `name`, `description` and the first 7 characters of `source.resolvedSha`.
3. [unit] A `ProjectSkillsPanel` row whose `source.resolvedSha` is null renders `—` in place of the SHA.
4. [unit] When `canManage` is true, switching on a disabled skill calls `useProjectSkills().enable`, which sends `PUT /projects/<slug>/skills/<skillId>`.
5. [unit] When `canManage` is true, switching off an enabled skill calls `useProjectSkills().disable`, which sends `DELETE /projects/<slug>/skills/<skillId>`.
6. [unit] When `enable` rejects, the panel shows a toast with the message from `extractApiError` and the switch shows off again.
7. [unit] When `useProjectViewerRole(slug)` resolves `data.value.canManage` to false, every switch is disabled.
8. [unit] A row whose `source.status` is `RESOLVE_FAILED` renders the warning text for the `skills.project.sourceFailed` key.
9. [unit] The default layout rendered for a global admin contains a link to `/admin/skills` labelled with the `nav.skills` key.
10. [unit] The default layout rendered for a user who is not a global admin contains no link to `/admin/skills`.
11. [unit] `CommandPalette` opened by a global admin lists an entry with id `skills` that navigates to `/admin/skills`.
12. [unit] `CommandPalette` opened by a user who is not a global admin lists no entry with id `skills`.
