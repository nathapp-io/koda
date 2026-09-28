# Track 3 Slice 6 — Web & CLI Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the web and CLI LOWs, the CI path-filter LOW, and the #145 API cleanup LOWs, as one PR on `feat/track3-web-cli-hygiene`. This is the last Track 3 slice.

**Architecture:** The web gets one tagged-template helper, `apiPath`, which encodes every interpolated value. Every API path moves to it, and a source-guard spec keeps raw interpolation out. The API cleanup deletes dead code and removes two redundant reads. It changes no route and no contract. The CLI gets three small shared helpers: `parsePositiveInt` for numeric options, `requireForce` for delete confirmations, and `resolveSecret` for secrets. `resolveSecret` reads a secret from stdin (`-`), a hidden prompt, or an environment variable, so it never has to go on argv. The CLI also gets a signal installer that exits 130 on Ctrl+C.

**Tech Stack:** Nuxt 3 web (Jest + ts-jest, source-text and esbuild mount specs), NestJS 11 + Prisma on PostgreSQL 16 (Jest), Commander 12 CLI (Jest), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-27-track-3-review-remediation-design.md`, section "Slice 6 — Web & CLI hygiene". Source findings: `docs/20260925-review-whole-repo.md`, "LOW (abbreviated)" → Web, CLI, and "CI and release" (path filters only). The API cleanup comes from GitHub issue #145 ("Dead or unused code" and "Minor query inefficiencies"). The guard half of #145 shipped in Slice 3.

## Global Constraints

Copied from the spec's Constraints section; every task's requirements include them.

- API stays single-instance. Postgres only. String-typed enum / JSON-as-String columns stay.
- Follow `nathapp-nestjs-patterns`: `JsonResponse.Ok`, `AppException` subclasses, `registerAs` config, repository → service → controller, outbox `record()` inside `txManager.run`.
- TDD for every slice. DB-backed behavior gets integration tests on real Postgres (`KODA_DB_TESTS=1`).
- The production API runs on **Bun** (`start:prod-runtime`), dev on Node.
- Contract changes regenerate `openapi.json` and the CLI client in the same PR. This slice changes no contract: Task 14 proves `bun run generate` leaves `openapi.json` unchanged.
- All ten CI checks are required on `main`; each slice PR must be green, including `e2e` and `evaluate`.

Plan-level rules:

- Work on branch `feat/track3-web-cli-hygiene` in the main checkout (`repos/koda`), not a worktree. It was branched from `main` @ `8589f872` (after Slice 4, #153). Nothing else is in development in parallel.
- Spec scope for secrets is exactly `--api-key` (login, init, config set, config profile add) and `vcs connect --token`. `auth register --password`, `user create --password`, `webhook --secret` and `ci-webhook --signature` are not in the spec. They stay as they are and are listed in the PR as out of scope.
- API: run specs with `cd apps/api && bun run test:scoped <paths>`. Never `bun run test:integration -- <path>`: it ignores the path and runs every DB suite. ts-jest type-checks every spec. After a signature change, run `cd apps/api && bunx tsc --noEmit -p tsconfig.json` to list broken specs, and fix every one in the same task.
- Web: run specs with `cd apps/web && bunx jest <paths>`. CLI: `cd apps/cli && bunx jest <paths>`. The CLI's `src/generated` is gitignored. If it is missing, run `bun run generate:cli` from the repo root first.
- CLI command specs spy on `process.exit` with a no-op, so code after `process.exit(...)` keeps running in tests. Every new exit path returns right after the exit call.
- No emojis anywhere. Conventional commits (`fix:`, `feat:`, `test:`, `refactor:`, `docs:`, `ci:`), no attribution trailer.

## Review Focus

The five inputs the spec implies but its test list does not name, most likely to bite first. Each has a test in the task that owns the code.

1. **A code-intel symbol id contains `/` and `::`.** Ids are `${projectId}:${repoId}:${file}::${localId}`, and `file` is a path. `apiPath` must keep the id as one segment (`%2F`), exactly as the old hand-written `encodeURIComponent` did. Task 1 tests a real-shaped id, and Task 3 keeps the code-intel mount spec green.
2. **An empty or missing route value.** A missing `slug` would build `/projects//tickets`, which the API routes somewhere else or 404s confusingly. `apiPath` throws on `''`, `undefined` and `null` instead of building that path. Task 1.
3. **A secret piped on stdin ends with a newline**, as it does with `echo key | koda login --api-key -`. The trailing newline must not become part of the key. An empty stdin must fail with a message, not save an empty key. Task 11.
4. **Ctrl+C while the hidden prompt is open.** In raw mode the terminal does not send SIGINT, so the prompt itself must restore the terminal and exit 130. Otherwise the shell is left without echo. Task 11.
5. **`config set --api-url <url>` with `KODA_API_KEY` set in the environment.** The environment fallback applies only to `login` and `vcs connect`. `config set` must not quietly save the environment's key into the config file. Task 12 tests this.

---

## File Structure

| File | Responsibility | Task |
|:--|:--|:--|
| `apps/web/lib/api-path.ts` (new) | `apiPath` tagged template: encode every interpolated value | 1 |
| `apps/web/tests/lib/api-path.spec.ts` (new) | `apiPath` unit tests | 1 |
| `apps/web/tests/lib/api-path-guard.spec.ts` (new) | Source guard: no raw interpolation in API paths | 2, 3 |
| `apps/web/components/*.vue`, `apps/web/composables/*.ts` | Call sites move to `apiPath` | 2 |
| `apps/web/pages/**/*.vue` | Call sites move to `apiPath` | 3 |
| `apps/web/pages/[project]/tickets/[ref].vue`, `apps/web/components/CommentThread.vue` | One comment toast | 4 |
| `apps/web/i18n/locales/{en,zh}.json`, `apps/web/tests/i18n/used-keys-exist.spec.ts` (new) | Missing `agents.*` keys; guard that every literal `t()` key exists | 4 |
| `apps/web/components/ui/input/Input.vue` | `inheritAttrs: false` | 5 |
| `apps/api/src/projects/projects.service.ts`, `apps/api/src/rag/rag.controller.ts`, `apps/api/src/retrieval/retrieval.controller.ts`, `apps/api/src/agents/agents.service.ts` | Dead code out | 6 |
| `apps/api/src/koda-domain-writer/prisma-koda-domain-writer.repository.ts`, `apps/api/src/comments/{comments.service,prisma-comment.repository}.ts` | Fewer reads | 7 |
| `apps/cli/src/utils/parse-positive-int.ts` (new) | Commander parser for positive integers | 8 |
| `apps/cli/src/utils/signals.ts` (new), `apps/cli/src/utils/force.ts` (new) | Exit 130 on Ctrl+C; `--force` exits 1 | 9 |
| `apps/cli/src/config.ts`, `apps/cli/src/commands/login.ts` | `apiUrl` falls through empty values | 10 |
| `apps/cli/src/utils/secret-input.ts` (new) | Read a secret from stdin, a hidden prompt, env, or a literal with a warning | 11 |
| `apps/cli/src/index.ts`, `apps/cli/src/commands/vcs.ts` | Secret options use `resolveSecret` | 12 |
| `.github/workflows/ci.yml` | Path filter adds `turbo.json`, `.nax/**` | 13 |

---

### Task 0: Branch, test database and baseline

**Files:** none changed.

- [ ] **Step 1: Confirm the branch and base**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda
git status -sb
git merge-base HEAD main
```

Expected: branch `feat/track3-web-cli-hygiene`, merge-base `8589f872`, and a clean tree.

- [ ] **Step 2: Start the test database and generate the CLI client**

```bash
cd apps/api && bun run test:db:up && cd ../.. && bun run generate:cli
```

Expected: the container reports healthy on port 5433, and `apps/cli/src/generated/` exists.

- [ ] **Step 3: Record the baseline**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda && bun run test 2>&1 | tail -15
cd apps/api && bun run test:scoped test/integration/projects/project-membership-gate.integration.spec.ts test/integration/graphify-kb-validation 2>&1 | tail -15
```

Expected: both green. Write the suite and test counts into the PR draft notes. If anything is red on the untouched branch, stop and report it. Do not start Task 1 on a red baseline.

- [ ] **Step 4: Confirm the plan is committed**

The plan was committed as `8e89d36d` when it was written. `git log --oneline -3` should show it. There is nothing to commit here.

---

### Task 1: `apiPath` helper

**Files:**
- Create: `apps/web/lib/api-path.ts`
- Test: `apps/web/tests/lib/api-path.spec.ts`

**Interfaces:**
- Produces: `apiPath(strings: TemplateStringsArray, ...values: Array<string | number>): string`, exported from `~/lib/api-path`. Tasks 2 and 3 use it at every API call site. `lib/` is not auto-imported by Nuxt, so every user imports it explicitly.

Context: route params (`slug`, `ref`, ids) go into API paths without encoding (review LOW, Web "Route params"). A value containing `/`, `?` or `#` changes which route the request hits.

- [ ] **Step 1: Write the failing test**

`apps/web/tests/lib/api-path.spec.ts`:

```ts
import { describe, expect, it } from '@jest/globals'
import { apiPath } from '~/lib/api-path'

describe('apiPath', () => {
  it('keeps the literal parts and encodes each interpolated value', () => {
    const slug = 'koda'
    const ref = 'KODA-12'
    expect(apiPath`/projects/${slug}/tickets/${ref}/comments`).toBe('/projects/koda/tickets/KODA-12/comments')
  })

  it.each([
    ['a/b', 'a%2Fb'],
    ['a?b=1', 'a%3Fb%3D1'],
    ['a#b', 'a%23b'],
    ['a b', 'a%20b'],
    ['50%', '50%25'],
    ['中文', '%E4%B8%AD%E6%96%87'],
  ])('encodes %p as one path segment', (value, encoded) => {
    expect(apiPath`/projects/${value}/labels`).toBe(`/projects/${encoded}/labels`)
  })

  it('keeps a code-intel symbol id (with / and ::) in one segment', () => {
    const id = 'proj1:repo1:src/app/main.ts::fn:boot'
    expect(apiPath`/code-intel/symbols/${id}/callers`).toBe(
      '/code-intel/symbols/proj1%3Arepo1%3Asrc%2Fapp%2Fmain.ts%3A%3Afn%3Aboot/callers',
    )
  })

  it('accepts numbers', () => {
    expect(apiPath`/projects/${'koda'}/vcs/sync/${42}`).toBe('/projects/koda/vcs/sync/42')
  })

  it('returns a template with no values unchanged', () => {
    expect(apiPath`/agents`).toBe('/agents')
  })

  it.each([[''], [undefined], [null]])('throws on an empty value (%p) instead of building //', (value) => {
    expect(() => apiPath`/projects/${value as unknown as string}/tickets`).toThrow('apiPath: empty value')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && bunx jest tests/lib/api-path.spec.ts`
Expected: FAIL, `Cannot find module '~/lib/api-path'`.

- [ ] **Step 3: Implement**

`apps/web/lib/api-path.ts`:

```ts
/**
 * Tagged template for API paths. Every interpolated value goes through
 * encodeURIComponent, so a slug, ticket ref or id stays one path segment and
 * can never add a segment or a query string. The literal parts are kept as
 * written, so query strings belong in the literal or in `$api`'s `query`.
 *
 *   apiPath`/projects/${slug}/tickets/${ref}`
 *
 * An empty value throws: `/projects//tickets` would reach a different route.
 */
export function apiPath(strings: TemplateStringsArray, ...values: Array<string | number>): string {
  return strings.reduce((path, part, index) => {
    if (index >= values.length) return path + part
    const value = values[index]
    if (value === undefined || value === null || value === '') {
      throw new Error(`apiPath: empty value after "${path + part}"`)
    }
    return path + part + encodeURIComponent(String(value))
  }, '')
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd apps/web && bunx jest tests/lib/api-path.spec.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/api-path.ts apps/web/tests/lib/api-path.spec.ts
git commit -m "feat(web): apiPath tagged template that encodes every path value"
```

---

### Task 2: Components and composables use `apiPath`

**Files:**
- Create: `apps/web/tests/lib/api-path-guard.spec.ts`
- Modify: `apps/web/components/CommentThread.vue:29,92,108`
- Modify: `apps/web/components/KbAddDocumentDialog.vue:31`
- Modify: `apps/web/components/ImportIssueDialog.vue:76`
- Modify: `apps/web/components/RotateKeyDialog.vue:71`
- Modify: `apps/web/components/EditAgentCapabilitiesDialog.vue:114`
- Modify: `apps/web/components/DeleteAgentDialog.vue:56`
- Modify: `apps/web/components/TicketActionPanel.vue:52`
- Modify: `apps/web/components/EditAgentRolesDialog.vue:93`
- Modify: `apps/web/components/CreateTicketDialog.vue:127`
- Modify: `apps/web/composables/useMemory.ts:65`
- Modify: `apps/web/composables/useTimelineEvents.ts:60`
- Modify: `apps/web/composables/useProjectViewerRole.ts:25`
- Modify: `apps/web/composables/useProjectMembers.ts:27,72,77`
- Modify: `apps/web/composables/useAdminUsers.ts:68,72`
- Modify: `apps/web/composables/useProjectEvents.ts:18`
- Modify (test text): `apps/web/tests/openapi/web-gap-ops.spec.ts:27`, `apps/web/tests/composables/useProjectEvents.spec.ts:14`

**Interfaces:**
- Consumes: `apiPath` from Task 1 (`import { apiPath } from '~/lib/api-path'`).
- Produces: the guard spec with a `GUARDED_DIRS` array. Task 3 appends `'pages'` to it.

- [ ] **Step 1: Write the failing guard**

`apps/web/tests/lib/api-path-guard.spec.ts`:

```ts
import { describe, expect, it } from '@jest/globals'
import { readdirSync, readFileSync } from 'fs'
import { join, relative } from 'path'

const webDir = join(__dirname, '../..')

/** Directories whose API paths must go through apiPath. Task 3 adds 'pages'. */
const GUARDED_DIRS = ['components', 'composables']

const API_ROOT = String.raw`(?:api\/)?(?:projects|agents|comments|admin|code-intel)\/`
/** An API path written as an untagged template literal with an interpolation. */
const RAW_TEMPLATE = new RegExp(String.raw`(?<!apiPath)\`\/${API_ROOT}[^\`]*\$\{`)
/** An API path built by string concatenation. */
const CONCAT = new RegExp(String.raw`['"]\/${API_ROOT}['"]\s*\+`)
/** A value encoded by hand inside apiPath, which would be encoded twice. */
const DOUBLE_ENCODED = /apiPath`[^`]*encodeURIComponent\(/

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(vue|ts)$/.test(entry.name) && !entry.name.endsWith('.spec.ts') ? [path] : []
  })
}

function offenders(dirs: string[]): string[] {
  return dirs
    .flatMap((dir) => sourceFiles(join(webDir, dir)))
    .flatMap((file) =>
      readFileSync(file, 'utf-8')
        .split('\n')
        .flatMap((line, index) =>
          RAW_TEMPLATE.test(line) || CONCAT.test(line) || DOUBLE_ENCODED.test(line)
            ? [`${relative(webDir, file)}:${index + 1}: ${line.trim()}`]
            : [],
        ),
    )
}

describe('API paths go through apiPath', () => {
  it('the patterns catch what they are meant to catch', () => {
    expect(RAW_TEMPLATE.test('$api.get(`/projects/${slug}/labels`)')).toBe(true)
    expect(RAW_TEMPLATE.test('$api.get(apiPath`/projects/${slug}/labels`)')).toBe(false)
    expect(RAW_TEMPLATE.test('router.push(`/${slug}/tickets/${ref}`)')).toBe(false)
    expect(CONCAT.test("$api.delete('/agents/' + props.agent.slug)")).toBe(true)
    expect(DOUBLE_ENCODED.test('apiPath`/projects/${encodeURIComponent(slug)}`')).toBe(true)
  })

  it('no guarded file interpolates an API path by hand', () => {
    expect(offenders(GUARDED_DIRS)).toEqual([])
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && bunx jest tests/lib/api-path-guard.spec.ts`
Expected: the pattern test passes. The offender test FAILS and lists the component and composable sites named in **Files** above.

- [ ] **Step 3: Move every component site to `apiPath`**

In each `.vue` file below, add `import { apiPath } from '~/lib/api-path'` to the `<script setup>` imports. Then make these exact replacements:

| File:line | Before | After |
|:--|:--|:--|
| `CommentThread.vue:29` | ``const commentsEndpoint = `/projects/${props.projectSlug}/tickets/${props.ticketRef}/comments` `` | ``const commentsEndpoint = apiPath`/projects/${props.projectSlug}/tickets/${props.ticketRef}/comments` `` |
| `CommentThread.vue:92` | ``$api.patch(`/comments/${comment.id}`, {`` | ``$api.patch(apiPath`/comments/${comment.id}`, {`` |
| `CommentThread.vue:108` | ``$api.delete(`/comments/${comment.id}`)`` | ``$api.delete(apiPath`/comments/${comment.id}`)`` |
| `KbAddDocumentDialog.vue:31` | ``$api.post(`/projects/${props.projectSlug}/kb/documents`, {`` | ``$api.post(apiPath`/projects/${props.projectSlug}/kb/documents`, {`` |
| `ImportIssueDialog.vue:76` | ``  `/projects/${props.projectSlug}/vcs/sync/${issueNumber}` `` | ``  apiPath`/projects/${props.projectSlug}/vcs/sync/${issueNumber}` `` |
| `RotateKeyDialog.vue:71` | `$api.post('/agents/' + props.agent.slug + '/rotate-key', {})` | ``$api.post(apiPath`/agents/${props.agent.slug}/rotate-key`, {})`` |
| `EditAgentCapabilitiesDialog.vue:114` | ``$api.patch(`/agents/${props.agent.slug}/update-capabilities`, `` | ``$api.patch(apiPath`/agents/${props.agent.slug}/update-capabilities`, `` |
| `DeleteAgentDialog.vue:56` | `$api.delete('/agents/' + props.agent.slug)` | ``$api.delete(apiPath`/agents/${props.agent.slug}`)`` |
| `TicketActionPanel.vue:52` | ``computed(() => `/projects/${props.projectSlug}/tickets/${props.ticket.ref}`)`` | ``computed(() => apiPath`/projects/${props.projectSlug}/tickets/${props.ticket.ref}`)`` |
| `EditAgentRolesDialog.vue:93` | ``$api.patch(`/agents/${props.agent.slug}/update-roles`, `` | ``$api.patch(apiPath`/agents/${props.agent.slug}/update-roles`, `` |
| `CreateTicketDialog.vue:127` | ``$api.post(`/projects/${props.projectSlug}/tickets`, `` | ``$api.post(apiPath`/projects/${props.projectSlug}/tickets`, `` |

`TicketActionPanel.vue:57,59,61` build on `baseUrl.value` (`` `${baseUrl.value}/verify-fix?approve=true` ``, `` `${baseUrl.value}/${action}` ``). Leave them as they are. `baseUrl` is now encoded, and `action` is the component's own action name, not user input.

- [ ] **Step 4: Move every composable site to `apiPath`**

In each `.ts` file below, add `import { apiPath } from '~/lib/api-path'` at the top. Then make these exact replacements:

| File:line | Before | After |
|:--|:--|:--|
| `useMemory.ts:65` | ``  `/projects/${slug}/memory`, `` | ``  apiPath`/projects/${slug}/memory`, `` |
| `useTimelineEvents.ts:60` | ``  `/projects/${slug}/timeline`, `` | ``  apiPath`/projects/${slug}/timeline`, `` |
| `useProjectViewerRole.ts:25` | ``(`/projects/${encodeURIComponent(slug)}/members`, `` | ``(apiPath`/projects/${slug}/members`, `` |
| `useProjectMembers.ts:27` | ``const base = `/projects/${encodeURIComponent(slug)}/members` `` | ``const base = apiPath`/projects/${slug}/members` `` |
| `useProjectMembers.ts:72` | ``$api.patch<ProjectMember>(`${base}/${encodeURIComponent(userId)}`, { role })`` | ``$api.patch<ProjectMember>(base + apiPath`/${userId}`, { role })`` |
| `useProjectMembers.ts:77` | ``$api.delete(`${base}/${encodeURIComponent(userId)}`)`` | ``$api.delete(base + apiPath`/${userId}`)`` |
| `useAdminUsers.ts:68` | ``$api.patch<AdminUser>(`/admin/users/${encodeURIComponent(id)}`, { disabled })`` | ``$api.patch<AdminUser>(apiPath`/admin/users/${id}`, { disabled })`` |
| `useAdminUsers.ts:72` | ``$api.patch<AdminUser>(`/admin/users/${encodeURIComponent(id)}`, { role })`` | ``$api.patch<AdminUser>(apiPath`/admin/users/${id}`, { role })`` |
| `useProjectEvents.ts:18` | ``createProjectEventStream(`/api/projects/${encodeURIComponent(slug)}/events`, handlers, {`` | ``createProjectEventStream(apiPath`/api/projects/${slug}/events`, handlers, {`` |

- [ ] **Step 5: Update the two tests that pin the old source text**

`apps/web/tests/openapi/web-gap-ops.spec.ts:27`:

```ts
    expect(source).toContain('$api.delete(apiPath`/comments/${comment.id}`)')
```

`apps/web/tests/composables/useProjectEvents.spec.ts:13-14`:

```ts
  test('targets the proxied events route with the slug encoded by apiPath', () => {
    expect(source).toContain('apiPath`/api/projects/${slug}/events`')
```

Other specs match looser text (`'/agents/'`, `'/kb/documents'`, `'/vcs/sync'`, `/projects/`), and they still pass.

- [ ] **Step 6: Run the guard, the touched specs, and type-check**

```bash
cd apps/web
bunx jest tests/lib tests/components tests/composables tests/openapi/web-gap-ops.spec.ts
bun run type-check
```

Expected: all PASS. `web-gap-ops.spec.ts`'s settings and labels tests still pass, because this task does not touch pages. Task 3 updates them together with the pages. Composable specs that assert URLs such as `'/projects/team/members'` and `'/admin/users/b'` still pass, because those test values encode to themselves.

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib apps/web/components apps/web/composables apps/web/tests
git commit -m "fix(web): components and composables build API paths with apiPath"
```

---

### Task 3: Pages use `apiPath`

**Files:**
- Modify: `apps/web/tests/lib/api-path-guard.spec.ts` (`GUARDED_DIRS`)
- Modify: `apps/web/pages/[project]/settings.vue:49,66,97,112,184,185,220,234,249,267,279`
- Modify: `apps/web/pages/[project]/labels.vue:38,58,72,110`
- Modify: `apps/web/pages/agents.vue:96`
- Modify: `apps/web/pages/[project]/index.vue:37,42`
- Modify: `apps/web/pages/[project]/kb.vue:38,62,85,101`
- Modify: `apps/web/pages/[project]/agents.vue:21,34`
- Modify: `apps/web/pages/[project]/tickets/[ref].vue:62,67,78,91,100,154,299,312,327,344,358,375,391`
- Modify: `apps/web/pages/[project]/code-intel.vue:92-96`
- Modify (tests): `apps/web/tests/openapi/web-gap-ops.spec.ts:20-22,32`, `apps/web/tests/pages/code-intel-mount.spec.ts:59`

**Interfaces:**
- Consumes: `apiPath` (Task 1) and `GUARDED_DIRS` (Task 2).

- [ ] **Step 1: Extend the guard and watch it fail**

In `apps/web/tests/lib/api-path-guard.spec.ts`:

```ts
/** Directories whose API paths must go through apiPath. */
const GUARDED_DIRS = ['components', 'composables', 'pages']
```

Run: `cd apps/web && bunx jest tests/lib/api-path-guard.spec.ts`
Expected: FAIL, listing the page sites named in **Files**.

- [ ] **Step 2: Move every page site**

In each page, add `import { apiPath } from '~/lib/api-path'` to the `<script setup>` imports. Each site below is an untagged template literal passed to `$api`, apart from `[ref].vue`'s path constants. Put `apiPath` directly in front of the opening backtick. Leave the literal text exactly as it is. For example, ``$api.get(`/projects/${slug}`)`` becomes ``$api.get(apiPath`/projects/${slug}`)``.

| File | Lines | Literal(s) |
|:--|:--|:--|
| `pages/[project]/settings.vue` | 49, 184, 185 | `` `/projects/${slug}/vcs` `` |
| | 66, 97, 112 | `` `/projects/${slug}` `` |
| | 220 | `` `/projects/${slug}/vcs/webhook-secret/rotate` `` |
| | 234 | `` `/projects/${slug}/vcs/test` `` |
| | 249 | `` `/projects/${slug}/vcs/sync` `` |
| | 267 | `` `/projects/${slug}/vcs/sync-pr` `` |
| | 279 | `` `/projects/${slug}/vcs` `` |
| `pages/[project]/labels.vue` | 38, 58 | `` `/projects/${slug}/labels` `` |
| | 72 | `` `/projects/${slug}/labels/${labelId}` `` |
| | 110 | `` `/projects/${slug}/labels/${label.id}` `` |
| `pages/agents.vue` | 96 | `` `/agents/${agent.slug}` `` |
| `pages/[project]/index.vue` | 37, 42 | `` `/projects/${slug}/tickets` `` |
| `pages/[project]/kb.vue` | 38 | `` `/projects/${slug}/kb/search` `` |
| | 62 | `` `/projects/${slug}/kb/documents` `` |
| | 85 | `` `/projects/${slug}/kb/optimize` `` |
| | 101 | `` `/projects/${slug}/kb/documents/${sourceId}` `` |
| `pages/[project]/agents.vue` | 21 | `` `/projects/${slug}/agents` `` |
| | 34 | `` `/projects/${slug}/agents/${agent.slug}` `` |
| `pages/[project]/tickets/[ref].vue` | 62, 91, 154, 327 | `` `/projects/${slug}/tickets/${ref}` `` |
| | 67, 375 | `` `/projects/${slug}/tickets/${ref}/links` `` |
| | 78 | `` `/projects/${slug}/labels` `` |
| | 100 | `` `/projects/${slug}/tickets/${ref}/comments` `` |
| | 299, 312 | `` `/projects/${slug}/tickets/${ref}/assign` `` |
| | 344 | `` `/projects/${slug}/tickets/${ref}/labels` `` |
| | 358 | `` `/projects/${slug}/tickets/${ref}/labels/${labelId}` `` |
| | 391 | `` `/projects/${slug}/tickets/${ref}/links/${linkId}` `` |

Line numbers are from `8589f872`. If a file has shifted, search for the literal. Do not touch router paths such as `` router.push(`/${slug}/tickets/${ticket.ref}`) `` (`pages/[project]/index.vue:64`) or `` navigateTo(`/${slug}`) `` (`[ref].vue:329`). They are page routes, not API paths, and the guard ignores them.

`pages/[project]/code-intel.vue:92-96`, replace:

```ts
    const encodedId = encodeURIComponent(id)
    const [detail, callers, callees] = await Promise.all([
      $api.get<CodeIntelSymbolDetail>(`/code-intel/symbols/${encodedId}`, { query: { projectSlug: slug } }),
      $api.get<CallerInfo[]>(`/code-intel/symbols/${encodedId}/callers`, { query: { projectSlug: slug } }),
      $api.get<CallerInfo[]>(`/code-intel/symbols/${encodedId}/callees`, { query: { projectSlug: slug } }),
    ])
```

with:

```ts
    const [detail, callers, callees] = await Promise.all([
      $api.get<CodeIntelSymbolDetail>(apiPath`/code-intel/symbols/${id}`, { query: { projectSlug: slug } }),
      $api.get<CallerInfo[]>(apiPath`/code-intel/symbols/${id}/callers`, { query: { projectSlug: slug } }),
      $api.get<CallerInfo[]>(apiPath`/code-intel/symbols/${id}/callees`, { query: { projectSlug: slug } }),
    ])
```

- [ ] **Step 3: Let the code-intel mount spec resolve the new import**

`tests/pages/code-intel-mount.spec.ts` bundles the compiled page with esbuild and rewrites only `~/composables/useApi`. Add a rewrite for the new import next to it (line ~59):

```ts
  const code = scriptResult.content
    .replace(/~\/composables\/useApi/g, join(webDir, 'composables/useApi'))
    .replace(/~\/lib\/api-path/g, join(webDir, 'lib/api-path'))
```

- [ ] **Step 4: Update the gap-ops spec text**

`apps/web/tests/openapi/web-gap-ops.spec.ts`:

```ts
  test('project settings uses GET/PATCH/DELETE /projects/:slug', () => {
    const source = src(settingsPath)
    expect(source).toContain('$api.get(apiPath`/projects/${slug}`)')
    expect(source).toContain('$api.patch(apiPath`/projects/${slug}`')
    expect(source).toContain('$api.delete(apiPath`/projects/${slug}`)')
  })
```

and:

```ts
    expect(source).toContain('$api.patch(apiPath`/projects/${slug}/labels/${label.id}`')
```

The remaining `toContain('/tickets/${ref}/...')` checks still match, because the literal text is unchanged.

- [ ] **Step 5: Run the whole web suite and type-check**

```bash
cd apps/web && bunx jest && bun run type-check && bun run lint
```

Expected: all green, and the guard reports no offenders in any of the three directories.

- [ ] **Step 6: Commit**

```bash
git add apps/web/pages apps/web/tests
git commit -m "fix(web): pages build API paths with apiPath; guard covers pages"
```

---

### Task 4: One comment toast, and the missing `agents.*` keys

**Files:**
- Modify: `apps/web/pages/[project]/tickets/[ref].vue:215-217,519`
- Modify: `apps/web/tests/pages/ticket-detail-priority.spec.ts:169-197`
- Modify: `apps/web/i18n/locales/en.json`, `apps/web/i18n/locales/zh.json` (`agents` block)
- Modify: `apps/web/components/CreateAgentDialog.vue:172-174`, `apps/web/components/EditAgentRolesDialog.vue:75`
- Create: `apps/web/tests/i18n/used-keys-exist.spec.ts`

Context: posting a comment shows two identical toasts. `CommentThread.vue` emits `comment-added` (line 68) and toasts (line 69), and the page's `onCommentAdded` (`[ref].vue:215-217`) toasts again. The spec keeps the `CommentThread` toast. Separately, `agents.empty`, `agents.toast.created`, `agents.toast.createFailed` and `agents.validation.*` are missing from both locales. The validation keys exist under `agents.form.validation.*`. A scan at `8589f872` found no other literal `t()` key missing from either locale, so the new repo-wide guard passes once these are fixed.

- [ ] **Step 1: Write the failing tests**

Replace the `describe('US-005-4 AC5: ...')` block in `apps/web/tests/pages/ticket-detail-priority.spec.ts:169-197` with:

```ts
describe('US-005-4 AC5: one success toast after a comment is added', () => {
  test('the page does not toast comments itself (CommentThread owns the toast)', () => {
    expect(source()).not.toContain("comments.toast.added")
  })

  test('CommentThread toasts exactly once', () => {
    const thread = readFileSync(join(__dirname, '../../components/CommentThread.vue'), 'utf-8')
    expect(thread.match(/t\('comments\.toast\.added'\)/g)).toHaveLength(1)
  })
})
```

If the file does not import `readFileSync` and `join` yet, add `import { readFileSync } from 'fs'` and `import { join } from 'path'` at the top.

`apps/web/tests/i18n/used-keys-exist.spec.ts`:

```ts
import { describe, expect, it } from '@jest/globals'
import { readdirSync, readFileSync } from 'fs'
import { join, relative } from 'path'

const webDir = join(__dirname, '../..')
const SOURCE_DIRS = ['pages', 'components', 'composables', 'layouts', 'middleware', 'lib']
const LOCALES = ['en', 'zh'] as const
/** A literal key passed to t() or $t(). Dynamic keys (template literals) are not checked. */
const LITERAL_KEY = /\bt\(\s*['"]([A-Za-z0-9_.]+)['"]/g

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(vue|ts)$/.test(entry.name) && !entry.name.endsWith('.spec.ts') ? [path] : []
  })
}

function hasKey(messages: unknown, key: string): boolean {
  return key.split('.').reduce<{ ok: boolean; node: unknown }>(
    (acc, part) => {
      if (!acc.ok || typeof acc.node !== 'object' || acc.node === null || !(part in acc.node)) {
        return { ok: false, node: undefined }
      }
      return { ok: true, node: (acc.node as Record<string, unknown>)[part] }
    },
    { ok: true, node: messages },
  ).ok
}

describe('every literal translation key exists in every locale', () => {
  const messages = Object.fromEntries(
    LOCALES.map((locale) => [locale, JSON.parse(readFileSync(join(webDir, 'i18n/locales', `${locale}.json`), 'utf-8'))]),
  )
  const used = SOURCE_DIRS.flatMap((dir) => sourceFiles(join(webDir, dir))).flatMap((file) =>
    [...readFileSync(file, 'utf-8').matchAll(LITERAL_KEY)].map((match) => ({ key: match[1], file: relative(webDir, file) })),
  )

  it('finds keys to check (the scan is not vacuous)', () => {
    expect(used.length).toBeGreaterThan(100)
  })

  it.each(LOCALES)('%s has every key the source uses', (locale) => {
    const missing = used.filter(({ key }) => !hasKey(messages[locale], key)).map(({ key, file }) => `${key} (${file})`)
    expect([...new Set(missing)]).toEqual([])
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/web && bunx jest tests/pages/ticket-detail-priority.spec.ts tests/i18n/used-keys-exist.spec.ts`
Expected: FAIL. The page still contains `comments.toast.added`. Both locales list `agents.empty`, `agents.toast.created`, `agents.toast.createFailed` and the four `agents.validation.*` keys.

- [ ] **Step 3: Remove the page's duplicate toast**

In `pages/[project]/tickets/[ref].vue`, delete:

```ts
function onCommentAdded() {
  toast.success(t('comments.toast.added'))
}
```

and change the `CommentThread` usage (line ~516) to:

```vue
        <CommentThread
          :project-slug="slug"
          :ticket-ref="ref"
        />
```

`CommentThread` keeps its `comment-added` emit. It is part of the component's interface and costs nothing.

- [ ] **Step 4: Add the missing keys and repoint the validation keys**

In `i18n/locales/en.json`, inside the top-level `agents` object, add:

```json
    "empty": "No agents yet.",
```

and inside `agents.toast` add:

```json
      "created": "Agent created successfully",
      "createFailed": "Failed to create agent",
```

In `i18n/locales/zh.json`, inside `agents` add:

```json
    "empty": "暂无代理。",
```

and inside `agents.toast` add:

```json
      "created": "代理创建成功",
      "createFailed": "创建代理失败",
```

In `components/CreateAgentDialog.vue:172-174`, replace `agents.validation.` with `agents.form.validation.`:

```ts
  name: z.string().min(1, t('agents.form.validation.nameRequired')),
  slug: z.string().min(1, t('agents.form.validation.slugRequired')).regex(/^[a-z0-9-]+$/, t('agents.form.validation.slugFormat')),
  roles: z.array(z.string()).min(1, t('agents.form.validation.rolesRequired')),
```

In `components/EditAgentRolesDialog.vue:75`:

```ts
  roles: z.array(z.string()).min(1, t('agents.form.validation.rolesRequired')),
```

- [ ] **Step 5: Run the web suite**

Run: `cd apps/web && bunx jest && bun run type-check`
Expected: all PASS. This includes `tests/i18n/*parity*` and `CreateAgentDialog.spec.ts`, which checks the dialog source still contains `'agents.toast.created'`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/pages apps/web/components apps/web/i18n apps/web/tests
git commit -m "fix(web): one comment toast; add missing agents translation keys"
```

---

### Task 5: `Input` does not inherit attributes twice

**Files:**
- Modify: `apps/web/components/ui/input/Input.vue:13-19`
- Create: `apps/web/tests/components/ui-input-attrs.spec.ts`

Context: `Input.vue` already binds a filtered `forwardedAttrs` (no `class`, `modelValue` or `onUpdate:modelValue`) and merges `$attrs.class` itself. Without `inheritAttrs: false`, Vue also falls every attribute through to the root `<input>`. `modelValue` then renders as a raw HTML attribute, and the listener is bound twice. `Textarea.vue` already has the option, and `tests/components/ui-textarea-v-model.spec.ts` pins it. This test mirrors that one.

- [ ] **Step 1: Write the failing test**

`apps/web/tests/components/ui-input-attrs.spec.ts`:

```ts
import { describe, expect, it } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const source = readFileSync(join(__dirname, '../../components/ui/input/Input.vue'), 'utf-8')

describe('ui/input Input.vue attribute handling', () => {
  it('turns off automatic attribute inheritance', () => {
    expect(source).toMatch(/defineOptions\(\{ inheritAttrs: false \}\)/)
  })

  it('still strips model bindings and class from the forwarded attrs', () => {
    expect(source).toMatch(/class: _c, modelValue: _mv, 'onUpdate:modelValue': _up/)
    expect(source).toContain('v-bind="forwardedAttrs"')
  })

  it('still merges the caller class into the root class', () => {
    expect(source).toContain('$attrs.class')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && bunx jest tests/components/ui-input-attrs.spec.ts`
Expected: the first test FAILS. The other two pass, because they pin behavior that already exists.

- [ ] **Step 3: Implement**

In `Input.vue`, add the option right after the `cn` import:

```ts
import { computed } from 'vue'
import { cn } from '~/lib/utils'

defineOptions({ inheritAttrs: false })
```

- [ ] **Step 4: Run the web suite**

Run: `cd apps/web && bunx jest && bun run type-check`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/ui/input/Input.vue apps/web/tests/components/ui-input-attrs.spec.ts
git commit -m "fix(web): Input sets inheritAttrs false so attrs are bound once"
```

---

### Task 6: API dead code (#145)

**Files:**
- Modify: `apps/api/src/projects/projects.service.ts:70-72`
- Modify: `apps/api/src/projects/projects.controller.spec.ts:78,139-144`
- Modify: `apps/api/src/projects/project-membership.guard.routes.spec.ts:55-60,136-137`
- Modify: `apps/api/src/projects/projects.service.spec.ts` (new test)
- Modify: `apps/api/src/rag/rag.controller.ts:53-57,82-86,101-105,117-121,154-158,176-179`
- Modify: `apps/api/src/retrieval/retrieval.controller.ts:33-36`
- Create: `apps/api/src/rag/no-principal-params.spec.ts`
- Modify (call sites): `apps/api/src/rag/rag.controller.spec.ts`, `apps/api/src/retrieval/retrieval.controller.spec.ts`, `apps/api/test/integration/graphify-kb-validation/graphify-kb-validation.integration.spec.ts`
- Modify: `apps/api/src/agents/agents.service.ts:109`
- Modify: `apps/api/src/agents/dto/create-agent.dto.spec.ts` (new test)

**Interfaces:**
- Produces:
  - `ProjectsService.findAll` no longer exists. `findAllForPrincipal` is the only list method.
  - The six `RagController` handlers and `RetrievalController.evaluateRetrieval` lose their trailing (or, for `listDocuments`, middle) principal argument. New signatures:
    - `addDocument(slug, dto)`
    - `listDocuments(slug, rawQuery?)`
    - `deleteDocument(slug, sourceId)`
    - `search(slug, dto)`
    - `importGraphify(slug, dto)`
    - `optimizeTable(slug)`
    - `evaluateRetrieval(slug)`

Context (#145): `ProjectsService.findAll()` has had no production caller since `findAllForPrincipal` replaced it. Its only test reference asserts it is *not* called. The RAG and retrieval handlers take `@Principal() _principal` and never read it, because `ProjectMembershipGuard` decides access at class level. `AgentsService` create derives a slug from the name when `slug` is falsy, but `CreateAgentDto.slug` is `@IsNotEmpty()` and required, so that branch cannot run for validated input.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/projects/projects.service.spec.ts`, inside the top-level `describe`:

```ts
  describe('#145 dead code', () => {
    it('has no unscoped findAll (findAllForPrincipal is the only list method)', () => {
      expect('findAll' in ProjectsService.prototype).toBe(false);
      expect(typeof ProjectsService.prototype.findAllForPrincipal).toBe('function');
    });
  });
```

`apps/api/src/rag/no-principal-params.spec.ts`:

```ts
import 'reflect-metadata';
import { ROUTE_ARGS_METADATA, CUSTOM_ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RagController } from './rag.controller';
import { RetrievalController } from '../retrieval/retrieval.controller';

/**
 * #145: ProjectMembershipGuard decides access for these handlers, so none of
 * them declares a custom parameter decorator (such as `@Principal()`) that
 * it would never read.
 */
const HANDLERS: Array<[new (...args: never[]) => unknown, string]> = [
  [RagController, 'addDocument'],
  [RagController, 'listDocuments'],
  [RagController, 'deleteDocument'],
  [RagController, 'search'],
  [RagController, 'importGraphify'],
  [RagController, 'optimizeTable'],
  [RetrievalController, 'evaluateRetrieval'],
];

describe('#145 RAG and retrieval handlers take no principal', () => {
  it.each(HANDLERS)('%p.%s has no custom parameter decorator', (controller, method) => {
    const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, method) ?? {}) as Record<string, unknown>;
    expect(Object.keys(args).filter((key) => key.includes(CUSTOM_ROUTE_ARGS_METADATA))).toEqual([]);
  });

  it('the check sees the route params it keeps (not vacuous)', () => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, RagController, 'addDocument') as Record<string, unknown>;
    expect(Object.keys(args).length).toBeGreaterThanOrEqual(2);
  });
});
```

Append to `apps/api/src/agents/dto/create-agent.dto.spec.ts`, inside the canonical-DTO `describe`:

```ts
    it('rejects a create without a slug, so the service never has to derive one (#145)', async () => {
      expect(await errorProperties(CreateAgentDto, { name: 'No Slug Agent' })).toContain('slug');
      expect(await errorProperties(CreateAgentDto, { name: 'Empty Slug Agent', slug: '' })).toContain('slug');
    });
```

- [ ] **Step 2: Run them and watch the first two fail**

Run: `cd apps/api && bun run test:scoped src/projects/projects.service.spec.ts src/rag/no-principal-params.spec.ts src/agents/dto/create-agent.dto.spec.ts`
Expected: the `findAll` test and all seven handler cases FAIL. The DTO test PASSES. It pins the precondition that makes Step 5 safe, and it is not meant to go red first.

- [ ] **Step 3: Delete `ProjectsService.findAll` and its spec references**

Delete from `projects.service.ts`:

```ts
  async findAll() {
    return ProjectResponseDto.fromMany(await this.projectRepo.findAll());
  }
```

In `projects.controller.spec.ts`, delete `findAll: jest.fn(),` from the `projectsService` mock (line 78) and delete the test at lines 139-144 (`it('does not use the unscoped list', ...)`). The service method it guarded no longer exists, and the new service test replaces it. In `project-membership.guard.routes.spec.ts`, delete `findAll: jest.Mock` from the `ProjectsServiceStub` interface (line ~56) and `findAll: jest.fn(),` from the stub object (line ~136). Leave every `projectRepo.findAll` mock alone, because `findAllForPrincipal` still uses the repository method.

- [ ] **Step 4: Drop the unused principal parameters**

In `rag.controller.ts`, delete the `@Principal() _principal: KodaPrincipal,` line from each of the six handlers. `listDocuments` becomes:

```ts
  async listDocuments(
    @Param('slug') slug: string,
    @Query() rawQuery?: ListKbDocumentsQuery,
  ) {
```

and `optimizeTable` becomes:

```ts
  async optimizeTable(@Param('slug') slug: string) {
```

In `retrieval.controller.ts:33-36`, `evaluateRetrieval` becomes `evaluateRetrieval(@Param('slug') slug: string)`. Then remove `Principal` from the `@nathapp/nestjs-auth` import and delete the `KodaPrincipal` import in both files, unless `bun run lint` shows another use.

Update the direct handler calls. Delete the trailing principal argument, or for `listDocuments` the middle one:

- `src/rag/rag.controller.spec.ts`:
  - `addDocument(...)` at lines 113, 135, 147, 159
  - `deleteDocument` at 213
  - `search` at 231, 241, 254, 263, 288
  - `importGraphify` at 299, 309, 321
  - `optimizeTable` at 340
  - `listDocuments`: 181 becomes `controller.listDocuments('alpha', {} as ListKbDocumentsQuery)`, 190 becomes `controller.listDocuments('alpha', { limit: '25' } as unknown as ListKbDocumentsQuery)`, and 199 becomes `controller.listDocuments('alpha')`
- `src/retrieval/retrieval.controller.spec.ts:68,78,89`: `evaluateRetrieval('alpha')`.
- `test/integration/graphify-kb-validation/graphify-kb-validation.integration.spec.ts` lines 572-701: `controller.importGraphify('test-project', dto)`.

Then run `bunx tsc --noEmit -p tsconfig.json` from `apps/api` and fix any remaining call site it reports. In the `@nathapp/nestjs-auth` import, keep `RequiredPermission` (and anything else still used) and drop only `Principal`. A principal fixture that becomes unused in a spec gets deleted when lint flags it.

- [ ] **Step 5: Drop the unreachable slug fallback**

`agents.service.ts:109`, replace:

```ts
      const slug = scalarFields.slug || scalarFields.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
```

with:

```ts
      // CreateAgentDto requires a non-empty, pattern-checked slug (#145).
      const { slug } = scalarFields;
```

- [ ] **Step 6: Run the affected specs, type-check and lint**

```bash
cd apps/api
bun run test:scoped src/projects src/rag src/retrieval src/agents test/unit/projects test/integration/graphify-kb-validation
bunx tsc --noEmit -p tsconfig.json
bun run lint
```

Expected: all green. The membership route specs (`kb-documents-membership.routes.spec.ts`, `retrieval-membership.routes.spec.ts`) still pass over HTTP, which shows access control did not depend on the removed parameters.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "refactor(api): drop unscoped findAll, unused principal params and dead slug fallback (#145)"
```

---

### Task 7: API reads — role lookup in parallel, one comment fetch (#145)

**Files:**
- Modify: `apps/api/src/koda-domain-writer/prisma-koda-domain-writer.repository.ts:22-36`
- Create: `apps/api/test/unit/koda-domain-writer/find-user-project-roles.spec.ts`
- Modify: `apps/api/src/comments/prisma-comment.repository.ts:92-127`
- Modify: `apps/api/src/comments/comments.service.ts:50-75,155-214`
- Modify: `apps/api/src/comments/comments.service.spec.ts`

**Interfaces:**
- Produces: `PrismaCommentRepository.findOwningProjectAndTicket(commentId)` now returns `{ comment: CommentDomain; project: {...}; ticket: {...} } | null`. The `project` and `ticket` shapes are unchanged, and it now includes the comment. `CommentsService`'s private `assertCommentProjectMembership` returns `{ projectId, role, comment }`. `update` and `delete` no longer call `findById`.

Context (#145): `findUserProjectRoles` awaits the user lookup and then the membership lookup. The two are independent, so they run together. `CommentsService.update` and `delete` fetch the comment twice: once through `findOwningProjectAndTicket` (project and ticket only) and once through `findById` (the author fields the CASL check reads). One query that selects the comment's own columns plus the ticket and project serves both.

- [ ] **Step 1: Write the failing role-lookup test**

`apps/api/test/unit/koda-domain-writer/find-user-project-roles.spec.ts`:

```ts
import { PrismaKodaDomainWriterRepository } from '../../../src/koda-domain-writer/prisma-koda-domain-writer.repository';

describe('#145 findUserProjectRoles', () => {
  function setup() {
    let releaseUser: (value: { role: string } | null) => void = () => undefined;
    const prismaMock = {
      client: {
        user: {
          findUnique: jest.fn(() => new Promise((resolve) => { releaseUser = resolve; })),
        },
        projectMember: {
          findUnique: jest.fn(async () => ({ role: 'DEVELOPER' })),
        },
      },
    };
    const repo = new PrismaKodaDomainWriterRepository(prismaMock as never);
    return { repo, prismaMock, release: (value: { role: string } | null) => releaseUser(value) };
  }

  it('starts the membership lookup without waiting for the user lookup', async () => {
    const { repo, prismaMock, release } = setup();
    const pending = repo.findUserProjectRoles('p1', 'u1');
    await Promise.resolve();
    expect(prismaMock.client.projectMember.findUnique).toHaveBeenCalledWith({
      where: { projectId_userId: { projectId: 'p1', userId: 'u1' } },
      select: { role: true },
    });
    release({ role: 'ADMIN' });
    await expect(pending).resolves.toEqual(['ADMIN', 'DEVELOPER']);
  });

  it('returns only the membership role for a non-admin user', async () => {
    const { repo, release } = setup();
    const pending = repo.findUserProjectRoles('p1', 'u1');
    release({ role: 'MEMBER' });
    await expect(pending).resolves.toEqual(['DEVELOPER']);
  });

  it('returns no roles for an unknown user with no membership', async () => {
    const { repo, prismaMock, release } = setup();
    prismaMock.client.projectMember.findUnique.mockResolvedValueOnce(null as never);
    const pending = repo.findUserProjectRoles('p1', 'ghost');
    release(null);
    await expect(pending).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch the first test fail**

Run: `cd apps/api && bun run test:scoped test/unit/koda-domain-writer/find-user-project-roles.spec.ts`
Expected: the first test FAILS (`projectMember.findUnique` not called yet). The other two pass.

- [ ] **Step 3: Run the two lookups together**

Replace the two sequential awaits in `findUserProjectRoles`:

```ts
  async findUserProjectRoles(projectId: string, userId: string): Promise<string[]> {
    const [user, membership] = await Promise.all([
      this.prisma.client.user.findUnique({
        where: { id: userId },
        select: { role: true },
      }),
      this.prisma.client.projectMember.findUnique({
        where: { projectId_userId: { projectId, userId } },
        select: { role: true },
      }),
    ]);

    const roles: string[] = [];
    if (user?.role === 'ADMIN') roles.push('ADMIN');
    if (membership?.role) roles.push(membership.role);
    return roles;
  }
```

Run: `bun run test:scoped test/unit/koda-domain-writer test/integration/events/event-write-operations.integration.spec.ts test/integration/koda-domain-writer`
Expected: PASS.

- [ ] **Step 4: Point the comment specs at the one fetch, and add the failing assertions**

In `apps/api/src/comments/comments.service.spec.ts`, **first** re-point the existing mocks, before adding the `givenComment` helper below (the line numbers quoted here are from before any edit). Inside the `describe('update'` block (line 539), the `describe('delete'` block (line 669) and the `describe('US-002 project membership gate'` block (line 758), replace every

```ts
mockCommentRepo.findById.mockResolvedValue(
```

with

```ts
givenComment(
```

Do not touch the `describe('findById'` block (line 734): that tests `service.findById`, which keeps using the repository's `findById`. A range-limited command does it:

```bash
cd apps/api
perl -0pi -e 's{(describe\(\x27update\x27.*?)(describe\(\x27findById\x27)}{ my ($a,$b)=($1,$2); $a =~ s/mockCommentRepo\.findById\.mockResolvedValue\(/givenComment(/g; $a.$b }se; s{(describe\(\x27US-002 project membership gate\x27.*?)(describe\(\x27#144)}{ my ($a,$b)=($1,$2); $a =~ s/mockCommentRepo\.findById\.mockResolvedValue\(/givenComment(/g; $a.$b }se' src/comments/comments.service.spec.ts
grep -n "findById.mockResolvedValue\|givenComment(" src/comments/comments.service.spec.ts
```

Expected: `findById.mockResolvedValue` remains only inside `describe('findById'` (and in the `#144` block, handled next). Every other former site now reads `givenComment(`.

Add the helper just below the `mockCommentRepo` Proxy definition (after line ~214):

```ts
  /** update/delete read the comment with its ticket and project in one call. */
  function givenComment(comment: unknown): void {
    mockCommentRepo.findOwningProjectAndTicket.mockResolvedValue(
      comment ? { ...OWNING_RESOLUTION, comment } : null,
    );
  }
```

In the `#144` block's `beforeEach` (line ~882), replace the two lines

```ts
      mockCommentRepo.findOwningProjectAndTicket.mockResolvedValue(ownership);
      mockCommentRepo.findById.mockResolvedValue(othersComment);
```

with

```ts
      mockCommentRepo.findOwningProjectAndTicket.mockResolvedValue({ ...ownership, comment: othersComment });
```

Then add the new assertions at the end of the `describe('update'` block:

```ts
    it('#145: reads the comment once (no separate findById)', async () => {
      givenComment(mockComment);
      mockCommentRepo.update.mockResolvedValue({ ...mockComment, body: 'x' });

      await service.update('comment-123', { body: 'x' }, mockUserPrincipal);

      expect(mockCommentRepo.findOwningProjectAndTicket).toHaveBeenCalledTimes(1);
      expect(mockCommentRepo.findById).not.toHaveBeenCalled();
    });
```

and at the end of the `describe('delete'` block:

```ts
    it('#145: reads the comment once (no separate findById)', async () => {
      givenComment(mockComment);

      await service.delete('comment-123', mockUserPrincipal);

      expect(mockCommentRepo.findOwningProjectAndTicket).toHaveBeenCalledTimes(1);
      expect(mockCommentRepo.findById).not.toHaveBeenCalled();
    });
```

- [ ] **Step 5: Run the comment spec and watch it fail**

Run: `cd apps/api && bun run test:scoped src/comments/comments.service.spec.ts`
Expected: the two `#145` tests FAIL (`findById` was called). Some author-rule tests may also fail, because the service still reads the comment from `findById`, which is no longer mocked. The `findById` describe passes.

- [ ] **Step 6: Return the comment from the ownership query**

In `prisma-comment.repository.ts`, replace `findOwningProjectAndTicket` (and update its doc comment's last sentence):

```ts
  /**
   * US-002 / #145: the comment itself plus its owning ticket and project, in
   * one query. Slug-less mutation paths gate by membership on the project and
   * run the CASL check on the comment without a second fetch. Returns null
   * when the comment does not exist.
   */
  async findOwningProjectAndTicket(
    commentId: string,
  ): Promise<{
    comment: CommentDomain;
    project: { id: string; slug: string; key: string; deletedAt: Date | null };
    ticket: { id: string; deletedAt: Date | null };
  } | null> {
    const row = await this.prisma.client.comment.findUnique({
      where: { id: commentId },
      include: {
        ticket: {
          select: {
            id: true,
            deletedAt: true,
            project: {
              select: { id: true, slug: true, key: true, deletedAt: true },
            },
          },
        },
      },
    });
    if (!row) return null;
    const { ticket, ...comment } = row;
    return {
      comment: this.toDomain(comment),
      project: {
        id: ticket.project.id,
        slug: ticket.project.slug,
        key: ticket.project.key,
        deletedAt: ticket.project.deletedAt,
      },
      ticket: { id: ticket.id, deletedAt: ticket.deletedAt },
    };
  }
```

In `comments.service.ts`, `assertCommentProjectMembership` returns the comment:

```ts
  private async assertCommentProjectMembership(
    commentId: string,
    principal: KodaPrincipal,
  ): Promise<{ projectId: string; role: string | null; comment: CommentDomain }> {
    const ownership = await this.commentRepo.findOwningProjectAndTicket(commentId);

    if (!ownership || ownership.ticket.deletedAt || ownership.project.deletedAt) {
      throw new NotFoundAppException({}, 'comments');
    }

    // Agents resolve to null without a lookup; global ADMIN resolves to 'ADMIN'.
    // A non-member's 403 becomes 404 so the comment's existence stays hidden.
    try {
      const role = await this.access.resolveMembership(ownership.project.id, principal);
      return { projectId: ownership.project.id, role, comment: ownership.comment };
    } catch (err) {
      if (err instanceof ForbiddenAppException) throw new NotFoundAppException({}, 'comments');
      throw err;
    }
  }
```

In `update`, replace

```ts
    const { role } = await this.assertCommentProjectMembership(commentId, principal);

    // Find the comment via repository
    const comment = await this.commentRepo.findById(commentId);

    if (!comment) {
      throw new NotFoundAppException({}, 'comments');
    }
```

with

```ts
    // #145: the membership gate's query already returned the comment.
    const { role, comment } = await this.assertCommentProjectMembership(commentId, principal);
```

Make the same replacement in `delete`. Import `CommentDomain` from `./domain/comment.domain` if the service does not import it yet. The not-found path is unchanged: a missing comment makes `findOwningProjectAndTicket` return null, and the gate throws `NotFoundAppException`.

- [ ] **Step 7: Run the comment specs and the real-Postgres gate**

```bash
cd apps/api
bun run test:scoped src/comments test/integration/projects/project-membership-gate.integration.spec.ts
bunx tsc --noEmit -p tsconfig.json
bun run lint
```

Expected: all green. `project-membership-gate.integration.spec.ts` drives `PATCH` and `DELETE /api/comments/:id` over HTTP against Postgres, so it proves the Prisma `include` shape on the real client.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "perf(api): parallel role lookup and one comment fetch for update/delete (#145)"
```

---

### Task 8: CLI numeric options go through `parsePositiveInt`

**Files:**
- Create: `apps/cli/src/utils/parse-positive-int.ts`, `apps/cli/src/utils/parse-positive-int.spec.ts`
- Modify: `apps/cli/src/commands/ticket.ts:132-133,141`
- Modify: `apps/cli/src/commands/user.ts:35-36,42`
- Modify: `apps/cli/src/commands/member.ts:40-41,48`
- Modify: `apps/cli/src/commands/context.ts:40,49`
- Modify: `apps/cli/src/commands/vcs.ts:192,208-210,302-317`
- Modify: `apps/cli/src/commands/agent.ts:127,139,165,174`
- Modify: `apps/cli/src/commands/memory.ts:34,43`
- Modify (spec): `apps/cli/src/commands/user.spec.ts` (new test)
- Modify (spec): `apps/cli/src/commands/vcs-update-test-sync-import.spec.ts:513-521` (invalid issue number now rejects)

**Interfaces:**
- Produces: `parsePositiveInt(value: string): number`. It throws commander's `InvalidArgumentError` for anything that is not a whole number of 1 or more. Commander then prints `error: option '--page <number>' argument 'abc' is invalid. must be a positive integer` and exits 1.

Context: numeric options are passed through `parseInt` or `Number` unchecked, so `--page abc` sends `NaN` (review LOW, CLI "Numeric options"). Examples: `--size 0`, `--polling-interval-ms -5`, and `memory --limit` (sent as a string). `memory --confidence` is a 0-1 decimal, already rejects non-finite values, and is not a positive integer, so it stays as it is.

- [ ] **Step 1: Write the failing tests**

`apps/cli/src/utils/parse-positive-int.spec.ts`:

```ts
import { InvalidArgumentError } from 'commander';
import { parsePositiveInt } from './parse-positive-int';

describe('parsePositiveInt', () => {
  it.each([['1', 1], ['20', 20], [' 7 ', 7], ['3600000', 3600000]])('parses %p', (raw, expected) => {
    expect(parsePositiveInt(raw)).toBe(expected);
  });

  it.each(['abc', '', '0', '-5', '1.5', '1e3', '0x10', '12abc', '9007199254740993'])('rejects %p', (raw) => {
    expect(() => parsePositiveInt(raw)).toThrow(InvalidArgumentError);
    expect(() => parsePositiveInt(raw)).toThrow('must be a positive integer');
  });
});
```

Append to `apps/cli/src/commands/user.spec.ts`, inside `describe('userCommand'`:

```ts
  it('list rejects a non-numeric --page with exit 1 and sends nothing', async () => {
    await expect(
      program.parseAsync(['node', 'koda', 'user', 'list', '--page', 'abc']),
    ).rejects.toMatchObject({ code: 'commander.invalidArgument', exitCode: 1 });
    expect(adminUsersControllerList).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/cli && bunx jest src/utils/parse-positive-int.spec.ts src/commands/user.spec.ts`
Expected: FAIL. The module is missing, and `user list --page abc` calls the API with `NaN`.

- [ ] **Step 3: Implement**

`apps/cli/src/utils/parse-positive-int.ts`:

```ts
import { InvalidArgumentError } from 'commander';

/**
 * Commander option parser for counts, sizes and ids: a whole number >= 1.
 * Anything else (NaN, 0, negatives, decimals, exponents, trailing junk, values
 * beyond Number.MAX_SAFE_INTEGER) fails before any request is sent, and
 * commander exits 1 with the option name in the message.
 */
export function parsePositiveInt(value: string): number {
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError('must be a positive integer');
  }
  return parsed;
}
```

- [ ] **Step 4: Use it on every numeric option**

Commander calls the parser as `(value, previous)`, so pass the function itself. Defaults become numbers. Import it in each file with `import { parsePositiveInt } from '../utils/parse-positive-int';`.

| Site | Before | After |
|:--|:--|:--|
| `ticket.ts:132-133` | `.option('--page <number>', 'Page number (1-based)', '1')`<br>`.option('--size <number>', 'Tickets per page (1-100)', '20')` | `.option('--page <number>', 'Page number (1-based)', parsePositiveInt, 1)`<br>`.option('--size <number>', 'Tickets per page (1-100)', parsePositiveInt, 20)` |
| `ticket.ts:141` | `current: parseInt(options.page, 10), size: parseInt(options.size, 10)` | `current: options.page, size: options.size` |
| `user.ts:35-36` | `--page <n>` default `'1'`, `--size <n>` default `'20'` | same flags and descriptions, `parsePositiveInt, 1` and `parsePositiveInt, 20` |
| `user.ts:42` | `current: parseInt(options.page, 10), size: parseInt(options.size, 10)` | `current: options.page, size: options.size` |
| `member.ts:40-41,48` | same as `user.ts` | same change |
| `context.ts:40` | `.option('--token-budget <n>', 'Max token budget for the response', parseInt)` | `.option('--token-budget <n>', 'Max token budget for the response', parsePositiveInt)` |
| `context.ts:49` | `if (options.tokenBudget) requestBody['tokenBudget'] = options.tokenBudget;` | `if (options.tokenBudget !== undefined) requestBody['tokenBudget'] = options.tokenBudget;` |
| `vcs.ts:192` | `.option('--polling-interval-ms <ms>', 'Polling interval in milliseconds')` | `.option('--polling-interval-ms <ms>', 'Polling interval in milliseconds', parsePositiveInt)` |
| `vcs.ts:208-210` | `if (options.pollingIntervalMs) { requestBody.pollingIntervalMs = Number(options.pollingIntervalMs); }` | `if (options.pollingIntervalMs !== undefined) { requestBody.pollingIntervalMs = options.pollingIntervalMs; }` |
| `agent.ts:127,165` | `--max-concurrent-tickets <n>` with no parser | add `parsePositiveInt` as the third argument (the API DTO has `@Min(1)`) |
| `agent.ts:139,174` | `Number(options.maxConcurrentTickets)` | `options.maxConcurrentTickets` |
| `memory.ts:34` | `.option('--limit <n>', 'Maximum number of events to return (1-100, default: 50)', '50')` | `.option('--limit <n>', 'Maximum number of events to return (1-100, default: 50)', parsePositiveInt, 50)` |

`vcs import`: change the command at `vcs.ts:308` (search for `'import <issueNumber>'`) from `command('import <issueNumber>')` to

```ts
    .command('import')
    .argument('<issueNumber>', 'Issue number to import', parsePositiveInt)
```

and delete the `parseInt` plus `isNaN` block at lines 312-317. The action's first parameter is now the parsed number. Rename it from `issueNumberArg` to `issueNumber: number`, and keep the rest of the body. If `VCS_MESSAGES.INVALID_ISSUE_NUMBER` has no other user, delete it from `vcs-messages.ts`.

- [ ] **Step 5: Run the CLI suite and type-check**

```bash
cd apps/cli && bunx jest && bun run type-check && bun run lint
```

Expected: green. Specs that passed string numbers and expected numeric request fields (for example `--page 2 --size 5` → `current: 2, size: 5`) keep passing. In commander 12.1.0, a parser error is always re-thrown out of `parseAsync` (`_callParseArg` rethrows after `this.error()`), with or without `exitOverride()`. So `vcs-update-test-sync-import.spec.ts:513-521` (`'handles invalid issue number and exits 1'`), which awaits `parseAsync([... 'not-a-number'])` bare, now fails. Rewrite its call and assertions as:

```ts
      await expect(
        importCmd?.parseAsync(['node', 'test', 'not-a-number']),
      ).rejects.toMatchObject({ code: 'commander.invalidArgument' });
      expect(vcsControllerSyncIssue).not.toHaveBeenCalled();
```

This replaces the bare `await importCmd?.parseAsync(...)` and its two `exitSpy` / `errorSpy` expectations. Keep the two `find(...)` lines above them. `vcsControllerSyncIssue` is already imported there. Do **not** add `exitOverride()` to that file. The sibling test `'prints usage help and exits 1 when issue number is not provided'` (lines 504-511) passes today because there is no override: a missing argument calls the mocked `process.exit` and returns. With an override, it would throw instead.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src
git commit -m "fix(cli): numeric options reject non-positive-integers instead of sending NaN"
```

---

### Task 9: CLI exit codes and the auth hint

**Files:**
- Create: `apps/cli/src/utils/signals.ts`, `apps/cli/src/utils/signals.spec.ts`
- Create: `apps/cli/src/utils/force.ts`, `apps/cli/src/utils/force.spec.ts`
- Modify: `apps/cli/src/index.ts:254-277`
- Modify: `apps/cli/src/commands/kb.ts:165-169`, `project.ts:151-154`, `comment.ts:126-129`, `ticket.ts:535-537`
- Modify: `apps/cli/src/commands/ticket.spec.ts:1918-1926`
- Modify: `apps/cli/src/utils/error.ts:103`, `apps/cli/src/utils/error.spec.ts:291,310,353`

**Interfaces:**
- Produces:
  - `installSignalHandlers(target?: SignalTarget, log?: (message: string) => void): void`
  - `EXIT_SIGINT = 130`
  - `EXIT_SIGTERM = 143`
  - `requireForce(force: unknown): boolean`, which prints `Use --force to confirm deletion`, exits 1 and returns false when `force` is falsy
  - Task 11 reuses `EXIT_SIGINT`.

Context (review LOW, CLI "Exit codes"): Ctrl+C exits 0, so a script cannot tell an interrupted command from a successful one. A missing `--force` exits 1 in `kb`, `project` and `comment` but 3 in `ticket`. The 401 hint says `koda config set apiKey <key>`, but the real syntax is `koda config set --api-key <key>`. SIGTERM also exits 0 today. This plan gives it the conventional 143 (128 + 15) in the same helper, because it is the same defect. The PR notes this beyond-spec choice.

- [ ] **Step 1: Write the failing tests**

`apps/cli/src/utils/signals.spec.ts`:

```ts
import { EventEmitter } from 'events';
import { EXIT_SIGINT, EXIT_SIGTERM, installSignalHandlers } from './signals';

function fakeProcess() {
  const emitter = new EventEmitter();
  const exit = jest.fn();
  return { target: { on: emitter.on.bind(emitter), exit: exit as unknown as (code: number) => never }, emitter, exit };
}

describe('installSignalHandlers', () => {
  it('exits 130 on SIGINT (Ctrl+C)', () => {
    const { target, emitter, exit } = fakeProcess();
    const log = jest.fn();
    installSignalHandlers(target, log);
    emitter.emit('SIGINT');
    expect(EXIT_SIGINT).toBe(130);
    expect(exit).toHaveBeenCalledWith(130);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Interrupted'));
  });

  it('exits 143 on SIGTERM', () => {
    const { target, emitter, exit } = fakeProcess();
    installSignalHandlers(target, jest.fn());
    emitter.emit('SIGTERM');
    expect(EXIT_SIGTERM).toBe(143);
    expect(exit).toHaveBeenCalledWith(143);
  });
});
```

`apps/cli/src/utils/force.spec.ts`:

```ts
jest.mock('chalk', () => ({ red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s, gray: (s: string) => s, cyan: { bold: (s: string) => s } }));

import { requireForce } from './force';

describe('requireForce', () => {
  let exitSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it('returns true and does nothing when --force is set', () => {
    expect(requireForce(true)).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it.each([undefined, false])('exits 1 with the hint when --force is %p', (force) => {
    expect(requireForce(force)).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Use --force to confirm deletion'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
```

In `apps/cli/src/commands/ticket.spec.ts`, change the test at line 1918 from `'exits 3 with hint when --force is omitted (AC4)'` to `'exits 1 with hint when --force is omitted (AC4)'`. Change its exit assertion from `3` to `1`, and keep the `--force` message assertion.

In `apps/cli/src/utils/error.spec.ts`, change the three expectations at lines 291, 310 and 353 to the real syntax: `toContain('koda config set --api-key')` twice, and `toBe('Check your API key: koda config set --api-key <key>')`.

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/cli && bunx jest src/utils/signals.spec.ts src/utils/force.spec.ts src/commands/ticket.spec.ts src/utils/error.spec.ts`
Expected: FAIL. The modules are missing, ticket delete exits 3, and the hint text is old.

- [ ] **Step 3: Implement the helpers**

`apps/cli/src/utils/signals.ts`:

```ts
/** Shell convention: 128 + signal number. */
export const EXIT_SIGINT = 130;
export const EXIT_SIGTERM = 143;

export interface SignalTarget {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  exit(code: number): never;
}

/**
 * Exit with 128 + signal on Ctrl+C / SIGTERM, so scripts can tell an
 * interrupted command from a successful one. Messages go to stderr to keep
 * `--json` stdout clean.
 */
export function installSignalHandlers(
  target: SignalTarget = process,
  log: (message: string) => void = (message) => console.error(message),
): void {
  target.on('SIGINT', () => {
    log('\nInterrupted.');
    target.exit(EXIT_SIGINT);
  });
  target.on('SIGTERM', () => {
    log('\nTerminated.');
    target.exit(EXIT_SIGTERM);
  });
}
```

`apps/cli/src/utils/force.ts`:

```ts
import { error } from './output';

/**
 * Destructive commands need `--force`. Without it, print the hint and exit 1
 * (the same code everywhere). Returns false so callers can `return` right away:
 * command specs stub process.exit, so code after it still runs there.
 */
export function requireForce(force: unknown): boolean {
  if (force) return true;
  error('Use --force to confirm deletion');
  process.exit(1);
  return false;
}
```

- [ ] **Step 4: Wire them in**

`index.ts:265-277`: replace the two `process.on('SIGINT'…)` / `process.on('SIGTERM'…)` blocks with:

```ts
installSignalHandlers();
```

and add `import { installSignalHandlers } from './utils/signals';` with the other imports. Leave the `uncaughtException` and `unhandledRejection` handlers unchanged.

Replace each `--force` check with `if (!requireForce(options.force)) return;` and add `import { requireForce } from '../utils/force';`:

- `kb.ts:165-169`: the `if (!options.force) { error(...); process.exit(1); return; }` block.
- `project.ts:151-154`: the `if (!options.force) { error(...); process.exit(1); }` block.
- `comment.ts:126-129`: same as `project.ts`.
- `ticket.ts:535-537`: `if (!options.force) { handleApiError(new Error('Deletion requires --force flag.'), { validationError: true }); }`.

`error.ts:103`:

```ts
    emitError(message, 'UNAUTHORIZED', status, 'Check your API key: koda config set --api-key <key>');
```

- [ ] **Step 5: Run the CLI suite**

```bash
cd apps/cli && bunx jest && bun run type-check && bun run lint
```

Expected: green. The existing `kb`, `project` and `comment` delete specs already expect exit 1 and the same message.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src
git commit -m "fix(cli): Ctrl+C exits 130, missing --force exits 1, auth hint uses real syntax"
```

---

### Task 10: CLI `apiUrl` falls through empty values

**Files:**
- Modify: `apps/cli/src/config.ts:157-161`
- Modify: `apps/cli/src/commands/login.ts:20`
- Modify: `apps/cli/src/config.spec.ts` (new tests in `describe('env var overrides'`)

Context (review LOW, CLI "Global conf"): `resolveContext` chains `apiUrl` with `??`, so an empty `KODA_API_URL=""` (common in CI templates) or an empty profile `apiUrl` wins over the configured URL, and the CLI then calls `''`. `login` has the same issue with `--api-url ''`. The spec asks for `||` on flag and profile values. The same applies to the environment value in between, so the whole chain changes. The `apiKey` chain is not changed here: Task 12 decides where keys come from.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('env var overrides'` in `apps/cli/src/config.spec.ts`:

```ts
      it('an empty KODA_API_URL falls through to the configured URL', async () => {
        process.env.KODA_API_URL = '';
        const deps: ResolveContextDeps = {
          findProjectConfig: makeProjectConfigDep(null),
          getConfig: makeGlobalConfig({ apiUrl: 'https://global.example.com' }),
        };
        const result = await resolveContext({}, deps);
        expect(result.apiUrl).toBe('https://global.example.com');
      });

      it('an empty --api-url flag and an empty profile apiUrl fall through too', async () => {
        const deps: ResolveContextDeps = {
          findProjectConfig: makeProjectConfigDep({ projectSlug: 'p', profile: 'blank' }),
          getConfig: makeGlobalConfig({
            apiUrl: 'https://global.example.com',
            profiles: { blank: { apiUrl: '', apiKey: 'profile-key-abcdef' } },
          }),
        };
        const result = await resolveContext({ apiUrl: '' }, deps);
        expect(result.apiUrl).toBe('https://global.example.com');
      });
```

In `apps/cli/src/commands/login.spec.ts`, inside `describe('login command'`:

```ts
  it('saves the default URL when --api-url is an empty string', async () => {
    await loginCommand('sk-proj-test123456', '', {});
    expect(mockStore.set).toHaveBeenCalledWith('apiUrl', 'http://localhost:3100');
  });
```

(Today `'' ?? default` keeps `''`, and the spec's `setConfig` mock skips an empty `apiUrl`, so this fails.)

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/cli && bunx jest src/config.spec.ts src/commands/login.spec.ts`
Expected: the new tests FAIL (`apiUrl` is `''`).

- [ ] **Step 3: Implement**

`config.ts:157-161`:

```ts
  // `||`, not `??`: an empty flag, env var or profile value means "not set".
  const apiUrl =
    flags.apiUrl ||
    process.env.KODA_API_URL ||
    profile?.apiUrl ||
    globalConfig.apiUrl ||
    DEFAULT_API_URL;
```

`login.ts:20`:

```ts
  const url = (apiUrl || 'http://localhost:3100').replace(/\/api\/?$/, '');
```

- [ ] **Step 4: Run the CLI suite**

Run: `cd apps/cli && bunx jest && bun run type-check`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src
git commit -m "fix(cli): empty apiUrl values fall through to the configured URL"
```

---

### Task 11: `resolveSecret` — secrets from stdin, a hidden prompt, or the environment

**Files:**
- Create: `apps/cli/src/utils/secret-input.ts`
- Create: `apps/cli/src/utils/secret-input.spec.ts`

**Interfaces:**
- Consumes: `EXIT_SIGINT` from Task 9.
- Produces (Task 12 uses all of these):

```ts
export interface SecretSpec { flag: string; label: string; envVar?: string }
export interface SecretIo {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
  stderr: { write(chunk: string): unknown };
  env: Record<string, string | undefined>;
  exit: (code: number) => never;
}
export class SecretInputError extends Error {}
export function resolveSecret(raw: string | boolean | undefined, spec: SecretSpec, io?: SecretIo): Promise<string | undefined>
export const API_KEY_SECRET: SecretSpec   // flag '--api-key', no env fallback
export const LOGIN_API_KEY_SECRET: SecretSpec // flag '--api-key', env KODA_API_KEY
export const VCS_TOKEN_SECRET: SecretSpec // flag '--token', env KODA_VCS_TOKEN
```

The `raw` argument is what commander produces for an optional-value option `--flag [value]`:
- `undefined`: the flag is absent.
- `true`: the flag is given with no value.
- a string: the flag is given with a value.

Rules, in order:

| `raw` | Result |
|:--|:--|
| `'-'` | Read all of stdin and trim surrounding whitespace, including the trailing newline. Empty after trimming → `SecretInputError`. |
| `true`, stdin is a TTY | Hidden prompt on stderr: no echo, Backspace edits, Enter finishes. Ctrl+C restores the terminal and exits 130. Empty → `SecretInputError`. |
| `true`, stdin not a TTY | `SecretInputError` telling the user to pass `-` or set the environment variable. |
| a non-empty string | Returned as is, with a warning on stderr that argv values are visible in shell history and process lists. |
| `undefined` | `env[spec.envVar]` if the spec has one and it is non-empty, else `undefined`. |

- [ ] **Step 1: Write the failing tests**

`apps/cli/src/utils/secret-input.spec.ts`:

```ts
import { PassThrough } from 'stream';
import { resolveSecret, SecretInputError, SecretIo, SecretSpec } from './secret-input';

const SPEC: SecretSpec = { flag: '--token', label: 'VCS token', envVar: 'KODA_VCS_TOKEN' };

function makeIo(options: { tty?: boolean; env?: Record<string, string> } = {}) {
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: jest.Mock };
  if (options.tty) {
    stdin.isTTY = true;
    stdin.setRawMode = jest.fn();
  }
  const written: string[] = [];
  const exit = jest.fn();
  const io: SecretIo = {
    stdin,
    stderr: { write: (chunk: string) => written.push(chunk) },
    env: options.env ?? {},
    exit: exit as unknown as (code: number) => never,
  };
  return { io, stdin, written, exit };
}

describe('resolveSecret', () => {
  it("reads '-' from stdin and trims the trailing newline", async () => {
    const { io, stdin } = makeIo();
    const pending = resolveSecret('-', SPEC, io);
    stdin.end('ghp_secret\n');
    await expect(pending).resolves.toBe('ghp_secret');
  });

  it("rejects an empty stdin for '-'", async () => {
    const { io, stdin } = makeIo();
    const pending = resolveSecret('-', SPEC, io);
    stdin.end('\n');
    await expect(pending).rejects.toThrow(SecretInputError);
  });

  it('prompts without echo on a TTY and restores the terminal', async () => {
    const { io, stdin, written } = makeIo({ tty: true });
    const pending = resolveSecret(true, SPEC, io);
    stdin.write('abcx');
    stdin.write('\u007f');
    stdin.write('d\r');
    await expect(pending).resolves.toBe('abcd');
    expect(written.join('')).toContain('VCS token: ');
    expect(written.join('')).not.toContain('abcd');
    expect(stdin.setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it('exits 130 and restores the terminal on Ctrl+C in the prompt', async () => {
    const { io, stdin, exit } = makeIo({ tty: true });
    void resolveSecret(true, SPEC, io);
    stdin.write('ab\u0003');
    await new Promise((resolve) => setImmediate(resolve));
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(exit).toHaveBeenCalledWith(130);
  });

  it('refuses a bare flag when stdin is not a terminal', async () => {
    const { io } = makeIo();
    await expect(resolveSecret(true, SPEC, io)).rejects.toThrow("--token - or set KODA_VCS_TOKEN");
  });

  it('returns a literal value but warns on stderr', async () => {
    const { io, written } = makeIo();
    await expect(resolveSecret('ghp_literal', SPEC, io)).resolves.toBe('ghp_literal');
    expect(written.join('')).toContain('Warning: --token');
    expect(written.join('')).not.toContain('ghp_literal');
  });

  it('falls back to the environment variable when the flag is absent', async () => {
    const { io } = makeIo({ env: { KODA_VCS_TOKEN: 'from-env' } });
    await expect(resolveSecret(undefined, SPEC, io)).resolves.toBe('from-env');
  });

  it('ignores an empty environment variable', async () => {
    const { io } = makeIo({ env: { KODA_VCS_TOKEN: '' } });
    await expect(resolveSecret(undefined, SPEC, io)).resolves.toBeUndefined();
  });

  it('has no environment fallback when the spec names none', async () => {
    const { io } = makeIo({ env: { KODA_API_KEY: 'from-env' } });
    await expect(resolveSecret(undefined, { flag: '--api-key', label: 'API key' }, io)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/cli && bunx jest src/utils/secret-input.spec.ts`
Expected: FAIL, `Cannot find module './secret-input'`.

- [ ] **Step 3: Implement**

`apps/cli/src/utils/secret-input.ts`:

```ts
import { EXIT_SIGINT } from './signals';

export interface SecretSpec {
  /** The option as the user types it, e.g. `--api-key`. */
  flag: string;
  /** Prompt label, e.g. `API key`. */
  label: string;
  /** Environment variable read when the flag is absent. Omit for no fallback. */
  envVar?: string;
}

export interface SecretIo {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
  stderr: { write(chunk: string): unknown };
  env: Record<string, string | undefined>;
  exit: (code: number) => never;
}

export class SecretInputError extends Error {}

export const API_KEY_SECRET: SecretSpec = { flag: '--api-key', label: 'API key' };
export const LOGIN_API_KEY_SECRET: SecretSpec = { flag: '--api-key', label: 'API key', envVar: 'KODA_API_KEY' };
export const VCS_TOKEN_SECRET: SecretSpec = { flag: '--token', label: 'VCS token', envVar: 'KODA_VCS_TOKEN' };

const defaultIo = (): SecretIo => ({
  stdin: process.stdin,
  stderr: process.stderr,
  env: process.env,
  exit: (code: number) => process.exit(code),
});

/**
 * Resolve a secret option declared as `--flag [value]` without requiring the
 * secret on argv (where shell history and `ps` see it):
 *   --flag -        read stdin          --flag          hidden prompt (TTY only)
 *   (absent)        spec.envVar         --flag <value>  accepted, with a warning
 */
export async function resolveSecret(
  raw: string | boolean | undefined,
  spec: SecretSpec,
  io: SecretIo = defaultIo(),
): Promise<string | undefined> {
  if (raw === '-') return nonEmpty(await readAll(io.stdin), spec, 'stdin');
  if (raw === true) {
    if (!io.stdin.isTTY || !io.stdin.setRawMode) {
      throw new SecretInputError(
        `${spec.flag} needs a value when stdin is not a terminal: pipe it with ${spec.flag} -${spec.envVar ? ` or set ${spec.envVar}` : ''}`,
      );
    }
    return nonEmpty(await promptHidden(`${spec.label}: `, io), spec, 'the prompt');
  }
  if (typeof raw === 'string' && raw !== '') {
    io.stderr.write(
      `Warning: ${spec.flag} <value> puts the secret in shell history and process lists. ` +
        `Use ${spec.flag} - to read stdin, or ${spec.flag} alone to be prompted` +
        `${spec.envVar ? `, or set ${spec.envVar}` : ''}.\n`,
    );
    return raw;
  }
  const fromEnv = spec.envVar ? io.env[spec.envVar] : undefined;
  return fromEnv ? fromEnv : undefined;
}

function nonEmpty(value: string, spec: SecretSpec, source: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new SecretInputError(`${spec.flag}: no value read from ${source}`);
  return trimmed;
}

function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => chunks.push(chunk));
    stream.on('end', () => resolve(chunks.join('')));
    stream.on('error', reject);
  });
}

/** Read one line in raw mode without echo. Ctrl+C restores the terminal and exits 130. */
function promptHidden(prompt: string, io: SecretIo): Promise<string> {
  const { stdin } = io;
  io.stderr.write(prompt);
  stdin.setRawMode?.(true);
  stdin.setEncoding('utf8');
  stdin.resume();

  return new Promise((resolve) => {
    let value = '';
    const finish = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      io.stderr.write('\n');
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\u0003') {
          finish();
          io.exit(EXIT_SIGINT);
          return;
        }
        if (char === '\r' || char === '\n' || char === '\u0004') {
          finish();
          resolve(value);
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
        } else {
          value += char;
        }
      }
    };
    stdin.on('data', onData);
  });
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd apps/cli && bunx jest src/utils/secret-input.spec.ts && bun run type-check && bun run lint`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/utils/secret-input.ts apps/cli/src/utils/secret-input.spec.ts
git commit -m "feat(cli): resolveSecret reads secrets from stdin, a hidden prompt or env"
```

---

### Task 12: Secret options use `resolveSecret`

**Files:**
- Modify: `apps/cli/src/index.ts:77-96` (login), `:99-109` (init), `:131-153` (config set), `:165-181` (config profile add)
- Modify: `apps/cli/src/commands/vcs.ts:82-112`, `apps/cli/src/commands/vcs-messages.ts:13`
- Modify: `apps/cli/src/commands/vcs.spec.ts` (new tests)
- Modify: `apps/cli/README.md` if it documents `--api-key <key>` or `--token <token>` (check with `grep -n "api-key\|--token" apps/cli/README.md`)

**Interfaces:**
- Consumes: `resolveSecret`, `SecretInputError`, `API_KEY_SECRET`, `LOGIN_API_KEY_SECRET`, `VCS_TOKEN_SECRET` (Task 11).

Rules per command:

| Command | Option | Env fallback | Missing value |
|:--|:--|:--|:--|
| `login` | `--api-key [key]` | `KODA_API_KEY` | exit 2, `API key is required: use --api-key - (stdin), --api-key (prompt), or KODA_API_KEY` |
| `init` | `--api-key [key]` | none here; `resolveAuth` already reads `KODA_API_KEY` | unchanged (`resolveAuth` decides) |
| `config set` | `--api-key [key]` | **none** (Review Focus 5) | unchanged (`Must provide at least one option`) |
| `config profile add` | `--api-key [key]` (was `requiredOption`) | none | exit 2, `API key is required for a profile: use --api-key - or --api-key (prompt)` |
| `vcs connect` | `--token [token]` | `KODA_VCS_TOKEN` | exit 3, `MISSING_REQUIRED_OPTIONS` (text updated) |

`index.ts` runs `program.parse` when imported, so its actions cannot be imported into a spec. The index wiring is proven by the built-CLI smoke run in Step 5, and `vcs connect` by unit specs.

- [ ] **Step 1: Write the failing `vcs connect` tests**

Append inside `describe('vcs connect'` in `apps/cli/src/commands/vcs.spec.ts`. Reuse the `mockConnection` shape from the first test in that block. If the block does not share it, copy it into a `const` at the top of the new tests.

```ts
    it('takes the token from KODA_VCS_TOKEN when --token is absent', async () => {
      mockData.projectSlug = 'my-project';
      process.env.KODA_VCS_TOKEN = 'env_token_1234567890';
      (vcsControllerCreateConnection as jest.Mock).mockResolvedValue({
        ret: 0,
        data: { id: 'conn-1', provider: 'github', repoOwner: 'o', repoName: 'r', syncMode: 'off', isActive: true },
      });
      const connectCmd = program.commands.find((c) => c.name() === 'vcs')?.commands.find((c) => c.name() === 'connect');

      try {
        await connectCmd?.parseAsync(['node', 'test', '--provider', 'github', '--owner', 'o', '--repo', 'r']);
      } finally {
        delete process.env.KODA_VCS_TOKEN;
      }

      expect(vcsControllerCreateConnection).toHaveBeenCalledWith(
        expect.objectContaining({ body: expect.objectContaining({ token: 'env_token_1234567890' }) }),
      );
    });

    it('warns on stderr when the token is passed as a literal', async () => {
      mockData.projectSlug = 'my-project';
      const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
      (vcsControllerCreateConnection as jest.Mock).mockResolvedValue({
        ret: 0,
        data: { id: 'conn-1', provider: 'github', repoOwner: 'o', repoName: 'r', syncMode: 'off', isActive: true },
      });
      const connectCmd = program.commands.find((c) => c.name() === 'vcs')?.commands.find((c) => c.name() === 'connect');

      await connectCmd?.parseAsync(['node', 'test', '--provider', 'github', '--owner', 'o', '--repo', 'r', '--token', 'ghp_literal_123456']);

      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Warning: --token'));
      expect(vcsControllerCreateConnection).toHaveBeenCalledWith(
        expect.objectContaining({ body: expect.objectContaining({ token: 'ghp_literal_123456' }) }),
      );
    });

    it('exits 3 when no token comes from the flag or the environment', async () => {
      delete process.env.KODA_VCS_TOKEN;
      const connectCmd = program.commands.find((c) => c.name() === 'vcs')?.commands.find((c) => c.name() === 'connect');

      await connectCmd?.parseAsync(['node', 'test', '--provider', 'github', '--owner', 'o', '--repo', 'r']);

      expect(exitSpy).toHaveBeenCalledWith(3);
      expect(vcsControllerCreateConnection).not.toHaveBeenCalled();
    });
```

- [ ] **Step 2: Run them and watch the first fail**

Run: `cd apps/cli && bunx jest src/commands/vcs.spec.ts`
Expected: the environment-variable test FAILS (exit 3, no call) and the warning test FAILS (no warning). The exit-3 test already passes, and it pins behavior that must survive.

- [ ] **Step 3: Wire `vcs connect`**

In `vcs.ts`, import `{ resolveSecret, VCS_TOKEN_SECRET, SecretInputError }` from `'../utils/secret-input'`. Change the option and the start of the action:

```ts
    .option('--token [token]', 'Provider API token (- reads stdin; omit the value to be prompted; or set KODA_VCS_TOKEN)')
```

```ts
    .action(async (options) => {
      try {
        const token = await resolveSecret(options.token, VCS_TOKEN_SECRET);
        if (!options.provider || !options.owner || !options.repo || !token) {
          error(VCS_MESSAGES.MISSING_REQUIRED_OPTIONS);
          process.exit(3);
          return;
        }
```

and use `token` in the request body (`token,` instead of `token: options.token,`). The action's existing `catch` goes through `handleApiError`. Add a branch at the top of the `catch` so a `SecretInputError` is reported as a validation error (exit 3), not an API error:

```ts
      } catch (err: unknown) {
        if (err instanceof SecretInputError) {
          error(err.message);
          process.exit(3);
          return;
        }
```

(keep the existing `catch` body after it). In `vcs-messages.ts:13`:

```ts
  MISSING_REQUIRED_OPTIONS: 'Missing required options: --provider (github|gitlab), --owner, --repo, and a token (--token -, --token to be prompted, or KODA_VCS_TOKEN)',
```

Run: `cd apps/cli && bunx jest src/commands/vcs.spec.ts src/commands/vcs-update-test-sync-import.spec.ts`
Expected: PASS. The existing connect tests pass `--token gh_test_token_1234567890` as a literal. They still pass and now also produce the warning, which they do not assert against.

- [ ] **Step 4: Wire the `index.ts` commands**

Import `{ resolveSecret, API_KEY_SECRET, LOGIN_API_KEY_SECRET }` from `'./utils/secret-input'`.

`login`:

```ts
program
  .command('login')
  .description('Save API credentials locally')
  .option('--api-key [key]', 'API key (- reads stdin; omit the value to be prompted; or set KODA_API_KEY)')
  .option('--api-url <url>', 'API URL (default: http://localhost:3100)')
  .action(async (options) => {
    try {
      const apiKey = await resolveSecret(options.apiKey, LOGIN_API_KEY_SECRET);
      if (!apiKey) {
        throw new Error('API key is required: use --api-key - (stdin), --api-key (prompt), or KODA_API_KEY');
      }
      const result = await loginCommand(apiKey, options.apiUrl, {});
      console.log(result.message);
      process.exit(0);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${errorMessage}`);
      process.exit(2);
    }
  });
```

`init`: change the option to `.option('--api-key [key]', 'API key (- reads stdin; omit the value to be prompted)')`. Make the action:

```ts
  .action(async (options) => {
    try {
      const apiKey = await resolveSecret(options.apiKey, API_KEY_SECRET);
      await initCommand({ ...options, apiKey });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${errorMessage}`);
      process.exit(2);
    }
  });
```

`config set`: change the option to `.option('--api-key [key]', 'API key (- reads stdin; omit the value to be prompted)')`, make the action `async`, and resolve the key before the existing check:

```ts
      .action(async (options) => {
        try {
          const apiKey = await resolveSecret(options.apiKey, API_KEY_SECRET);
          if (!apiKey && !options.apiUrl) {
            throw new Error('Must provide at least one option: --api-key or --api-url');
          }
          const result = configSet({
            apiKey,
            apiUrl: options.apiUrl,
          });
```

(the rest of the action is unchanged). `API_KEY_SECRET` has no environment fallback, so `KODA_API_KEY=… koda config set --api-url x` does not save the environment's key.

`config profile add`: replace `.requiredOption('--api-key <key>', 'API key for this profile')` with `.option('--api-key [key]', 'API key for this profile (- reads stdin; omit the value to be prompted)')`. Make the action `async`:

```ts
          .action(async (name, options) => {
            try {
              const apiKey = await resolveSecret(options.apiKey, API_KEY_SECRET);
              if (!apiKey) {
                throw new Error('API key is required for a profile: use --api-key - (stdin) or --api-key (prompt)');
              }
              configProfileAddAction(name, options.apiUrl, apiKey, { getProfiles, setProfile, removeProfile });
```

(the rest is unchanged). The main program uses `program.parse` (synchronous), which already runs async actions. Leave that unchanged.

Update the "not configured" hints that say `koda login --api-key <key>` to `koda login --api-key -` (`utils/context.ts:45-46`, `commands/project.ts:26,60,112,160,198`, `commands/vcs-messages.ts:14`, `commands/auth.ts:57`, `commands/init.ts:47`), so the CLI never suggests putting the key on argv. Then grep specs for the old text and update each assertion to match:

```bash
cd apps/cli && grep -rn "login --api-key <key>" src
```

- [ ] **Step 5: Run the CLI suite, build, and smoke-test the built CLI**

```bash
cd apps/cli && bunx jest && bun run type-check && bun run lint && bun run build
SMOKE_HOME=$(mktemp -d)
printf 'smoke-key-abcdefghij\n' | HOME="$SMOKE_HOME" node dist/index.js config set --api-key -; echo "exit=$?"
HOME="$SMOKE_HOME" node dist/index.js config show
HOME="$SMOKE_HOME" KODA_API_KEY=env-key-should-not-save node dist/index.js config set --api-url http://localhost:3999; echo "exit=$?"
HOME="$SMOKE_HOME" node dist/index.js config show
HOME="$SMOKE_HOME" node dist/index.js config set --api-key literal-key-abcdefgh 2>&1 | head -2
HOME="$SMOKE_HOME" node dist/index.js config set --api-key < /dev/null; echo "exit=$?"
HOME="$SMOKE_HOME" node dist/index.js ticket list --page abc; echo "exit=$?"
rm -rf "$SMOKE_HOME"
```

Expected, in order:
1. `Config updated successfully.`, `exit=0`.
2. `config show` prints a masked key (not the full `smoke-key-abcdefghij`).
3. `exit=0`.
4. `config show` still shows the masked **smoke** key, not `env-key...`.
5. The literal set prints a `Warning: --api-key` line.
6. The bare flag with a non-TTY stdin prints `--api-key needs a value when stdin is not a terminal` and exits 2.
7. `--page abc` prints commander's invalid-argument error and exits 1.

Also check once, interactively, in a real terminal: `HOME=$(mktemp -d) node dist/index.js config set --api-key`. It shows `API key: ` with no echo, and Ctrl+C at the prompt exits 130 (`echo $?`) with the terminal still echoing afterwards. This is a manual step. Record it in the PR test plan, or leave it for the user if no TTY is available.

If `HOME` does not move the `conf` store on this platform (step 2 shows no key, or shows the user's real key), stop. Do not run against the real config. Report it, and do the smoke with the `conf` `cwd` override instead.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src apps/cli/README.md
git commit -m "fix(cli): --api-key and vcs --token read stdin, a prompt or env instead of argv"
```

---

### Task 13: CI path filter covers `turbo.json` and `.nax/**`

**Files:**
- Modify: `.github/workflows/ci.yml:7-16,52`

Context (review LOW, "Path filters"): a push to `main` or a PR that changes only `turbo.json` (task graph) or root `.nax/**` (nax config and rules) never runs CI. The `changes` job's `CODE_PATHS` must match `on.push.paths`, as the workflow's own comment at lines 28-29 requires.

- [ ] **Step 1: Write the check first (red)**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda
CODE_PATHS=$(sed -n "s/^ *CODE_PATHS='\(.*\)'$/\1/p" .github/workflows/ci.yml)
for f in turbo.json .nax/config.json .nax/rules/api-core.md apps/api/src/main.ts docs/README.md README.md; do
  printf '%s -> ' "$f"; echo "$f" | grep -Eq "$CODE_PATHS" && echo code || echo skip
done
```

Expected before the change: `turbo.json -> skip` and `.nax/... -> skip` (the defect), `apps/api/src/main.ts -> code`, and both docs paths `-> skip`.

- [ ] **Step 2: Implement**

`ci.yml` `on.push.paths`: add two entries after `"openapi.json"`:

```yaml
      - "openapi.json"
      - "turbo.json"
      - ".nax/**"
```

`ci.yml:52`:

```bash
          CODE_PATHS='^(apps/|packages/|prisma/|scripts/|\.github/workflows/|\.nax/)|^(bun\.lock|package\.json|openapi\.json|turbo\.json)$|^tsconfig[^/]*\.json$'
```

- [ ] **Step 3: Re-run the check (green)**

Re-run the Step 1 loop.
Expected: `turbo.json -> code`, both `.nax/...` → `code`, `apps/api/src/main.ts -> code`, and both docs paths still `-> skip`. That last result is the docs-only skip path. Also validate the YAML:

```bash
bunx --bun js-yaml .github/workflows/ci.yml > /dev/null && echo yaml-ok
```

Expected: `yaml-ok`. If `js-yaml` is not available through `bunx`, use `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))" && echo yaml-ok`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: path filter includes turbo.json and .nax/**"
```

---

### Task 14: Whole-slice verification and PR

**Files:** none new.

- [ ] **Step 1: Full local gates**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda
bun run generate && git status --short openapi.json
bun run lint
bun run type-check
bun run test
cd apps/api && bun run test:scoped test/integration/projects test/integration/graphify-kb-validation test/integration/events test/integration/koda-domain-writer
```

Expected: `git status` prints nothing for `openapi.json`, because no contract changed. Every gate is green. Test counts only grow compared with the Task 0 baseline. A full local e2e run hits the known login-throttle 429 cascade, which this slice does not cause. CI is the authority for the complete e2e job.

- [ ] **Step 2: Confirm every spec item has a commit**

| Spec item (Slice 6) | Task |
|:--|:--|
| `apiPath` helper, all `$api` call sites, guard test on raw interpolation, no double encoding | 1, 2, 3 |
| Duplicate comment toast removed (only `CommentThread` toasts) | 4 |
| `agents.empty`, `agents.toast.created` / `createFailed` (en + zh); `agents.validation.*` → `agents.form.validation.*` | 4 |
| `ui/input/Input.vue` `inheritAttrs: false` | 5 |
| #145: drop `ProjectsService.findAll()`, unused `@Principal()`, unreachable agent slug fallback | 6 |
| #145: `findUserProjectRoles` in parallel; one comment fetch for update/delete | 7 |
| CLI: `--api-key` and `vcs --token` accept `-`, prompt on a TTY, read `KODA_API_KEY` / `KODA_VCS_TOKEN`, literal warns | 11, 12 |
| CLI: Ctrl+C exits 130; missing `--force` exits 1 everywhere | 9 |
| CLI: auth hint uses the real syntax | 9 |
| CLI: numeric options through one `parsePositiveInt` | 8 |
| CLI: `apiUrl` resolution uses `\|\|` | 10 |
| CI: path filter and `changes` list add `turbo.json` and `.nax/**`; docs-only skip confirmed | 13 |
| Tests: `apiPath` encoding, `parsePositiveInt`, secret-source precedence, SIGINT exit code, `Input` attrs | 1, 8, 11, 9, 5 |

- [ ] **Step 3: Review before push**

Run a code review of the whole branch (`git diff main...HEAD`) before pushing. Fix CRITICAL and HIGH findings, and MEDIUM ones where practical. Re-run Step 1 after any fix.

- [ ] **Step 4: Push and open the PR (after the user approves)**

Push `feat/track3-web-cli-hygiene` with `-u` and open a PR titled `fix(track3-slice6): web and CLI hygiene, #145 API cleanup, CI path filter`. The body contains:

- A summary per area (web, API, CLI, CI), naming the review LOWs closed and `Closes #145`.
- **Breaking CLI changes:**
  - `--api-key` and `vcs connect --token` still accept a literal value, but now print a warning on stderr.
  - Numeric options now exit 1 on invalid input instead of sending `NaN`.
  - `ticket delete` without `--force` exits 1, not 3.
  - Ctrl+C exits 130 and SIGTERM exits 143, not 0.
- **Beyond spec:** SIGTERM 143 and the updated "not configured" hints (`koda login --api-key -`).
- **Out of scope** (not in the spec): `auth register --password`, `user create --password`, `webhook --secret`, `ci-webhook --signature` on argv.
- The Task 0 and Task 14 test counts, the Task 13 path-filter check output (the docs-only skip path), and the Task 12 smoke output. Include the interactive prompt and Ctrl+C check if it was run.
