# Fleet S1 Slice 4b — Web Foundation and Admin Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Numbering.** This is plan 4b, the second of three slice 4 plans (`2026-10-01-fleet-s1-slice-4-overview.md`, D114). Read the overview first: it fixes the API contract this plan consumes (from 4a) and the shared decisions D114-D129. Decision numbers continue the fleet S1 register; this plan adds **D135-D137**.

**Prerequisite:** plan 4a is merged (the API additions: `RunnerDto.bootId`, `bootedAt`, `online`; `POST /api/fleet/repos/:id/check`; `GET /api/projects/:slug/fleet/runners`). Task 0 verifies this before any code is written. If 4a's contract changed in review, patch this plan's types (Task 2) and composables (Task 3) first.

**Goal:** A global admin manages the fleet from the web: sees every runner's online state, capabilities, last seen and boot age (refreshed every 15 s), enables, disables, relabels, resizes and deletes runners, issues an enrollment token shown once, and registers, checks and removes fleet repos.

**Architecture:** Two admin pages under `/admin/fleet/` (D115), each backed by one composable (`useFleetRunners`, `useFleetRepos`) that owns its API calls and immutable list state. Pure helpers in `lib/` (wire types, input rules, age formatting, capability chips, enroll command, a bounded-concurrency mapper) carry the logic and the behavioural tests; pages and dialogs are thin and are pinned by source-wiring specs, the way the existing admin pages are. A new `fleet.*` i18n section holds every string, including the shared enum maps (`fleet.state`, `fleet.misfit`, `fleet.repoReason`) that 4c also uses.

**Tech Stack:** Nuxt 3.21 SSR, Vue 3.5 `<script setup>`, shadcn-nuxt (`Table`, `Badge`, `Dialog`, `Form*`, `Input`, `Button`, `Label`), vee-validate 4 + zod 3 (`toTypedSchema`), `@nuxtjs/i18n` 10 (`t`, `te`), lucide-vue-next 0.400 (`Server`, `FolderGit2`, `KeyRound`, `Plus`), Jest 29 + ts-jest (`testEnvironment: node`, `~` mapped to the web root).

**Specs:** `docs/superpowers/specs/2026-09-29-fleet-s1-dispatch-design.md` ("S1 spec": §11 Runners and Repos bullets, §1 "The Runners page is not project-scoped and polls every 15s", §2.2 permissions, §3.4 endpoints) and the slice 4 overview (contract, D114-D129). Precedent code: `apps/web/pages/admin/users.vue`, `components/CreateUserDialog.vue`, `components/RotateKeyDialog.vue`, `composables/useAdminUsers.ts`.

## Global Constraints

From the specs, the overview and the repo rules (`.nax/rules/web.md`, `.nax/rules/common.md`); every task includes them.

- **Routes:** `/admin/fleet/runners` and `/admin/fleet/repos` (D115). Sidebar links only for `auth.user.role === 'ADMIN'` (`isGlobalAdmin`).
- **Permissions:** every route these pages call is global ADMIN. A non-admin who opens the URL gets the API's 403, which arrives as `ApiError.code === 40003` (the envelope `ret`, not the HTTP status; see the comment in `pages/admin/users.vue`). The page then shows `fleet.common.adminOnly` and stops polling.
- **Contract (overview):** `RunnerDto` = `id, name, os, arch, labels, capacity, capabilities, daemonVersion, protocolVersion, enabled, lastSeenAt, createdAt, bootId, bootedAt (string | null), online`; `FleetRepoDto` = `id, projectId, provider ('github' | 'gitlab'), owner, name, defaultBranch, githubInstallationId (string | null), createdAt`; `POST /api/fleet/repos/:id/check` answers 200 `{ repoId, reachable, reason | null, checkedAt }`; enrollment create answers `EnrollmentDto & { token }`. Pages are `{ records, total, current, size, hasNext, hasPrev }`.
- **Lists:** one page of `size=100` and a "more" note when `hasNext` (D125).
- **Input rules copied from the API DTOs:** labels `^[a-z0-9][a-z0-9._-]{0,31}$`, at most 20; capacity integer 1..16; repo owner `^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$`; repo name `^[A-Za-z0-9._-]{1,100}$`.
- **Runners page polls every 15 s** (S1 spec §1): never two polls at once, skips a hidden tab, refreshes as soon as the tab is visible again, clears its timer and listener on unmount, and a poll that started before a mutation never overwrites it.
- **Enrollment tokens are shown once** (S1 spec §11): the dialog forgets the token when it closes, and while a token is showing only its Done button closes it (Esc and outside clicks do not). Copy falls back to manual selection where the Clipboard API is missing (plain http, the VPN phase).
- **Codes are translated from fixed key maps; an unknown code shows raw** (D126).
- **Web rules:** API calls only through `useApi()` inside composables; every path with an interpolation through the `apiPath` tag; no hardcoded UI strings, en and zh both updated; vee-validate + zod forms with i18n messages; semantic Tailwind tokens (`text-muted-foreground`, `border-border`, `bg-muted`); errors shown with `toast.error(extractApiError(err))`.
- **Repo conventions:** conventional commits, no attribution trailer, never push, no emojis, no `console.log`, no `any`, no `eslint-disable` in new source (the existing layout-spec pattern's `no-var-requires` disables are copied as-is in test files only), immutable updates (`map`/`filter`/spread, never mutate a ref's array or object in place), files under 400 lines, functions under 50 lines.

Plan-level rules:

- Branch `feat/fleet-s1-slice4b-web-admin`, cut from `main` after 4a merged (Task 0). Commit on it only; never push.
- Web unit tests: `cd apps/web && npx jest <path>`; all: `bun run test`; lint: `bun run lint`; types: `bun run type-check` (`nuxt typecheck`, about a minute).
- Do not add shadcn components or dependencies: everything used here already exists in `components/ui/`.

## Plan decisions beyond the spec

| # | Decision | Why |
|:--|:--|:--|
| D135 | Fleet wire types are hand-written in `apps/web/lib/fleet-types.ts`, and the runner `capabilities` object is read defensively in `lib/fleet-capabilities.ts` (every field checked; a malformed part yields no chip). The web does not depend on `@nathapp/fleet-protocol`. | `.nax/mono/apps/web/context.md`: the web uses hand-written composables and types by design, no generated or shared client. On the wire `capabilities` is `Record<string, unknown>`, and a runner on an older daemon may send an older shape; the Runners page must never crash on it. 4c adds job types to the same file. |
| D136 | The enrollment dialog shows the token and the full command `koda-runner enroll --server <origin> --token <token>`, where `<origin>` is the page's own `window.location.origin`, with a hint to replace it if runners reach koda at another address. | `docs/deployment/runner.md` documents `--server https://koda.example.com`, the same origin that serves the web and proxies `/api`. The web has no other knowledge of the public API URL (`runtimeConfig.public.apiBaseUrl` is the relative `/api`). A copy-ready line removes the most common enrollment mistake; the hint covers split deployments. |
| D137 | Fleet forms use a native `<select>` through the new `components/fleet/NativeSelect.vue` (`<FleetNativeSelect>`), not the shadcn `Select`. It takes `modelValue` and emits `update:modelValue` from the native `change` event (and `blur`), so vee-validate's `componentField` binds to it; 4c reuses it. | Issue #58: shadcn `Select` renders its options in a portal that Playwright and snapshot automation cannot reach reliably, and 4c's E2E drives fleet forms. Track 1 slice 4 already chose native selects for the admin users page. A bare `<select v-bind="componentField">` does not work: `componentField` is `{ modelValue, 'onUpdate:modelValue', onBlur }`, component props and events that a native element renders as a `modelvalue` attribute and never fires, so the form value never changes (reproduced in review, Vue 3.5). `components/CreateUserDialog.vue` binds its role select that way and has the same latent defect: out of scope here, to be filed separately. This overrides `.nax/rules/web.md`'s "prefer Shadcn primitives" for selects only. |

Smaller choices (no decision number): deletes confirm with `window.confirm`, as in `pages/[project]/settings.vue`, `kb.vue` and `CommentThread.vue`; dialogs call their own composable instance and the page reloads on their event, as `CreateUserDialog` does; Nuxt prefixes components by folder, so `components/fleet/Age.vue` is used as `<FleetAge>`.

## Review Focus

The five inputs or conditions most likely to bite an admin that no spec line names, each pinned by a test in the owning task:

1. **A malformed or older capability report** (missing `sandbox`, non-array `credentials`, a credential without `providerId`): the Runners page must render the row with fewer chips, never throw. Pinned in Task 2 (`capabilityChips` "never throws on a malformed report").
2. **The API restarts or the network drops while the Runners page is open, or the tab sits hidden**: polling must keep the last rows, show the stale note, not toast every 15 s, never stack two polls, recover on the next good poll, refresh as soon as the tab is visible again, and stop on a 403; a poll that started before an enable/disable must not overwrite it. Pinned in Task 6 (`useVisiblePolling` fake-timer spec) and Task 3 (`useFleetRunners` drops a load that raced a mutation).
3. **Label input as people type it** (`Linux, gpu,,gpu`): upper case is reported (not silently folded), duplicates and blanks collapse, more than 20 is refused, all before the PATCH. Pinned in Task 2 (`parseLabels`).
4. **Many repos on the Repos page**: checks run with at most 4 requests in flight, and one failing check marks only its own row. Pinned in Task 3 (`checkAll` peak concurrency, `check` error state) and Task 2 (`mapLimit` keeps going after a rejection).
5. **Browser and API clocks disagree**: a `lastSeenAt` slightly in the future must read "0s ago", not a negative or NaN age; a null `bootedAt` (runner not rebooted since the 4a migration) reads as a dash. Pinned in Task 2 (`ageParts`).

---

## Task 0: Branch and contract check

**Files:** none changed.

- [ ] **Step 1: Cut the branch from the merged 4a**

```bash
cd repos/koda
git fetch origin
git switch -c feat/fleet-s1-slice4b-web-admin origin/main
git log --oneline -1
```

Expected: the head commit is the 4a merge (`feat(fleet): S1 slice 4a ...`) or later.

- [ ] **Step 2: Confirm the 4a contract is in `openapi.json`**

```bash
grep -c '"bootedAt"' openapi.json
grep -c '"/api/fleet/repos/{id}/check"' openapi.json
grep -c '"/api/projects/{slug}/fleet/runners"' openapi.json
```

Expected: each count is at least 1. If any is 0, 4a is not merged (or its contract changed): stop and report.

- [ ] **Step 3: Baseline**

```bash
cd apps/web && bun run test 2>&1 | tail -4
```

Expected: all suites pass. Record the suite and test counts for Task 8.

---

## Task 1: Fleet i18n section and locale parity

**Files:**
- Modify: `apps/web/i18n/locales/en.json` (the `nav` block, and a new last top-level key `fleet`)
- Modify: `apps/web/i18n/locales/zh.json` (same)
- Test: `apps/web/tests/i18n/fleet-locale-parity.spec.ts` (create)

**Interfaces:**
- Produces: `nav.fleetRunners`, `nav.fleetRepos`, and the `fleet` tree. Shared with 4c: `fleet.common.*` (`online`, `offline`, `enabled`, `disabled`, `adminOnly`, `more`, `stale`, `copy`, `copied`, `copyFailed`, `unknown`, `ago.{s,m,h,d}`, `duration.{s,m,h,d}`), `fleet.validation.*`, `fleet.state.<STATE>` (9 states), `fleet.misfit.<reason>` (11), `fleet.repoReason.<reason>` (13). 4b-only: `fleet.runners.*`, `fleet.repos.*`. 4c adds `fleet.jobs.*` and `fleet.dispatch.*` and extends this spec's `ENUMS` if it adds maps.

- [ ] **Step 1: Write the failing parity spec**

Create `apps/web/tests/i18n/fleet-locale-parity.spec.ts`:

```ts
import { describe, test, expect } from '@jest/globals'

const en = require('../../i18n/locales/en.json') as Record<string, unknown>
const zh = require('../../i18n/locales/zh.json') as Record<string, unknown>

type Tree = Record<string, unknown>

function at(tree: Tree, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => (node as Tree | undefined)?.[key], tree)
}

function leafPaths(node: unknown, prefix = ''): string[] {
  if (node === null || typeof node !== 'object') return [prefix]
  return Object.entries(node as Tree).flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key))
}

// The API's enumerations (S1 spec; slice 4 overview). Each one is rendered through a
// dynamic key (fleet.state.<STATE> ...), which used-keys-exist.spec cannot see.
const ENUMS: Record<string, string[]> = {
  'fleet.state': ['QUEUED', 'ASSIGNED', 'RUNNING', 'UPLOADING', 'COMPLETED', 'FAILED', 'ESCALATED', 'CRASHED', 'CANCELLED'],
  'fleet.misfit': ['disabled', 'offline', 'labels', 'executor', 'protocol', 'provider_missing', 'provider_unavailable', 'sandbox', 'tools', 'busy_repo', 'capacity'],
  'fleet.repoReason': [
    'github_app_not_configured', 'github_app_key_unreadable', 'app_not_installed', 'app_permissions_insufficient',
    'repo_not_found', 'provider_unreachable', 'provider_error', 'vcs_connection_missing', 'vcs_connection_mismatch',
    'vcs_encryption_key_missing', 'gitlab_token_invalid', 'gitlab_access_insufficient', 'gitlab_scope_missing',
  ],
  'fleet.common.ago': ['s', 'm', 'h', 'd'],
  'fleet.common.duration': ['s', 'm', 'h', 'd'],
  'fleet.repos.provider': ['github', 'gitlab'],
  'fleet.runners.chip.kind': ['api-key', 'oauth', 'exec', 'ambient', 'none'],
}

describe('Fleet locale parity (en and zh)', () => {
  test.each(['fleet', 'nav'])('%s has the same keys in en and zh, all non-empty', (subtree) => {
    const enNode = at(en, subtree)
    const zhNode = at(zh, subtree)
    expect(enNode).toBeDefined()
    expect(zhNode).toBeDefined()
    expect(leafPaths(zhNode).sort()).toEqual(leafPaths(enNode).sort())
    for (const leaf of leafPaths(zhNode)) {
      expect(String(at(zhNode as Tree, leaf) ?? '').trim()).not.toBe('')
    }
  })

  test.each(Object.entries(ENUMS))('%s covers exactly the API values', (path, values) => {
    expect(Object.keys(at(en, path) as Tree).sort()).toEqual([...values].sort())
  })

  test('nav has the two admin fleet links', () => {
    expect(at(en, 'nav.fleetRunners')).toBe('Runners')
    expect(at(en, 'nav.fleetRepos')).toBe('Repos')
  })

  test('no fleet message uses the vue-i18n plural or linked-message syntax by accident', () => {
    for (const leaf of leafPaths(at(en, 'fleet'))) {
      const value = String(at(en, `fleet.${leaf}`))
      expect(value).not.toMatch(/[|@]/)
    }
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd apps/web && npx jest tests/i18n/fleet-locale-parity.spec.ts`
Expected: FAIL (`fleet` undefined; `nav.fleetRunners` undefined).

- [ ] **Step 3: Add the nav keys**

In `apps/web/i18n/locales/en.json`, in the `nav` object, replace the line `    "users": "Users"` with:

```json
    "users": "Users",
    "fleetRunners": "Runners",
    "fleetRepos": "Repos"
```

In `apps/web/i18n/locales/zh.json`, replace `    "users": "用户"` (in `nav`) with:

```json
    "users": "用户",
    "fleetRunners": "执行机",
    "fleetRepos": "仓库"
```

- [ ] **Step 4: Add the `fleet` section to `en.json`**

Make `fleet` the last top-level key: put a comma after the closing `}` of the current last key (`slos`) and add (indent the block by two spaces so it sits at top level):

```json
"fleet": {
  "common": {
    "online": "Online",
    "offline": "Offline",
    "enabled": "Enabled",
    "disabled": "Disabled",
    "adminOnly": "Only global administrators can manage the fleet.",
    "more": "Showing the first {n}. More exist; narrow the list in the API or CLI.",
    "stale": "Could not refresh. Showing the last data.",
    "copy": "Copy",
    "copied": "Copied",
    "copyFailed": "Could not copy. Select the text and copy it manually.",
    "unknown": "Unknown",
    "ago": {
      "s": "{n}s ago",
      "m": "{n}m ago",
      "h": "{n}h ago",
      "d": "{n}d ago"
    },
    "duration": {
      "s": "{n}s",
      "m": "{n}m",
      "h": "{n}h",
      "d": "{n}d"
    }
  },
  "validation": {
    "labelInvalid": "Invalid label \"{label}\": use lower case letters, digits, . _ - (max 32, starting with a letter or digit)",
    "labelsTooMany": "At most 20 labels",
    "capacityRange": "Enter a whole number from 1 to 16",
    "required": "Required",
    "ownerInvalid": "Use letters, digits, . _ - and / for groups",
    "nameInvalid": "Use letters, digits, . _ -"
  },
  "state": {
    "QUEUED": "Queued",
    "ASSIGNED": "Assigned",
    "RUNNING": "Running",
    "UPLOADING": "Uploading",
    "COMPLETED": "Completed",
    "FAILED": "Failed",
    "ESCALATED": "Escalated",
    "CRASHED": "Crashed",
    "CANCELLED": "Cancelled"
  },
  "misfit": {
    "disabled": "Runner is disabled",
    "offline": "Runner is offline",
    "labels": "Runner lacks a required label",
    "executor": "Runner has no host executor",
    "protocol": "A profile needs a protocol the runner's nax lacks",
    "provider_missing": "A profile needs a provider the runner has no credential for",
    "provider_unavailable": "A provider credential is not usable right now",
    "sandbox": "A profile needs the sandbox, which is unavailable",
    "tools": "Runner lacks git, gh or glab for this repo",
    "busy_repo": "Runner already runs a job for this repo",
    "capacity": "Runner is at capacity"
  },
  "repoReason": {
    "github_app_not_configured": "The GitHub App is not configured on the koda server",
    "github_app_key_unreadable": "The GitHub App private key cannot be read",
    "app_not_installed": "The GitHub App is not installed on this repository",
    "app_permissions_insufficient": "The GitHub App lacks the permissions fleet jobs need",
    "repo_not_found": "Repository not found",
    "provider_unreachable": "The forge did not answer",
    "provider_error": "The forge returned an error",
    "vcs_connection_missing": "The project has no GitLab connection",
    "vcs_connection_mismatch": "The project's GitLab connection is for another repository",
    "vcs_encryption_key_missing": "The server cannot decrypt the stored GitLab token",
    "gitlab_token_invalid": "The stored GitLab token is invalid",
    "gitlab_access_insufficient": "The GitLab token cannot push to this repository",
    "gitlab_scope_missing": "The GitLab token lacks a required scope"
  },
  "runners": {
    "title": "Runners",
    "subtitle": "Machines that run nax jobs for koda.",
    "empty": "No runners yet. Create an enrollment token and run koda-runner enroll on a machine.",
    "deleteConfirm": "Delete runner {name}? Its key is revoked. A runner with unfinished or pinned jobs cannot be deleted.",
    "table": {
      "name": "Name",
      "status": "Status",
      "labels": "Labels",
      "capacity": "Capacity",
      "capabilities": "Capabilities",
      "lastSeen": "Last seen",
      "boot": "Up",
      "version": "Versions"
    },
    "actions": {
      "enroll": "Enrollment token",
      "enable": "Enable",
      "disable": "Disable",
      "edit": "Edit",
      "delete": "Delete"
    },
    "chip": {
      "sandboxOn": "sandbox",
      "sandboxOff": "no sandbox",
      "protocol": "{name}",
      "credential": "{provider}: {kind}",
      "credentialExpires": "{provider}: {kind} until {expires}",
      "credentialExpired": "{provider}: {kind}, expired {expires}",
      "kind": {
        "api-key": "API key",
        "oauth": "OAuth",
        "exec": "exec helper",
        "ambient": "ambient",
        "none": "no credential"
      }
    },
    "toast": {
      "enabled": "Runner enabled",
      "disabled": "Runner disabled",
      "updated": "Runner updated",
      "deleted": "Runner deleted"
    },
    "edit": {
      "title": "Edit runner {name}",
      "labels": "Labels",
      "labelsHint": "Comma or space separated.",
      "capacity": "Concurrent jobs",
      "submit": "Save",
      "submitting": "Saving…"
    },
    "enrollment": {
      "title": "New enrollment token",
      "labels": "Labels for the new runner",
      "labelsHint": "Optional. Comma or space separated.",
      "submit": "Create token",
      "submitting": "Creating…",
      "tokenOnce": "Copy the token now. It is shown once and expires {expiresAt}.",
      "token": "Token",
      "command": "Enroll command",
      "commandHint": "Run it as the runner's service user. Replace the server URL if the runner reaches koda at another address. The runner requires https unless the server is loopback or you add --insecure-http."
    }
  },
  "repos": {
    "title": "Repos",
    "subtitle": "Repositories koda can clone and push for fleet jobs.",
    "empty": "No repos registered.",
    "deleteConfirm": "Unregister {repo}? A repo with unfinished jobs cannot be removed.",
    "table": {
      "repo": "Repository",
      "project": "Project",
      "provider": "Provider",
      "branch": "Default branch",
      "reachability": "Reachability"
    },
    "reach": {
      "checking": "Checking…",
      "ok": "Reachable",
      "failed": "Unreachable",
      "error": "Check failed"
    },
    "actions": {
      "add": "Add repo",
      "recheck": "Check again",
      "delete": "Delete"
    },
    "provider": {
      "github": "GitHub",
      "gitlab": "GitLab"
    },
    "toast": {
      "added": "Repo added",
      "deleted": "Repo removed"
    },
    "form": {
      "title": "Add repo",
      "hint": "koda checks that it can broker git access before it saves the repo.",
      "project": "Project",
      "projectPlaceholder": "Choose a project",
      "provider": "Provider",
      "owner": "Owner or group",
      "name": "Repository name",
      "submit": "Add repo",
      "submitting": "Checking access…"
    }
  }
}
```

- [ ] **Step 5: Add the `fleet` section to `zh.json`**

Same place, same shape:

```json
"fleet": {
  "common": {
    "online": "在线",
    "offline": "离线",
    "enabled": "已启用",
    "disabled": "已停用",
    "adminOnly": "只有全局管理员可以管理执行机群。",
    "more": "仅显示前 {n} 条。还有更多，请在 API 或 CLI 中筛选。",
    "stale": "刷新失败，显示的是上一次的数据。",
    "copy": "复制",
    "copied": "已复制",
    "copyFailed": "无法复制，请手动选择文本复制。",
    "unknown": "未知",
    "ago": {
      "s": "{n} 秒前",
      "m": "{n} 分钟前",
      "h": "{n} 小时前",
      "d": "{n} 天前"
    },
    "duration": {
      "s": "{n} 秒",
      "m": "{n} 分钟",
      "h": "{n} 小时",
      "d": "{n} 天"
    }
  },
  "validation": {
    "labelInvalid": "标签 \"{label}\" 无效：只能使用小写字母、数字和 . _ -（最多 32 个字符，以字母或数字开头）",
    "labelsTooMany": "最多 20 个标签",
    "capacityRange": "请输入 1 到 16 之间的整数",
    "required": "必填",
    "ownerInvalid": "只能使用字母、数字、. _ - 以及表示分组的 /",
    "nameInvalid": "只能使用字母、数字和 . _ -"
  },
  "state": {
    "QUEUED": "排队中",
    "ASSIGNED": "已分配",
    "RUNNING": "运行中",
    "UPLOADING": "上传中",
    "COMPLETED": "已完成",
    "FAILED": "失败",
    "ESCALATED": "已升级",
    "CRASHED": "已崩溃",
    "CANCELLED": "已取消"
  },
  "misfit": {
    "disabled": "执行机已停用",
    "offline": "执行机离线",
    "labels": "执行机缺少所需标签",
    "executor": "执行机没有主机执行器",
    "protocol": "某个配置需要执行机的 nax 不支持的协议",
    "provider_missing": "某个配置需要执行机没有凭据的提供方",
    "provider_unavailable": "某个提供方凭据当前不可用",
    "sandbox": "某个配置需要沙箱，但沙箱不可用",
    "tools": "执行机缺少此仓库所需的 git、gh 或 glab",
    "busy_repo": "执行机已在运行此仓库的任务",
    "capacity": "执行机已满载"
  },
  "repoReason": {
    "github_app_not_configured": "koda 服务器未配置 GitHub App",
    "github_app_key_unreadable": "无法读取 GitHub App 私钥",
    "app_not_installed": "GitHub App 未安装到此仓库",
    "app_permissions_insufficient": "GitHub App 缺少执行机任务所需的权限",
    "repo_not_found": "找不到仓库",
    "provider_unreachable": "代码托管平台无响应",
    "provider_error": "代码托管平台返回错误",
    "vcs_connection_missing": "项目没有 GitLab 连接",
    "vcs_connection_mismatch": "项目的 GitLab 连接属于另一个仓库",
    "vcs_encryption_key_missing": "服务器无法解密已保存的 GitLab 令牌",
    "gitlab_token_invalid": "已保存的 GitLab 令牌无效",
    "gitlab_access_insufficient": "GitLab 令牌无法推送到此仓库",
    "gitlab_scope_missing": "GitLab 令牌缺少必需的权限范围"
  },
  "runners": {
    "title": "执行机",
    "subtitle": "为 koda 运行 nax 任务的机器。",
    "empty": "还没有执行机。请创建注册令牌，并在机器上运行 koda-runner enroll。",
    "deleteConfirm": "删除执行机 {name}？其密钥将被吊销。有未完成任务或被固定任务的执行机无法删除。",
    "table": {
      "name": "名称",
      "status": "状态",
      "labels": "标签",
      "capacity": "容量",
      "capabilities": "能力",
      "lastSeen": "最后在线",
      "boot": "已运行",
      "version": "版本"
    },
    "actions": {
      "enroll": "注册令牌",
      "enable": "启用",
      "disable": "停用",
      "edit": "编辑",
      "delete": "删除"
    },
    "chip": {
      "sandboxOn": "沙箱",
      "sandboxOff": "无沙箱",
      "protocol": "{name}",
      "credential": "{provider}：{kind}",
      "credentialExpires": "{provider}：{kind}，有效期至 {expires}",
      "credentialExpired": "{provider}：{kind}，已于 {expires} 过期",
      "kind": {
        "api-key": "API 密钥",
        "oauth": "OAuth",
        "exec": "外部命令",
        "ambient": "环境凭据",
        "none": "无凭据"
      }
    },
    "toast": {
      "enabled": "执行机已启用",
      "disabled": "执行机已停用",
      "updated": "执行机已更新",
      "deleted": "执行机已删除"
    },
    "edit": {
      "title": "编辑执行机 {name}",
      "labels": "标签",
      "labelsHint": "用逗号或空格分隔。",
      "capacity": "并发任务数",
      "submit": "保存",
      "submitting": "保存中…"
    },
    "enrollment": {
      "title": "新建注册令牌",
      "labels": "新执行机的标签",
      "labelsHint": "可选。用逗号或空格分隔。",
      "submit": "创建令牌",
      "submitting": "创建中…",
      "tokenOnce": "请立即复制令牌。它只显示一次，将于 {expiresAt} 过期。",
      "token": "令牌",
      "command": "注册命令",
      "commandHint": "请以执行机的服务用户身份运行。如果执行机通过其他地址访问 koda，请替换服务器 URL。除非服务器是本机回环地址或添加 --insecure-http，执行机要求使用 https。"
    }
  },
  "repos": {
    "title": "仓库",
    "subtitle": "koda 可为执行机任务克隆和推送的仓库。",
    "empty": "还没有注册仓库。",
    "deleteConfirm": "取消注册 {repo}？有未完成任务的仓库无法移除。",
    "table": {
      "repo": "仓库",
      "project": "项目",
      "provider": "平台",
      "branch": "默认分支",
      "reachability": "可达性"
    },
    "reach": {
      "checking": "检查中…",
      "ok": "可达",
      "failed": "不可达",
      "error": "检查失败"
    },
    "actions": {
      "add": "添加仓库",
      "recheck": "重新检查",
      "delete": "删除"
    },
    "provider": {
      "github": "GitHub",
      "gitlab": "GitLab"
    },
    "toast": {
      "added": "仓库已添加",
      "deleted": "仓库已移除"
    },
    "form": {
      "title": "添加仓库",
      "hint": "保存前，koda 会检查是否能代理该仓库的 git 访问。",
      "project": "项目",
      "projectPlaceholder": "选择项目",
      "provider": "平台",
      "owner": "所有者或分组",
      "name": "仓库名称",
      "submit": "添加仓库",
      "submitting": "正在检查访问权限…"
    }
  }
}
```

Do not reformat the rest of either file: the diff must add lines only (plus the two `"users"` lines that gain a comma and the `slos` closing brace that gains one).

- [ ] **Step 6: Run the i18n specs**

Run: `cd apps/web && npx jest tests/i18n`
Expected: PASS, every suite (the new one plus `used-keys-exist`, `locale-parity`, the other parity specs).

- [ ] **Step 7: Commit**

```bash
git add apps/web/i18n/locales/en.json apps/web/i18n/locales/zh.json apps/web/tests/i18n/fleet-locale-parity.spec.ts
git commit -m "feat(web): fleet i18n section and admin nav keys"
```

---

## Task 2: Fleet web types and pure helpers

**Files:**
- Create: `apps/web/lib/fleet-types.ts`, `apps/web/lib/fleet-validation.ts`, `apps/web/lib/fleet-age.ts`, `apps/web/lib/fleet-capabilities.ts`, `apps/web/lib/fleet-enroll.ts`, `apps/web/lib/map-limit.ts`
- Test: `apps/web/tests/lib/fleet-validation.spec.ts`, `fleet-age.spec.ts`, `fleet-capabilities.spec.ts`, `fleet-enroll.spec.ts`, `map-limit.spec.ts` (create)

**Interfaces:**
- Consumes: the overview contract; the `fleet.*` keys from Task 1.
- Produces (4c relies on the types and `ageParts`):
  - `fleet-types.ts`: `FleetPage<T>`, `FLEET_LIST_SIZE = 100`, `FleetProtocol`, `FleetProfileNeeds`, `FleetCredentialStored`, `FleetCredential`, `FleetCapabilities`, `FleetRunner`, `FleetRunnerPatch`, `FleetEnrollment`, `FleetEnrollmentCreated`, `FleetRunnerSummary`, `FleetProvider`, `FleetRepo`, `NewFleetRepo`, `FleetRepoCheck`.
  - `fleet-validation.ts`: `LABEL_PATTERN`, `MAX_LABELS`, `CAPACITY_MIN`, `CAPACITY_MAX`, `REPO_OWNER_PATTERN`, `REPO_NAME_PATTERN`, `type LabelParse`, `parseLabels(input: string): LabelParse`.
  - `fleet-age.ts`: `type AgeUnit`, `interface AgeParts { n; unit }`, `ageParts(fromIso: string | null | undefined, now: Date): AgeParts | null`.
  - `fleet-capabilities.ts`: `type ChipTone = 'ok' | 'warn' | 'bad'`, `interface CapabilityChip { id; key; params; tone }` (a credential chip's `params.kind` is a `CredentialKind` code, translated by the chips component), `CREDENTIAL_KINDS`, `type CredentialKind`, `capabilityChips(capabilities: unknown): CapabilityChip[]`, `naxVersion(capabilities: unknown): string | null`.
  - `fleet-enroll.ts`: `enrollCommand(server: string, token: string): string`.
  - `map-limit.ts`: `mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void>`.

- [ ] **Step 1: Write the failing specs**

Create `apps/web/tests/lib/fleet-validation.spec.ts`:

```ts
import { describe, expect, it } from '@jest/globals'
import { LABEL_PATTERN, MAX_LABELS, REPO_NAME_PATTERN, REPO_OWNER_PATTERN, parseLabels } from '~/lib/fleet-validation'

describe('parseLabels', () => {
  it('splits on commas and whitespace, trims, de-duplicates and sorts', () => {
    expect(parseLabels(' linux, gpu  mac,linux ')).toEqual({ ok: true, labels: ['gpu', 'linux', 'mac'] })
  })

  it('reads an empty or blank input as no labels', () => {
    expect(parseLabels('')).toEqual({ ok: true, labels: [] })
    expect(parseLabels(' ,  ')).toEqual({ ok: true, labels: [] })
  })

  it('reports the first label the API would reject, without changing its case', () => {
    expect(parseLabels('linux, GPU')).toEqual({ ok: false, error: 'invalid', label: 'GPU' })
    expect(parseLabels('-lead')).toEqual({ ok: false, error: 'invalid', label: '-lead' })
    expect(parseLabels('a'.repeat(33))).toEqual({ ok: false, error: 'invalid', label: 'a'.repeat(33) })
  })

  it('accepts the documented characters and the 32-character maximum', () => {
    expect(parseLabels('a.b_c-1 ' + 'z'.repeat(32))).toEqual({ ok: true, labels: ['a.b_c-1', 'z'.repeat(32)] })
  })

  it('refuses more than MAX_LABELS distinct labels', () => {
    const many = Array.from({ length: MAX_LABELS + 1 }, (_, i) => `l${i}`).join(',')
    expect(parseLabels(many)).toEqual({ ok: false, error: 'tooMany' })
    const max = Array.from({ length: MAX_LABELS }, (_, i) => `l${i}`).join(',')
    expect(parseLabels(max).ok).toBe(true)
  })
})

describe('fleet patterns mirror the API DTOs', () => {
  it('LABEL_PATTERN', () => {
    expect(LABEL_PATTERN.test('gpu')).toBe(true)
    expect(LABEL_PATTERN.test('Gpu')).toBe(false)
  })

  it('REPO_OWNER_PATTERN allows GitLab subgroups, REPO_NAME_PATTERN does not allow slashes', () => {
    expect(REPO_OWNER_PATTERN.test('group/sub')).toBe(true)
    expect(REPO_OWNER_PATTERN.test('/group')).toBe(false)
    expect(REPO_NAME_PATTERN.test('koda.web')).toBe(true)
    expect(REPO_NAME_PATTERN.test('a/b')).toBe(false)
    expect(REPO_NAME_PATTERN.test('')).toBe(false)
  })
})
```

Create `apps/web/tests/lib/fleet-age.spec.ts`:

```ts
import { describe, expect, it } from '@jest/globals'
import { ageParts } from '~/lib/fleet-age'

const now = new Date('2026-10-01T12:00:00.000Z')
const before = (ms: number) => new Date(now.getTime() - ms).toISOString()

describe('ageParts', () => {
  it('uses the largest whole unit', () => {
    expect(ageParts(before(59_000), now)).toEqual({ n: 59, unit: 's' })
    expect(ageParts(before(60_000), now)).toEqual({ n: 1, unit: 'm' })
    expect(ageParts(before(3 * 3_600_000 + 59 * 60_000), now)).toEqual({ n: 3, unit: 'h' })
    expect(ageParts(before(2 * 86_400_000 + 5), now)).toEqual({ n: 2, unit: 'd' })
  })

  it('reads a future time (clock skew) as 0 s', () => {
    expect(ageParts(new Date(now.getTime() + 5_000).toISOString(), now)).toEqual({ n: 0, unit: 's' })
  })

  it('is null for a missing or unparseable time', () => {
    expect(ageParts(null, now)).toBeNull()
    expect(ageParts(undefined, now)).toBeNull()
    expect(ageParts('', now)).toBeNull()
    expect(ageParts('not a date', now)).toBeNull()
  })
})
```

Create `apps/web/tests/lib/fleet-capabilities.spec.ts`:

```ts
import { describe, expect, it } from '@jest/globals'
import { CREDENTIAL_KINDS, capabilityChips, naxVersion } from '~/lib/fleet-capabilities'

const caps = {
  nax: { version: '0.83.1', protocols: ['native', 'acp'] },
  sandbox: { available: true, probedAt: '2026-10-01T00:00:00Z' },
  profiles: {},
  credentials: [
    { providerId: 'anthropic', available: true, stored: { kind: 'oauth', expires: '2026-11-02T10:00:00Z', expired: false }, ambient: false },
    { providerId: 'openai', available: true, stored: { kind: 'api-key', expired: false }, ambient: false },
    { providerId: 'zai', available: true, stored: { kind: 'oauth', expires: '2026-09-30T00:00:00Z', expired: true }, ambient: false },
    { providerId: 'minimax', available: false, stored: null, exec: 'declined', ambient: false },
    { providerId: 'bedrock', available: true, stored: null, ambient: true },
    { providerId: 'none', available: false, stored: null, ambient: false },
  ],
  tools: { git: true, gh: true, glab: false },
  executors: ['host'],
}

describe('capabilityChips', () => {
  it('lists sandbox, protocols, then one chip per credential with kind, expiry and tone', () => {
    expect(capabilityChips(caps)).toEqual([
      { id: 'sandbox', key: 'fleet.runners.chip.sandboxOn', params: {}, tone: 'ok' },
      { id: 'protocol:native', key: 'fleet.runners.chip.protocol', params: { name: 'native' }, tone: 'ok' },
      { id: 'protocol:acp', key: 'fleet.runners.chip.protocol', params: { name: 'acp' }, tone: 'ok' },
      { id: 'credential:anthropic', key: 'fleet.runners.chip.credentialExpires', params: { provider: 'anthropic', kind: 'oauth', expires: '2026-11-02' }, tone: 'ok' },
      { id: 'credential:openai', key: 'fleet.runners.chip.credential', params: { provider: 'openai', kind: 'api-key' }, tone: 'ok' },
      { id: 'credential:zai', key: 'fleet.runners.chip.credentialExpired', params: { provider: 'zai', kind: 'oauth', expires: '2026-09-30' }, tone: 'warn' },
      { id: 'credential:minimax', key: 'fleet.runners.chip.credential', params: { provider: 'minimax', kind: 'exec' }, tone: 'bad' },
      { id: 'credential:bedrock', key: 'fleet.runners.chip.credential', params: { provider: 'bedrock', kind: 'ambient' }, tone: 'ok' },
      { id: 'credential:none', key: 'fleet.runners.chip.credential', params: { provider: 'none', kind: 'none' }, tone: 'bad' },
    ])
  })

  it('shows an unavailable sandbox as a bad chip', () => {
    expect(capabilityChips({ ...caps, nax: undefined, credentials: [], sandbox: { available: false, probedAt: 'x', error: 'bwrap missing' } }))
      .toEqual([{ id: 'sandbox', key: 'fleet.runners.chip.sandboxOff', params: {}, tone: 'bad' }])
  })

  it('never throws on a malformed report: bad parts yield no chip', () => {
    expect(capabilityChips(null)).toEqual([])
    expect(capabilityChips('x')).toEqual([])
    expect(capabilityChips({})).toEqual([])
    expect(capabilityChips({ sandbox: { available: 'yes' }, nax: { protocols: [1, ''] }, credentials: [null, { providerId: 'p' }, 'x'] })).toEqual([])
  })
})

describe('naxVersion', () => {
  it('reads nax.version or null', () => {
    expect(naxVersion(caps)).toBe('0.83.1')
    expect(naxVersion({})).toBeNull()
    expect(naxVersion({ nax: { version: 3 } })).toBeNull()
  })
})

describe('every chip key exists in both locales', () => {
  const en = require('../../i18n/locales/en.json') as Record<string, unknown>
  const zh = require('../../i18n/locales/zh.json') as Record<string, unknown>
  const has = (tree: Record<string, unknown>, key: string) =>
    typeof key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], tree) === 'string'

  it.each([['en', en], ['zh', zh]])('%s', (_name, tree) => {
    const keys = new Set([
      ...capabilityChips(caps).map((chip) => chip.key),
      ...capabilityChips({ sandbox: { available: false } }).map((chip) => chip.key),
      // The chips component translates params.kind through fleet.runners.chip.kind.<code>.
      ...CREDENTIAL_KINDS.map((kind) => `fleet.runners.chip.kind.${kind}`),
    ])
    expect([...keys].filter((key) => !has(tree as Record<string, unknown>, key))).toEqual([])
  })

  it('every kind a chip can carry is in CREDENTIAL_KINDS', () => {
    const kinds = capabilityChips(caps).flatMap((chip) => (chip.params.kind ? [chip.params.kind] : []))
    expect(kinds.filter((kind) => !(CREDENTIAL_KINDS as readonly string[]).includes(kind))).toEqual([])
  })
})
```

Create `apps/web/tests/lib/fleet-enroll.spec.ts`:

```ts
import { describe, expect, it } from '@jest/globals'
import { enrollCommand } from '~/lib/fleet-enroll'

describe('enrollCommand', () => {
  it('prints the documented enroll line', () => {
    expect(enrollCommand('https://koda.example.com', 'ke_abc')).toBe('koda-runner enroll --server https://koda.example.com --token ke_abc')
  })

  it('drops trailing slashes from the server', () => {
    expect(enrollCommand('https://koda.example.com//', 'ke_abc')).toBe('koda-runner enroll --server https://koda.example.com --token ke_abc')
  })
})
```

Create `apps/web/tests/lib/map-limit.spec.ts`:

```ts
import { describe, expect, it } from '@jest/globals'
import { mapLimit } from '~/lib/map-limit'

describe('mapLimit', () => {
  it('visits every item once, with at most `limit` in flight', async () => {
    let inFlight = 0
    let peak = 0
    const seen: number[] = []
    await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      seen.push(n)
      inFlight -= 1
    })
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5])
    expect(peak).toBe(2)
  })

  it('keeps going after a rejection', async () => {
    const seen: number[] = []
    await mapLimit([1, 2, 3], 1, async (n) => {
      seen.push(n)
      if (n === 1) throw new Error('x')
    })
    expect(seen).toEqual([1, 2, 3])
  })

  it('does nothing for no items, and treats a limit below 1 as 1', async () => {
    await expect(mapLimit([], 4, async () => undefined)).resolves.toBeUndefined()
    const seen: number[] = []
    await mapLimit([1, 2], 0, async (n) => { seen.push(n) })
    expect(seen).toEqual([1, 2])
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd apps/web && npx jest tests/lib/fleet-validation.spec.ts tests/lib/fleet-age.spec.ts tests/lib/fleet-capabilities.spec.ts tests/lib/fleet-enroll.spec.ts tests/lib/map-limit.spec.ts`
Expected: FAIL, "Cannot find module '~/lib/fleet-validation'" (and the others).

- [ ] **Step 3: Write `apps/web/lib/fleet-types.ts`**

```ts
/**
 * Fleet S1 wire types for the web (hand-written: the web has no generated client).
 * Shapes follow docs/superpowers/plans/2026-10-01-fleet-s1-slice-4-overview.md.
 */

/** Page envelope of every fleet list (`toPageResult`). */
export interface FleetPage<T> {
  records: T[]
  total: number
  current: number
  size: number
  hasNext: boolean
  hasPrev: boolean
}

/** Runner and repo lists ask for one page of this size (plan D125). */
export const FLEET_LIST_SIZE = 100

export type FleetProtocol = 'acp' | 'native'

export interface FleetProfileNeeds {
  protocol: FleetProtocol
  providers: string[]
  sandbox: boolean
}

export interface FleetCredentialStored {
  kind: 'api-key' | 'oauth'
  expires?: string
  expired: boolean
}

export interface FleetCredential {
  providerId: string
  available: boolean
  stored: FleetCredentialStored | null
  exec?: 'served' | 'declined' | 'error'
  ambient: boolean
}

/** `RunnerCapabilities` from packages/fleet-protocol; on the wire it is an untyped object. */
export interface FleetCapabilities {
  nax: { version: string; protocols: FleetProtocol[] }
  sandbox: { available: boolean; probedAt: string; error?: string }
  profiles: Record<string, FleetProfileNeeds>
  credentials: FleetCredential[]
  tools: { git: boolean; gh: boolean; glab: boolean }
  executors: string[]
}

export interface FleetRunner {
  id: string
  name: string
  os: string
  arch: string
  labels: string[]
  capacity: number
  capabilities: Record<string, unknown>
  daemonVersion: string
  protocolVersion: number
  enabled: boolean
  lastSeenAt: string
  createdAt: string
  bootId: string
  bootedAt: string | null
  online: boolean
}

export interface FleetRunnerPatch {
  enabled?: boolean
  labels?: string[]
  capacity?: number
}

export interface FleetEnrollment {
  id: string
  labels: string[]
  expiresAt: string
  usedAt: string | null
  runnerId: string | null
  createdById: string
  createdAt: string
}

export interface FleetEnrollmentCreated extends FleetEnrollment {
  token: string
}

/** Project-member view of a runner (GET /projects/:slug/fleet/runners). */
export interface FleetRunnerSummary {
  id: string
  name: string
  os: string
  arch: string
  labels: string[]
  enabled: boolean
  online: boolean
  profiles: string[]
}

export type FleetProvider = 'github' | 'gitlab'

export interface FleetRepo {
  id: string
  projectId: string
  provider: FleetProvider
  owner: string
  name: string
  defaultBranch: string
  githubInstallationId: string | null
  createdAt: string
}

export interface NewFleetRepo {
  projectSlug: string
  provider: FleetProvider
  owner: string
  name: string
}

export interface FleetRepoCheck {
  repoId: string
  reachable: boolean
  reason: string | null
  checkedAt: string
}
```

- [ ] **Step 4: Write `apps/web/lib/fleet-validation.ts`**

```ts
/** Client-side copies of the API's fleet input rules, so a form fails before the request. */

/** apps/api/src/fleet/common LABEL_PATTERN; at most MAX_LABELS per runner or enrollment. */
export const LABEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/
export const MAX_LABELS = 20
export const CAPACITY_MIN = 1
export const CAPACITY_MAX = 16
/** CreateFleetRepoDto owner and name rules. */
export const REPO_OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/
export const REPO_NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/

export type LabelParse =
  | { ok: true; labels: string[] }
  | { ok: false; error: 'invalid'; label: string }
  | { ok: false; error: 'tooMany' }

/**
 * Splits a comma- or space-separated label list, trims, drops empties, de-duplicates
 * and sorts (the server sorts too). No case folding: an upper-case label is reported,
 * not silently changed.
 */
export function parseLabels(input: string): LabelParse {
  const labels = [...new Set(input.split(/[\s,]+/).map((part) => part.trim()).filter((part) => part !== ''))].sort()
  const bad = labels.find((label) => !LABEL_PATTERN.test(label))
  if (bad !== undefined) return { ok: false, error: 'invalid', label: bad }
  if (labels.length > MAX_LABELS) return { ok: false, error: 'tooMany' }
  return { ok: true, labels }
}
```

- [ ] **Step 5: Write `apps/web/lib/fleet-age.ts`**

```ts
export type AgeUnit = 's' | 'm' | 'h' | 'd'

export interface AgeParts {
  n: number
  unit: AgeUnit
}

const STEPS: ReadonlyArray<{ unit: AgeUnit; ms: number }> = [
  { unit: 'd', ms: 86_400_000 },
  { unit: 'h', ms: 3_600_000 },
  { unit: 'm', ms: 60_000 },
]

/**
 * Coarse age of `fromIso` at `now`, in the largest whole unit (59 s, 3 m, 5 h, 2 d).
 * Null for a missing or unparseable time. A time in the future (clock skew between
 * the API and the browser) reads as 0 s.
 */
export function ageParts(fromIso: string | null | undefined, now: Date): AgeParts | null {
  if (!fromIso) return null
  const from = Date.parse(fromIso)
  if (Number.isNaN(from)) return null
  const elapsed = Math.max(0, now.getTime() - from)
  const step = STEPS.find((s) => elapsed >= s.ms)
  return step ? { n: Math.floor(elapsed / step.ms), unit: step.unit } : { n: Math.floor(elapsed / 1000), unit: 's' }
}
```

- [ ] **Step 6: Write `apps/web/lib/fleet-capabilities.ts`**

```ts
import type { FleetCredential } from '~/lib/fleet-types'

export type ChipTone = 'ok' | 'warn' | 'bad'

/** How nax serves a provider; each code has a label under fleet.runners.chip.kind. */
export const CREDENTIAL_KINDS = ['api-key', 'oauth', 'exec', 'ambient', 'none'] as const
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number]

/** One capability chip: an i18n key under fleet.runners.chip, its params, and a tone. */
export interface CapabilityChip {
  id: string
  key: string
  params: Record<string, string>
  tone: ChipTone
}

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

function sandboxChip(raw: unknown): CapabilityChip[] {
  if (!isObj(raw) || typeof raw.available !== 'boolean') return []
  return raw.available
    ? [{ id: 'sandbox', key: 'fleet.runners.chip.sandboxOn', params: {}, tone: 'ok' }]
    : [{ id: 'sandbox', key: 'fleet.runners.chip.sandboxOff', params: {}, tone: 'bad' }]
}

function protocolChips(raw: unknown): CapabilityChip[] {
  if (!isObj(raw) || !Array.isArray(raw.protocols)) return []
  return raw.protocols
    .filter((p): p is string => typeof p === 'string' && p !== '')
    .map((name) => ({ id: `protocol:${name}`, key: 'fleet.runners.chip.protocol', params: { name }, tone: 'ok' as const }))
}

/** How nax serves the provider: the stored kind, else exec, else ambient, else none. */
function credentialKind(c: Pick<FleetCredential, 'stored' | 'exec' | 'ambient'>): CredentialKind {
  if (c.stored) return c.stored.kind
  if (c.exec) return 'exec'
  return c.ambient ? 'ambient' : 'none'
}

function credentialChip(raw: unknown): CapabilityChip[] {
  if (!isObj(raw)) return []
  const provider = str(raw.providerId)
  if (!provider || typeof raw.available !== 'boolean') return []
  const stored = isObj(raw.stored) ? raw.stored : null
  const kind = credentialKind({
    stored: stored && (stored.kind === 'api-key' || stored.kind === 'oauth') ? { kind: stored.kind, expired: stored.expired === true } : null,
    exec: raw.exec === 'served' || raw.exec === 'declined' || raw.exec === 'error' ? raw.exec : undefined,
    ambient: raw.ambient === true,
  })
  const expires = stored ? str(stored.expires) : undefined
  const expired = stored?.expired === true
  const tone: ChipTone = !raw.available ? 'bad' : expired ? 'warn' : 'ok'
  if (!expires) return [{ id: `credential:${provider}`, key: 'fleet.runners.chip.credential', params: { provider, kind }, tone }]
  // An expired credential says so in words, not only by the chip's tone (review 4b).
  const key = expired ? 'fleet.runners.chip.credentialExpired' : 'fleet.runners.chip.credentialExpires'
  return [{ id: `credential:${provider}`, key, params: { provider, kind, expires: expires.slice(0, 10) }, tone }]
}

/**
 * Chips for the Runners table from a runner's `capabilities` (S1 spec §11: sandbox,
 * protocols, credential kinds and expiry). The wire type is an untyped object, so every
 * field is checked; anything malformed yields no chip rather than a crash.
 */
export function capabilityChips(capabilities: unknown): CapabilityChip[] {
  if (!isObj(capabilities)) return []
  const credentials = Array.isArray(capabilities.credentials) ? capabilities.credentials : []
  return [
    ...sandboxChip(capabilities.sandbox),
    ...protocolChips(capabilities.nax),
    ...credentials.flatMap(credentialChip),
  ]
}

/** The nax version the runner reported, or null. */
export function naxVersion(capabilities: unknown): string | null {
  if (!isObj(capabilities) || !isObj(capabilities.nax)) return null
  return str(capabilities.nax.version) ?? null
}
```

- [ ] **Step 7: Write `apps/web/lib/fleet-enroll.ts` and `apps/web/lib/map-limit.ts`**

```ts
/**
 * The command an operator runs on the new machine (docs/deployment/runner.md, "Enroll").
 * `server` is the koda origin the runner will reach; the page passes its own origin (plan D136).
 */
export function enrollCommand(server: string, token: string): string {
  return `koda-runner enroll --server ${server.replace(/\/+$/, '')} --token ${token}`
}
```

```ts
/**
 * Runs `fn` over `items` with at most `limit` calls in flight. Resolves when all have
 * settled; a rejected call does not stop the others (callers record their own errors).
 */
export async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const width = Math.max(1, Math.min(limit, items.length))
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next]
      next += 1
      await fn(item).catch(() => undefined)
    }
  }
  await Promise.all(Array.from({ length: width }, worker))
}
```

- [ ] **Step 8: Run the specs**

Run: `cd apps/web && npx jest tests/lib/fleet-validation.spec.ts tests/lib/fleet-age.spec.ts tests/lib/fleet-capabilities.spec.ts tests/lib/fleet-enroll.spec.ts tests/lib/map-limit.spec.ts`
Expected: PASS, 5 suites, 22 tests.

- [ ] **Step 9: Commit**

```bash
git add apps/web/lib/fleet-types.ts apps/web/lib/fleet-validation.ts apps/web/lib/fleet-age.ts apps/web/lib/fleet-capabilities.ts apps/web/lib/fleet-enroll.ts apps/web/lib/map-limit.ts apps/web/tests/lib/fleet-*.spec.ts apps/web/tests/lib/map-limit.spec.ts
git commit -m "feat(web): fleet wire types and pure helpers"
```

---

## Task 3: apiPath guard and the admin fleet composables

**Files:**
- Modify: `apps/web/tests/lib/api-path-guard.spec.ts:10` (add `fleet` to `API_ROOT`) and its self-check block
- Create: `apps/web/composables/useFleetRunners.ts`, `apps/web/composables/useFleetRepos.ts`
- Test: `apps/web/tests/composables/useFleetRunners.spec.ts`, `apps/web/tests/composables/useFleetRepos.spec.ts` (create)

**Interfaces:**
- Consumes: Task 2 types, `FLEET_LIST_SIZE`, `mapLimit`; `useApi()` (`$api.get/post/patch/delete`), `extractApiError` from `~/composables/useApi`, `apiPath` from `~/lib/api-path`.
- Produces:
  - `useFleetRunners()` → `{ runners: Ref<FleetRunner[]>, hasMore: Ref<boolean>, pending: Ref<boolean>, load(): Promise<void>, apply(updated: FleetRunner): void, update(id, patch: FleetRunnerPatch): Promise<FleetRunner>, remove(id): Promise<void>, createEnrollment(labels: readonly string[]): Promise<FleetEnrollmentCreated> }`. `apply` puts a row saved elsewhere (the edit dialog's own instance) into this list and counts as a mutation, so an in-flight poll cannot overwrite it.
  - `useFleetRepos()` → `{ repos, hasMore, pending, checks: Ref<Record<string, RepoCheckState>>, projects: Ref<ProjectOption[]>, load(), loadProjects(), check(id): Promise<void> (never throws), checkAll(), create(input: NewFleetRepo): Promise<FleetRepo>, remove(id) }`; exported `type RepoCheckState`, `interface ProjectOption { id; slug; name }`, `CHECK_CONCURRENCY = 4`.

- [ ] **Step 1: Extend the apiPath guard first**

In `apps/web/tests/lib/api-path-guard.spec.ts`, change line 10 to:

```ts
const API_ROOT = String.raw`(?:api\/)?(?:projects|agents|comments|admin|code-intel|fleet)\/`
```

and in `it('the patterns catch what they are meant to catch', ...)`, after the `CONCAT.test("$api.delete('/agents/' + props.agent.slug)")` line, add:

```ts
    expect(RAW_TEMPLATE.test('$api.patch(`/fleet/runners/${id}`, body)')).toBe(true)
    expect(RAW_TEMPLATE.test('$api.post(apiPath`/fleet/repos/${id}/check`, {})')).toBe(false)
    expect(CONCAT.test("$api.delete('/fleet/' + path)")).toBe(true)
```

(`CONCAT` only matches a literal that ends at the root segment, `'/fleet/' + x`, by design.)

Run: `cd apps/web && npx jest tests/lib/api-path-guard.spec.ts`
Expected: PASS (nothing under `components`, `composables` or `pages` uses `/fleet/` yet).

- [ ] **Step 2: Write the failing composable specs**

Create `apps/web/tests/composables/useFleetRunners.spec.ts`:

```ts
import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { join } from 'path'

const composablePath = join(__dirname, '../..', 'composables', 'useFleetRunners.ts')
const r = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: id, os: 'linux', arch: 'x64', labels: [], capacity: 1, capabilities: {}, daemonVersion: '0.1.0',
  protocolVersion: 1, enabled: true, lastSeenAt: '2026-10-01T00:00:00Z', createdAt: '2026-09-30T00:00:00Z',
  bootId: 'b1', bootedAt: null, online: true, ...over,
})
const pageOf = (records: unknown[], over: Record<string, unknown> = {}) => ({ records, total: records.length, current: 1, size: 100, hasNext: false, hasPrev: false, ...over })

function withApi(api: Record<string, jest.Mock>) {
  (globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
}

describe('useFleetRunners', () => {
  beforeEach(() => { (globalThis as Record<string, unknown>).useApi = undefined })

  test('load asks for one page of 100 and records hasMore', async () => {
    const get = jest.fn(async () => pageOf([r('a')], { total: 101, hasNext: true }))
    withApi({ get })
    const { useFleetRunners } = await import(composablePath)
    const fleet = useFleetRunners()

    await fleet.load()

    expect(get).toHaveBeenCalledWith('/fleet/runners', { query: { size: '100' } })
    expect(fleet.runners.value).toHaveLength(1)
    expect(fleet.hasMore.value).toBe(true)
    expect(fleet.pending.value).toBe(false)
  })

  test('load clears pending when the request fails', async () => {
    const get = jest.fn(async () => { throw new Error('boom') })
    withApi({ get })
    const { useFleetRunners } = await import(composablePath)
    const fleet = useFleetRunners()

    await expect(fleet.load()).rejects.toThrow('boom')
    expect(fleet.pending.value).toBe(false)
  })

  test('update patches and replaces the row without mutating the old array', async () => {
    const get = jest.fn(async () => pageOf([r('a'), r('b')]))
    const patch = jest.fn(async () => r('b', { enabled: false }))
    withApi({ get, patch })
    const { useFleetRunners } = await import(composablePath)
    const fleet = useFleetRunners()
    await fleet.load()
    const before = fleet.runners.value

    await fleet.update('b', { enabled: false })

    expect(patch).toHaveBeenCalledWith('/fleet/runners/b', { enabled: false })
    expect(fleet.runners.value[1].enabled).toBe(false)
    expect(before[1].enabled).toBe(true)
  })

  test('a load that started before a mutation does not overwrite it', async () => {
    let release: (value: unknown) => void = () => undefined
    const get = jest.fn()
      .mockImplementationOnce(async () => pageOf([r('a')]))
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const patch = jest.fn(async () => r('a', { enabled: false }))
    withApi({ get, patch })
    const { useFleetRunners } = await import(composablePath)
    const fleet = useFleetRunners()
    await fleet.load()

    const poll = fleet.load()
    await fleet.update('a', { enabled: false })
    release(pageOf([r('a', { enabled: true })]))
    await poll

    expect(fleet.runners.value[0].enabled).toBe(false)
    expect(fleet.pending.value).toBe(false)
  })

  test('update encodes the id as one path segment', async () => {
    const patch = jest.fn(async () => r('a/b'))
    withApi({ get: jest.fn(), patch })
    const { useFleetRunners } = await import(composablePath)

    await useFleetRunners().update('a/b', { capacity: 2 })

    expect(patch).toHaveBeenCalledWith('/fleet/runners/a%2Fb', { capacity: 2 })
  })

  test('remove deletes and drops the row', async () => {
    const get = jest.fn(async () => pageOf([r('a'), r('b')]))
    const del = jest.fn(async () => ({}))
    withApi({ get, delete: del })
    const { useFleetRunners } = await import(composablePath)
    const fleet = useFleetRunners()
    await fleet.load()

    await fleet.remove('a')

    expect(del).toHaveBeenCalledWith('/fleet/runners/a')
    expect(fleet.runners.value.map((x: { id: string }) => x.id)).toEqual(['b'])
  })

  test('createEnrollment posts the labels and returns the token row', async () => {
    const post = jest.fn(async () => ({ id: 'e1', labels: ['gpu'], token: 'ke_x', expiresAt: '2026-10-02T00:00:00Z' }))
    withApi({ get: jest.fn(), post })
    const { useFleetRunners } = await import(composablePath)

    const created = await useFleetRunners().createEnrollment(['gpu'])

    expect(post).toHaveBeenCalledWith('/fleet/enrollments', { labels: ['gpu'] })
    expect(created.token).toBe('ke_x')
  })
})
```

Create `apps/web/tests/composables/useFleetRepos.spec.ts`:

```ts
import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { join } from 'path'

const composablePath = join(__dirname, '../..', 'composables', 'useFleetRepos.ts')
const repo = (id: string) => ({ id, projectId: 'p1', provider: 'github', owner: 'acme', name: id, defaultBranch: 'main', githubInstallationId: '7', createdAt: '2026-10-01T00:00:00Z' })
const pageOf = (records: unknown[], over: Record<string, unknown> = {}) => ({ records, total: records.length, current: 1, size: 100, hasNext: false, hasPrev: false, ...over })
const ok = (repoId: string) => ({ repoId, reachable: true, reason: null, checkedAt: '2026-10-01T00:00:00Z' })

function withApi(api: Record<string, jest.Mock>) {
  (globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
}

describe('useFleetRepos', () => {
  beforeEach(() => { (globalThis as Record<string, unknown>).useApi = undefined })

  test('load asks for one page of 100', async () => {
    const get = jest.fn(async () => pageOf([repo('a')], { hasNext: true }))
    withApi({ get })
    const { useFleetRepos } = await import(composablePath)
    const fleet = useFleetRepos()

    await fleet.load()

    expect(get).toHaveBeenCalledWith('/fleet/repos', { query: { size: '100' } })
    expect(fleet.repos.value).toHaveLength(1)
    expect(fleet.hasMore.value).toBe(true)
  })

  test('loadProjects keeps id, slug and name', async () => {
    const get = jest.fn(async () => [{ id: 'p1', slug: 'koda', name: 'Koda', key: 'KODA' }])
    withApi({ get })
    const { useFleetRepos } = await import(composablePath)
    const fleet = useFleetRepos()

    await fleet.loadProjects()

    expect(get).toHaveBeenCalledWith('/projects')
    expect(fleet.projects.value).toEqual([{ id: 'p1', slug: 'koda', name: 'Koda' }])
  })

  test('check records checking, then the result; a failed request becomes an error state', async () => {
    const post = jest.fn()
      .mockImplementationOnce(async () => ok('a'))
      .mockImplementationOnce(async () => { throw new Error('network down') })
    withApi({ get: jest.fn(), post })
    const { useFleetRepos } = await import(composablePath)
    const fleet = useFleetRepos()

    const pending = fleet.check('a')
    expect(fleet.checks.value.a).toEqual({ status: 'checking' })
    await pending
    await fleet.check('b')

    expect(post).toHaveBeenNthCalledWith(1, '/fleet/repos/a/check', {})
    expect(fleet.checks.value.a).toEqual({ status: 'done', result: ok('a') })
    expect(fleet.checks.value.b).toEqual({ status: 'error', message: 'network down' })
  })

  test('checkAll checks every loaded repo with at most CHECK_CONCURRENCY in flight', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    let inFlight = 0
    let peak = 0
    const post = jest.fn(async (path: string) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight -= 1
      return ok(path.split('/')[3])
    })
    withApi({ get: jest.fn(async () => pageOf(ids.map(repo))), post })
    const { useFleetRepos, CHECK_CONCURRENCY } = await import(composablePath)
    const fleet = useFleetRepos()
    await fleet.load()

    await fleet.checkAll()

    expect(post).toHaveBeenCalledTimes(ids.length)
    expect(peak).toBeLessThanOrEqual(CHECK_CONCURRENCY)
    expect(Object.keys(fleet.checks.value).sort()).toEqual(ids)
  })

  test('a check still in flight when its repo is removed does not bring its state back', async () => {
    let release: (value: unknown) => void = () => undefined
    const post = jest.fn(() => new Promise((resolve) => { release = resolve }))
    withApi({ get: jest.fn(async () => pageOf([repo('a')])), post, delete: jest.fn(async () => ({})) })
    const { useFleetRepos } = await import(composablePath)
    const fleet = useFleetRepos()
    await fleet.load()

    const checking = fleet.check('a')
    await fleet.remove('a')
    release(ok('a'))
    await checking

    expect(fleet.checks.value).toEqual({})
  })

  test('create posts the body and appends; remove deletes, drops the row and its check', async () => {
    const post = jest.fn()
      .mockImplementationOnce(async () => repo('b'))
      .mockImplementationOnce(async () => ok('a'))
    const del = jest.fn(async () => ({}))
    withApi({ get: jest.fn(async () => pageOf([repo('a')])), post, delete: del })
    const { useFleetRepos } = await import(composablePath)
    const fleet = useFleetRepos()
    await fleet.load()

    await fleet.create({ projectSlug: 'koda', provider: 'github', owner: 'acme', name: 'b' })
    await fleet.check('a')
    await fleet.remove('a')

    expect(post).toHaveBeenNthCalledWith(1, '/fleet/repos', { projectSlug: 'koda', provider: 'github', owner: 'acme', name: 'b' })
    expect(del).toHaveBeenCalledWith('/fleet/repos/a')
    expect(fleet.repos.value.map((x: { id: string }) => x.id)).toEqual(['b'])
    expect(fleet.checks.value).toEqual({})
  })
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `cd apps/web && npx jest tests/composables/useFleetRunners.spec.ts tests/composables/useFleetRepos.spec.ts`
Expected: FAIL, "Cannot find module" for both composables.

- [ ] **Step 4: Write `apps/web/composables/useFleetRunners.ts`**

```ts
import { ref } from 'vue'
import { apiPath } from '~/lib/api-path'
import { FLEET_LIST_SIZE } from '~/lib/fleet-types'
import type { FleetEnrollmentCreated, FleetPage, FleetRunner, FleetRunnerPatch } from '~/lib/fleet-types'

/** Admin Runners page data: one page of FLEET_LIST_SIZE runners (plan D125). */
export function useFleetRunners() {
  const { $api } = useApi()
  const runners = ref<FleetRunner[]>([])
  const hasMore = ref(false)
  const pending = ref(false)
  // Bumped by every successful mutation. A load (a poll) that started before one would carry
  // older rows, so it drops its result; the next poll brings fresh ones.
  let mutations = 0

  async function load(): Promise<void> {
    const started = mutations
    pending.value = true
    try {
      const res = await $api.get<FleetPage<FleetRunner>>('/fleet/runners', { query: { size: String(FLEET_LIST_SIZE) } })
      if (started !== mutations) return
      runners.value = res.records ?? []
      hasMore.value = res.hasNext === true
    } finally {
      pending.value = false
    }
  }

  /** A row saved here or elsewhere (the edit dialog's own instance) replaces the listed one. */
  function apply(updated: FleetRunner): void {
    mutations += 1
    runners.value = runners.value.map((r) => (r.id === updated.id ? updated : r))
  }

  async function update(id: string, patch: FleetRunnerPatch): Promise<FleetRunner> {
    const updated = await $api.patch<FleetRunner>(apiPath`/fleet/runners/${id}`, { ...patch })
    apply(updated)
    return updated
  }

  async function remove(id: string): Promise<void> {
    await $api.delete(apiPath`/fleet/runners/${id}`)
    mutations += 1
    runners.value = runners.value.filter((r) => r.id !== id)
  }

  async function createEnrollment(labels: readonly string[]): Promise<FleetEnrollmentCreated> {
    return $api.post<FleetEnrollmentCreated>('/fleet/enrollments', { labels: [...labels] })
  }

  return { runners, hasMore, pending, load, apply, update, remove, createEnrollment }
}
```

- [ ] **Step 5: Write `apps/web/composables/useFleetRepos.ts`**

```ts
import { ref } from 'vue'
import { apiPath } from '~/lib/api-path'
import { extractApiError } from '~/composables/useApi'
import { mapLimit } from '~/lib/map-limit'
import { FLEET_LIST_SIZE } from '~/lib/fleet-types'
import type { FleetPage, FleetRepo, FleetRepoCheck, NewFleetRepo } from '~/lib/fleet-types'

export type RepoCheckState =
  | { status: 'checking' }
  | { status: 'done'; result: FleetRepoCheck }
  | { status: 'error'; message: string }

export interface ProjectOption {
  id: string
  slug: string
  name: string
}

/** Reachability checks in flight at once (each one calls the forge). */
export const CHECK_CONCURRENCY = 4

/** Admin Repos page data: the registry, its reachability checks, and project options. */
export function useFleetRepos() {
  const { $api } = useApi()
  const repos = ref<FleetRepo[]>([])
  const hasMore = ref(false)
  const pending = ref(false)
  const checks = ref<Record<string, RepoCheckState>>({})
  const projects = ref<ProjectOption[]>([])

  async function load(): Promise<void> {
    pending.value = true
    try {
      const res = await $api.get<FleetPage<FleetRepo>>('/fleet/repos', { query: { size: String(FLEET_LIST_SIZE) } })
      repos.value = res.records ?? []
      hasMore.value = res.hasNext === true
    } finally {
      pending.value = false
    }
  }

  async function loadProjects(): Promise<void> {
    const rows = await $api.get<ProjectOption[]>('/projects')
    projects.value = (rows ?? []).map(({ id, slug, name }) => ({ id, slug, name }))
  }

  // Repos removed while their check was in flight: a late result must not bring the row's state back.
  let removed: ReadonlySet<string> = new Set()

  function setCheck(id: string, state: RepoCheckState): void {
    if (removed.has(id)) return
    checks.value = { ...checks.value, [id]: state }
  }

  /** Never throws: a failed request is recorded as an `error` state for the row. */
  async function check(id: string): Promise<void> {
    setCheck(id, { status: 'checking' })
    try {
      setCheck(id, { status: 'done', result: await $api.post<FleetRepoCheck>(apiPath`/fleet/repos/${id}/check`, {}) })
    } catch (err: unknown) {
      setCheck(id, { status: 'error', message: extractApiError(err) })
    }
  }

  async function checkAll(): Promise<void> {
    await mapLimit(repos.value.map((r) => r.id), CHECK_CONCURRENCY, check)
  }

  async function create(input: NewFleetRepo): Promise<FleetRepo> {
    const created = await $api.post<FleetRepo>('/fleet/repos', { ...input })
    repos.value = [...repos.value, created]
    return created
  }

  async function remove(id: string): Promise<void> {
    await $api.delete(apiPath`/fleet/repos/${id}`)
    removed = new Set([...removed, id])
    repos.value = repos.value.filter((r) => r.id !== id)
    checks.value = Object.fromEntries(Object.entries(checks.value).filter(([key]) => key !== id))
  }

  return { repos, hasMore, pending, checks, projects, load, loadProjects, check, checkAll, create, remove }
}
```

`useApi` stays the Nuxt auto-import (the specs fake it on `globalThis`); only `extractApiError` is imported explicitly, so it does not shadow the fake.

- [ ] **Step 6: Run the specs and the guard**

Run: `cd apps/web && npx jest tests/composables/useFleetRunners.spec.ts tests/composables/useFleetRepos.spec.ts tests/lib/api-path-guard.spec.ts`
Expected: PASS, 3 suites (7 + 6 composable tests, 2 guard tests).

- [ ] **Step 7: Commit**

```bash
git add apps/web/tests/lib/api-path-guard.spec.ts apps/web/composables/useFleetRunners.ts apps/web/composables/useFleetRepos.ts apps/web/tests/composables/useFleetRunners.spec.ts apps/web/tests/composables/useFleetRepos.spec.ts
git commit -m "feat(web): admin fleet composables; apiPath guard covers /fleet"
```

---

## Task 4: Admin sidebar links

**Files:**
- Modify: `apps/web/layouts/default.vue:2` (icon import) and after the `/admin/users` link (line 89)
- Test: `apps/web/tests/layouts/default-fleet-nav.spec.ts` (create)

**Interfaces:**
- Consumes: `nav.fleetRunners`, `nav.fleetRepos` (Task 1); the layout's existing `isGlobalAdmin`, `navLinkClass`, `activeClass`.
- Produces: links to `/admin/fleet/runners` and `/admin/fleet/repos`, admin only. 4c adds the project-scoped fleet link.

- [ ] **Step 1: Write the failing layout spec**

Create `apps/web/tests/layouts/default-fleet-nav.spec.ts`:

```ts
import { describe, test, expect, beforeAll } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const layoutPath = join(__dirname, '../..', 'layouts', 'default.vue')

// Same SSR pattern as tests/layouts/default-slos-nav.spec.ts.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const VueFull = require('vue/dist/vue.cjs.js')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { renderToString } = require('vue/server-renderer')

function extractTemplate(sfcSource: string): string {
  const m = sfcSource.match(/<template>([\s\S]*)<\/template>/)
  if (!m) throw new Error('No template found')
  return m[1]
}

const icon = { render() { return VueFull.h('span', { class: 'icon' }) } }
const stub = (tag: string) => ({ name: `Stub${tag}`, render(this: { $slots: { default?: () => unknown } }) { return VueFull.h('div', {}, this.$slots.default?.()) } })

describe('Fleet admin nav links', () => {
  let layoutTemplate: string

  beforeAll(() => {
    layoutTemplate = extractTemplate(readFileSync(layoutPath, 'utf-8'))
  })

  function render(isGlobalAdmin: boolean): Promise<string> {
    const app = VueFull.createSSRApp({
      template: layoutTemplate,
      setup: () => ({
        t: (key: string) => key,
        auth: { user: { value: { email: 'a@k.t', role: isGlobalAdmin ? 'ADMIN' : 'MEMBER' } }, logout: () => {}, token: { value: 't' } },
        route: { path: '/', params: {} },
        sidebarOpen: { value: true },
        projectSlug: undefined,
        breadcrumbItems: [],
        backTo: '/',
        navLinkClass: 'nav-link',
        activeClass: 'active',
        isGlobalAdmin,
      }),
      components: {
        NuxtLink: {
          name: 'NuxtLink',
          props: { to: [String, Object] },
          render(this: { $props: { to: string }; $slots: { default?: () => unknown } }) {
            return VueFull.h('a', { href: String(this.$props.to) }, this.$slots.default?.())
          },
        },
        Button: stub('Button'), BackButton: stub('BackButton'), AppBreadcrumb: stub('AppBreadcrumb'),
        LanguageSwitcher: stub('LanguageSwitcher'), ThemeSwitcher: stub('ThemeSwitcher'),
        LayoutDashboard: icon, Kanban: icon, Bot: icon, Tag: icon, BookOpen: icon, Clock: icon, Brain: icon,
        Code2: icon, Activity: icon, Users: icon, Server: icon, FolderGit2: icon,
      },
      directives: { show: {} },
    })
    return renderToString(app)
  }

  test('a global admin sees Runners and Repos links with their nav labels', async () => {
    const html = await render(true)
    expect(html.match(/<a href="\/admin\/fleet\/runners"[^>]*>[\s\S]*?<\/a>/)?.[0]).toContain('nav.fleetRunners')
    expect(html.match(/<a href="\/admin\/fleet\/repos"[^>]*>[\s\S]*?<\/a>/)?.[0]).toContain('nav.fleetRepos')
  })

  test('a non-admin does not see them', async () => {
    const html = await render(false)
    expect(html).not.toContain('/admin/fleet/')
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd apps/web && npx jest tests/layouts/default-fleet-nav.spec.ts`
Expected: FAIL on the first test (no `/admin/fleet/runners` link); the second passes.

- [ ] **Step 3: Add the links**

In `apps/web/layouts/default.vue`, change the lucide import to:

```ts
import { LayoutDashboard, Kanban, Bot, Tag, BookOpen, Clock, Brain, Code2, Activity, Users, Server, FolderGit2 } from 'lucide-vue-next'
```

and right after the line `<NuxtLink v-if="isGlobalAdmin" to="/admin/users" ...>...</NuxtLink>` add:

```vue

        <NuxtLink v-if="isGlobalAdmin" to="/admin/fleet/runners" :class="navLinkClass" :active-class="activeClass"><Server class="h-4 w-4 shrink-0" />{{ t('nav.fleetRunners') }}</NuxtLink>

        <NuxtLink v-if="isGlobalAdmin" to="/admin/fleet/repos" :class="navLinkClass" :active-class="activeClass"><FolderGit2 class="h-4 w-4 shrink-0" />{{ t('nav.fleetRepos') }}</NuxtLink>
```

- [ ] **Step 4: Run the layout specs**

Run: `cd apps/web && npx jest tests/layouts`
Expected: PASS, every layout suite (the existing ones render the same template without registering the two new icons; Vue renders an unknown tag there, as it already does for `Users`).

- [ ] **Step 5: Commit**

```bash
git add apps/web/layouts/default.vue apps/web/tests/layouts/default-fleet-nav.spec.ts
git commit -m "feat(web): admin sidebar links to fleet runners and repos"
```

---

## Task 5: Runner components

**Files:**
- Create: `apps/web/components/fleet/Age.vue`, `apps/web/components/fleet/RunnerCapabilityChips.vue`, `apps/web/components/fleet/EnrollmentTokenDialog.vue`, `apps/web/components/fleet/RunnerEditDialog.vue`
- Test: `apps/web/tests/pages/admin-fleet-runners.spec.ts` (create; its "Fleet runner dialogs wiring" block covers this task, the page block covers Task 6)

**Interfaces:**
- Consumes: `ageParts`, `capabilityChips`, `naxVersion`, `ChipTone`, `parseLabels`, `CAPACITY_MIN/MAX`, `enrollCommand`, `FleetRunner`, `FleetEnrollmentCreated` (Task 2); `useFleetRunners().createEnrollment` and `.update` (Task 3).
- Produces (auto-registered with the folder prefix):
  - `<FleetAge :iso="string | null" :now="Date" mode="'ago' | 'duration'" />` (4c uses it for job times).
  - `<FleetRunnerCapabilityChips :capabilities="Record<string, unknown>" />`.
  - `<FleetEnrollmentTokenDialog v-model:open />`.
  - `<FleetRunnerEditDialog v-model:open :runner="FleetRunner" @saved="(runner: FleetRunner) => void" />`.

- [ ] **Step 1: Write the failing wiring spec**

Create `apps/web/tests/pages/admin-fleet-runners.spec.ts`:

```ts
import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const read = (...p: string[]) => readFileSync(join(webDir, ...p), 'utf-8')

describe('Fleet admin Runners page wiring', () => {
  const page = read('pages', 'admin', 'fleet', 'runners.vue')

  test('loads through useFleetRunners and handles the admin-only 403 as ret 40003', () => {
    expect(page).toContain('useFleetRunners()')
    expect(page).toContain('err.code === 40003')
    expect(page).toContain("t('fleet.common.adminOnly')")
  })

  // The timing itself (interval, hidden tab, no overlap, visibility refresh) is pinned by
  // tests/composables/useVisiblePolling.spec.ts; this only checks the page uses it.
  test('polls every 15 s through useVisiblePolling, and stops on unmount and on 403', () => {
    expect(page).toContain('const POLL_MS = 15_000')
    expect(page).toContain('useVisiblePolling(refresh, POLL_MS)')
    expect(page).toContain('onBeforeUnmount(polling.stop)')
    expect(page).toMatch(/adminOnly\.value = true\s+polling\.stop\(\)/)
  })

  test('a failed poll keeps the rows and shows the stale note; only the first load toasts', () => {
    expect(page).toContain('stale.value = true')
    expect(page).toContain("t('fleet.common.stale')")
    expect(page).toContain('if (runners.value.length === 0) toast.error(extractApiError(err))')
  })

  test('shows online, disabled, labels, capacity, capability chips, last seen and boot age', () => {
    expect(page).toContain("runner.online ? t('fleet.common.online') : t('fleet.common.offline')")
    expect(page).toContain('v-if="!runner.enabled"')
    expect(page).toContain('<FleetRunnerCapabilityChips :capabilities="runner.capabilities" />')
    expect(page).toContain('<FleetAge :iso="runner.lastSeenAt" :now="now" mode="ago" />')
    // Uptime only means something while the runner is online (review 4b).
    expect(page).toContain('<FleetAge v-if="runner.online" :iso="runner.bootedAt" :now="now" mode="duration" />')
  })

  test('enable/disable patches, edit opens the dialog, delete asks first', () => {
    expect(page).toContain('update(runner.id, { enabled })')
    expect(page).toContain('<FleetRunnerEditDialog')
    expect(page).toContain("window.confirm(t('fleet.runners.deleteConfirm', { name: runner.name }))")
    expect(page).toContain('<FleetEnrollmentTokenDialog v-model:open="enrollOpen" />')
    // The edit dialog has its own composable instance: the page applies the saved row through its own.
    expect(page).toContain('@saved="apply"')
  })

  test('tells the admin when the list was capped', () => {
    expect(page).toContain("v-if=\"hasMore\"")
    expect(page).toContain("t('fleet.common.more', { n: FLEET_LIST_SIZE })")
  })
})

describe('Fleet runner dialogs wiring', () => {
  test('enrollment dialog posts labels, shows the token once, and forgets it on close', () => {
    const dialog = read('components', 'fleet', 'EnrollmentTokenDialog.vue')
    expect(dialog).toContain('createEnrollment(parsed.labels)')
    expect(dialog).toContain('enrollCommand(window.location.origin, created.value.token)')
    expect(dialog).toContain('navigator.clipboard.writeText(text)')
    expect(dialog).toMatch(/if \(!value\) \{\s+generation \+= 1\s+created\.value = null/)
    expect(dialog).toContain('parseLabels(value)')
  })

  test('enrollment dialog keeps a showing token safe: no silent copy failure, no accidental close, no stale reply', () => {
    const dialog = read('components', 'fleet', 'EnrollmentTokenDialog.vue')
    expect(dialog).toContain("toast.error(t('fleet.common.copyFailed'))")
    expect(dialog).toContain('@interact-outside="guardClose"')
    expect(dialog).toContain('@escape-key-down="guardClose"')
    expect(dialog).toContain('if (created.value) event.preventDefault()')
    expect(dialog).toContain('if (started !== generation) return')
    expect(dialog).toContain('@focus="selectAll"')
  })

  test('capability chips translate the credential kind code, raw when unknown', () => {
    const chips = read('components', 'fleet', 'RunnerCapabilityChips.vue')
    expect(chips).toContain('te(key) ? t(key) : kind')
  })

  test('edit dialog validates labels and capacity, patches both, and reloads its values per runner', () => {
    const dialog = read('components', 'fleet', 'RunnerEditDialog.vue')
    expect(dialog).toContain('update(props.runner.id, { labels: parsed.labels, capacity: values.capacity })')
    expect(dialog).toContain('.min(CAPACITY_MIN')
    expect(dialog).toContain('.max(CAPACITY_MAX')
    expect(dialog).toContain('resetForm({ values: initialValues() })')
    expect(dialog).toContain("emit('saved', saved)")
  })
})
```

- [ ] **Step 2: Run it to see the dialog block fail**

Run: `cd apps/web && npx jest tests/pages/admin-fleet-runners.spec.ts -t "dialogs"`
Expected: FAIL, ENOENT for `components/fleet/EnrollmentTokenDialog.vue`.

- [ ] **Step 3: Write `apps/web/components/fleet/Age.vue`**

```vue
<template>
  <span :title="iso ?? undefined">{{ text }}</span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ageParts } from '~/lib/fleet-age'

/** "3m ago" (mode ago) or "3m" (mode duration) for an ISO time; an em dash when unknown. */
const props = defineProps<{ iso: string | null; now: Date; mode: 'ago' | 'duration' }>()

const { t } = useI18n()

const text = computed(() => {
  const age = ageParts(props.iso, props.now)
  return age ? t(`fleet.common.${props.mode}.${age.unit}`, { n: age.n }) : '—'
})
</script>
```

- [ ] **Step 4: Write `apps/web/components/fleet/RunnerCapabilityChips.vue`**

```vue
<template>
  <div class="flex flex-wrap gap-1">
    <Badge v-for="chip in chips" :key="chip.id" :variant="variantOf(chip.tone)">
      {{ t(chip.key, paramsOf(chip)) }}
    </Badge>
    <span v-if="version" class="text-xs text-muted-foreground">nax {{ version }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { capabilityChips, naxVersion } from '~/lib/fleet-capabilities'
import type { CapabilityChip, ChipTone } from '~/lib/fleet-capabilities'

const props = defineProps<{ capabilities: Record<string, unknown> }>()

const { t, te } = useI18n()

const chips = computed(() => capabilityChips(props.capabilities))
const version = computed(() => naxVersion(props.capabilities))

function variantOf(tone: ChipTone): 'secondary' | 'outline' | 'destructive' {
  if (tone === 'bad') return 'destructive'
  return tone === 'warn' ? 'outline' : 'secondary'
}

/** A credential chip carries its kind as a code: show its label (an unknown code shows raw, plan D126). */
function paramsOf(chip: CapabilityChip): Record<string, string> {
  const kind = chip.params.kind
  if (!kind) return chip.params
  const key = `fleet.runners.chip.kind.${kind}`
  return { ...chip.params, kind: te(key) ? t(key) : kind }
}
</script>
```

- [ ] **Step 5: Write `apps/web/components/fleet/EnrollmentTokenDialog.vue`**

```vue
<template>
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogContent class="sm:max-w-[600px]" @interact-outside="guardClose" @escape-key-down="guardClose">
      <DialogHeader>
        <DialogTitle>{{ t('fleet.runners.enrollment.title') }}</DialogTitle>
      </DialogHeader>

      <form v-if="!created" class="space-y-4" @submit="onSubmit">
        <FormField v-slot="{ componentField }" name="labels">
          <FormItem>
            <FormLabel>{{ t('fleet.runners.enrollment.labels') }}</FormLabel>
            <FormControl><Input v-bind="componentField" placeholder="linux, gpu" /></FormControl>
            <p class="text-xs text-muted-foreground">{{ t('fleet.runners.enrollment.labelsHint') }}</p>
            <FormMessage />
          </FormItem>
        </FormField>
        <div class="flex justify-end gap-2">
          <Button type="button" variant="outline" @click="onOpenChange(false)">{{ t('common.cancel') }}</Button>
          <Button type="submit" :disabled="isSubmitting">
            {{ isSubmitting ? t('fleet.runners.enrollment.submitting') : t('fleet.runners.enrollment.submit') }}
          </Button>
        </div>
      </form>

      <div v-else class="space-y-4">
        <p class="text-sm text-muted-foreground">
          {{ t('fleet.runners.enrollment.tokenOnce', { expiresAt: new Date(created.expiresAt).toLocaleString() }) }}
        </p>
        <div class="space-y-1">
          <Label>{{ t('fleet.runners.enrollment.token') }}</Label>
          <div class="flex gap-2">
            <Input :value="created.token" readonly class="flex-1 font-mono text-sm" data-testid="enrollment-token" @focus="selectAll" />
            <Button type="button" variant="outline" @click="copy(created.token, 'token')">{{ copied === 'token' ? t('fleet.common.copied') : t('fleet.common.copy') }}</Button>
          </div>
        </div>
        <div class="space-y-1">
          <Label>{{ t('fleet.runners.enrollment.command') }}</Label>
          <div class="flex gap-2">
            <pre class="flex-1 select-all overflow-x-auto rounded-md border border-border bg-muted p-2 font-mono text-xs">{{ command }}</pre>
            <Button type="button" variant="outline" @click="copy(command, 'command')">{{ copied === 'command' ? t('fleet.common.copied') : t('fleet.common.copy') }}</Button>
          </div>
          <p class="text-xs text-muted-foreground">{{ t('fleet.runners.enrollment.commandHint') }}</p>
        </div>
        <div class="flex justify-end">
          <Button type="button" @click="onOpenChange(false)">{{ t('common.done') }}</Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import * as z from 'zod'
import { extractApiError } from '~/composables/useApi'
import { parseLabels } from '~/lib/fleet-validation'
import { enrollCommand } from '~/lib/fleet-enroll'
import type { FleetEnrollmentCreated } from '~/lib/fleet-types'

defineProps<{ open: boolean }>()

const emit = defineEmits<{ (e: 'update:open', value: boolean): void }>()

const { t } = useI18n()
const toast = useAppToast()
const { createEnrollment } = useFleetRunners()

const created = ref<FleetEnrollmentCreated | null>(null)
const copied = ref<'token' | 'command' | null>(null)
// Bumped on every close: a token request that answers after the dialog closed must not
// reappear when it is opened again.
let generation = 0

const formSchema = toTypedSchema(z.object({
  labels: z.string().superRefine((value, ctx) => {
    const parsed = parseLabels(value)
    if (parsed.ok) return
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: parsed.error === 'tooMany' ? t('fleet.validation.labelsTooMany') : t('fleet.validation.labelInvalid', { label: parsed.label }),
    })
  }),
}))

const { handleSubmit, isSubmitting, resetForm } = useForm({ validationSchema: formSchema, initialValues: { labels: '' } })

const command = computed(() => (created.value ? enrollCommand(window.location.origin, created.value.token) : ''))

const onSubmit = handleSubmit(async (values) => {
  const parsed = parseLabels(values.labels)
  if (!parsed.ok) return
  const started = generation
  try {
    const result = await createEnrollment(parsed.labels)
    if (started !== generation) return
    created.value = result
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  }
})

/** navigator.clipboard is undefined on a plain-http origin (the VPN phase): say so, the text stays selectable. */
async function copy(text: string, which: 'token' | 'command'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    copied.value = which
  } catch {
    toast.error(t('fleet.common.copyFailed'))
  }
}

function selectAll(event: FocusEvent): void {
  (event.target as HTMLInputElement | null)?.select()
}

/** While a token is showing, only Done closes the dialog: Esc or an outside click would lose it. */
function guardClose(event: Event): void {
  if (created.value) event.preventDefault()
}

/** Closing forgets the token: it is shown once (S1 spec §11). */
function onOpenChange(value: boolean): void {
  if (!value) {
    generation += 1
    created.value = null
    copied.value = null
    resetForm()
  }
  emit('update:open', value)
}
</script>
```

- [ ] **Step 6: Write `apps/web/components/fleet/RunnerEditDialog.vue`**

```vue
<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent class="sm:max-w-[500px]">
      <DialogHeader>
        <DialogTitle>{{ t('fleet.runners.edit.title', { name: runner.name }) }}</DialogTitle>
      </DialogHeader>

      <form class="space-y-4" @submit="onSubmit">
        <FormField v-slot="{ componentField }" name="labels">
          <FormItem>
            <FormLabel>{{ t('fleet.runners.edit.labels') }}</FormLabel>
            <FormControl><Input v-bind="componentField" /></FormControl>
            <p class="text-xs text-muted-foreground">{{ t('fleet.runners.edit.labelsHint') }}</p>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField v-slot="{ componentField }" name="capacity">
          <FormItem>
            <FormLabel>{{ t('fleet.runners.edit.capacity') }}</FormLabel>
            <FormControl><Input type="number" :min="CAPACITY_MIN" :max="CAPACITY_MAX" v-bind="componentField" /></FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <div class="flex justify-end gap-2">
          <Button type="button" variant="outline" @click="$emit('update:open', false)">{{ t('common.cancel') }}</Button>
          <Button type="submit" :disabled="isSubmitting">
            {{ isSubmitting ? t('fleet.runners.edit.submitting') : t('fleet.runners.edit.submit') }}
          </Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { watch } from 'vue'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import * as z from 'zod'
import { extractApiError } from '~/composables/useApi'
import { CAPACITY_MAX, CAPACITY_MIN, parseLabels } from '~/lib/fleet-validation'
import type { FleetRunner } from '~/lib/fleet-types'

const props = defineProps<{ open: boolean; runner: FleetRunner }>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'saved', runner: FleetRunner): void
}>()

const { t } = useI18n()
const toast = useAppToast()
const { update } = useFleetRunners()

const formSchema = toTypedSchema(z.object({
  labels: z.string().superRefine((value, ctx) => {
    const parsed = parseLabels(value)
    if (parsed.ok) return
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: parsed.error === 'tooMany' ? t('fleet.validation.labelsTooMany') : t('fleet.validation.labelInvalid', { label: parsed.label }),
    })
  }),
  capacity: z.coerce.number({ invalid_type_error: t('fleet.validation.capacityRange') })
    .int(t('fleet.validation.capacityRange'))
    .min(CAPACITY_MIN, t('fleet.validation.capacityRange'))
    .max(CAPACITY_MAX, t('fleet.validation.capacityRange')),
}))

const initialValues = () => ({ labels: props.runner.labels.join(', '), capacity: props.runner.capacity })

const { handleSubmit, isSubmitting, resetForm } = useForm({ validationSchema: formSchema, initialValues: initialValues() })

// The dialog is reused across rows: reload the values whenever it opens for a runner.
watch(() => [props.open, props.runner.id] as const, ([open]) => {
  if (open) resetForm({ values: initialValues() })
})

const onSubmit = handleSubmit(async (values) => {
  const parsed = parseLabels(values.labels)
  if (!parsed.ok) return
  try {
    const saved = await update(props.runner.id, { labels: parsed.labels, capacity: values.capacity })
    toast.success(t('fleet.runners.toast.updated'))
    emit('saved', saved)
    emit('update:open', false)
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  }
})
</script>
```

- [ ] **Step 7: Run the dialog block**

Run: `cd apps/web && npx jest tests/pages/admin-fleet-runners.spec.ts -t "dialogs"`
Expected: PASS, 4 tests (the page block is skipped by `-t`; it fails until Task 6).

- [ ] **Step 8: Commit**

```bash
git add apps/web/components/fleet/Age.vue apps/web/components/fleet/RunnerCapabilityChips.vue apps/web/components/fleet/EnrollmentTokenDialog.vue apps/web/components/fleet/RunnerEditDialog.vue apps/web/tests/pages/admin-fleet-runners.spec.ts
git commit -m "feat(web): fleet runner components (age, capability chips, enrollment and edit dialogs)"
```

---

## Task 6: Runners page

**Files:**
- Create: `apps/web/composables/useVisiblePolling.ts`, `apps/web/pages/admin/fleet/runners.vue`
- Test: `apps/web/tests/composables/useVisiblePolling.spec.ts` (create); `apps/web/tests/pages/admin-fleet-runners.spec.ts` (page block, written in Task 5)

**Interfaces:**
- Consumes: `useFleetRunners()` (Task 3, including `apply`), the Task 5 components, `FLEET_LIST_SIZE`, `ApiError`, `extractApiError`.
- Produces: route `/admin/fleet/runners`; `useVisiblePolling(task: () => Promise<void>, ms: number, deps?: PollingDeps) → { start(), stop(), runNow(): Promise<void>, isActive(): boolean }`, `interface PollingDeps { isHidden; setInterval; clearInterval; onVisible }`, `browserPollingDeps(): PollingDeps` (4c may reuse it).

- [ ] **Step 1: Write the failing polling spec**

The polling rules are behaviour, so they get a real test with fake timers and injected browser hooks, not source strings. Create `apps/web/tests/composables/useVisiblePolling.spec.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals'
import { useVisiblePolling } from '~/composables/useVisiblePolling'
import type { PollingDeps } from '~/composables/useVisiblePolling'

function fakeBrowser(hidden: boolean) {
  const state = { hidden, onVisible: null as (() => void) | null }
  const deps: PollingDeps = {
    isHidden: () => state.hidden,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    onVisible: (fn) => {
      state.onVisible = fn
      return () => { state.onVisible = null }
    },
  }
  return { state, deps }
}

describe('useVisiblePolling', () => {
  beforeEach(() => { jest.useFakeTimers() })
  afterEach(() => { jest.useRealTimers() })

  test('runs the task once per interval while the tab is visible', async () => {
    const task = jest.fn(async () => undefined)
    const polling = useVisiblePolling(task, 15_000, fakeBrowser(false).deps)

    polling.start()
    await jest.advanceTimersByTimeAsync(45_000)

    expect(task).toHaveBeenCalledTimes(3)
  })

  test('skips ticks while hidden and runs at once when the tab becomes visible', async () => {
    const task = jest.fn(async () => undefined)
    const browser = fakeBrowser(true)
    const polling = useVisiblePolling(task, 15_000, browser.deps)

    polling.start()
    await jest.advanceTimersByTimeAsync(45_000)
    expect(task).not.toHaveBeenCalled()

    browser.state.hidden = false
    browser.state.onVisible?.()
    await jest.advanceTimersByTimeAsync(0)
    expect(task).toHaveBeenCalledTimes(1)
  })

  test('stop halts the timer and drops the visibility listener', async () => {
    const task = jest.fn(async () => undefined)
    const browser = fakeBrowser(false)
    const polling = useVisiblePolling(task, 15_000, browser.deps)

    polling.start()
    await jest.advanceTimersByTimeAsync(15_000)
    polling.stop()
    await jest.advanceTimersByTimeAsync(45_000)

    expect(task).toHaveBeenCalledTimes(1)
    expect(browser.state.onVisible).toBeNull()
    expect(polling.isActive()).toBe(false)
  })

  test('a rejected run does not stop the polling', async () => {
    const task = jest.fn(async () => { throw new Error('API down') })
    const polling = useVisiblePolling(task, 15_000, fakeBrowser(false).deps)

    polling.start()
    await jest.advanceTimersByTimeAsync(30_000)

    expect(task).toHaveBeenCalledTimes(2)
  })

  test('never overlaps: ticks and runNow during a slow run are skipped', async () => {
    let release: () => void = () => undefined
    const task = jest.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const polling = useVisiblePolling(task, 15_000, fakeBrowser(false).deps)

    polling.start()
    polling.start() // idempotent: still one timer
    await jest.advanceTimersByTimeAsync(15_000)
    await polling.runNow()
    await jest.advanceTimersByTimeAsync(30_000)
    expect(task).toHaveBeenCalledTimes(1)

    release()
    await jest.advanceTimersByTimeAsync(15_000)
    expect(task).toHaveBeenCalledTimes(2)
  })
})
```

`await polling.runNow()` resolves at once here because a run is in flight (it returns without waiting).

- [ ] **Step 2: Run it to see it fail**

Run: `cd apps/web && npx jest tests/composables/useVisiblePolling.spec.ts`
Expected: FAIL, "Cannot find module '~/composables/useVisiblePolling'".

- [ ] **Step 3: Write `apps/web/composables/useVisiblePolling.ts`**

```ts
/** What the poller needs from the browser; injected so the timing is testable with fake timers. */
export interface PollingDeps {
  isHidden: () => boolean
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
  /** Calls `fn` whenever the tab becomes visible; returns the unsubscribe. */
  onVisible: (fn: () => void) => () => void
}

/** The real browser hooks. Only touched on the client (start runs in onMounted). */
export function browserPollingDeps(): PollingDeps {
  return {
    isHidden: () => document.visibilityState === 'hidden',
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (handle) => window.clearInterval(handle as number),
    onVisible: (fn) => {
      const listener = (): void => {
        if (document.visibilityState === 'visible') fn()
      }
      document.addEventListener('visibilitychange', listener)
      return () => document.removeEventListener('visibilitychange', listener)
    },
  }
}

/**
 * Runs `task` every `ms` while the tab is visible (S1 spec §1: the Runners page polls every 15 s).
 * At most one run at a time: a tick or runNow during a run is skipped. A rejected run never stops
 * the polling (the task reports its own errors). The tab becoming visible again runs it at once.
 */
export function useVisiblePolling(task: () => Promise<void>, ms: number, deps: PollingDeps = browserPollingDeps()) {
  let handle: unknown = null
  let unsubscribe: (() => void) | null = null
  let running = false

  async function runNow(): Promise<void> {
    if (running) return
    running = true
    try {
      await task()
    } catch {
      // The task owns its error reporting (toast, stale note); polling carries on.
    } finally {
      running = false
    }
  }

  function tick(): void {
    if (!deps.isHidden()) void runNow()
  }

  function start(): void {
    if (handle !== null) return
    handle = deps.setInterval(tick, ms)
    unsubscribe = deps.onVisible(tick)
  }

  function stop(): void {
    if (handle !== null) deps.clearInterval(handle)
    handle = null
    unsubscribe?.()
    unsubscribe = null
  }

  return { start, stop, runNow, isActive: () => handle !== null }
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `cd apps/web && npx jest tests/composables/useVisiblePolling.spec.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run the page block to see it fail**

Run: `cd apps/web && npx jest tests/pages/admin-fleet-runners.spec.ts -t "Runners page"`
Expected: FAIL, ENOENT for `pages/admin/fleet/runners.vue`.

- [ ] **Step 6: Write `apps/web/pages/admin/fleet/runners.vue`**

```vue
<script setup lang="ts">
import { KeyRound } from 'lucide-vue-next'
import { ApiError, extractApiError } from '~/composables/useApi'
import { FLEET_LIST_SIZE } from '~/lib/fleet-types'
import type { FleetRunner } from '~/lib/fleet-types'

definePageMeta({ layout: 'default' })

/** S1 spec §1: the Runners page is not project-scoped, so it polls instead of using SSE. */
const POLL_MS = 15_000

const { t } = useI18n()
const toast = useAppToast()
const { runners, hasMore, pending, load, apply, update, remove } = useFleetRunners()

const adminOnly = ref(false)
const stale = ref(false)
const now = ref(new Date())
const enrollOpen = ref(false)
const editOpen = ref(false)
const editing = ref<FleetRunner | null>(null)

// ApiError.code is the envelope `ret`: a 403 arrives as ret 40003 (see pages/admin/users.vue).
function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && (err.code === 40003 || err.code === 403)
}

async function refresh(): Promise<void> {
  try {
    await load()
    stale.value = false
  } catch (err: unknown) {
    if (isForbidden(err)) {
      adminOnly.value = true
      polling.stop()
      return
    }
    // The first load reports; a failed poll keeps the last rows and marks them stale.
    if (runners.value.length === 0) toast.error(extractApiError(err))
    stale.value = true
  } finally {
    now.value = new Date()
  }
}

// Declared after refresh, which it runs; refresh only reaches `polling` when it is called.
const polling = useVisiblePolling(refresh, POLL_MS)

async function setEnabled(runner: FleetRunner, enabled: boolean): Promise<void> {
  try {
    await update(runner.id, { enabled })
    toast.success(t(enabled ? 'fleet.runners.toast.enabled' : 'fleet.runners.toast.disabled'))
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  }
}

function openEdit(runner: FleetRunner): void {
  editing.value = runner
  editOpen.value = true
}

async function confirmDelete(runner: FleetRunner): Promise<void> {
  if (!window.confirm(t('fleet.runners.deleteConfirm', { name: runner.name }))) return
  try {
    await remove(runner.id)
    toast.success(t('fleet.runners.toast.deleted'))
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  }
}

onMounted(() => {
  void polling.runNow()
  polling.start()
})
onBeforeUnmount(polling.stop)
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('fleet.runners.title')" :subtitle="t('fleet.runners.subtitle')">
      <template #actions>
        <Button :disabled="adminOnly" @click="enrollOpen = true">
          <KeyRound class="mr-2 h-4 w-4" />{{ t('fleet.runners.actions.enroll') }}
        </Button>
      </template>
    </PageHeader>

    <p v-if="adminOnly" class="text-sm text-muted-foreground">{{ t('fleet.common.adminOnly') }}</p>

    <template v-else>
      <p v-if="stale" class="text-sm text-muted-foreground">{{ t('fleet.common.stale') }}</p>
      <LoadingState v-if="pending && runners.length === 0" />
      <EmptyState v-else-if="runners.length === 0" :message="t('fleet.runners.empty')" />
      <Table v-else>
        <TableHeader>
          <TableRow>
            <TableHead>{{ t('fleet.runners.table.name') }}</TableHead>
            <TableHead>{{ t('fleet.runners.table.status') }}</TableHead>
            <TableHead>{{ t('fleet.runners.table.labels') }}</TableHead>
            <TableHead>{{ t('fleet.runners.table.capacity') }}</TableHead>
            <TableHead>{{ t('fleet.runners.table.capabilities') }}</TableHead>
            <TableHead>{{ t('fleet.runners.table.lastSeen') }}</TableHead>
            <TableHead>{{ t('fleet.runners.table.boot') }}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="runner in runners" :key="runner.id" :data-testid="`fleet-runner-${runner.name}`">
            <TableCell>
              <div class="font-medium">{{ runner.name }}</div>
              <div class="text-xs text-muted-foreground">{{ runner.os }}/{{ runner.arch }} · {{ t('fleet.runners.table.version') }} {{ runner.daemonVersion }}</div>
            </TableCell>
            <TableCell class="space-x-1">
              <Badge :variant="runner.online ? 'secondary' : 'outline'">{{ runner.online ? t('fleet.common.online') : t('fleet.common.offline') }}</Badge>
              <Badge v-if="!runner.enabled" variant="destructive">{{ t('fleet.common.disabled') }}</Badge>
            </TableCell>
            <TableCell>
              <div class="flex flex-wrap gap-1">
                <Badge v-for="label in runner.labels" :key="label" variant="outline">{{ label }}</Badge>
              </div>
            </TableCell>
            <TableCell>{{ runner.capacity }}</TableCell>
            <TableCell><FleetRunnerCapabilityChips :capabilities="runner.capabilities" /></TableCell>
            <TableCell><FleetAge :iso="runner.lastSeenAt" :now="now" mode="ago" /></TableCell>
            <TableCell>
              <FleetAge v-if="runner.online" :iso="runner.bootedAt" :now="now" mode="duration" />
              <span v-else class="text-muted-foreground">—</span>
            </TableCell>
            <TableCell class="space-x-1 whitespace-nowrap text-right">
              <Button size="sm" variant="outline" @click="setEnabled(runner, !runner.enabled)">
                {{ runner.enabled ? t('fleet.runners.actions.disable') : t('fleet.runners.actions.enable') }}
              </Button>
              <Button size="sm" variant="outline" @click="openEdit(runner)">{{ t('fleet.runners.actions.edit') }}</Button>
              <Button size="sm" variant="destructive" @click="confirmDelete(runner)">{{ t('fleet.runners.actions.delete') }}</Button>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <p v-if="hasMore" class="text-sm text-muted-foreground">{{ t('fleet.common.more', { n: FLEET_LIST_SIZE }) }}</p>
    </template>

    <FleetEnrollmentTokenDialog v-model:open="enrollOpen" />
    <FleetRunnerEditDialog v-if="editing" v-model:open="editOpen" :runner="editing" @saved="apply" />
  </div>
</template>
```

Notes for the implementer: `refresh()` reports its own errors (toast on the first load, stale note on a poll, admin-only on a 403), and `useVisiblePolling` keeps polling after a rejected run anyway; `now` is bumped after every poll so the ages in the table move with the data; an offline runner shows a dash for uptime (its daemon may be long gone); `@saved="apply"` puts the edit dialog's saved row into this page's list as a mutation, so a poll already in flight cannot overwrite it.

- [ ] **Step 7: Run the whole spec**

Run: `cd apps/web && npx jest tests/pages/admin-fleet-runners.spec.ts tests/composables/useVisiblePolling.spec.ts`
Expected: PASS, 15 tests (10 wiring, 5 polling).

- [ ] **Step 8: Type-check**

Run: `cd apps/web && bun run type-check`
Expected: exit 0, no `error TS` lines. (Verified while writing this plan: a deliberate `{ enabled: 3 }` in this page fails type-check with TS2322, so the check does cover these files.)

- [ ] **Step 9: Commit**

```bash
git add apps/web/composables/useVisiblePolling.ts apps/web/tests/composables/useVisiblePolling.spec.ts apps/web/pages/admin/fleet/runners.vue
git commit -m "feat(web): admin fleet Runners page with 15 s visible-tab polling"
```

---

## Task 7: Repos page

**Files:**
- Create: `apps/web/components/fleet/NativeSelect.vue`, `apps/web/components/fleet/RepoReachabilityBadge.vue`, `apps/web/components/fleet/AddRepoDialog.vue`, `apps/web/pages/admin/fleet/repos.vue`
- Test: `apps/web/tests/pages/admin-fleet-repos.spec.ts`, `apps/web/tests/components/fleet-native-select.spec.ts`, `apps/web/tests/helpers/mount-sfc.ts` (create)

**Interfaces:**
- Consumes: `useFleetRepos()`, `RepoCheckState`, `ProjectOption` (Task 3); `REPO_OWNER_PATTERN`, `REPO_NAME_PATTERN`, `FleetRepo`, `FLEET_LIST_SIZE` (Task 2); `fleet.repoReason.*` (Task 1).
- Produces: route `/admin/fleet/repos`; `<FleetRepoReachabilityBadge :state />`, `<FleetAddRepoDialog v-model:open :projects @created="(repo: FleetRepo) => void" />`; `<FleetNativeSelect v-bind="componentField" :options="Array<{ value: string; label: string }>" placeholder? testid? />` (D137; 4c reuses it); test helper `mountSfc(file, props) → { root, find(tag) }` in `tests/helpers/mount-sfc.ts` (mounts a real `.vue` file that imports only `vue`, through a recording custom renderer, so a test can fire a native event and see what the component emits).

- [ ] **Step 1: Write the failing wiring spec**

Create `apps/web/tests/pages/admin-fleet-repos.spec.ts`:

```ts
import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const read = (...p: string[]) => readFileSync(join(webDir, ...p), 'utf-8')

describe('Fleet admin Repos page wiring', () => {
  const page = read('pages', 'admin', 'fleet', 'repos.vue')

  test('loads through useFleetRepos, handles the admin-only 403, then labels projects and checks every row', () => {
    expect(page).toContain('useFleetRepos()')
    expect(page).toContain('err.code === 40003')
    expect(page).toMatch(/await loadRows\(\)[\s\S]*await loadProjects\(\)[\s\S]*await checkAll\(\)/)
  })

  test('each row has a reachability badge and a recheck button that is disabled while checking', () => {
    expect(page).toContain('<FleetRepoReachabilityBadge :state="checks[repo.id]" />')
    expect(page).toContain("checks[repo.id]?.status === 'checking'")
    expect(page).toContain('@click="check(repo.id)"')
  })

  test('delete asks first; a new repo reloads the rows and checks only itself', () => {
    expect(page).toContain("window.confirm(t('fleet.repos.deleteConfirm', { repo: repoName(repo) }))")
    expect(page).toContain('<FleetAddRepoDialog v-model:open="addOpen" :projects="projects" @created="onCreated" />')
    expect(page).toMatch(/async function onCreated\(repo: FleetRepo\)[\s\S]*?await check\(repo\.id\)/)
    expect(page.match(/async function onCreated[\s\S]*?\n\}/)?.[0]).not.toContain('checkAll')
  })
})

describe('Fleet repo components wiring', () => {
  test('add dialog posts through useFleetRepos().create and shows API errors via extractApiError', () => {
    const dialog = read('components', 'fleet', 'AddRepoDialog.vue')
    expect(dialog).toContain('await create(values)')
    expect(dialog).toContain('toast.error(extractApiError(err))')
    expect(dialog).toContain('REPO_OWNER_PATTERN')
    expect(dialog).toContain('REPO_NAME_PATTERN')
    // Native selects through FleetNativeSelect (plan D137, issue #58): a bare <select> cannot bind
    // componentField, so the form value would never change (FleetNativeSelect's own spec proves it binds).
    expect(dialog).toContain('<FleetNativeSelect v-bind="componentField"')
    expect(dialog).not.toMatch(/<select[^>]*v-bind="componentField"/)
    expect(dialog).toContain('testid="fleet-repo-project"')
    expect(dialog).toContain('testid="fleet-repo-provider"')
    expect(dialog).not.toContain('<SelectContent')
  })

  test('the badge translates known reasons and falls back to the raw code', () => {
    const badge = read('components', 'fleet', 'RepoReachabilityBadge.vue')
    expect(badge).toContain('te(key) ? t(key) : reason')
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd apps/web && npx jest tests/pages/admin-fleet-repos.spec.ts`
Expected: FAIL, ENOENT for `pages/admin/fleet/repos.vue` and the two components.

- [ ] **Step 3: Write the mount helper and the failing `FleetNativeSelect` spec**

The web has no `@vue/test-utils` or jsdom, and a source-string check cannot prove a select binds a form (the review found the wiring specs pass with a broken binding). This helper mounts the real SFC in node. Create `apps/web/tests/helpers/mount-sfc.ts`:

```ts
/**
 * Mounts a real .vue file in node without a DOM: compiles the SFC with vue/compiler-sfc, transpiles
 * its TypeScript, and renders it through a minimal custom renderer that records element props and
 * event handlers. Enough to fire a native event at an element and observe what the component emits.
 * Only `vue` can be imported by the SFC under test.
 */
import { readFileSync } from 'fs'
import * as ts from 'typescript'
import * as Vue from 'vue'
import type { Component } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

export interface FakeNode {
  tag: string
  props: Record<string, unknown>
  children: FakeNode[]
  text: string
  parent: FakeNode | null
}

const node = (tag: string, text = ''): FakeNode => ({ tag, props: {}, children: [], text, parent: null })

const renderer = Vue.createRenderer({
  createElement: (tag: string) => node(tag),
  createText: (text: string) => node('#text', text),
  createComment: (text: string) => node('#comment', text),
  setText: (n: FakeNode, text: string) => { n.text = text },
  setElementText: (n: FakeNode, text: string) => { n.children = [node('#text', text)] },
  insert: (child: FakeNode, parent: FakeNode, anchor: FakeNode | null) => {
    child.parent = parent
    const at = anchor ? parent.children.indexOf(anchor) : -1
    parent.children = at < 0 ? [...parent.children, child] : [...parent.children.slice(0, at), child, ...parent.children.slice(at)]
  },
  remove: (child: FakeNode) => {
    if (child.parent) child.parent.children = child.parent.children.filter((c) => c !== child)
  },
  patchProp: (el: FakeNode, key: string, _prev: unknown, next: unknown) => { el.props = { ...el.props, [key]: next } },
  parentNode: (n: FakeNode) => n.parent,
  nextSibling: (n: FakeNode) => {
    if (!n.parent) return null
    return n.parent.children[n.parent.children.indexOf(n) + 1] ?? null
  },
})

function loadComponent(file: string): Component {
  const { descriptor } = parse(readFileSync(file, 'utf-8'), { filename: file })
  const script = compileScript(descriptor, { id: 'test', inlineTemplate: true })
  const js = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const mod: { exports: Record<string, unknown> } = { exports: {} }
  const requireVue = (id: string): unknown => {
    if (id === 'vue') return Vue
    throw new Error(`mount-sfc: ${file} imports ${id}; only 'vue' is supported`)
  }
  new Function('require', 'module', 'exports', js)(requireVue, mod, mod.exports)
  return mod.exports.default as Component
}

export function mountSfc(file: string, props: Record<string, unknown>): { root: FakeNode; find: (tag: string) => FakeNode[] } {
  const root = node('#root')
  renderer.createApp(loadComponent(file), props).mount(root)
  const find = (tag: string, from: FakeNode = root): FakeNode[] =>
    from.children.flatMap((c) => [...(c.tag === tag ? [c] : []), ...find(tag, c)])
  return { root, find: (tag: string) => find(tag) }
}
```

Create `apps/web/tests/components/fleet-native-select.spec.ts`:

```ts
import { describe, test, expect, jest } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'
import { mountSfc } from '../helpers/mount-sfc'

const file = join(__dirname, '../..', 'components', 'fleet', 'NativeSelect.vue')
const options = [{ value: 'github', label: 'GitHub' }, { value: 'gitlab', label: 'GitLab' }]

// vee-validate's FormField hands this exact shape to its slot as `componentField`.
function componentField(value: string) {
  return { modelValue: value, 'onUpdate:modelValue': jest.fn(), onBlur: jest.fn() }
}

describe('FleetNativeSelect binds vee-validate componentField', () => {
  test('a native change reaches onUpdate:modelValue with the chosen value', () => {
    const field = componentField('github')
    const { find } = mountSfc(file, { ...field, options, testid: 'fleet-repo-provider' })
    const [select] = find('select')

    ;(select.props.onChange as (e: unknown) => void)({ target: { value: 'gitlab' } })

    expect(field['onUpdate:modelValue']).toHaveBeenCalledWith('gitlab')
  })

  test('blur reaches onBlur', () => {
    const field = componentField('github')
    const { find } = mountSfc(file, { ...field, options })
    const event = { type: 'blur' }

    ;(find('select')[0].props.onBlur as (e: unknown) => void)(event)

    expect(field.onBlur).toHaveBeenCalledWith(event)
  })

  test('the select shows modelValue and never leaks modelValue as an attribute', () => {
    const { find } = mountSfc(file, { ...componentField('gitlab'), options, testid: 'fleet-repo-provider' })
    const [select] = find('select')

    expect(select.props.value).toBe('gitlab')
    expect(select.props['data-testid']).toBe('fleet-repo-provider')
    expect(Object.keys(select.props)).not.toContain('modelValue')
    expect(find('option').map((o) => o.props.value)).toEqual(['github', 'gitlab'])
  })

  test('a placeholder renders a disabled empty first option', () => {
    const { find } = mountSfc(file, { ...componentField(''), options, placeholder: 'Choose' })
    const [first] = find('option')

    expect(first.props.value).toBe('')
    expect(first.props.disabled).toBe('')
  })

  test('the SFC imports nothing but vue (the mount helper only provides vue)', () => {
    const source = readFileSync(file, 'utf-8')
    expect(source).not.toMatch(/from '(?!vue')/)
  })
})
```

Run: `cd apps/web && npx jest tests/components/fleet-native-select.spec.ts`
Expected: FAIL, ENOENT for `components/fleet/NativeSelect.vue`.

- [ ] **Step 4: Write `apps/web/components/fleet/NativeSelect.vue`**

```vue
<template>
  <select
    :value="modelValue"
    :data-testid="testid"
    class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
    @change="onChange"
    @blur="emit('blur', $event)"
  >
    <option v-if="placeholder" value="" disabled>{{ placeholder }}</option>
    <option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option>
  </select>
</template>

<script setup lang="ts">
/**
 * A native <select> that speaks the v-model protocol, so vee-validate's `componentField`
 * (modelValue + onUpdate:modelValue + onBlur) binds to it. Binding componentField straight onto a
 * bare <select> renders `modelvalue` as an attribute and never updates the form (plan D137).
 */
interface NativeSelectOption {
  value: string
  label: string
}

defineProps<{ modelValue?: string; options: readonly NativeSelectOption[]; testid?: string; placeholder?: string }>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'blur', event: FocusEvent): void
}>()

function onChange(event: Event): void {
  const target = event.target as HTMLSelectElement | null
  emit('update:modelValue', target?.value ?? '')
}
</script>
```

Run: `cd apps/web && npx jest tests/components/fleet-native-select.spec.ts`
Expected: PASS, 5 tests. (Verified while fixing the plan: swapping the component body for a bare `<select v-bind="$attrs">` fails the change, modelValue and placeholder tests: there is no `onChange` handler, and `modelValue` lands on the element as an attribute.)

- [ ] **Step 5: Write `apps/web/components/fleet/RepoReachabilityBadge.vue`**

```vue
<template>
  <Badge v-if="!state || state.status === 'checking'" variant="outline">{{ t('fleet.repos.reach.checking') }}</Badge>
  <Badge v-else-if="state.status === 'error'" variant="outline" :title="state.message">{{ t('fleet.repos.reach.error') }}</Badge>
  <Badge v-else-if="state.result.reachable" variant="secondary">{{ t('fleet.repos.reach.ok') }}</Badge>
  <Badge v-else variant="destructive" :title="reasonText(state.result.reason)">
    {{ t('fleet.repos.reach.failed') }}: {{ reasonText(state.result.reason) }}
  </Badge>
</template>

<script setup lang="ts">
import type { RepoCheckState } from '~/composables/useFleetRepos'

defineProps<{ state: RepoCheckState | undefined }>()

const { t, te } = useI18n()

/** Translated reason (plan D126); an unknown code is shown as sent. */
function reasonText(reason: string | null): string {
  if (!reason) return t('fleet.common.unknown')
  const key = `fleet.repoReason.${reason}`
  return te(key) ? t(key) : reason
}
</script>
```

- [ ] **Step 6: Write `apps/web/components/fleet/AddRepoDialog.vue`**

```vue
<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent class="sm:max-w-[500px]">
      <DialogHeader>
        <DialogTitle>{{ t('fleet.repos.form.title') }}</DialogTitle>
      </DialogHeader>
      <p class="text-sm text-muted-foreground">{{ t('fleet.repos.form.hint') }}</p>

      <form class="space-y-4" @submit="onSubmit">
        <FormField v-slot="{ componentField }" name="projectSlug">
          <FormItem>
            <FormLabel>{{ t('fleet.repos.form.project') }}</FormLabel>
            <FormControl>
              <FleetNativeSelect v-bind="componentField" :options="projectOptions" :placeholder="t('fleet.repos.form.projectPlaceholder')" testid="fleet-repo-project" />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField v-slot="{ componentField }" name="provider">
          <FormItem>
            <FormLabel>{{ t('fleet.repos.form.provider') }}</FormLabel>
            <FormControl>
              <FleetNativeSelect v-bind="componentField" :options="providerOptions" testid="fleet-repo-provider" />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField v-slot="{ componentField }" name="owner">
          <FormItem>
            <FormLabel>{{ t('fleet.repos.form.owner') }}</FormLabel>
            <FormControl><Input v-bind="componentField" /></FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField v-slot="{ componentField }" name="name">
          <FormItem>
            <FormLabel>{{ t('fleet.repos.form.name') }}</FormLabel>
            <FormControl><Input v-bind="componentField" /></FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <div class="flex justify-end gap-2">
          <Button type="button" variant="outline" @click="$emit('update:open', false)">{{ t('common.cancel') }}</Button>
          <Button type="submit" :disabled="isSubmitting">
            {{ isSubmitting ? t('fleet.repos.form.submitting') : t('fleet.repos.form.submit') }}
          </Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import * as z from 'zod'
import { extractApiError } from '~/composables/useApi'
import { REPO_NAME_PATTERN, REPO_OWNER_PATTERN } from '~/lib/fleet-validation'
import type { ProjectOption } from '~/composables/useFleetRepos'
import type { FleetRepo } from '~/lib/fleet-types'

const props = defineProps<{ open: boolean; projects: ProjectOption[] }>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'created', repo: FleetRepo): void
}>()

const { t } = useI18n()
const toast = useAppToast()
const { create } = useFleetRepos()

const projectOptions = computed(() => props.projects.map((p) => ({ value: p.slug, label: `${p.name} (${p.slug})` })))
const providerOptions = computed(() => [
  { value: 'github', label: t('fleet.repos.provider.github') },
  { value: 'gitlab', label: t('fleet.repos.provider.gitlab') },
])

const formSchema = toTypedSchema(z.object({
  projectSlug: z.string().min(1, t('fleet.validation.required')),
  provider: z.enum(['github', 'gitlab']),
  owner: z.string().trim().regex(REPO_OWNER_PATTERN, t('fleet.validation.ownerInvalid')),
  name: z.string().trim().regex(REPO_NAME_PATTERN, t('fleet.validation.nameInvalid')),
}))

const { handleSubmit, isSubmitting, resetForm } = useForm({
  validationSchema: formSchema,
  initialValues: { projectSlug: '', provider: 'github' as const, owner: '', name: '' },
})

// The API runs the forge check before saving. A 409 (already registered) or a 422 arrives as the
// API's translated message; a 422's message embeds the check reason as its raw code, which stays
// raw here: parsing it out of the message is banned (.nax/rules/common.md, structured codes only).
const onSubmit = handleSubmit(async (values) => {
  try {
    const repo = await create(values)
    toast.success(t('fleet.repos.toast.added'))
    emit('created', repo)
    emit('update:open', false)
    resetForm()
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  }
})
</script>
```

- [ ] **Step 7: Write `apps/web/pages/admin/fleet/repos.vue`**

```vue
<script setup lang="ts">
import { Plus } from 'lucide-vue-next'
import { ApiError, extractApiError } from '~/composables/useApi'
import { FLEET_LIST_SIZE } from '~/lib/fleet-types'
import type { FleetRepo } from '~/lib/fleet-types'

definePageMeta({ layout: 'default' })

const { t } = useI18n()
const toast = useAppToast()
const { repos, hasMore, pending, checks, projects, load, loadProjects, check, checkAll, remove } = useFleetRepos()

const adminOnly = ref(false)
const addOpen = ref(false)

// ApiError.code is the envelope `ret`: a 403 arrives as ret 40003 (see pages/admin/users.vue).
function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && (err.code === 40003 || err.code === 403)
}

const projectLabel = computed(() => new Map(projects.value.map((p) => [p.id, p.slug])))

function repoName(repo: FleetRepo): string {
  return `${repo.owner}/${repo.name}`
}

/** Loads the rows; false (after a toast or the admin-only note) when that failed. */
async function loadRows(): Promise<boolean> {
  try {
    await load()
    return true
  } catch (err: unknown) {
    if (isForbidden(err)) adminOnly.value = true
    else toast.error(extractApiError(err))
    return false
  }
}

async function reload(): Promise<void> {
  if (!(await loadRows())) return
  // The project list only labels rows; a failure there leaves the ids showing.
  await loadProjects().catch((err: unknown) => toast.error(extractApiError(err)))
  await checkAll()
}

/** A new repo: reload the rows (the dialog has its own composable instance) and check only the new one. */
async function onCreated(repo: FleetRepo): Promise<void> {
  if (await loadRows()) await check(repo.id)
}

async function confirmDelete(repo: FleetRepo): Promise<void> {
  if (!window.confirm(t('fleet.repos.deleteConfirm', { repo: repoName(repo) }))) return
  try {
    await remove(repo.id)
    toast.success(t('fleet.repos.toast.deleted'))
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  }
}

onMounted(() => reload())
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('fleet.repos.title')" :subtitle="t('fleet.repos.subtitle')">
      <template #actions>
        <Button :disabled="adminOnly" @click="addOpen = true">
          <Plus class="mr-2 h-4 w-4" />{{ t('fleet.repos.actions.add') }}
        </Button>
      </template>
    </PageHeader>

    <p v-if="adminOnly" class="text-sm text-muted-foreground">{{ t('fleet.common.adminOnly') }}</p>

    <template v-else>
      <LoadingState v-if="pending && repos.length === 0" />
      <EmptyState v-else-if="repos.length === 0" :message="t('fleet.repos.empty')" />
      <Table v-else>
        <TableHeader>
          <TableRow>
            <TableHead>{{ t('fleet.repos.table.repo') }}</TableHead>
            <TableHead>{{ t('fleet.repos.table.project') }}</TableHead>
            <TableHead>{{ t('fleet.repos.table.provider') }}</TableHead>
            <TableHead>{{ t('fleet.repos.table.branch') }}</TableHead>
            <TableHead>{{ t('fleet.repos.table.reachability') }}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="repo in repos" :key="repo.id" :data-testid="`fleet-repo-${repo.owner}-${repo.name}`">
            <TableCell class="font-medium">{{ repoName(repo) }}</TableCell>
            <TableCell>{{ projectLabel.get(repo.projectId) ?? repo.projectId }}</TableCell>
            <TableCell>{{ t(`fleet.repos.provider.${repo.provider}`) }}</TableCell>
            <TableCell>{{ repo.defaultBranch }}</TableCell>
            <TableCell><FleetRepoReachabilityBadge :state="checks[repo.id]" /></TableCell>
            <TableCell class="space-x-1 whitespace-nowrap text-right">
              <Button size="sm" variant="outline" :disabled="checks[repo.id]?.status === 'checking'" @click="check(repo.id)">
                {{ t('fleet.repos.actions.recheck') }}
              </Button>
              <Button size="sm" variant="destructive" @click="confirmDelete(repo)">{{ t('fleet.repos.actions.delete') }}</Button>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <p v-if="hasMore" class="text-sm text-muted-foreground">{{ t('fleet.common.more', { n: FLEET_LIST_SIZE }) }}</p>
    </template>

    <FleetAddRepoDialog v-model:open="addOpen" :projects="projects" @created="onCreated" />
  </div>
</template>
```

`reload()` and `onCreated()` never throw (they toast or set `adminOnly`; `check` records its own errors), so `onMounted` and `@created` need no catch. Only mount checks every row: adding one repo checks only that repo, so a large registry does not re-run every forge check on each add.

- [ ] **Step 8: Run the specs and the guard**

Run: `cd apps/web && npx jest tests/pages/admin-fleet-repos.spec.ts tests/components/fleet-native-select.spec.ts tests/lib/api-path-guard.spec.ts tests/i18n/used-keys-exist.spec.ts`
Expected: PASS, 4 suites.

- [ ] **Step 9: Commit**

```bash
git add apps/web/components/fleet/NativeSelect.vue apps/web/components/fleet/RepoReachabilityBadge.vue apps/web/components/fleet/AddRepoDialog.vue apps/web/pages/admin/fleet/repos.vue apps/web/tests/pages/admin-fleet-repos.spec.ts apps/web/tests/components/fleet-native-select.spec.ts apps/web/tests/helpers/mount-sfc.ts
git commit -m "feat(web): admin fleet Repos page with reachability checks"
```

---

## Task 8: Verification and smoke

**Files:** none changed (fix-ups, if any, go in their own commit).

- [ ] **Step 1: Lint**

Run: `cd apps/web && bun run lint`
Expected: exit 0, no output after the eslint command line.

- [ ] **Step 2: Type-check**

Run: `cd apps/web && bun run type-check`
Expected: exit 0.

- [ ] **Step 3: All web unit tests**

Run: `cd apps/web && bun run test 2>&1 | tail -5`
Expected: every suite passes; 13 suites and 73 tests more than the Task 0 baseline (verified after the review fixes, on `main` at `0ba9ba94` plus this plan: 116 suites / 2079 tests before, 129 / 2152 after; `bun run lint` and `bun run type-check` exit 0, and type-check covers the new SFCs and `tests/helpers/mount-sfc.ts`).

- [ ] **Step 4: Manual smoke (human, optional, local only)**

With the API on :3100 (`cd apps/api && bun run start:dev`, test Postgres up) and the web on :3101 (`cd apps/web && bun run dev`), log in as a global admin and check:

1. The sidebar shows Runners and Repos; a MEMBER user does not see them, and opening `/admin/fleet/runners` as that user shows the admin-only note.
2. Runners: "Enrollment token" with labels `linux, gpu` shows a `ke_` token and the enroll command with `http://localhost:3101`; Copy works on localhost; Esc and a click outside do not close the dialog while the token shows; Done closes it, and reopening shows the form again. Uppercase `GPU` is refused with the translated message. Opened from another machine over plain http (no Clipboard API), Copy shows the "could not copy" toast and the token is still selectable.
3. With a runner enrolled (or a row inserted by the 4a integration fixtures), the row shows Online, chips with translated credential kinds, "Ns ago"; stop the API for 20 s: the stale note appears without toasts, and clears after the API is back. Switch to another tab for 30 s and back: the table refreshes at once (network tab shows one `GET /api/fleet/runners` on return, none while hidden).
4. Edit labels and capacity, disable, enable, delete (confirm dialog).
5. Repos: in Add repo, choose a project other than the first and provider GitLab, then submit: the network tab's `POST /api/fleet/repos` body carries that `projectSlug` and `"provider":"gitlab"` (the D137 binding; the review found a bare select would send `github` and an empty project). A repo koda cannot reach shows the API's 422 message (its reason code stays raw there); an existing row shows Reachable or Unreachable with a translated reason; "Check again" shows Checking first; adding a repo checks only the new row.
6. Switch the language to zh: every fleet string changes.

- [ ] **Step 5: Hand-off**

Do not push. Report the branch head, the test counts, and anything Step 4 found.
