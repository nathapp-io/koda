# Fleet S3 — Repo Config Editing and Credential Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let project members browse a fleet repo's allowlisted `.nax/` files in koda, let DEVELOPER+ turn edits into a runner-prepared PR (regenerated agent files, nax-validated), offer an on-demand drift check, and give admins a fleet-wide credential and profile board.

**Architecture:** The API reads `.nax/` files through the forge (GitHub App installation token / GitLab project token). Saving queues a new fleet job kind (`CONFIG_EDIT`, or `CONFIG_DRIFT` for the check) that a runner executes without a nax session: staleness check, apply, `nax generate`, nax validation, commit, push, `gh`/`glab` PR; the result rides the existing snapshot event. The board is a pure derivation over `Runner.capabilities`.

**Tech Stack:** NestJS 11 + Fastify + Prisma (PostgreSQL 16), Bun runner daemon, Nuxt 3 + shadcn-nuxt, Commander CLI (generated client), Jest / bun:test / Playwright.

**Spec:** `docs/superpowers/specs/2026-10-07-fleet-s3-repo-config-and-credential-board-design.md` (decisions D465-D498).

**Delivery:** three PRs, each cut from `main` only after the previous one merged (no stacking):
- **PR 1 — Part A** (`feat/fleet-s3-1-credential-board`, already created; carries the spec and this plan): Tasks A0-A10.
- **PR 2 — Parts B1 + B2** (`feat/fleet-s3-2-config-jobs`): Tasks B1-0..B1-13, then B2-1..B2-12 (B2-12 opens the PR).
- **PR 3 — Part C** (`feat/fleet-s3-3-config-web`): Tasks C0-C13, then C14 (human-run deploy + live check after merge).

## Global Constraints

- No Prisma enums (repo rule): new kinds, modes and outcomes are strings.
- The API never imports runtime code from `@nathapp/fleet-protocol` (type-only; its image does not ship `packages/`): runtime copies live in `apps/api/src/fleet/common/` with a parity spec (D493). The web may import the package.
- File allowlist exactly: `.nax/rules/**/*.md`, `.nax/context.md`, `.nax/mono/**/context.md`, `.nax/config.json`, `.nax/mono/**/config.json`, `.nax/profiles/*.json`, `.nax/constitution.md`; never `.nax/profiles/*.env`.
- Limits: 50 edits, 256 KiB per file, 1 MiB total (UTF-8 bytes), path at most 512 chars, PR title 1..200 chars, PR body at most 8 KiB; `configResult` files at most 50 x 512 chars, output at most 8 KiB, runner trims to a 12 KiB serialized budget.
- Config jobs: `feature = 'nax-config'`, `profiles = []`, `maxCostUsd = 0`, `bashMode = 'raw'`; at most one active config job per repo (409 `config_job_active`).
- Permissions: browse = any project member; save / regenerate / drift = `CREATE FleetJob` (DEVELOPER+); board = global admin.
- `FLEET_CREDENTIAL_EXPIRY_WARN_DAYS` default 7 (OAuth only). Runner config-job timeout 600 000 ms and heartbeat 30 000 ms are `Tuning` constants.
- Runner nax floor stays 0.83.1. Config jobs never spend money and never upload a bundle.
- Never log file contents, config values or git tokens; PR attribution names the requester, never an email.
- i18n: every new API error in `apps/api/src/i18n/{en,zh}`; every new web string in `apps/web/i18n/locales/{en,zh}.json`.
- `openapi.json` and `apps/cli/src/generated/` are regenerated with `bun run generate`, never hand-edited; generated `AGENTS.md`/`CLAUDE.md` are regenerated with `nax generate`, never hand-edited.
- Repo commands: `bun run test`, `bun run lint`, `bun run type-check`; API integration needs `bun run test:db:up` in `apps/api`.

## Review Focus

1. A CRLF file opened and saved without edits: a reasonable person expects no change in the PR; an edited CRLF file keeps CRLF (test: Task C2 Step 4b).
2. Deleting a file and re-creating it at the same path in one draft: expected to be a plain modify, not a false `conflict` (test: Task C2 Step 4b).
3. Emptying a rule file (content `''`): expected to save, not be rejected as "missing content" (test: Task B1-8 Step 3b).
4. A repo whose `.nax/` holds files named with spaces or non-ASCII characters: expected to list everything else normally, never to fail the listing (test: Task B1-7 Step 4b).
5. Rules or context written in Chinese or with accents: expected to reach the PR byte for byte (test: Task B2-5 Step 4b).

---

## Part A — PR 1: Credential board

Implements spec §4.4 (board endpoint + dashboard `expiring`) and the `/admin/fleet/credentials` page of §6. No
protocol, runner or Prisma change. Branch `feat/fleet-s3-1-credential-board` cut from `main`.

### File Structure (Part A)

API (`apps/api`):
- Modify `src/config/fleet.config.ts` — `credentialExpiryWarnDays` (env `FLEET_CREDENTIAL_EXPIRY_WARN_DAYS`, default 7).
- Modify `src/config/env.validation.ts` — Joi rule for the new env var.
- Modify `src/config/fleet.config.spec.ts` — default/override/boot-refusal tests.
- Modify `src/common/test-helpers/fleet-config.ts` — `credentialExpiryWarnDays: 7`.
- Modify `src/fleet/jobs/placement-rules.ts` — export `profileMisfit(needs, caps)` (extracted from `capabilityMisfit`, no behaviour change).
- Modify `src/fleet/jobs/placement-rules.spec.ts` — `profileMisfit` tests.
- Create `src/fleet/dashboard/credential-board.ts` — pure derivation: `isExpiring`, `credentialCell`, `buildCredentialBoard`.
- Create `src/fleet/dashboard/credential-board.spec.ts`.
- Modify `src/fleet/dashboard/dashboard.types.ts` — `CREDENTIAL_WHY` gains `'expiring'`; `AttentionThresholds.credentialExpiryWarnDays`.
- Modify `src/common/test-helpers/fleet-dashboard.ts` — `DASH_THRESHOLDS.credentialExpiryWarnDays = 7`.
- Modify `src/fleet/dashboard/attention-runners.ts` — `expiring` credential condition (warn, never escalates).
- Modify `src/fleet/dashboard/attention-runners.spec.ts`.
- Modify `src/fleet/dashboard/dashboard.service.ts` — pass the threshold.
- Create `src/fleet/dashboard/credential-board.service.ts` (+ `.spec.ts`) — reads runners, derives the board.
- Create `src/fleet/dashboard/fleet-credential-board.controller.ts` — `GET /fleet/credential-board` (global ADMIN).
- Create `src/fleet/dashboard/dto/credential-board.dto.ts`.
- Modify `src/fleet/dashboard/dashboard.module.ts` — register service + controller.
- Create `test/integration/fleet/fleet-credential-board-api.integration.spec.ts`.
- Modify `src/fleet/fleet-openapi.contract.spec.ts` — pin the route and DTO.
- Regenerate `openapi.json` and `apps/cli/src/generated/` (`bun run generate`).

Web (`apps/web`):
- Modify `lib/fleet-dashboard-types.ts` — `CREDENTIAL_WHY` gains `'expiring'`.
- Create `lib/fleet-credential-board.ts` — wire types + `cellTone`, `cellLabelKey`, `profileCellLabel`.
- Create `composables/useFleetCredentialBoard.ts` — load once, 403 -> forbidden, manual refresh.
- Create `components/fleet/credentials/CredentialGrid.vue` (Nuxt name `FleetCredentialsCredentialGrid`).
- Create `components/fleet/credentials/ProfileInventory.vue` (Nuxt name `FleetCredentialsProfileInventory`).
- Create `pages/admin/fleet/credentials.vue`.
- Modify `pages/admin/fleet/runners.vue` — header link to the board.
- Modify `components/fleet/dashboard/Overview.vue` — admin-scope link to the board in the Runners section.
- Modify `i18n/locales/en.json`, `i18n/locales/zh.json` — `fleet.credentials.*`, `fleet.dashboard.attention.condition.credential.expiring`, `fleet.dashboard.runners.board`, `fleet.runners.actions.credentials`.
- Modify `tests/i18n/fleet-locale-parity.spec.ts` — pin the new enums.
- Modify `tests/helpers/mount-sfc.ts` — register the two new fleet components.
- Modify `tests/helpers/fleet-harness.ts` — stubs for `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent`.
- Create `tests/lib/fleet-credential-board.spec.ts`, `tests/composables/useFleetCredentialBoard.spec.ts`,
  `tests/components/fleet-credentials.spec.ts`, `tests/pages/admin-fleet-credentials.spec.ts`.
- Modify `tests/e2e/fixtures/scripted-runner.ts` — `enroll(..., { capabilities })` override.
- Create `tests/e2e/fleet-credentials.e2e.spec.ts`.

Conventions every task follows:
- API unit tests: `cd apps/api && bunx jest <path>`; whole unit suite `bun run test`. Integration (needs the compose test
  Postgres: `cd apps/api && bun run test:db:up`): `cd apps/api && bun run test:scoped <path>`.
- Web unit tests: `cd apps/web && bunx jest <path>`; whole suite `bun run test`.
- No emojis, no `console.log`, no mutation of inputs (build new arrays/objects), no Prisma enums.
- All UI text through i18n, `en` and `zh` both.

---

### Task A0: Start on the PR 1 branch

**Files:** none.

The branch `feat/fleet-s3-1-credential-board` already exists: it was cut from `main` `a61c11aa` and carries the spec
and this plan as its first commits. Work on it; do not cut a new one.

- [ ] **Step 1: Check out the branch and bring it up to date with main**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda
git fetch origin
git switch feat/fleet-s3-1-credential-board
git rebase origin/main
```

Expected: the rebase applies cleanly (the branch only adds the spec and plan under `docs/superpowers/`).
`git log --oneline origin/main..HEAD` lists only the `docs(fleet): S3 ...` commits.

---

### Task A1: `FLEET_CREDENTIAL_EXPIRY_WARN_DAYS` config

**Files:**
- Modify: `apps/api/src/config/fleet.config.ts` (interface after `prRefreshMs` ~line 56; schema after `FLEET_PR_REFRESH_MS` ~line 87; value after `prRefreshMs` ~line 133)
- Modify: `apps/api/src/config/env.validation.ts:78` (after `FLEET_PR_REFRESH_MS`)
- Modify: `apps/api/src/common/test-helpers/fleet-config.ts`
- Test: `apps/api/src/config/fleet.config.spec.ts`

**Interfaces:**
- Produces: `IFleetConfig.credentialExpiryWarnDays: number` (default 7, 1..90).

- [ ] **Step 1: Write the failing tests** — append inside the `describe('fleet config', ...)` block of `apps/api/src/config/fleet.config.spec.ts`:

```ts
  it('defaults the credential expiry warning to 7 days and reads an override (S3 D473)', () => {
    delete process.env.FLEET_CREDENTIAL_EXPIRY_WARN_DAYS;
    expect(fleetConfig().credentialExpiryWarnDays).toBe(7);
    process.env.FLEET_CREDENTIAL_EXPIRY_WARN_DAYS = '14';
    expect(fleetConfig().credentialExpiryWarnDays).toBe(14);
    delete process.env.FLEET_CREDENTIAL_EXPIRY_WARN_DAYS;
  });

  it.each(['0', '91', '1.5', 'abc'])('refuses boot on FLEET_CREDENTIAL_EXPIRY_WARN_DAYS=%s', (value) => {
    expect(() => validate({ ...BASE, FLEET_CREDENTIAL_EXPIRY_WARN_DAYS: value })).toThrow();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && bunx jest src/config/fleet.config.spec.ts`
Expected: FAIL — `credentialExpiryWarnDays` is `undefined`; the `0`/`91` cases do not throw.

- [ ] **Step 3: Implement**

In `apps/api/src/config/fleet.config.ts`, add to `IFleetConfig` after `prRefreshMs`:

```ts
  /** S3 §4.4 (D473): an OAuth credential expiring within this many days shows as `expiring` on the board and dashboard. */
  credentialExpiryWarnDays: number;
```

Add to `FleetConfigSchema` after `FLEET_PR_REFRESH_MS`:

```ts
  @IsOptional() @IsString() FLEET_CREDENTIAL_EXPIRY_WARN_DAYS: string;
```

Add to the returned object after `prRefreshMs`:

```ts
    credentialExpiryWarnDays: int('FLEET_CREDENTIAL_EXPIRY_WARN_DAYS', 7),
```

In `apps/api/src/config/env.validation.ts`, after the `FLEET_PR_REFRESH_MS` line:

```ts
  FLEET_CREDENTIAL_EXPIRY_WARN_DAYS: Joi.number().integer().min(1).max(90).optional(),
```

In `apps/api/src/common/test-helpers/fleet-config.ts`, after `prRefreshMs: 600_000,`:

```ts
    credentialExpiryWarnDays: 7,
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && bunx jest src/config/fleet.config.spec.ts && bun run type-check`
Expected: PASS; type-check clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/config/fleet.config.ts apps/api/src/config/env.validation.ts apps/api/src/config/fleet.config.spec.ts apps/api/src/common/test-helpers/fleet-config.ts
git commit -m "feat(fleet): FLEET_CREDENTIAL_EXPIRY_WARN_DAYS config (S3 D473)"
```

---

### Task A2: Export `profileMisfit` from placement rules

The board's Profiles tab must say why a runner cannot serve one profile, with exactly the rules placement uses. Extract
the per-profile body of `capabilityMisfit` (no behaviour change).

**Files:**
- Modify: `apps/api/src/fleet/jobs/placement-rules.ts:48-66`
- Test: `apps/api/src/fleet/jobs/placement-rules.spec.ts`

**Interfaces:**
- Produces: `export function profileMisfit(needs: ProfileNeeds, caps: RunnerCapabilities): MisfitReason | null` —
  returns `'protocol' | 'provider_missing' | 'provider_unavailable' | 'sandbox' | 'interaction' | null`.

- [ ] **Step 1: Write the failing test** — add to `apps/api/src/fleet/jobs/placement-rules.spec.ts` (extend the import
  list with `profileMisfit`) a new `describe` at the end of the file:

```ts
describe('profileMisfit (S3 §4.4: one profile, the placement rules)', () => {
  const needs = (over: Partial<ProfileNeeds> = {}): ProfileNeeds => ({ protocol: 'native', providers: ['deepseek'], sandbox: true, ...over });

  it('fits when protocol, providers, sandbox and interaction are fine', () => {
    expect(profileMisfit(needs(), caps())).toBeNull();
  });

  it('reports, in placement order, protocol, provider_missing, provider_unavailable, sandbox, interaction', () => {
    expect(profileMisfit(needs({ protocol: 'acp' }), caps())).toBe('protocol');
    expect(profileMisfit(needs({ providers: ['openai'] }), caps())).toBe('provider_missing');
    expect(profileMisfit(needs(), caps({ credentials: [cred({ available: false })] }))).toBe('provider_unavailable');
    expect(profileMisfit(needs(), caps({ sandbox: { available: false, probedAt: NOW.toISOString() } }))).toBe('sandbox');
    expect(profileMisfit(needs({ interaction: TG_FAILED }), caps())).toBe('interaction');
  });
});
```

Add `ProfileNeeds` to the type import: `import type { ProfileNeeds, RunnerCapabilities } from '../common/protocol';`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && bunx jest src/fleet/jobs/placement-rules.spec.ts`
Expected: FAIL — `profileMisfit` is not exported.

- [ ] **Step 3: Implement** — in `apps/api/src/fleet/jobs/placement-rules.ts` change the type import to
  `import type { ProfileNeeds, RunnerCapabilities, BashMode } from '../common/protocol';`, add above
  `capabilityMisfit`:

```ts
/** S3 §4.4: the placement rules for one profile the runner reports (also used by the credential board). */
export function profileMisfit(needs: ProfileNeeds, caps: RunnerCapabilities): MisfitReason | null {
  if (!caps.nax.protocols.includes(needs.protocol)) return 'protocol';
  for (const provider of needs.providers) {
    const credential = caps.credentials.find((c) => c.providerId === provider);
    if (!credential) return 'provider_missing';
    // nax's own verdict (slice 3 design §1.1): available deliberately ignores access-token expiry.
    if (!credential.available) return 'provider_unavailable';
  }
  if (needs.sandbox && !caps.sandbox.available) return 'sandbox';
  // #207: nax could not start this profile's interaction plugin in the runner's environment.
  if (needs.interaction?.ok === false) return 'interaction';
  return null;
}
```

and replace the loop body in `capabilityMisfit` so it reads:

```ts
  for (const name of job.profiles) {
    // A name the runner does not report is repo-provided and unknowable before clone (spec §2.1).
    if (!own(caps.profiles, name)) continue;
    const misfit = profileMisfit(caps.profiles[name], caps);
    if (misfit) return misfit;
  }
```

(Keep the existing comment line that precedes `if (!own(...))` verbatim; only the statements after it change.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && bunx jest src/fleet/jobs/placement-rules.spec.ts src/fleet/dashboard`
Expected: PASS (all pre-existing placement and dashboard tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/fleet/jobs/placement-rules.ts apps/api/src/fleet/jobs/placement-rules.spec.ts
git commit -m "refactor(fleet): export profileMisfit from placement rules (S3 §4.4)"
```

---

### Task A3: Credential board derivation (pure)

**Files:**
- Create: `apps/api/src/fleet/dashboard/credential-board.ts`
- Test: `apps/api/src/fleet/dashboard/credential-board.spec.ts`

**Interfaces:**
- Consumes: `profileMisfit` (Task A2), `RunnerCapabilities`, `RunnerCredential` from `../common/protocol`, `MisfitReason`.
- Produces (exact):

```ts
export type CredentialCellState = 'ok' | 'expiring' | 'expired' | 'unavailable' | 'missing';
export type CredentialCellKind = 'api-key' | 'oauth' | 'exec' | 'ambient' | 'none';
export interface CredentialCell { state: CredentialCellState; kind: CredentialCellKind; expires?: string }
export interface ProfileCell { present: boolean; needs?: ProfileNeeds; misfit?: MisfitReason }
export interface BoardRunner { id: string; name: string; enabled: boolean; online: boolean; capabilities: RunnerCapabilities | null }
export interface CredentialBoardRunner { id: string; name: string; enabled: boolean; online: boolean; readable: boolean }
export interface CredentialBoard {
  generatedAt: string;
  warnDays: number;
  runners: CredentialBoardRunner[];
  providers: Array<{ providerId: string; cells: Record<string, CredentialCell> }>;
  profiles: Array<{ name: string; runners: Record<string, ProfileCell> }>;
}
export function isExpiring(cred: RunnerCredential, now: Date, warnDays: number): boolean;
export function credentialCell(cred: RunnerCredential | undefined, now: Date, warnDays: number): CredentialCell;
export function buildCredentialBoard(runners: readonly BoardRunner[], now: Date, warnDays: number): CredentialBoard;
```

Rules (spec §4.4, D473):
- `isExpiring`: `stored?.kind === 'oauth'`, `stored.expired === false`, `stored.expires` parses, and
  `expires - now <= warnDays * 86_400_000` (a past date the runner has not yet flagged also counts).
- `credentialCell` precedence: no credential -> `missing` (kind `none`); `!available` -> `unavailable`;
  `stored?.expired` -> `expired`; `isExpiring` -> `expiring`; else `ok`. `kind` = `stored.kind`, else `exec` when
  `exec` is set, else `ambient` when `ambient`, else `none`. `expires` copied from `stored.expires` when present.
- Runners with unreadable capabilities (`null`) are listed with `readable: false` and get no cells (no key in any
  `cells` / `runners` map). Other runners get a cell for every provider row.
- Provider rows = union of every readable runner's credential providerIds and every provider named by any readable
  runner's profiles, sorted by code unit. A provider a runner has no credential for is `missing` there.
- Profile rows = union of profile names across readable runners, sorted by code unit; each readable runner gets
  `{ present: false }` or `{ present: true, needs, misfit? }` (`misfit` omitted when `profileMisfit` is null).
- Runner order = input order (the repository already orders by name then id).

- [ ] **Step 1: Write the failing test** — `apps/api/src/fleet/dashboard/credential-board.spec.ts`:

```ts
import { DASH_NOW, dashCaps } from '../../common/test-helpers/fleet-dashboard';
import type { RunnerCredential } from '../common/protocol';
import { BoardRunner, buildCredentialBoard, credentialCell, isExpiring } from './credential-board';

const DAY = 86_400_000;
const inDays = (d: number): string => new Date(DASH_NOW.getTime() + d * DAY).toISOString();
const oauth = (expires: string | undefined, expired = false): RunnerCredential => ({
  providerId: 'anthropic', available: true, stored: { kind: 'oauth', ...(expires ? { expires } : {}), expired }, ambient: false,
});
const board = (over: Partial<BoardRunner> = {}): BoardRunner => ({
  id: 'r1', name: 'wk-mac', enabled: true, online: true, capabilities: dashCaps(), ...over,
});

describe('isExpiring (S3 D473)', () => {
  it('is true for an unexpired OAuth credential inside the window, including the boundary and a past unflagged date', () => {
    expect(isExpiring(oauth(inDays(3)), DASH_NOW, 7)).toBe(true);
    expect(isExpiring(oauth(inDays(7)), DASH_NOW, 7)).toBe(true);
    expect(isExpiring(oauth(inDays(-1)), DASH_NOW, 7)).toBe(true);
  });

  it('is false outside the window, when already expired, undated, unparsable, or not OAuth', () => {
    expect(isExpiring(oauth(new Date(DASH_NOW.getTime() + 7 * DAY + 1000).toISOString()), DASH_NOW, 7)).toBe(false);
    expect(isExpiring(oauth(inDays(1), true), DASH_NOW, 7)).toBe(false);
    expect(isExpiring(oauth(undefined), DASH_NOW, 7)).toBe(false);
    expect(isExpiring(oauth('not-a-date'), DASH_NOW, 7)).toBe(false);
    expect(isExpiring({ providerId: 'k', available: true, stored: { kind: 'api-key', expires: inDays(1), expired: false }, ambient: false }, DASH_NOW, 7)).toBe(false);
  });
});

describe('credentialCell (S3 §4.4)', () => {
  it('orders missing > unavailable > expired > expiring > ok and reports the serving kind', () => {
    expect(credentialCell(undefined, DASH_NOW, 7)).toEqual({ state: 'missing', kind: 'none' });
    expect(credentialCell({ providerId: 'x', available: false, stored: null, exec: 'error', ambient: false }, DASH_NOW, 7))
      .toEqual({ state: 'unavailable', kind: 'exec' });
    expect(credentialCell(oauth(inDays(-2), true), DASH_NOW, 7)).toEqual({ state: 'expired', kind: 'oauth', expires: inDays(-2) });
    expect(credentialCell(oauth(inDays(2)), DASH_NOW, 7)).toEqual({ state: 'expiring', kind: 'oauth', expires: inDays(2) });
    expect(credentialCell(oauth(inDays(30)), DASH_NOW, 7)).toEqual({ state: 'ok', kind: 'oauth', expires: inDays(30) });
    expect(credentialCell({ providerId: 'x', available: true, stored: null, ambient: true }, DASH_NOW, 7)).toEqual({ state: 'ok', kind: 'ambient' });
  });
});

describe('buildCredentialBoard (S3 §4.4)', () => {
  it('builds a provider x runner grid over the union of reported and profile-named providers', () => {
    const a = board({
      id: 'a', name: 'a',
      capabilities: dashCaps({
        profiles: { fast: { protocol: 'native', providers: ['deepseek', 'openai'], sandbox: false } },
        credentials: [{ providerId: 'deepseek', available: true, stored: { kind: 'api-key', expired: false }, ambient: false }, oauth(inDays(2))],
      }),
    });
    const b = board({ id: 'b', name: 'b', online: false });
    const out = buildCredentialBoard([a, b], DASH_NOW, 7);
    expect(out.generatedAt).toBe(DASH_NOW.toISOString());
    expect(out.warnDays).toBe(7);
    expect(out.runners).toEqual([
      { id: 'a', name: 'a', enabled: true, online: true, readable: true },
      { id: 'b', name: 'b', enabled: true, online: false, readable: true },
    ]);
    expect(out.providers.map((p) => p.providerId)).toEqual(['anthropic', 'deepseek', 'openai']);
    const row = (id: string) => out.providers.find((p) => p.providerId === id)?.cells;
    expect(row('anthropic')).toEqual({ a: { state: 'expiring', kind: 'oauth', expires: inDays(2) }, b: { state: 'missing', kind: 'none' } });
    expect(row('openai')).toEqual({ a: { state: 'missing', kind: 'none' }, b: { state: 'missing', kind: 'none' } });
    expect(row('deepseek')?.b).toEqual({ state: 'ok', kind: 'api-key' });
  });

  it('lists a runner with unreadable capabilities without cells', () => {
    const out = buildCredentialBoard([board(), board({ id: 'x', name: 'x', capabilities: null })], DASH_NOW, 7);
    expect(out.runners.find((r) => r.id === 'x')).toEqual({ id: 'x', name: 'x', enabled: true, online: true, readable: false });
    expect(out.providers.every((p) => !('x' in p.cells))).toBe(true);
    expect(out.profiles.every((p) => !('x' in p.runners))).toBe(true);
  });

  it('builds the profile inventory with needs and the placement misfit', () => {
    const a = board({ id: 'a', name: 'a', capabilities: dashCaps({
      profiles: {
        fast: { protocol: 'native', providers: ['deepseek'], sandbox: false },
        boxed: { protocol: 'native', providers: ['deepseek'], sandbox: true },
      },
      sandbox: { available: false, probedAt: DASH_NOW.toISOString() },
    }) });
    const b = board({ id: 'b', name: 'b' });
    const out = buildCredentialBoard([a, b], DASH_NOW, 7);
    expect(out.profiles.map((p) => p.name)).toEqual(['boxed', 'fast']);
    expect(out.profiles[0].runners).toEqual({
      a: { present: true, needs: { protocol: 'native', providers: ['deepseek'], sandbox: true }, misfit: 'sandbox' },
      b: { present: false },
    });
    expect(out.profiles[1].runners.a).toEqual({ present: true, needs: { protocol: 'native', providers: ['deepseek'], sandbox: false } });
  });

  it('returns empty rows for no runners and does not mutate its input', () => {
    expect(buildCredentialBoard([], DASH_NOW, 7)).toEqual({ generatedAt: DASH_NOW.toISOString(), warnDays: 7, runners: [], providers: [], profiles: [] });
    const input = [board()];
    const snapshot = JSON.stringify(input);
    buildCredentialBoard(input, DASH_NOW, 7);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && bunx jest src/fleet/dashboard/credential-board.spec.ts`
Expected: FAIL — cannot find module `./credential-board`.

- [ ] **Step 3: Implement** — `apps/api/src/fleet/dashboard/credential-board.ts`:

```ts
import type { ProfileNeeds, RunnerCapabilities, RunnerCredential } from '../common/protocol';
import { MisfitReason, profileMisfit } from '../jobs/placement-rules';

/** Fleet S3 §4.4: the admin credential board, derived from `Runner.capabilities` only (no storage). */
export type CredentialCellState = 'ok' | 'expiring' | 'expired' | 'unavailable' | 'missing';
export type CredentialCellKind = 'api-key' | 'oauth' | 'exec' | 'ambient' | 'none';
export interface CredentialCell { state: CredentialCellState; kind: CredentialCellKind; expires?: string }
export interface ProfileCell { present: boolean; needs?: ProfileNeeds; misfit?: MisfitReason }
export interface BoardRunner { id: string; name: string; enabled: boolean; online: boolean; capabilities: RunnerCapabilities | null }
export interface CredentialBoardRunner { id: string; name: string; enabled: boolean; online: boolean; readable: boolean }
export interface CredentialBoard {
  generatedAt: string;
  warnDays: number;
  runners: CredentialBoardRunner[];
  providers: Array<{ providerId: string; cells: Record<string, CredentialCell> }>;
  profiles: Array<{ name: string; runners: Record<string, ProfileCell> }>;
}

const DAY_MS = 86_400_000;
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** D473: an unexpired OAuth credential whose `expires` is within `warnDays` (a past, unflagged date counts too). */
export function isExpiring(cred: RunnerCredential, now: Date, warnDays: number): boolean {
  const stored = cred.stored;
  if (stored?.kind !== 'oauth' || stored.expired || stored.expires === undefined) return false;
  const at = Date.parse(stored.expires);
  return Number.isFinite(at) && at - now.getTime() <= warnDays * DAY_MS;
}

function kindOf(cred: RunnerCredential): CredentialCellKind {
  if (cred.stored) return cred.stored.kind;
  if (cred.exec) return 'exec';
  return cred.ambient ? 'ambient' : 'none';
}

function stateOf(cred: RunnerCredential, now: Date, warnDays: number): CredentialCellState {
  if (!cred.available) return 'unavailable';
  if (cred.stored?.expired) return 'expired';
  return isExpiring(cred, now, warnDays) ? 'expiring' : 'ok';
}

export function credentialCell(cred: RunnerCredential | undefined, now: Date, warnDays: number): CredentialCell {
  if (!cred) return { state: 'missing', kind: 'none' };
  const expires = cred.stored?.expires;
  return { state: stateOf(cred, now, warnDays), kind: kindOf(cred), ...(expires !== undefined ? { expires } : {}) };
}

function profileCell(caps: RunnerCapabilities, name: string): ProfileCell {
  if (!Object.prototype.hasOwnProperty.call(caps.profiles, name)) return { present: false };
  const needs = caps.profiles[name];
  const misfit = profileMisfit(needs, caps);
  return { present: true, needs, ...(misfit ? { misfit } : {}) };
}

export function buildCredentialBoard(runners: readonly BoardRunner[], now: Date, warnDays: number): CredentialBoard {
  const readable = runners.flatMap((r) => (r.capabilities ? [{ id: r.id, caps: r.capabilities }] : []));
  const providerIds = [...new Set(readable.flatMap(({ caps }) => [
    ...caps.credentials.map((c) => c.providerId),
    ...Object.values(caps.profiles).flatMap((p) => p.providers),
  ]))].sort(byCodeUnit);
  const profileNames = [...new Set(readable.flatMap(({ caps }) => Object.keys(caps.profiles)))].sort(byCodeUnit);
  return {
    generatedAt: now.toISOString(),
    warnDays,
    runners: runners.map((r) => ({ id: r.id, name: r.name, enabled: r.enabled, online: r.online, readable: r.capabilities !== null })),
    providers: providerIds.map((providerId) => ({
      providerId,
      cells: Object.fromEntries(readable.map(({ id, caps }) =>
        [id, credentialCell(caps.credentials.find((c) => c.providerId === providerId), now, warnDays)] as const)),
    })),
    profiles: profileNames.map((name) => ({
      name,
      runners: Object.fromEntries(readable.map(({ id, caps }) => [id, profileCell(caps, name)] as const)),
    })),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && bunx jest src/fleet/dashboard/credential-board.spec.ts && bun run type-check`
Expected: PASS; type-check clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/fleet/dashboard/credential-board.ts apps/api/src/fleet/dashboard/credential-board.spec.ts
git commit -m "feat(fleet): credential board derivation (S3 §4.4, D473)"
```

---

### Task A4: Dashboard `expiring` credential condition

**Files:**
- Modify: `apps/api/src/fleet/dashboard/dashboard.types.ts` (`AttentionThresholds` ~line 10; `CREDENTIAL_WHY` ~line 105)
- Modify: `apps/api/src/common/test-helpers/fleet-dashboard.ts:9-11`
- Modify: `apps/api/src/fleet/dashboard/attention-runners.ts:15-30` (`credentialConditions`) and `runnerUnhealthyItems`
- Modify: `apps/api/src/fleet/dashboard/dashboard.service.ts:10,36-39`
- Test: `apps/api/src/fleet/dashboard/attention-runners.spec.ts`, `apps/api/src/fleet/dashboard/dashboard.service.spec.ts`

**Interfaces:**
- Consumes: `isExpiring` (Task A3), `IFleetConfig.credentialExpiryWarnDays` (Task A1).
- Produces: `CREDENTIAL_WHY = ['missing', 'unavailable', 'expired', 'expiring']`;
  `AttentionThresholds.credentialExpiryWarnDays: number`. `RunnerConditionDto.why` enum picks it up automatically
  (it uses `CREDENTIAL_WHY`).

Rule (spec §4.4): `expiring` is added for an OAuth credential `isExpiring` reports, unless the same provider already
has a `missing`/`unavailable`/`expired` condition; like `expired`, it applies even when no profile names the provider.
An `expiring` condition alone never escalates the item to `error` (it blocks no placement), and alone it still raises
a `warning` item.

- [ ] **Step 1: Write the failing tests** — append to the `describe('runner_unhealthy ...')` block in
  `attention-runners.spec.ts`:

```ts
  it('warns on an OAuth credential expiring within the window, even when no profile names it (S3 §4.4)', () => {
    const soon = new Date(DASH_NOW.getTime() + 3 * 86_400_000).toISOString();
    const later = new Date(DASH_NOW.getTime() + 30 * 86_400_000).toISOString();
    const caps = dashCaps({
      profiles: {},
      credentials: [
        { providerId: 'claude', available: true, stored: { kind: 'oauth', expires: soon, expired: false }, ambient: false },
        { providerId: 'codex', available: true, stored: { kind: 'oauth', expires: later, expired: false }, ambient: false },
      ],
    });
    expect(run([dashRunner({ capabilities: caps })])).toEqual([
      expect.objectContaining({ severity: 'warning', conditions: [{ type: 'credential', providerId: 'claude', why: 'expiring' }] }),
    ]);
  });

  it('does not add expiring for a provider already reported, and expiring alone never escalates to error', () => {
    const soon = new Date(DASH_NOW.getTime() + 1 * 86_400_000).toISOString();
    const unavailable = dashCaps({
      credentials: [{ providerId: 'deepseek', available: false, stored: { kind: 'oauth', expires: soon, expired: false }, ambient: false }],
    });
    expect(run([dashRunner({ capabilities: unavailable })])[0].conditions).toEqual([{ type: 'credential', providerId: 'deepseek', why: 'unavailable' }]);
    const expiringOnly = dashCaps({
      credentials: [{ providerId: 'deepseek', available: true, stored: { kind: 'oauth', expires: soon, expired: false }, ambient: false }],
    });
    expect(run([dashRunner({ capabilities: expiringOnly })], new Map(), new Set(['r1']))[0]).toMatchObject({
      severity: 'warning', conditions: [{ type: 'credential', providerId: 'deepseek', why: 'expiring' }],
    });
  });

  it('honours the configured window', () => {
    const in10 = new Date(DASH_NOW.getTime() + 10 * 86_400_000).toISOString();
    const caps = dashCaps({ credentials: [{ providerId: 'deepseek', available: true, stored: { kind: 'oauth', expires: in10, expired: false }, ambient: false }] });
    expect(run([dashRunner({ capabilities: caps })])).toEqual([]);
    expect(runnerUnhealthyItems([dashRunner({ capabilities: caps })], new Map(), new Set(), DASH_NOW, { ...DASH_THRESHOLDS, credentialExpiryWarnDays: 14 }))
      .toHaveLength(1);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && bunx jest src/fleet/dashboard/attention-runners.spec.ts`
Expected: FAIL — no `expiring` condition; type error on `credentialExpiryWarnDays`.

- [ ] **Step 3: Implement**

`dashboard.types.ts` — add to `AttentionThresholds`:

```ts
  /** S3 §4.4 (D473): OAuth expiry window (days) for the `expiring` credential condition. */
  credentialExpiryWarnDays: number;
```

and change `CREDENTIAL_WHY`:

```ts
export const CREDENTIAL_WHY = ['missing', 'unavailable', 'expired', 'expiring'] as const;
```

`common/test-helpers/fleet-dashboard.ts` — `DASH_THRESHOLDS` becomes:

```ts
export const DASH_THRESHOLDS: AttentionThresholds = {
  runnerOfflineSec: 90, jobSilentSec: 180, jobSilentErrorSec: 600, jobStartSec: 300, jobQueuedWarnSec: 60, credentialExpiryWarnDays: 7,
};
```

`attention-runners.ts` — import `import { isExpiring } from './credential-board';`, replace `credentialConditions`
with:

```ts
/**
 * Spec §2.4, D405: providers named by the runner's own profiles that have no credential (missing) or
 * an unavailable one; then api-key credentials that expired; then (S3 §4.4, D473) OAuth credentials expiring within
 * the window. OAuth expiry itself is still ignored (nax refreshes; placement follows `available`).
 */
function credentialConditions(caps: RunnerCapabilities, now: Date, warnDays: number): RunnerCondition[] {
  const needed = [...new Set(Object.values(caps.profiles).flatMap((p) => p.providers))].sort();
  const fromProfiles = needed.flatMap((providerId): RunnerCondition[] => {
    const credential = caps.credentials.find((c) => c.providerId === providerId);
    if (!credential) return [{ type: 'credential', providerId, why: 'missing' }];
    return credential.available ? [] : [{ type: 'credential', providerId, why: 'unavailable' }];
  });
  const reported = new Set(fromProfiles.map((c) => c.providerId));
  const expired = caps.credentials
    .filter((c) => c.stored?.kind === 'api-key' && c.stored.expired && !reported.has(c.providerId))
    .map((c): RunnerCondition => ({ type: 'credential', providerId: c.providerId, why: 'expired' }));
  const seen = new Set([...reported, ...expired.map((c) => c.providerId)]);
  const expiring = caps.credentials
    .filter((c) => c.available && !seen.has(c.providerId) && isExpiring(c, now, warnDays))
    .map((c): RunnerCondition => ({ type: 'credential', providerId: c.providerId, why: 'expiring' }));
  return [...fromProfiles, ...expired, ...expiring];
}
```

In `runnerUnhealthyItems`, change the credentials line and the `fixable` line:

```ts
    const credentials = caps ? credentialConditions(caps, now, t.credentialExpiryWarnDays) : [];
```

```ts
    // `expiring` blocks no placement, so it never makes the item an error (S3 §4.4).
    const fixable = credentials.filter((c) => c.why !== 'expiring').length + interaction.length > 0;
```

`dashboard.service.ts` — extend the `DashboardConfig` pick with `'credentialExpiryWarnDays'` and add
`credentialExpiryWarnDays: this.cfg.credentialExpiryWarnDays,` to the `thresholds` literal.

Add to `dashboard.service.spec.ts` (inside its `describe`):

```ts
  it('passes the credential expiry window to the attention rules (S3 §4.4)', async () => {
    const soon = new Date(DASH_NOW.getTime() + 10 * 86_400_000).toISOString();
    const caps = dashCaps({ credentials: [{ providerId: 'deepseek', available: true, stored: { kind: 'oauth', expires: soon, expired: false }, ambient: false }] });
    const repo = fakeRepo({ findRunners: jest.fn().mockResolvedValue([rawRunner({ capabilities: caps })]), findActiveJobs: jest.fn().mockResolvedValue([]) });
    const v7 = await new FleetDashboardService(repo, budgets, testFleetConfig()).snapshot({ kind: 'global' }, DASH_NOW);
    expect(v7.attention).toEqual([]);
    const v14 = await new FleetDashboardService(repo, budgets, testFleetConfig({ credentialExpiryWarnDays: 14 })).snapshot({ kind: 'global' }, DASH_NOW);
    expect(v14.attention.map((a) => a.conditions)).toEqual([[{ type: 'credential', providerId: 'deepseek', why: 'expiring' }]]);
  });
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && bunx jest src/fleet/dashboard && bun run type-check`
Expected: PASS. (The existing "flags an expired api-key but never OAuth expiry" test still passes: its OAuth
credential is `expired: true`, which `isExpiring` excludes.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/fleet/dashboard/dashboard.types.ts apps/api/src/common/test-helpers/fleet-dashboard.ts apps/api/src/fleet/dashboard/attention-runners.ts apps/api/src/fleet/dashboard/attention-runners.spec.ts apps/api/src/fleet/dashboard/dashboard.service.ts apps/api/src/fleet/dashboard/dashboard.service.spec.ts
git commit -m "feat(fleet): dashboard warns on OAuth credentials expiring soon (S3 §4.4)"
```

---

### Task A5: `GET /fleet/credential-board` (global admin)

Global-admin fleet routes in this repo live at `/fleet/...` with `@RequiredPermission('ADMIN')` (e.g.
`fleet/dashboard`, `fleet/budgets`); there is no `/admin` API prefix. The board follows that convention:
`GET /api/fleet/credential-board`.

**Files:**
- Create: `apps/api/src/fleet/dashboard/credential-board.service.ts`
- Create: `apps/api/src/fleet/dashboard/credential-board.service.spec.ts`
- Create: `apps/api/src/fleet/dashboard/dto/credential-board.dto.ts`
- Create: `apps/api/src/fleet/dashboard/fleet-credential-board.controller.ts`
- Modify: `apps/api/src/fleet/dashboard/dashboard.module.ts`
- Modify: `apps/api/src/fleet/fleet-openapi.contract.spec.ts`
- Create: `apps/api/test/integration/fleet/fleet-credential-board-api.integration.spec.ts`
- Regenerate: `openapi.json`, `apps/cli/src/generated/`

**Interfaces:**
- Consumes: `buildCredentialBoard`, `BoardRunner`, `CredentialBoard` (A3); `DASHBOARD_REPOSITORY.findRunners()`;
  `readCapabilities` (`dashboard-view.ts`); `isRunnerOnline` (`../common/runner-online`); `FLEET_CFG`.
- Produces: `CredentialBoardService.board(now: Date): Promise<CredentialBoard>`; route
  `GET /api/fleet/credential-board` -> `JsonResponse.Ok(CredentialBoard)`; DTOs `CredentialBoardDto`,
  `CredentialBoardRunnerDto`, `CredentialCellDto`, `CredentialProviderRowDto`, `ProfileCellDto`,
  `ProfileNeedsDto`, `ProfileRowDto`.

- [ ] **Step 1: Write the failing unit test** — `credential-board.service.spec.ts`:

```ts
import { testFleetConfig } from '../../common/test-helpers/fleet-config';
import { DASH_NOW, dashCaps, secAgo } from '../../common/test-helpers/fleet-dashboard';
import { CredentialBoardService } from './credential-board.service';
import type { IDashboardRepository, RawRunnerRow } from './domain/dashboard.domain';

const raw = (over: Partial<RawRunnerRow> = {}): RawRunnerRow => ({
  id: 'r1', name: 'wk-mac', os: 'darwin', arch: 'arm64', labels: [], enabled: true, lastSeenAt: secAgo(10), capacity: 1,
  daemonVersion: '0.4.0', capabilities: dashCaps(), ...over,
});

describe('CredentialBoardService (S3 §4.4)', () => {
  it('derives the board from every runner, re-validating capabilities and computing online on the server clock', async () => {
    const repo = { findRunners: jest.fn().mockResolvedValue([raw(), raw({ id: 'r2', name: 'old', lastSeenAt: secAgo(500), capabilities: { broken: true } })]) };
    const service = new CredentialBoardService(repo as unknown as IDashboardRepository, testFleetConfig({ credentialExpiryWarnDays: 5 }));
    const board = await service.board(DASH_NOW);
    expect(board.warnDays).toBe(5);
    expect(board.runners).toEqual([
      { id: 'r1', name: 'wk-mac', enabled: true, online: true, readable: true },
      { id: 'r2', name: 'old', enabled: true, online: false, readable: false },
    ]);
    expect(board.providers.map((p) => p.providerId)).toEqual(['deepseek']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && bunx jest src/fleet/dashboard/credential-board.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service** — `credential-board.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { isRunnerOnline } from '../common/runner-online';
import { buildCredentialBoard, CredentialBoard } from './credential-board';
import { readCapabilities } from './dashboard-view';
import { DASHBOARD_REPOSITORY, IDashboardRepository } from './domain/dashboard.domain';

type BoardConfig = Pick<IFleetConfig, 'runnerOfflineSec' | 'credentialExpiryWarnDays'>;

/** Fleet S3 §4.4: one read of every runner; the board is derived, never stored. */
@Injectable()
export class CredentialBoardService {
  constructor(
    @Inject(DASHBOARD_REPOSITORY) private readonly repo: IDashboardRepository,
    @Inject(FLEET_CFG) private readonly cfg: BoardConfig,
  ) {}

  async board(now: Date): Promise<CredentialBoard> {
    const runners = await this.repo.findRunners();
    return buildCredentialBoard(
      runners.map((r) => ({
        id: r.id, name: r.name, enabled: r.enabled,
        online: isRunnerOnline(r.lastSeenAt, now, this.cfg.runnerOfflineSec),
        capabilities: readCapabilities(r.capabilities),
      })),
      now,
      this.cfg.credentialExpiryWarnDays,
    );
  }
}
```

Run: `cd apps/api && bunx jest src/fleet/dashboard/credential-board.service.spec.ts` — Expected: PASS.

- [ ] **Step 4: DTOs** — `dto/credential-board.dto.ts`:

```ts
import { ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';
import type {
  CredentialBoard, CredentialBoardRunner, CredentialCell, CredentialCellKind, CredentialCellState, ProfileCell,
} from '../credential-board';
import { MISFIT_REASONS } from '../dashboard.types';
import type { MisfitReason } from '../../jobs/placement-rules';
import type { NaxProtocol, ProfileNeeds } from '../../common/protocol';

const STATES: readonly CredentialCellState[] = ['ok', 'expiring', 'expired', 'unavailable', 'missing'];
const KINDS: readonly CredentialCellKind[] = ['api-key', 'oauth', 'exec', 'ambient', 'none'];

export class CredentialBoardRunnerDto implements CredentialBoardRunner {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty() enabled: boolean;
  @ApiProperty({ description: 'Synced within FLEET_RUNNER_OFFLINE_SEC' }) online: boolean;
  @ApiProperty({ description: 'False when the stored capabilities do not parse; the runner then has no cells' }) readable: boolean;
}

export class CredentialCellDto implements CredentialCell {
  @ApiProperty({ enum: STATES }) state: CredentialCellState;
  @ApiProperty({ enum: KINDS }) kind: CredentialCellKind;
  @ApiPropertyOptional({ format: 'date-time' }) expires?: string;
}

export class CredentialProviderRowDto {
  @ApiProperty() providerId: string;
  @ApiProperty({ type: 'object', additionalProperties: { $ref: getSchemaPath(CredentialCellDto) }, description: 'Keyed by runner id' })
  cells: Record<string, CredentialCell>;
}

export class ProfileNeedsDto implements Omit<ProfileNeeds, 'interaction'> {
  @ApiProperty({ enum: ['acp', 'native'] }) protocol: NaxProtocol;
  @ApiProperty({ type: [String] }) providers: string[];
  @ApiProperty() sandbox: boolean;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true }) interaction?: ProfileNeeds['interaction'];
}

export class ProfileCellDto implements ProfileCell {
  @ApiProperty() present: boolean;
  @ApiPropertyOptional({ type: ProfileNeedsDto }) needs?: ProfileNeeds;
  @ApiPropertyOptional({ enum: MISFIT_REASONS }) misfit?: MisfitReason;
}

export class ProfileRowDto {
  @ApiProperty() name: string;
  @ApiProperty({ type: 'object', additionalProperties: { $ref: getSchemaPath(ProfileCellDto) }, description: 'Keyed by runner id' })
  runners: Record<string, ProfileCell>;
}

export class CredentialBoardDto implements CredentialBoard {
  @ApiProperty({ format: 'date-time' }) generatedAt: string;
  @ApiProperty({ description: 'FLEET_CREDENTIAL_EXPIRY_WARN_DAYS' }) warnDays: number;
  @ApiProperty({ type: [CredentialBoardRunnerDto] }) runners: CredentialBoardRunner[];
  @ApiProperty({ type: [CredentialProviderRowDto] }) providers: CredentialProviderRowDto[];
  @ApiProperty({ type: [ProfileRowDto] }) profiles: ProfileRowDto[];
}
```

- [ ] **Step 5: Controller + module** — `fleet-credential-board.controller.ts`:

```ts
import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequiredPermission } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { CredentialBoardService } from './credential-board.service';
import { CredentialBoardDto, CredentialCellDto, ProfileCellDto } from './dto/credential-board.dto';

/** Fleet S3 §4.4: provider x runner credential grid and profile inventory (global admin). */
@ApiTags('fleet')
@ApiBearerAuth()
@ApiExtraModels(CredentialCellDto, ProfileCellDto)
@Controller('fleet/credential-board')
export class FleetCredentialBoardController {
  constructor(private readonly board: CredentialBoardService) {}

  @Get()
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Credential health per provider and runner, and the profile inventory (global admin)' })
  @ApiResponse({ status: 200, type: CredentialBoardDto })
  async get() {
    return JsonResponse.Ok(await this.board.board(new Date()));
  }
}
```

In `dashboard.module.ts` import both and set:

```ts
  controllers: [ProjectFleetDashboardController, FleetDashboardController, FleetCredentialBoardController],
  providers: [
    PrismaDashboardRepository, { provide: DASHBOARD_REPOSITORY, useExisting: PrismaDashboardRepository }, FleetDashboardService,
    CredentialBoardService,
  ],
```

- [ ] **Step 6: Write the integration test** — `test/integration/fleet/fleet-credential-board-api.integration.spec.ts`:

```ts
/**
 * Fleet S3 §4.4 — credential board route (PG): global admin only, derived from stored capabilities.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-credential-board-api.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import type { RunnerCapabilities } from '../../../src/fleet/common/protocol';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FLEET_CAPS, FleetHttpWorld, insertRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

interface Board {
  warnDays: number;
  runners: Array<{ id: string; name: string; readable: boolean; online: boolean }>;
  providers: Array<{ providerId: string; cells: Record<string, { state: string; kind: string }> }>;
  profiles: Array<{ name: string; runners: Record<string, { present: boolean; misfit?: string }> }>;
}

describeIntegration('fleet credential board API (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  const ids: Record<string, string> = {};
  const auth = (who: keyof FleetHttpWorld['tokens']) => ({ Authorization: `Bearer ${world.tokens[who]}` });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
    ids.mac = (await insertRunner(prisma, {
      name: 'wk-mac',
      capabilities: { ...FLEET_CAPS, credentials: [{ providerId: 'claude', available: true, stored: { kind: 'oauth', expires: soon, expired: false }, ambient: false }] },
    })).id;
    // A stored blob that no longer parses (spec §1.4 of the dashboard): the board lists it unreadable.
    ids.broken = (await insertRunner(prisma, { name: 'broken', capabilities: { not: 'caps' } as unknown as RunnerCapabilities })).id;
  });
  afterAll(async () => {
    await app.close();
  });

  it('refuses project members and outsiders', async () => {
    for (const who of ['dev', 'viewer', 'outsider'] as const) {
      await request(server).get('/api/fleet/credential-board').set(auth(who)).expect(403);
    }
  });

  it('returns the grid and the profile inventory for a global admin', async () => {
    const board = data<Board>(await request(server).get('/api/fleet/credential-board').set(auth('root')).expect(200));
    expect(board.warnDays).toBe(7);
    expect(board.runners.find((r) => r.id === ids.broken)).toMatchObject({ readable: false });
    const claude = board.providers.find((p) => p.providerId === 'claude');
    expect(claude?.cells[ids.mac]).toEqual({ state: 'expiring', kind: 'oauth', expires: expect.any(String) });
    expect(claude?.cells[ids.broken]).toBeUndefined();
    expect(board.profiles.length).toBeGreaterThan(0);
    expect(board.profiles.every((p) => p.runners[ids.mac] !== undefined)).toBe(true);
  });

  it('raises the expiring condition on the admin dashboard', async () => {
    const snap = data<{ attention: Array<{ subjectId: string; conditions?: Array<Record<string, unknown>> }> }>(
      await request(server).get('/api/fleet/dashboard').set(auth('root')).expect(200));
    const item = snap.attention.find((a) => a.subjectId === ids.mac);
    expect(item?.conditions).toEqual(expect.arrayContaining([{ type: 'credential', providerId: 'claude', why: 'expiring' }]));
  });
});
```

`insertRunner(prisma, over)` (`apps/api/test/helpers/fleet-fixtures.ts:30`) takes `capabilities: RunnerCapabilities`;
`FLEET_CAPS` (line 7) has the `fast` profile naming `deepseek` and a `deepseek` api-key credential, so replacing the
credentials array makes `deepseek` `missing` on `wk-mac` and `fast` misfit `provider_missing` there.

- [ ] **Step 7: Run the integration test**

Run: `cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/fleet-credential-board-api.integration.spec.ts`
Expected: 3 passing.

- [ ] **Step 8: Regenerate the contract and pin it** — add to `fleet-openapi.contract.spec.ts`:

```ts
  it('exposes the credential board (S3 §4.4)', () => {
    expect(spec.paths['/api/fleet/credential-board']?.['get']).toBeDefined();
    expect(Object.keys(spec.components.schemas['CredentialBoardDto']?.properties ?? {}).sort())
      .toEqual(['generatedAt', 'profiles', 'providers', 'runners', 'warnDays']);
    expect(JSON.stringify(spec.components.schemas['CredentialCellDto'])).toContain('expiring');
    expect(JSON.stringify(spec.components.schemas['RunnerConditionDto'])).toContain('expiring');
  });
```

Run:

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda && bun run generate
cd apps/api && bunx jest src/fleet/fleet-openapi.contract.spec.ts && bun run lint && bun run type-check
```

Expected: `openapi.json` and `apps/cli/src/generated/` change; contract spec PASS; lint and type-check clean.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/fleet/dashboard apps/api/src/fleet/fleet-openapi.contract.spec.ts apps/api/test/integration/fleet/fleet-credential-board-api.integration.spec.ts openapi.json apps/cli/src/generated
git commit -m "feat(fleet): GET /fleet/credential-board for global admins (S3 §4.4)"
```

---

### Task A6: Web board types, helpers, composable and the dashboard `expiring` label

**Files:**
- Modify: `apps/web/lib/fleet-dashboard-types.ts:14` (`CREDENTIAL_WHY`)
- Create: `apps/web/lib/fleet-credential-board.ts`
- Create: `apps/web/composables/useFleetCredentialBoard.ts`
- Modify: `apps/web/i18n/locales/en.json`, `apps/web/i18n/locales/zh.json`
- Modify: `apps/web/tests/i18n/fleet-locale-parity.spec.ts`
- Test: `apps/web/tests/lib/fleet-credential-board.spec.ts`, `apps/web/tests/composables/useFleetCredentialBoard.spec.ts`

**Interfaces:**
- Consumes: `GET /fleet/credential-board` (Task A5) — same JSON as `CredentialBoard` in A3.
- Produces (exact):

```ts
// lib/fleet-credential-board.ts
export const CELL_STATES = ['ok', 'expiring', 'expired', 'unavailable', 'missing'] as const
export type CellState = (typeof CELL_STATES)[number]
export interface BoardCell { state: CellState; kind: CredentialKind; expires?: string }
export interface BoardProfileNeeds { protocol: string; providers: string[]; sandbox: boolean }
export interface BoardProfileCell { present: boolean; needs?: BoardProfileNeeds; misfit?: string }
export interface BoardRunner { id: string; name: string; enabled: boolean; online: boolean; readable: boolean }
export interface CredentialBoard {
  generatedAt: string
  warnDays: number
  runners: BoardRunner[]
  providers: Array<{ providerId: string; cells: Record<string, BoardCell> }>
  profiles: Array<{ name: string; runners: Record<string, BoardProfileCell> }>
}
export const BOARD_PATH = '/fleet/credential-board'
export function cellTone(state: CellState): ChipTone
export function cellLabelKey(state: string): string           // fleet.credentials.state.<state>, unknown -> .unknown
export function profileCellLabel(cell: BoardProfileCell | undefined): { key: string }
export function rowNeeds(row: CredentialBoard['profiles'][number]): { needs: BoardProfileNeeds | null; differs: boolean }

// composables/useFleetCredentialBoard.ts
export function useFleetCredentialBoard(): {
  data: ShallowRef<CredentialBoard | null>; pending: Ref<boolean>; forbidden: Ref<boolean>; failed: Ref<boolean>; load: () => Promise<void>
}
```

Tones: `ok` -> `ok`; `expiring`, `expired` -> `warn`; `unavailable`, `missing` -> `bad`.
`profileCellLabel`: undefined (unreadable runner) -> `fleet.credentials.profiles.unknown`; `!present` ->
`fleet.credentials.profiles.absent`; `misfit` -> `fleet.misfit.<misfit>`; else `fleet.credentials.profiles.ready`.
`rowNeeds`: the needs of the first present cell in object order; `differs` is true when another present cell's needs
differ (deep compare of protocol, sorted providers, sandbox).

- [ ] **Step 1: Write the failing lib test** — `tests/lib/fleet-credential-board.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import { cellLabelKey, cellTone, profileCellLabel, rowNeeds } from '~/lib/fleet-credential-board'

describe('fleet credential board helpers (S3 §6)', () => {
  test('tones follow the chip scale', () => {
    expect(cellTone('ok')).toBe('ok')
    expect(cellTone('expiring')).toBe('warn')
    expect(cellTone('expired')).toBe('warn')
    expect(cellTone('unavailable')).toBe('bad')
    expect(cellTone('missing')).toBe('bad')
  })

  test('state label keys, with a fallback for an unknown state', () => {
    expect(cellLabelKey('expiring')).toBe('fleet.credentials.state.expiring')
    expect(cellLabelKey('weird')).toBe('fleet.credentials.state.unknown')
  })

  test('profile cell labels: unknown, absent, misfit, ready', () => {
    expect(profileCellLabel(undefined)).toEqual({ key: 'fleet.credentials.profiles.unknown' })
    expect(profileCellLabel({ present: false })).toEqual({ key: 'fleet.credentials.profiles.absent' })
    expect(profileCellLabel({ present: true, misfit: 'sandbox' })).toEqual({ key: 'fleet.misfit.sandbox' })
    expect(profileCellLabel({ present: true })).toEqual({ key: 'fleet.credentials.profiles.ready' })
  })

  test('row needs come from the first present runner and flag disagreement', () => {
    const fast = { protocol: 'native', providers: ['b', 'a'], sandbox: false }
    expect(rowNeeds({ name: 'fast', runners: { r1: { present: false }, r2: { present: true, needs: fast } } }))
      .toEqual({ needs: fast, differs: false })
    expect(rowNeeds({ name: 'fast', runners: { r1: { present: true, needs: fast }, r2: { present: true, needs: { ...fast, providers: ['a', 'b'] } } } }).differs)
      .toBe(false)
    expect(rowNeeds({ name: 'fast', runners: { r1: { present: true, needs: fast }, r2: { present: true, needs: { ...fast, sandbox: true } } } }).differs)
      .toBe(true)
    expect(rowNeeds({ name: 'gone', runners: { r1: { present: false } } })).toEqual({ needs: null, differs: false })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && bunx jest tests/lib/fleet-credential-board.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `lib/fleet-credential-board.ts`:

```ts
import type { ChipTone, CredentialKind } from '~/lib/fleet-capabilities'

/** Fleet S3 §4.4/§6: the admin credential board as `GET /fleet/credential-board` returns it. */
export const CELL_STATES = ['ok', 'expiring', 'expired', 'unavailable', 'missing'] as const
export type CellState = (typeof CELL_STATES)[number]
export interface BoardCell { state: CellState; kind: CredentialKind; expires?: string }
export interface BoardProfileNeeds { protocol: string; providers: string[]; sandbox: boolean }
export interface BoardProfileCell { present: boolean; needs?: BoardProfileNeeds; misfit?: string }
export interface BoardRunner { id: string; name: string; enabled: boolean; online: boolean; readable: boolean }
export interface CredentialBoard {
  generatedAt: string
  warnDays: number
  runners: BoardRunner[]
  providers: Array<{ providerId: string; cells: Record<string, BoardCell> }>
  profiles: Array<{ name: string; runners: Record<string, BoardProfileCell> }>
}

export const BOARD_PATH = '/fleet/credential-board'

const TONES: Record<CellState, ChipTone> = { ok: 'ok', expiring: 'warn', expired: 'warn', unavailable: 'bad', missing: 'bad' }

export function cellTone(state: CellState): ChipTone {
  return TONES[state] ?? 'bad'
}

export function cellLabelKey(state: string): string {
  return (CELL_STATES as readonly string[]).includes(state) ? `fleet.credentials.state.${state}` : 'fleet.credentials.state.unknown'
}

export function profileCellLabel(cell: BoardProfileCell | undefined): { key: string } {
  if (!cell) return { key: 'fleet.credentials.profiles.unknown' }
  if (!cell.present) return { key: 'fleet.credentials.profiles.absent' }
  return cell.misfit ? { key: `fleet.misfit.${cell.misfit}` } : { key: 'fleet.credentials.profiles.ready' }
}

const sameNeeds = (a: BoardProfileNeeds, b: BoardProfileNeeds): boolean =>
  a.protocol === b.protocol && a.sandbox === b.sandbox && [...a.providers].sort().join('\n') === [...b.providers].sort().join('\n')

export function rowNeeds(row: CredentialBoard['profiles'][number]): { needs: BoardProfileNeeds | null; differs: boolean } {
  const present = Object.values(row.runners).flatMap((c) => (c.present && c.needs ? [c.needs] : []))
  const first = present[0] ?? null
  return { needs: first, differs: first !== null && present.some((n) => !sameNeeds(first, n)) }
}
```

Run: `cd apps/web && bunx jest tests/lib/fleet-credential-board.spec.ts` — Expected: PASS.

- [ ] **Step 4: Write the failing composable test** — `tests/composables/useFleetCredentialBoard.spec.ts`:

```ts
import { afterEach, describe, expect, jest, test } from '@jest/globals'
import { ApiError } from '~/composables/useApi'
import type { CredentialBoard } from '~/lib/fleet-credential-board'

const g = globalThis as Record<string, unknown>
const BOARD: CredentialBoard = { generatedAt: '2026-10-07T00:00:00.000Z', warnDays: 7, runners: [], providers: [], profiles: [] }

async function load(get: jest.Mock) {
  g.useApi = () => ({ $api: { get } })
  return (await import('~/composables/useFleetCredentialBoard')).useFleetCredentialBoard()
}

describe('useFleetCredentialBoard (S3 §6)', () => {
  afterEach(() => { delete g.useApi })

  test('loads the board from the admin route', async () => {
    const get = jest.fn(async () => BOARD)
    const board = await load(get)
    await board.load()
    expect(get).toHaveBeenCalledWith('/fleet/credential-board')
    expect(board.data.value).toEqual(BOARD)
    expect(board.failed.value).toBe(false)
  })

  test.each([40003, 403])('a %s marks it forbidden and keeps no data', async (code) => {
    const board = await load(jest.fn(async () => { throw new ApiError(code, 'forbidden') }))
    await board.load()
    expect(board.forbidden.value).toBe(true)
    expect(board.data.value).toBeNull()
  })

  test('another error marks it failed and keeps the last board', async () => {
    const get = jest.fn<() => Promise<unknown>>().mockResolvedValueOnce(BOARD).mockRejectedValueOnce(new Error('down'))
    const board = await load(get)
    await board.load()
    await board.load()
    expect(board.failed.value).toBe(true)
    expect(board.data.value).toEqual(BOARD)
  })
})
```

- [ ] **Step 5: Implement** — `composables/useFleetCredentialBoard.ts`:

```ts
import { ref, shallowRef } from 'vue'
import { isForbidden } from '~/composables/useFleetBudgetPage'
import { BOARD_PATH } from '~/lib/fleet-credential-board'
import type { CredentialBoard } from '~/lib/fleet-credential-board'

/** Fleet S3 §6: the admin credential board, loaded on demand (no polling; the page has a Refresh button). */
export function useFleetCredentialBoard() {
  const { $api } = useApi()
  const data = shallowRef<CredentialBoard | null>(null)
  const pending = ref(false)
  const forbidden = ref(false)
  const failed = ref(false)

  async function load(): Promise<void> {
    if (forbidden.value) return
    pending.value = true
    try {
      data.value = await $api.get<CredentialBoard>(BOARD_PATH)
      failed.value = false
    } catch (err: unknown) {
      if (isForbidden(err)) forbidden.value = true
      else failed.value = true
    } finally {
      pending.value = false
    }
  }

  return { data, pending, forbidden, failed, load }
}
```

Run: `cd apps/web && bunx jest tests/composables/useFleetCredentialBoard.spec.ts` — Expected: PASS.

- [ ] **Step 6: Dashboard `expiring` label + i18n** — in `lib/fleet-dashboard-types.ts`:

```ts
export const CREDENTIAL_WHY = ['missing', 'unavailable', 'expired', 'expiring'] as const
```

In `tests/i18n/fleet-locale-parity.spec.ts`, change the pinned list and add the board enums to `ENUMS`:

```ts
  'fleet.dashboard.attention.condition.credential': ['missing', 'unavailable', 'expired', 'expiring'],
  'fleet.credentials.state': ['ok', 'expiring', 'expired', 'unavailable', 'missing', 'unknown'],
  'fleet.credentials.profiles': ['ready', 'absent', 'unknown'],
```

and inside the test that compares API enumerations (the one ending with the `CREDENTIAL_WHY` assertion, ~line 126),
add (and import `CELL_STATES` from `~/lib/fleet-credential-board`):

```ts
    expect(ENUMS['fleet.credentials.state'].filter((s) => s !== 'unknown').sort()).toEqual([...CELL_STATES].sort())
```

`en.json` — under `fleet.dashboard.attention.condition.credential` add
`"expiring": "OAuth credential for {provider} expires soon"`; under `fleet.dashboard.runners` add
`"board": "Credential board"`; under `fleet.runners.actions` add `"credentials": "Credential board"`; add a new
`fleet.credentials` object (sibling of `fleet.runners`):

```json
"credentials": {
  "title": "Credential board",
  "subtitle": "Provider credentials and profiles on every runner. OAuth credentials expiring within {days} days are flagged.",
  "refresh": "Refresh",
  "empty": "No runners enrolled",
  "loadFailed": "Could not load the credential board",
  "tabs": { "grid": "Credentials", "profiles": "Profiles" },
  "grid": { "provider": "Provider", "unreadable": "Capabilities unreadable", "expires": "until {date}" },
  "state": {
    "ok": "OK", "expiring": "Expiring", "expired": "Expired", "unavailable": "Unavailable", "missing": "Missing", "unknown": "Unknown"
  },
  "profiles": {
    "profile": "Profile", "needs": "Needs", "needsValue": "{protocol} · {providers}", "sandbox": "sandbox",
    "differs": "differs by runner", "ready": "Ready", "absent": "Not installed", "unknown": "Unknown"
  }
}
```

`zh.json` — same keys:

```json
"credentials": {
  "title": "凭据面板",
  "subtitle": "所有运行器上的提供商凭据与配置档。{days} 天内到期的 OAuth 凭据会被标记。",
  "refresh": "刷新",
  "empty": "尚未注册运行器",
  "loadFailed": "无法加载凭据面板",
  "tabs": { "grid": "凭据", "profiles": "配置档" },
  "grid": { "provider": "提供商", "unreadable": "能力信息无法读取", "expires": "至 {date}" },
  "state": {
    "ok": "正常", "expiring": "即将到期", "expired": "已过期", "unavailable": "不可用", "missing": "缺失", "unknown": "未知"
  },
  "profiles": {
    "profile": "配置档", "needs": "需求", "needsValue": "{protocol} · {providers}", "sandbox": "沙箱",
    "differs": "各运行器不一致", "ready": "就绪", "absent": "未安装", "unknown": "未知"
  }
}
```

plus `fleet.dashboard.attention.condition.credential.expiring`: `"{provider} 的 OAuth 凭据即将到期"`,
`fleet.dashboard.runners.board`: `"凭据面板"`, `fleet.runners.actions.credentials`: `"凭据面板"`.

- [ ] **Step 7: Run**

Run: `cd apps/web && bunx jest tests/i18n tests/lib/fleet-dashboard-attention.spec.ts tests/lib/fleet-credential-board.spec.ts tests/composables/useFleetCredentialBoard.spec.ts`
Expected: PASS (locale parity, the dashboard label test resolves `expiring` through `conditionText`).

- [ ] **Step 8: Commit**

```bash
git add apps/web/lib/fleet-dashboard-types.ts apps/web/lib/fleet-credential-board.ts apps/web/composables/useFleetCredentialBoard.ts apps/web/i18n/locales/en.json apps/web/i18n/locales/zh.json apps/web/tests/i18n/fleet-locale-parity.spec.ts apps/web/tests/lib/fleet-credential-board.spec.ts apps/web/tests/composables/useFleetCredentialBoard.spec.ts
git commit -m "feat(web): credential board data layer and dashboard expiring label (S3 §6)"
```

---

### Task A7: `CredentialGrid` and `ProfileInventory` components

**Files:**
- Create: `apps/web/components/fleet/credentials/CredentialGrid.vue`
- Create: `apps/web/components/fleet/credentials/ProfileInventory.vue`
- Modify: `apps/web/tests/helpers/mount-sfc.ts` (`FLEET_COMPONENT_FILES` ~line 245, `FleetComponentName` ~line 343)
- Test: `apps/web/tests/components/fleet-credentials.spec.ts`

**Interfaces:**
- Consumes: `CredentialBoard`, `cellTone`, `cellLabelKey`, `profileCellLabel`, `rowNeeds` (A6).
- Produces: components `FleetCredentialsCredentialGrid` and `FleetCredentialsProfileInventory`, prop
  `board: CredentialBoard`. Test ids: `fleet-credentials-grid`, `fleet-credentials-runner-head` (`data-runner`,
  `data-dimmed`), `fleet-credentials-cell` (`data-provider`, `data-runner`, `data-state`),
  `fleet-credentials-profiles`, `fleet-credentials-profile-row` (`data-profile`), `fleet-credentials-profile-cell`
  (`data-profile`, `data-runner`, `data-misfit`).

- [ ] **Step 1: Register the components in the test harness** — `tests/helpers/mount-sfc.ts`: add to
  `FLEET_COMPONENT_FILES`:

```ts
  FleetCredentialsCredentialGrid: 'credentials/CredentialGrid.vue',
  FleetCredentialsProfileInventory: 'credentials/ProfileInventory.vue',
```

and to the `FleetComponentName` union: `| 'FleetCredentialsCredentialGrid' | 'FleetCredentialsProfileInventory'`.

- [ ] **Step 2: Write the failing component test** — `tests/components/fleet-credentials.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import type { CredentialBoard } from '~/lib/fleet-credential-board'

const file = (name: string): string => webFile('components', 'fleet', 'credentials', name)
const mount = (name: string, board: CredentialBoard) =>
  mountSfc(file(name), { props: { board }, components: uiStubs, globals: { useI18n: () => enI18n() } })
const byId = (app: ReturnType<typeof mountSfc>, id: string) => app.find(`[data-testid="${id}"]`)

const BOARD: CredentialBoard = {
  generatedAt: '2026-10-07T00:00:00.000Z',
  warnDays: 7,
  runners: [
    { id: 'r1', name: 'wk-mac', enabled: true, online: true, readable: true },
    { id: 'r2', name: 'old-box', enabled: true, online: false, readable: true },
    { id: 'r3', name: 'broken', enabled: false, online: true, readable: false },
  ],
  providers: [
    { providerId: 'claude', cells: { r1: { state: 'expiring', kind: 'oauth', expires: '2026-10-09T00:00:00.000Z' }, r2: { state: 'missing', kind: 'none' } } },
  ],
  profiles: [
    { name: 'fast', runners: { r1: { present: true, needs: { protocol: 'native', providers: ['claude'], sandbox: true } }, r2: { present: true, needs: { protocol: 'native', providers: ['claude'], sandbox: true }, misfit: 'provider_missing' } } },
  ],
}

describe('FleetCredentialsCredentialGrid (S3 §6)', () => {
  test('one header per runner, offline or disabled dimmed, unreadable runners marked', () => {
    const app = mount('CredentialGrid.vue', BOARD)
    expect(byId(app, 'fleet-credentials-runner-head').map((n) => [n.props['data-runner'], n.props['data-dimmed']]))
      .toEqual([['r1', 'false'], ['r2', 'true'], ['r3', 'true']])
    expect(app.text()).toContain('Capabilities unreadable')
  })

  test('a cell per provider and readable runner with state, kind and expiry date', () => {
    const app = mount('CredentialGrid.vue', BOARD)
    const cells = byId(app, 'fleet-credentials-cell')
    expect(cells.map((n) => [n.props['data-provider'], n.props['data-runner'], n.props['data-state']]))
      .toEqual([['claude', 'r1', 'expiring'], ['claude', 'r2', 'missing'], ['claude', 'r3', 'none']])
    const first = app.textOf(cells[0])
    expect(first).toContain('Expiring')
    expect(first).toContain('until 2026-10-09')
    expect(app.textOf(cells[2])).toBe('-')
  })
})

describe('FleetCredentialsProfileInventory (S3 §6)', () => {
  test('a row per profile with its needs and a cell per runner showing ready, misfit or unknown', () => {
    const app = mount('ProfileInventory.vue', BOARD)
    expect(byId(app, 'fleet-credentials-profile-row').map((n) => n.props['data-profile'])).toEqual(['fast'])
    expect(app.text()).toContain('native · claude')
    const cells = byId(app, 'fleet-credentials-profile-cell')
    expect(cells.map((n) => [n.props['data-runner'], n.props['data-misfit']])).toEqual([['r1', ''], ['r2', 'provider_missing'], ['r3', '']])
    expect(cells.map((n) => app.textOf(n))).toEqual(['Ready', expect.any(String), 'Unknown'])
    expect(app.textOf(cells[1])).not.toBe('Ready')
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd apps/web && bunx jest tests/components/fleet-credentials.spec.ts`
Expected: FAIL — component files missing.

- [ ] **Step 4: Implement `CredentialGrid.vue`**

```vue
<script setup lang="ts">
import type { ChipTone } from '~/lib/fleet-capabilities'
import { cellLabelKey, cellTone } from '~/lib/fleet-credential-board'
import type { BoardCell, CredentialBoard } from '~/lib/fleet-credential-board'

/** Fleet S3 §6: providers x runners; a runner with unreadable capabilities has no cells. */
defineProps<{ board: CredentialBoard }>()
const { t } = useI18n()

function variantOf(tone: ChipTone): 'secondary' | 'outline' | 'destructive' {
  if (tone === 'bad') return 'destructive'
  return tone === 'warn' ? 'outline' : 'secondary'
}

function cellText(cell: BoardCell): string {
  const state = t(cellLabelKey(cell.state))
  const kind = t(`fleet.runners.chip.kind.${cell.kind}`)
  const until = cell.expires ? ` ${t('fleet.credentials.grid.expires', { date: cell.expires.slice(0, 10) })}` : ''
  return cell.state === 'missing' ? state : `${state} · ${kind}${until}`
}
</script>

<template>
  <Table data-testid="fleet-credentials-grid">
    <TableHeader>
      <TableRow>
        <TableHead>{{ t('fleet.credentials.grid.provider') }}</TableHead>
        <TableHead
          v-for="runner in board.runners"
          :key="runner.id"
          data-testid="fleet-credentials-runner-head"
          :data-runner="runner.id"
          :data-dimmed="!runner.online || !runner.enabled ? 'true' : 'false'"
          :class="!runner.online || !runner.enabled ? 'opacity-60' : ''"
        >
          <div class="font-medium">{{ runner.name }}</div>
          <div v-if="!runner.readable" class="text-xs text-muted-foreground">{{ t('fleet.credentials.grid.unreadable') }}</div>
        </TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      <TableRow v-for="row in board.providers" :key="row.providerId">
        <TableCell class="font-medium">{{ row.providerId }}</TableCell>
        <TableCell
          v-for="runner in board.runners"
          :key="runner.id"
          data-testid="fleet-credentials-cell"
          :data-provider="row.providerId"
          :data-runner="runner.id"
          :data-state="row.cells[runner.id]?.state ?? 'none'"
        >
          <Badge v-if="row.cells[runner.id]" :variant="variantOf(cellTone(row.cells[runner.id].state))">{{ cellText(row.cells[runner.id]) }}</Badge>
          <span v-else class="text-muted-foreground">-</span>
        </TableCell>
      </TableRow>
    </TableBody>
  </Table>
</template>
```

- [ ] **Step 5: Implement `ProfileInventory.vue`**

```vue
<script setup lang="ts">
import { profileCellLabel, rowNeeds } from '~/lib/fleet-credential-board'
import type { CredentialBoard } from '~/lib/fleet-credential-board'

/** Fleet S3 §6: every profile any runner reports, what it needs, and whether each runner can serve it. */
defineProps<{ board: CredentialBoard }>()
const { t } = useI18n()

function needsText(row: CredentialBoard['profiles'][number]): string {
  const { needs, differs } = rowNeeds(row)
  if (!needs) return '-'
  const base = t('fleet.credentials.profiles.needsValue', { protocol: needs.protocol, providers: needs.providers.join(', ') || '-' })
  const sandbox = needs.sandbox ? ` · ${t('fleet.credentials.profiles.sandbox')}` : ''
  const note = differs ? ` (${t('fleet.credentials.profiles.differs')})` : ''
  return `${base}${sandbox}${note}`
}
</script>

<template>
  <Table data-testid="fleet-credentials-profiles">
    <TableHeader>
      <TableRow>
        <TableHead>{{ t('fleet.credentials.profiles.profile') }}</TableHead>
        <TableHead>{{ t('fleet.credentials.profiles.needs') }}</TableHead>
        <TableHead v-for="runner in board.runners" :key="runner.id" :class="!runner.online || !runner.enabled ? 'opacity-60' : ''">
          {{ runner.name }}
        </TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      <TableRow v-for="row in board.profiles" :key="row.name" data-testid="fleet-credentials-profile-row" :data-profile="row.name">
        <TableCell class="font-medium">{{ row.name }}</TableCell>
        <TableCell class="text-sm">{{ needsText(row) }}</TableCell>
        <TableCell
          v-for="runner in board.runners"
          :key="runner.id"
          data-testid="fleet-credentials-profile-cell"
          :data-profile="row.name"
          :data-runner="runner.id"
          :data-misfit="row.runners[runner.id]?.misfit ?? ''"
        >
          <Badge
            v-if="row.runners[runner.id]?.present"
            :variant="row.runners[runner.id]?.misfit ? 'destructive' : 'secondary'"
          >{{ t(profileCellLabel(row.runners[runner.id]).key) }}</Badge>
          <span v-else class="text-muted-foreground">{{ t(profileCellLabel(row.runners[runner.id]).key) }}</span>
        </TableCell>
      </TableRow>
    </TableBody>
  </Table>
</template>
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd apps/web && bunx jest tests/components/fleet-credentials.spec.ts`
Expected: PASS. (If `textOf` on the `-` placeholder returns surrounding whitespace, compare with `.trim()`.)

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/fleet/credentials apps/web/tests/helpers/mount-sfc.ts apps/web/tests/components/fleet-credentials.spec.ts
git commit -m "feat(web): credential grid and profile inventory components (S3 §6)"
```

---

### Task A8: `/admin/fleet/credentials` page and its entry links

**Files:**
- Create: `apps/web/pages/admin/fleet/credentials.vue`
- Modify: `apps/web/pages/admin/fleet/runners.vue` (PageHeader `#actions`, ~line 82)
- Modify: `apps/web/components/fleet/dashboard/Overview.vue:50-53` (Runners section)
- Modify: `apps/web/tests/helpers/fleet-harness.ts:81-98` (`uiStubs`)
- Test: `apps/web/tests/pages/admin-fleet-credentials.spec.ts`; extend `apps/web/tests/pages/fleet-dashboard-pages.spec.ts`

**Interfaces:**
- Consumes: `useFleetCredentialBoard` (A6), `FleetCredentialsCredentialGrid`, `FleetCredentialsProfileInventory` (A7).
- Produces: route `/admin/fleet/credentials`; test ids `fleet-credentials-forbidden`, `fleet-credentials-refresh`,
  `fleet-credentials-tab-grid`, `fleet-credentials-tab-profiles`, `fleet-runners-credentials-link`,
  `fleet-dashboard-credentials-link`. No sidebar nav link (the layout is pinned by `tests/layouts/*`; the spec only
  asks for links from the runners page and the dashboard).

- [ ] **Step 1: Tabs stubs in the harness** — in `tests/helpers/fleet-harness.ts` add to the `uiStubs` tag list:

```ts
    ['Tabs', 'tabs'], ['TabsList', 'tabs-list'], ['TabsTrigger', 'tabs-trigger'], ['TabsContent', 'tabs-content'],
```

- [ ] **Step 2: Write the failing page test** — `tests/pages/admin-fleet-credentials.spec.ts`:

```ts
import { describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { computed, ref, shallowRef } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { ApiError } from '../../composables/useApi'
import type { CredentialBoard } from '~/lib/fleet-credential-board'

const page = webFile('pages', 'admin', 'fleet', 'credentials.vue')
const BOARD: CredentialBoard = {
  generatedAt: '2026-10-07T00:00:00.000Z', warnDays: 7,
  runners: [{ id: 'r1', name: 'wk-mac', enabled: true, online: true, readable: true }],
  providers: [{ providerId: 'claude', cells: { r1: { state: 'ok', kind: 'oauth' } } }],
  profiles: [{ name: 'fast', runners: { r1: { present: true, needs: { protocol: 'native', providers: ['claude'], sandbox: false } } } }],
}

type Get = jest.Mock<(path: string) => Promise<unknown>>

function mountPage(get: Get) {
  const app = mountSfc(page, {
    components: uiStubs,
    fleetComponents: ['FleetCredentialsCredentialGrid', 'FleetCredentialsProfileInventory'],
    alias: { '~/composables/useApi': apiModule },
    globals: {
      ref, computed, shallowRef, onMounted: Vue.onMounted,
      useI18n: () => enI18n(),
      useApi: () => ({ $api: { get } }),
      definePageMeta: () => undefined,
    },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  return { app, settle, byId: (id: string) => app.find(`[data-testid="${id}"]`) }
}

describe('admin credential board page (S3 §6)', () => {
  test('loads the board on mount and renders both tabs', async () => {
    const get: Get = jest.fn(async () => BOARD)
    const p = mountPage(get)
    await p.settle()
    expect(get.mock.calls.map(([path]) => path)).toEqual(['/fleet/credential-board'])
    expect(p.app.find('[data-stub="page-header"]')[0].props.title).toBe('Credential board')
    expect(p.byId('fleet-credentials-grid')).toHaveLength(1)
    expect(p.byId('fleet-credentials-profiles')).toHaveLength(1)
    expect(p.byId('fleet-credentials-tab-grid')).toHaveLength(1)
    expect(p.byId('fleet-credentials-tab-profiles')).toHaveLength(1)
  })

  test('Refresh reloads', async () => {
    const get: Get = jest.fn(async () => BOARD)
    const p = mountPage(get)
    await p.settle()
    ;(p.byId('fleet-credentials-refresh')[0].props.onClick as () => void)()
    await p.settle()
    expect(get).toHaveBeenCalledTimes(2)
  })

  test.each([40003, 403])('a %s shows the admin-only note and no board', async (code) => {
    const p = mountPage(jest.fn(async () => { throw new ApiError(code, 'forbidden') }) as Get)
    await p.settle()
    expect(p.app.textOf(p.byId('fleet-credentials-forbidden')[0])).toBe('Only global administrators can manage the fleet.')
    expect(p.byId('fleet-credentials-grid')).toHaveLength(0)
  })
})
```

Also extend `tests/pages/fleet-dashboard-pages.spec.ts` — in the first admin test add:

```ts
    expect(p.byId('fleet-dashboard-credentials-link').map((n) => n.props.to)).toEqual(['/admin/fleet/credentials'])
```

and in the project-scope page test (the one mounting `projectPage`) add:

```ts
    expect(p.byId('fleet-dashboard-credentials-link')).toHaveLength(0)
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd apps/web && bunx jest tests/pages/admin-fleet-credentials.spec.ts tests/pages/fleet-dashboard-pages.spec.ts`
Expected: FAIL — page missing; link missing.

- [ ] **Step 4: Implement the page** — `pages/admin/fleet/credentials.vue`:

```vue
<script setup lang="ts">
import { onMounted } from 'vue'
import { useFleetCredentialBoard } from '~/composables/useFleetCredentialBoard'

definePageMeta({ layout: 'default' })

/** Fleet S3 §6: provider credentials and profiles on every runner (global admin; others see the 403 note). */
const { t } = useI18n()
const { data, pending, forbidden, failed, load } = useFleetCredentialBoard()

onMounted(() => { void load() })
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('fleet.credentials.title')" :subtitle="t('fleet.credentials.subtitle', { days: data?.warnDays ?? 7 })">
      <template #actions>
        <Button variant="outline" :disabled="pending || forbidden" data-testid="fleet-credentials-refresh" @click="load()">
          {{ t('fleet.credentials.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <p v-if="forbidden" class="text-sm text-muted-foreground" data-testid="fleet-credentials-forbidden">{{ t('fleet.common.adminOnly') }}</p>
    <template v-else>
      <ErrorState v-if="failed && !data" @retry="load()" />
      <LoadingState v-else-if="!data" />
      <EmptyState v-else-if="data.runners.length === 0" :message="t('fleet.credentials.empty')" />
      <Tabs v-else default-value="grid">
        <TabsList>
          <TabsTrigger value="grid" data-testid="fleet-credentials-tab-grid">{{ t('fleet.credentials.tabs.grid') }}</TabsTrigger>
          <TabsTrigger value="profiles" data-testid="fleet-credentials-tab-profiles">{{ t('fleet.credentials.tabs.profiles') }}</TabsTrigger>
        </TabsList>
        <TabsContent value="grid" class="overflow-x-auto">
          <FleetCredentialsCredentialGrid :board="data" />
        </TabsContent>
        <TabsContent value="profiles" class="overflow-x-auto">
          <FleetCredentialsProfileInventory :board="data" />
        </TabsContent>
      </Tabs>
    </template>
  </div>
</template>
```

- [ ] **Step 5: Entry links**

`pages/admin/fleet/runners.vue` — inside `<template #actions>` before the Enroll button:

```vue
        <NuxtLink
          to="/admin/fleet/credentials"
          class="mr-4 self-center text-sm text-primary underline-offset-4 hover:underline"
          data-testid="fleet-runners-credentials-link"
        >{{ t('fleet.runners.actions.credentials') }}</NuxtLink>
```

(`components/ui/button/Button.vue` is a plain `<button>` with no `as-child`, so the link is a styled `NuxtLink`.)

`components/fleet/dashboard/Overview.vue` — replace the Runners section `h2` line with:

```vue
        <div class="flex items-center justify-between">
          <h2 class="text-sm font-semibold">{{ t('fleet.dashboard.sections.runners') }}</h2>
          <NuxtLink
            v-if="scope === 'global'"
            to="/admin/fleet/credentials"
            class="text-sm text-primary underline-offset-4 hover:underline"
            data-testid="fleet-dashboard-credentials-link"
          >{{ t('fleet.dashboard.runners.board') }}</NuxtLink>
        </div>
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd apps/web && bunx jest tests/pages tests/components && bun run lint && bun run type-check`
Expected: PASS; the existing `admin-fleet-runners.spec.ts` still passes (if it asserts the exact header action list,
add the link to its expectation).

- [ ] **Step 7: Commit**

```bash
git add apps/web/pages/admin/fleet/credentials.vue apps/web/pages/admin/fleet/runners.vue apps/web/components/fleet/dashboard/Overview.vue apps/web/tests/helpers/fleet-harness.ts apps/web/tests/pages/admin-fleet-credentials.spec.ts apps/web/tests/pages/fleet-dashboard-pages.spec.ts
git commit -m "feat(web): admin credential board page (S3 §6)"
```

---

### Task A9: E2E — credential board tabs and the expiring warning

**Files:**
- Modify: `apps/web/tests/e2e/fixtures/scripted-runner.ts:101-113` (`enroll` opts)
- Create: `apps/web/tests/e2e/fleet-credentials.e2e.spec.ts`

**Interfaces:**
- Consumes: `ScriptedRunner.enroll(adminToken, name, { capabilities })`, `login`, `E2E_ADMIN`, `webLogin`,
  `waitForHydration`, `call` (from `./fixtures/fleet-budgets-api`).

- [ ] **Step 1: Capabilities override on the scripted runner** — change the `enroll` signature and capabilities line:

```ts
  static async enroll(
    adminToken: string, name: string, opts: { relay?: boolean; logs?: boolean; capabilities?: Record<string, unknown> } = {},
  ): Promise<ScriptedRunner> {
    const protocolVersion = opts.logs ? 3 : opts.relay ? 2 : 1;
    const base = opts.capabilities ?? E2E_RUNNER_CAPABILITIES;
    const capabilities = opts.relay ? { ...base, approvals: { relay: true } } : base;
```

(Update the doc comment above it: "With `capabilities` the runner reports that blob instead of the default.")

- [ ] **Step 2: Write the E2E** — `tests/e2e/fleet-credentials.e2e.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { login, E2E_ADMIN } from './fixtures/api-client';
import { call } from './fixtures/fleet-budgets-api';
import { waitForHydration, webLogin } from './fixtures/page-helpers';
import { E2E_RUNNER_CAPABILITIES, ScriptedRunner } from './fixtures/scripted-runner';

/**
 * Fleet S3 §8 E2E: a scripted runner reports an OAuth credential expiring in 3 days and a sandboxed profile it
 * cannot serve. The admin board shows the expiring cell and the profile misfit; the dashboard raises `expiring`.
 * Assertions key on this run's runner id, provider and profile names, so other specs' runners do not matter.
 */
test.describe('Fleet credential board (scripted runner)', () => {
  const suffix = Date.now().toString().slice(-6);
  const provider = `e2e-oauth-${suffix}`;
  const profile = `e2e-boxed-${suffix}`;
  let token = '';
  let runner: ScriptedRunner;

  test.beforeAll(async () => {
    token = (await login(E2E_ADMIN.email, E2E_ADMIN.password)).token;
    const expires = new Date(Date.now() + 3 * 86_400_000).toISOString();
    runner = await ScriptedRunner.enroll(token, `e2e-credentials-runner-${suffix}`, {
      capabilities: {
        ...E2E_RUNNER_CAPABILITIES,
        sandbox: { available: false, probedAt: '2026-10-01T00:00:00.000Z' },
        profiles: { ...E2E_RUNNER_CAPABILITIES.profiles, [profile]: { protocol: 'native', providers: ['deepseek'], sandbox: true } },
        credentials: [...E2E_RUNNER_CAPABILITIES.credentials, { providerId: provider, available: true, stored: { kind: 'oauth', expires, expired: false }, ambient: false }],
      },
    });
    await runner.heartbeat();
  });

  test('the grid shows the expiring credential and the profiles tab the sandbox misfit', async ({ page }) => {
    test.setTimeout(90_000);
    const snap = await call<{ attention: Array<{ subjectId: string; conditions?: Array<{ providerId?: string; why?: string }> }> }>('GET', '/fleet/dashboard', token);
    expect(snap.attention.find((a) => a.subjectId === runner.id)?.conditions).toEqual(
      expect.arrayContaining([expect.objectContaining({ providerId: provider, why: 'expiring' })]));

    await webLogin(page);
    await page.goto('/admin/fleet/credentials');
    await waitForHydration(page);
    const cell = page.locator(`[data-testid="fleet-credentials-cell"][data-provider="${provider}"][data-runner="${runner.id}"]`);
    await expect(cell).toHaveAttribute('data-state', 'expiring', { timeout: 15_000 });
    await expect(cell).toContainText('Expiring');

    await page.getByTestId('fleet-credentials-tab-profiles').click();
    const profileCell = page.locator(`[data-testid="fleet-credentials-profile-cell"][data-profile="${profile}"][data-runner="${runner.id}"]`);
    await expect(profileCell).toHaveAttribute('data-misfit', 'sandbox');

    await page.goto('/admin/fleet');
    await waitForHydration(page);
    await page.getByTestId('fleet-dashboard-credentials-link').click();
    await expect(page).toHaveURL(/\/admin\/fleet\/credentials$/);
  });
});
```

- [ ] **Step 3: Run the E2E**

Run: `cd apps/web && bunx playwright test tests/e2e/fleet-credentials.e2e.spec.ts`
(The config boots the API on 3102 and web on 3103 against `koda_e2e` on the compose test Postgres; start it first
with `cd apps/api && bun run test:db:up` if it is not running.)
Expected: 1 passed. Also re-run `tests/e2e/fleet-dashboard.e2e.spec.ts` (it uses `enroll` without the new option).

- [ ] **Step 4: Commit**

```bash
git add apps/web/tests/e2e/fixtures/scripted-runner.ts apps/web/tests/e2e/fleet-credentials.e2e.spec.ts
git commit -m "test(web): credential board e2e (S3 §8)"
```

---

### Task A10: PR 1 gates and pull request

**Files:** none new.

- [ ] **Step 1: Full gates** (all must pass; fix and amend into the owning task's commit if anything fails)

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda
bun run generate && git status --short openapi.json apps/cli/src/generated   # expect no diff (A5 committed it)
cd apps/api && bun run lint && bun run type-check && bun run test && bun run test:db:up && KODA_DB_TESTS=1 bun run test:scoped test/integration/fleet/fleet-credential-board-api.integration.spec.ts test/integration/fleet/fleet-dashboard-api.integration.spec.ts
cd ../web && bun run lint && bun run type-check && bun run test
cd ../cli && bun run test
cd ../web && bunx playwright test tests/e2e/fleet-credentials.e2e.spec.ts tests/e2e/fleet-dashboard.e2e.spec.ts
```

Expected: every command exits 0. Check `bun run test:scoped` accepts multiple paths (read
`apps/api/scripts/test-scoped.ts`); if it takes one, run it once per file.

- [ ] **Step 2: Docs** — in `.nax/mono/apps/web/context.md` add under "Fleet overview (S2b (c))":

```markdown
- `/admin/fleet/credentials` (S3) renders `components/fleet/credentials/` from `useFleetCredentialBoard` (load on
  mount + Refresh, no polling). Board logic is pure in `lib/fleet-credential-board.ts`; a new cell state needs its key
  under `fleet.credentials.state` and its pin in `tests/i18n/fleet-locale-parity.spec.ts`.
```

then regenerate the agent files: `cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda && nax generate --all-packages`
and commit both (`docs: web context for the credential board`).

- [ ] **Step 3: Push and open the PR** (only with the user's go-ahead to push)

```bash
git push -u origin feat/fleet-s3-1-credential-board
gh pr create --base main --title "feat(fleet): S3 PR 1 — credential board" --body "$(cat <<'BODY'
## Summary
- `GET /api/fleet/credential-board` (global admin): provider x runner credential grid and profile inventory, derived from stored runner capabilities (S3 spec §4.4).
- Dashboard: new `expiring` credential condition for OAuth credentials expiring within `FLEET_CREDENTIAL_EXPIRY_WARN_DAYS` (default 7, D473); warn only, never escalates.
- Web: `/admin/fleet/credentials` (Credentials and Profiles tabs), linked from the runners page and the admin overview.
- Spec + plan: `docs/superpowers/specs/2026-10-07-fleet-s3-repo-config-and-credential-board-design.md`, `docs/superpowers/plans/2026-10-07-fleet-s3-repo-config-and-credential-board.md` (Part A).

## Test plan
- [ ] api unit + lint + type-check
- [ ] api integration: fleet-credential-board-api, fleet-dashboard-api
- [ ] web unit + lint + type-check
- [ ] e2e: fleet-credentials, fleet-dashboard
- [ ] openapi.json / CLI client regenerated, no diff
BODY
)"
```
## Part B1 — PR 2 (1/2): Contract and API

Implements spec §1, §2, §3 (server side), §4.1-§4.3 and the API halves of §6 "Other fleet surfaces". Part B2 adds the runner
and opens PR 2. All commands run from the repo root `/Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda`
unless a `cd` is shown. Integration tests need the compose Postgres: `cd apps/api && bun run test:db:up` once per session.

**Two facts every B1 task relies on (verified on main `a61c11aa`):**

- The API production image never ships `packages/` (`apps/api/src/fleet/common/protocol.spec.ts` enforces "production code
  imports `@nathapp/fleet-protocol` with `import type` only"). So every runtime value in the package (the allowlist
  functions, limits, `isConfigKind`) gets an API **mirror** under `apps/api/src/fleet/common/`, and a spec file (which may
  import the package at runtime) pins the mirror to the package. This is the existing `APPROVAL_TEXT_MAX_BYTES` pattern.
  The runner imports the package at runtime directly (B2). The web has no dependency on the package (Part C mirrors it).
- Test schema comes from `prisma db push` (`apps/api/test/global-setup.ts:56`); only partial indexes are replayed from
  `test/helpers/partial-indexes.ts`. The new table has a plain unique index, so `db push` covers it; the migration SQL is
  still committed for production.

### File structure (Part B1)

| Path | Responsibility |
|---|---|
| `packages/fleet-protocol/src/nax-config-paths.ts` (new) | Allowlist: `isAllowedNaxPath`, `naxPathGroup`, `NAX_CONFIG_LIMITS` |
| `packages/fleet-protocol/src/config-jobs.ts` (new) | Config job kinds, edit/result types, `isConfigKind`, result limits |
| `packages/fleet-protocol/src/index.ts` | Re-exports; `FleetJobKindName` union; `RunnerCapabilities.configJobs`; `SnapshotEventPayload.configResult` |
| `apps/api/src/fleet/common/protocol.ts` | Re-export the new types |
| `apps/api/src/fleet/common/nax-config-paths.ts` (new) | API runtime mirror of the allowlist |
| `apps/api/src/fleet/common/config-jobs.ts` (new) | API runtime mirror of `CONFIG_JOB_KINDS`, `isConfigKind`, `CONFIG_RESULT_LIMITS`, `CONFIG_COMPLETED_OUTCOMES` |
| `apps/api/src/fleet/common/nax-config-paths.spec.ts` (new) | Path table run against package and mirror; parity of limits and kinds |
| `apps/api/src/common/enums.ts` | `FleetJobKind` gains the two kinds |
| `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/20261008090000_fleet_config_jobs/migration.sql` (new) | `FleetJob.configResult`, `FleetConfigEdit` |
| `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts`, `prisma-fleet-job.repository.ts` | `configResult` on record/patch; `copyConfigResult` |
| `apps/api/src/fleet/common/capabilities-core.ts` | Accept `configJobs: true` |
| `apps/api/src/fleet/jobs/placement-rules.ts`, `placement.service.ts`, `dto/fleet-job.dto.ts` | `PlacementJob.command`, config-kind skips, `config_jobs` misfit, job-scope pause skip |
| `apps/api/src/fleet/repo-config/config-result.ts` (new) | `parseConfigResult` |
| `apps/api/src/fleet/sync/event-payloads.ts` | Mirror `configResult` |
| `apps/api/src/fleet/jobs/job-transitions.service.ts` | Copy `configResult` into `FleetConfigEdit.result` on a terminal config job |
| `apps/api/src/fleet/git-broker/github-app-client.ts`, `gitlab-access-checker.ts` | REST reads: branch head, tree, blob / tree, file |
| `apps/api/src/fleet/repo-config/fleet-repo-files.reader.ts` (new) | Reader interface, token, result types |
| `apps/api/src/fleet/repo-config/github-fleet-repo-files.reader.ts`, `gitlab-fleet-repo-files.reader.ts`, `fleet-repo-files.router.ts` (new) | Forge readers and provider router |
| `apps/api/src/fleet/repo-config/repo-config.exceptions.ts` (new) | `repo_unreachable` 409, `forge_error` 502, `file_unreadable` 422 |
| `apps/api/src/fleet/repo-config/config-edit-input.ts` (new) | `validateConfigEdits`, `validatePrTitle`, `validatePrBody`, `validateBaseSha` |
| `apps/api/src/fleet/repo-config/domain/config-edit.domain.ts`, `prisma-config-edit.repository.ts` (new) | `FleetConfigEdit` persistence |
| `apps/api/src/fleet/repo-config/config-jobs.service.ts` (new) | `submitEdit`, `submitRegenerate`, `submitDrift`, `getEditSet`, `listFiles`, `readFile`, `fetchForRunner` |
| `apps/api/src/fleet/repo-config/dto/*.ts` (new) | Request/response DTOs |
| `apps/api/src/fleet/repo-config/project-repo-config.controller.ts`, `project-job-config-edit.controller.ts`, `runner-config-edit.controller.ts`, `repo-config.module.ts` (new) | Routes; module |
| `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts`, `fleet-jobs.service.ts` | `FleetJobDto.configEdit`, `command` enum |
| `apps/api/src/fleet/analytics/prisma-analytics.repository.ts` | Exclude config kinds |
| `apps/api/src/i18n/{en,zh}/fleet.json` | New error messages |
| `openapi.json`, `apps/cli/src/generated/**` | Regenerated |

---

### Task B1-0: Cut the PR 2 branch

**Files:** none.

- [ ] **Step 1: Confirm PR 1 is merged and cut the branch from main**

```bash
git fetch origin
git switch main && git pull --ff-only
gh pr list --state merged --head feat/fleet-s3-1-credential-board --json number,mergedAt
git switch -c feat/fleet-s3-2-config-jobs
```

Expected: the `gh` call prints PR 1 with a `mergedAt`; the switch reports the new branch.

---

### Task B1-1: Protocol additions and the API mirrors (spec §2, §3)

**Files:**
- Create: `packages/fleet-protocol/src/nax-config-paths.ts`
- Create: `packages/fleet-protocol/src/config-jobs.ts`
- Modify: `packages/fleet-protocol/src/index.ts:7` (re-exports at top), `:56-68` (`RunnerCapabilities`), `:99` (`FleetJobKindName`), `:117-144` (`SnapshotEventPayload`)
- Modify: `apps/api/src/fleet/common/protocol.ts:1-40` (type re-exports)
- Create: `apps/api/src/fleet/common/nax-config-paths.ts`
- Create: `apps/api/src/fleet/common/config-jobs.ts`
- Modify: `apps/api/src/common/enums.ts:141-143`
- Modify: `apps/api/src/fleet/common/protocol.spec.ts:50`
- Test: `apps/api/src/fleet/common/nax-config-paths.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (package, exact):
  - `type NaxPathGroup = 'rules' | 'context' | 'config' | 'profiles' | 'constitution'`
  - `isAllowedNaxPath(path: string): boolean`, `naxPathGroup(path: string): NaxPathGroup | null`
  - `NAX_CONFIG_LIMITS = { maxEdits: 50, maxFileBytes: 262_144, maxTotalBytes: 1_048_576, maxPathChars: 512, maxPrTitleChars: 200, maxPrBodyBytes: 8_192 }`
  - `CONFIG_JOB_KINDS`, `ConfigJobKind`, `isConfigKind(command: string): command is ConfigJobKind`, `ConfigEditMode`, `ConfigFileEdit`, `ConfigEditPayload`, `ConfigJobOutcome`, `CONFIG_COMPLETED_OUTCOMES`, `ConfigJobResult`, `CONFIG_RESULT_LIMITS = { maxFiles: 50, maxFileChars: 512, maxOutputBytes: 8_192 }`
  - `FleetJobKindName = 'RUN' | 'PLAN' | ConfigJobKind`; `RunnerCapabilities.configJobs?: true`; `SnapshotEventPayload.configResult?: ConfigJobResult`
- Produces (API mirrors, same names, runtime): `apps/api/src/fleet/common/nax-config-paths.ts` exports `NaxPathGroup` (type), `isAllowedNaxPath`, `naxPathGroup`, `NAX_CONFIG_LIMITS`; `apps/api/src/fleet/common/config-jobs.ts` exports `CONFIG_JOB_KINDS`, `isConfigKind`, `CONFIG_COMPLETED_OUTCOMES`, `CONFIG_RESULT_LIMITS` and re-exports the types `ConfigJobKind`, `ConfigEditMode`, `ConfigFileEdit`, `ConfigEditPayload`, `ConfigJobOutcome`, `ConfigJobResult` (type-only from the package).
- Produces: `FleetJobKind.CONFIG_EDIT`, `FleetJobKind.CONFIG_DRIFT` in `apps/api/src/common/enums.ts`.

- [ ] **Step 1: Write the failing path-table spec**

Create `apps/api/src/fleet/common/nax-config-paths.spec.ts`:

```ts
// Runtime import of the package is allowed in a spec (protocol.spec.ts pins the rule for production code only).
import * as pkgPaths from '@nathapp/fleet-protocol';
import * as apiPaths from './nax-config-paths';
import * as apiJobs from './config-jobs';

const IMPLS = [
  ['package', pkgPaths.naxPathGroup, pkgPaths.isAllowedNaxPath],
  ['api mirror', apiPaths.naxPathGroup, apiPaths.isAllowedNaxPath],
] as const;

describe.each(IMPLS)('nax config allowlist (%s, spec §2)', (_name, group, allowed) => {
  it.each([
    ['.nax/rules/testing.md', 'rules'],
    ['.nax/rules/api/nest-conventions.md', 'rules'],
    ['.nax/context.md', 'context'],
    ['.nax/mono/apps/api/context.md', 'context'],
    ['.nax/mono/api/context.md', 'context'],
    ['.nax/config.json', 'config'],
    ['.nax/mono/apps/web/config.json', 'config'],
    ['.nax/profiles/fast.json', 'profiles'],
    ['.nax/profiles/codex-review.v2.json', 'profiles'],
    ['.nax/constitution.md', 'constitution'],
  ])('allows %s as %s', (path, expected) => {
    expect(group(path)).toBe(expected);
    expect(allowed(path)).toBe(true);
  });

  it.each([
    ['.nax/profiles/fast.env', 'an env profile'],
    ['.nax/profiles/fast.json.env', 'an env suffix'],
    ['.nax/rules/secrets.env/x.md', 'an env segment'],
    ['.nax/rules/../config.json', 'a dot-dot segment'],
    ['.nax/rules/./a.md', 'a dot segment'],
    ['.nax//context.md', 'an empty segment'],
    ['/.nax/context.md', 'an absolute path'],
    ['.nax\\context.md', 'a backslash'],
    ['.nax/context.md\u0000', 'a NUL'],
    ['.NAX/context.md', 'a case variant of .nax'],
    ['.nax/Rules/a.md', 'a case variant of rules'],
    ['.nax/CONTEXT.md', 'a case variant of context.md'],
    ['.nax/rules/a.txt', 'a non-md rule'],
    ['.nax/rules/.md', 'an empty rule name'],
    ['.nax/rules', 'the rules dir'],
    ['.nax/mono/context.md', 'mono without a package dir'],
    ['.nax/mono/apps/api/rules/a.md', 'a mono rules overlay (not allowlisted)'],
    ['.nax/profiles/sub/fast.json', 'a nested profile'],
    ['.nax/profiles/-bad.json', 'a profile name not starting alphanumeric'],
    ['.nax/features/x/prd.json', 'a feature file'],
    ['.nax/status.json', 'a runtime file'],
    ['AGENTS.md', 'a generated agent file'],
    ['CLAUDE.md', 'a generated agent file'],
    ['.nax/rules/has space.md', 'a space'],
    [`.nax/rules/${'a'.repeat(510)}.md`, 'a path over 512 chars'],
    ['', 'empty'],
  ])('refuses %s (%s)', (path) => {
    expect(group(path)).toBeNull();
    expect(allowed(path)).toBe(false);
  });

  it('refuses non-strings without throwing', () => {
    expect(allowed(42 as unknown as string)).toBe(false);
    expect(group(undefined as unknown as string)).toBeNull();
  });
});

describe('API mirrors match the package', () => {
  it('limits', () => {
    expect(apiPaths.NAX_CONFIG_LIMITS).toEqual(pkgPaths.NAX_CONFIG_LIMITS);
    expect(apiJobs.CONFIG_RESULT_LIMITS).toEqual(pkgPaths.CONFIG_RESULT_LIMITS);
  });
  it('kinds and completed outcomes', () => {
    expect([...apiJobs.CONFIG_JOB_KINDS]).toEqual([...pkgPaths.CONFIG_JOB_KINDS]);
    expect([...apiJobs.CONFIG_COMPLETED_OUTCOMES]).toEqual([...pkgPaths.CONFIG_COMPLETED_OUTCOMES]);
  });
  it.each([['CONFIG_EDIT', true], ['CONFIG_DRIFT', true], ['RUN', false], ['PLAN', false], ['config_edit', false]])(
    'isConfigKind(%s) is %s in both', (kind, expected) => {
      expect(apiJobs.isConfigKind(kind)).toBe(expected);
      expect(pkgPaths.isConfigKind(kind)).toBe(expected);
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bunx jest src/fleet/common/nax-config-paths.spec.ts`
Expected: FAIL, "Cannot find module './nax-config-paths'".

- [ ] **Step 3: Write the package modules**

Create `packages/fleet-protocol/src/nax-config-paths.ts`:

```ts
/**
 * Fleet S3 §2: the repo files a config edit may list, read, write or commit. Pure (no I/O); the API keeps a runtime
 * mirror (`apps/api/src/fleet/common/nax-config-paths.ts`) because its production image does not ship this package.
 */
export type NaxPathGroup = 'rules' | 'context' | 'config' | 'profiles' | 'constitution';

export const NAX_CONFIG_LIMITS = {
  maxEdits: 50,
  maxFileBytes: 262_144,
  maxTotalBytes: 1_048_576,
  maxPathChars: 512,
  maxPrTitleChars: 200,
  maxPrBodyBytes: 8_192,
} as const;

/** One path segment: no spaces, no shell or glob characters. Case-sensitive. */
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
/** nax profile names (#161 bound) plus `.json`. */
const PROFILE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json$/;

const ROOT_FILES: Readonly<Record<string, NaxPathGroup>> = {
  'context.md': 'context',
  'config.json': 'config',
  'constitution.md': 'constitution',
};
const MONO_FILES: Readonly<Record<string, NaxPathGroup>> = { 'context.md': 'context', 'config.json': 'config' };

export function naxPathGroup(path: string): NaxPathGroup | null {
  if (typeof path !== 'string' || path.length === 0 || path.length > NAX_CONFIG_LIMITS.maxPathChars) return null;
  if (path.includes('\\') || path.includes('\u0000') || path.startsWith('/')) return null;
  const parts = path.split('/');
  const badSegment = (p: string): boolean => p === '' || p === '.' || p === '..' || !SEGMENT_RE.test(p) || p.toLowerCase().endsWith('.env');
  if (parts.some(badSegment) || parts[0] !== '.nax' || parts.length < 2) return null;
  const top = parts[1];
  const rest = parts.slice(2);
  const file = parts[parts.length - 1];
  if (rest.length === 0) return Object.prototype.hasOwnProperty.call(ROOT_FILES, top) ? ROOT_FILES[top] : null;
  if (top === 'rules') return file.endsWith('.md') && file.length > '.md'.length ? 'rules' : null;
  if (top === 'profiles') return rest.length === 1 && PROFILE_FILE_RE.test(file) ? 'profiles' : null;
  if (top === 'mono' && rest.length >= 2) return Object.prototype.hasOwnProperty.call(MONO_FILES, file) ? MONO_FILES[file] : null;
  return null;
}

export function isAllowedNaxPath(path: string): boolean {
  return naxPathGroup(path) !== null;
}
```

Create `packages/fleet-protocol/src/config-jobs.ts`:

```ts
/** Fleet S3 §1, §3: config edit and drift jobs. The API mirrors the runtime values in apps/api/src/fleet/common/config-jobs.ts. */
export const CONFIG_JOB_KINDS = ['CONFIG_EDIT', 'CONFIG_DRIFT'] as const;
export type ConfigJobKind = (typeof CONFIG_JOB_KINDS)[number];

export function isConfigKind(command: string): command is ConfigJobKind {
  return (CONFIG_JOB_KINDS as readonly string[]).includes(command);
}

export type ConfigEditMode = 'edit' | 'regenerate' | 'drift';

/** `baseSha` is the git blob SHA the file was loaded at, or null for a file that did not exist. */
export interface ConfigFileEdit { path: string; op: 'put' | 'delete'; content?: string; baseSha: string | null }

/** `GET /fleet/runner/jobs/:jobId/config-edit` (spec §3). */
export interface ConfigEditPayload { mode: ConfigEditMode; edits: ConfigFileEdit[]; prTitle: string | null; prBody: string | null; baseSha: string }

export type ConfigJobOutcome = 'ok' | 'no_changes' | 'drift' | 'conflict' | 'invalid' | 'push_failed' | 'pr_failed' | 'timeout';

/** These end COMPLETED; every other outcome ends FAILED with stateReason = outcome (D471). */
export const CONFIG_COMPLETED_OUTCOMES: readonly ConfigJobOutcome[] = ['ok', 'no_changes', 'drift'];

/** Rides the snapshot event (D475). */
export interface ConfigJobResult { outcome: ConfigJobOutcome; files?: string[]; output?: string }

export const CONFIG_RESULT_LIMITS = { maxFiles: 50, maxFileChars: 512, maxOutputBytes: 8_192 } as const;
```

In `packages/fleet-protocol/src/index.ts`, directly under the header comment (after line 7 `export const FLEET_PROTOCOL_VERSION = 3 as const;`) add:

```ts
export * from './nax-config-paths';
export * from './config-jobs';
import type { ConfigJobKind, ConfigJobResult } from './config-jobs';
```

Inside `RunnerCapabilities`, after the `interaction?: InteractionCheck;` line add:

```ts
  /** Fleet S3 §3: the runner executes CONFIG_EDIT / CONFIG_DRIFT jobs. Absent on older runners (permanent misfit `config_jobs`). */
  configJobs?: true;
```

Replace `export type FleetJobKindName = 'RUN' | 'PLAN';` with:

```ts
export type FleetJobKindName = 'RUN' | 'PLAN' | ConfigJobKind;
```

Inside `SnapshotEventPayload`, after `droppedLogs?: number;` add:

```ts
  /** Fleet S3 §3 (D475): a config job's result; files at most 50 x 512 chars, output at most 8 KiB. */
  configResult?: ConfigJobResult;
```

- [ ] **Step 4: Write the API mirrors and enum**

Create `apps/api/src/fleet/common/nax-config-paths.ts` with exactly the body of the package module above (same code, same
comments) but with this header comment instead:

```ts
/**
 * Runtime mirror of packages/fleet-protocol/src/nax-config-paths.ts (fleet S3 §2, D467). The API image does not ship
 * workspace packages; nax-config-paths.spec.ts runs one path table against both and pins the limits equal.
 */
```

Create `apps/api/src/fleet/common/config-jobs.ts`:

```ts
/** Runtime mirror of packages/fleet-protocol/src/config-jobs.ts (fleet S3); nax-config-paths.spec.ts pins them equal. */
import type { ConfigJobKind, ConfigJobOutcome } from '@nathapp/fleet-protocol';

export type {
  ConfigEditMode, ConfigEditPayload, ConfigFileEdit, ConfigJobKind, ConfigJobOutcome, ConfigJobResult,
} from '@nathapp/fleet-protocol';

export const CONFIG_JOB_KINDS = ['CONFIG_EDIT', 'CONFIG_DRIFT'] as const;

export function isConfigKind(command: string): command is ConfigJobKind {
  return (CONFIG_JOB_KINDS as readonly string[]).includes(command);
}

export const CONFIG_COMPLETED_OUTCOMES: readonly ConfigJobOutcome[] = ['ok', 'no_changes', 'drift'];

export const CONFIG_RESULT_LIMITS = { maxFiles: 50, maxFileChars: 512, maxOutputBytes: 8_192 } as const;
```

In `apps/api/src/common/enums.ts` replace lines 141-143:

```ts
/** Fleet S1: FleetJob.command. S3 adds the config kinds (spec §1). */
export const FleetJobKind = { RUN: 'RUN', PLAN: 'PLAN', CONFIG_EDIT: 'CONFIG_EDIT', CONFIG_DRIFT: 'CONFIG_DRIFT' } as const;
export type FleetJobKind = (typeof FleetJobKind)[keyof typeof FleetJobKind];
```

In `apps/api/src/fleet/common/protocol.spec.ts:50` replace the `kinds` record:

```ts
  const kinds: Record<FleetJobKindName, true> = { RUN: true, PLAN: true, CONFIG_EDIT: true, CONFIG_DRIFT: true };
```

In `apps/api/src/fleet/common/protocol.ts`, add to the `export type { ... } from '@nathapp/fleet-protocol';` list (keep it
alphabetical): `ConfigEditMode, ConfigEditPayload, ConfigFileEdit, ConfigJobKind, ConfigJobOutcome, ConfigJobResult, NaxPathGroup,`.

- [ ] **Step 5: Run the specs and type checks**

Run: `cd apps/api && bunx jest src/fleet/common/ && cd ../.. && bun run --cwd packages/fleet-protocol type-check && bun run --cwd apps/api type-check`
Expected: PASS (nax-config-paths, protocol, capabilities specs); both type checks exit 0. If `type-check` reports
`FleetJobKind` exhaustiveness errors elsewhere (e.g. a `Record<FleetJobKind, ...>`), add the two kinds there with the same
value the RUN entry has and note it in the commit body.

- [ ] **Step 6: Commit**

```bash
git add packages/fleet-protocol/src apps/api/src/fleet/common apps/api/src/common/enums.ts
git commit -m "feat(fleet): S3 protocol - nax config allowlist, config job kinds and result types (D467)"
```

---

### Task B1-2: Schema, migration and the job record (spec §1)

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (model `FleetJob`, after `attributedAt`; relations block; new model after `FleetJob`)
- Create: `apps/api/prisma/migrations/20261008090000_fleet_config_jobs/migration.sql`
- Modify: `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts` (`FleetJobRecord`, `Mutable`, `IFleetJobRepository`)
- Modify: `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts:15-25` (`toJob`), `:107-125` (`update`), new method `copyConfigResult`
- Modify: `apps/api/src/fleet/jobs/fleet-jobs.service.ts` (requeue `extra`, add `configResult: null`)
- Test: `apps/api/test/integration/fleet/fleet-config-jobs-schema.integration.spec.ts`

**Interfaces:**
- Consumes: `ConfigJobResult` type (B1-1, from `../../common/config-jobs`).
- Produces: `FleetJobRecord.configResult: ConfigJobResult | null`; `FleetJobPatch` accepts `configResult`;
  `IFleetJobRepository.copyConfigResult(jobId: string): Promise<void>` (copies `FleetJob.configResult` into the job's
  `FleetConfigEdit.result`; no-op when the job has no config edit row); Prisma model `FleetConfigEdit`.

- [ ] **Step 1: Write the failing schema test**

Create `apps/api/test/integration/fleet/fleet-config-jobs-schema.integration.spec.ts`:

```ts
/**
 * Fleet S3 §1 — FleetJob.configResult and FleetConfigEdit (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-config-jobs-schema.integration.spec.ts
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { seedFleetBase } from '../../helpers/fleet-fixtures';
import { PrismaFleetJobRepository } from '../../../src/fleet/jobs/prisma-fleet-job.repository';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet config jobs schema (PG)', () => {
  const prisma = new PrismaClient();
  let base: Awaited<ReturnType<typeof seedFleetBase>>;
  const repo = new PrismaFleetJobRepository({ client: prisma } as never);

  const configJob = (feature = 'nax-config') => prisma.fleetJob.create({
    data: {
      projectId: base.projectId, repoId: base.repoId, ref: 'main', command: 'CONFIG_EDIT', feature, profiles: [],
      selectorLabels: [], maxCostUsd: new Prisma.Decimal(0), requestedById: base.adminId,
    },
  });

  beforeAll(async () => {
    await resetDb();
    base = await seedFleetBase(prisma);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('stores an edit row 1:1 with its job and cascades on job delete', async () => {
    const job = await configJob();
    const edit = await prisma.fleetConfigEdit.create({
      data: { jobId: job.id, mode: 'edit', edits: [{ path: '.nax/context.md', op: 'put', content: '# x', baseSha: null }], prTitle: 't', baseSha: 'a'.repeat(40) },
    });
    expect(edit.result).toBeNull();
    await expect(prisma.fleetConfigEdit.create({ data: { jobId: job.id, mode: 'drift', edits: [], baseSha: 'b'.repeat(40) } })).rejects.toThrow();
    await prisma.fleetJob.update({ where: { id: job.id }, data: { state: 'CANCELLED' } });
    await prisma.fleetJob.delete({ where: { id: job.id } });
    expect(await prisma.fleetConfigEdit.findUnique({ where: { id: edit.id } })).toBeNull();
  });

  it('keeps at most one active config job per repo through the existing (repoId, feature) index', async () => {
    const first = await configJob();
    await expect(configJob()).rejects.toThrow();
    await prisma.fleetJob.update({ where: { id: first.id }, data: { state: 'COMPLETED' } });
    await expect(configJob()).resolves.toBeDefined();
  });

  it('round-trips configResult through the repository and copies it into the edit row', async () => {
    const job = await configJob('nax-config-copy');
    await prisma.fleetConfigEdit.create({ data: { jobId: job.id, mode: 'drift', edits: [], baseSha: 'c'.repeat(40) } });
    const result = { outcome: 'drift', files: ['AGENTS.md'] };
    const updated = await repo.update(job.id, { configResult: result as never });
    expect(updated.configResult).toEqual(result);
    await repo.copyConfigResult(job.id);
    expect((await prisma.fleetConfigEdit.findUniqueOrThrow({ where: { jobId: job.id } })).result).toEqual(result);
    const cleared = await repo.update(job.id, { configResult: null });
    expect(cleared.configResult).toBeNull();
  });

  it('copyConfigResult is a no-op for a job without an edit row', async () => {
    const job = await prisma.fleetJob.create({
      data: {
        projectId: base.projectId, repoId: base.repoId, ref: 'main', command: 'RUN', feature: 'plain-run', profiles: [],
        selectorLabels: [], maxCostUsd: new Prisma.Decimal(1), requestedById: base.adminId,
      },
    });
    await expect(repo.copyConfigResult(job.id)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-config-jobs-schema.integration.spec.ts`
Expected: FAIL — TypeScript error "Property 'fleetConfigEdit' does not exist on type 'PrismaClient'".

- [ ] **Step 3: Schema and migration**

In `apps/api/prisma/schema.prisma`, model `FleetJob`: change the `command` comment and add the column after
`attributedAt DateTime? ...`:

```prisma
  command            String // RUN | PLAN | CONFIG_EDIT | CONFIG_DRIFT (S3 §1)
```

```prisma
  configResult       Json? // S3 §3 (D475): ConfigJobResult mirrored from snapshots; null for nax jobs
```

and in its relations block, after `reviewResults FleetReviewResult[]`:

```prisma
  configEdit    FleetConfigEdit?
```

Add the model right after `model FleetJob { ... }`:

```prisma
/// Fleet S3 §1: the edit set of a CONFIG_EDIT / CONFIG_DRIFT job (D466). 1:1 with FleetJob.
model FleetConfigEdit {
  id        String   @id @default(cuid())
  jobId     String   @unique
  mode      String // edit | regenerate | drift
  edits     Json // ConfigFileEdit[]; [] for regenerate and drift
  prTitle   String?
  prBody    String?
  baseSha   String // default-branch commit the editor read
  result    Json? // ConfigJobResult, copied from FleetJob.configResult on the terminal state
  createdAt DateTime @default(now())

  job FleetJob @relation(fields: [jobId], references: [id], onDelete: Cascade)
}
```

Generate the SQL from the schema diff (no database needed) and save it:

```bash
cd apps/api
git show main:apps/api/prisma/schema.prisma > /tmp/schema-main.prisma
mkdir -p prisma/migrations/20261008090000_fleet_config_jobs
bunx prisma migrate diff --from-schema-datamodel /tmp/schema-main.prisma --to-schema-datamodel prisma/schema.prisma --script \
  > prisma/migrations/20261008090000_fleet_config_jobs/migration.sql
cat prisma/migrations/20261008090000_fleet_config_jobs/migration.sql
```

Expected output (Prisma's formatting may differ only in whitespace; if it contains anything else, stop and investigate —
the diff must touch only these objects). Prepend the comment line:

```sql
-- Fleet S3: config jobs (spec §1, D465, D466, D475).
-- AlterTable
ALTER TABLE "FleetJob" ADD COLUMN     "configResult" JSONB;

-- CreateTable
CREATE TABLE "FleetConfigEdit" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "edits" JSONB NOT NULL,
    "prTitle" TEXT,
    "prBody" TEXT,
    "baseSha" TEXT NOT NULL,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FleetConfigEdit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FleetConfigEdit_jobId_key" ON "FleetConfigEdit"("jobId");

-- AddForeignKey
ALTER TABLE "FleetConfigEdit" ADD CONSTRAINT "FleetConfigEdit_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "FleetJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

Then: `bunx prisma generate`.

- [ ] **Step 4: Record, patch and repository**

In `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts`:
- add `import type { ConfigJobResult } from '../../common/config-jobs';`
- in `FleetJobRecord`, after `postRun: FleetJobPostRun | null;`:

```ts
  /** S3 §3 (D475): a config job's result from its snapshots; cleared on requeue. Null for nax jobs. */
  configResult: ConfigJobResult | null;
```

- add `| 'configResult'` to the end of the `Mutable` union (after `'ackedRunnerSeq'`).
- in `IFleetJobRepository`, after `findUserDisplayName`:

```ts
  /** S3 §3 (D475): FleetConfigEdit.result := FleetJob.configResult for this job; no-op without an edit row. Inside the terminal transition. */
  copyConfigResult(jobId: string): Promise<void>;
```

In `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts`:
- import `ConfigJobResult` type: `import type { ConfigJobResult } from '../common/config-jobs';`
- in `toJob` add `configResult: r.configResult as unknown as ConfigJobResult | null,`
- in `update`, destructure `configResult` too and add the JSON handling:

```ts
    const { bumpEpoch, costSpentUsd, costCarriedUsd, progress, stories, postRun, configResult, ...rest } = patch;
```

```ts
      ...(configResult !== undefined ? { configResult: configResult === null ? Prisma.DbNull : (configResult as unknown as Prisma.InputJsonValue) } : {}),
```

- add after `findUserDisplayName`:

```ts
  async copyConfigResult(jobId: string): Promise<void> {
    await this.db.$executeRaw`
      UPDATE "FleetConfigEdit" e SET "result" = j."configResult"
        FROM "FleetJob" j
       WHERE j."id" = ${jobId} AND e."jobId" = j."id"`;
  }
```

In `apps/api/src/fleet/jobs/fleet-jobs.service.ts` `requeue`, in the `extra` object add `configResult: null,` after
`postRun: null,`.

Every hand-written `FleetJobRecord` fixture in `apps/api/src/**/*.spec.ts` now needs `configResult: null`. Find them and add it
next to `postRun: null`:

```bash
cd apps/api && grep -rln "postRun: null" src --include='*.spec.ts'
```

(`grep --include` works in plain grep; if your shell aliases grep to ugrep, run `command grep`.)

- [ ] **Step 5: Run the tests**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-config-jobs-schema.integration.spec.ts && bunx jest src/fleet && bun run type-check`
Expected: PASS; type-check exits 0.

- [ ] **Step 6: Commit**

```bash
git add apps/api/prisma apps/api/src apps/api/test/integration/fleet/fleet-config-jobs-schema.integration.spec.ts
git commit -m "feat(fleet): S3 schema - FleetConfigEdit and FleetJob.configResult (D465, D466)"
```

---

### Task B1-3: Runner capability `configJobs` (spec §3 "Old runners")

**Files:**
- Modify: `apps/api/src/fleet/common/capabilities-core.ts:102` (destructure), `:116` (validate), `:131` (return)
- Test: `apps/api/src/fleet/common/capabilities.spec.ts` (new `describe` after the `approvals` block at `:110`)

**Interfaces:**
- Consumes: `RunnerCapabilities.configJobs?: true` (B1-1).
- Produces: `parseCapabilitiesCore` keeps `configJobs: true`, omits it when absent, refuses any other value.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/fleet/common/capabilities.spec.ts`, after the `describe('approvals (S1.5 §3, plan D271)', ...)` block:

```ts
  describe('configJobs (fleet S3 §3)', () => {
    it('keeps configJobs: true', () => {
      expect(parseCapabilitiesCore({ ...valid, configJobs: true }).configJobs).toBe(true);
    });
    it('omits configJobs when absent (an older runner)', () => {
      expect(parseCapabilitiesCore(valid)).not.toHaveProperty('configJobs');
    });
    it.each([[false], ['yes'], [1], [{}]])('refuses configJobs %p', (configJobs) => {
      expect(() => parseCapabilitiesCore({ ...valid, configJobs })).toThrow(CapabilityValidationError);
    });
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bunx jest src/fleet/common/capabilities.spec.ts -t configJobs`
Expected: FAIL — "keeps configJobs: true" receives `undefined`; "refuses" cases do not throw.

- [ ] **Step 3: Implement**

In `apps/api/src/fleet/common/capabilities-core.ts`:

```ts
  const { nax, sandbox, profiles, credentials, tools, executors, approvals, interaction, configJobs } = raw;
```

after the `approvals` check line:

```ts
  // Fleet S3 §3: strict like approvals; only exactly `true` is meaningful.
  if (configJobs !== undefined && configJobs !== true) fail('configJobs');
```

and in the returned object, after the `interaction` spread:

```ts
    ...(configJobs === true ? { configJobs: true as const } : {}),
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/api && bunx jest src/fleet/common/capabilities.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/fleet/common/capabilities-core.ts apps/api/src/fleet/common/capabilities.spec.ts
git commit -m "feat(fleet): S3 accept the configJobs runner capability"
```

---

### Task B1-4: Placement for config kinds (spec §3 "Placement", D470)

> **Builds on PR 1:** Task A2 already extracted `profileMisfit` from `capabilityMisfit`. Apply the edits below to the post-A2 `capabilityMisfit` (the early `isConfigKind` return goes first; the tail `toolsMisfit` replaces whatever tools check A2 left); do not reintroduce the per-profile loop A2 moved.

**Files:**
- Modify: `apps/api/src/fleet/jobs/placement-rules.ts:6-17` (`MisfitReason`, `PERMANENT_MISFITS`), `:19-26` (`PlacementJob`), `:48-74` (`capabilityMisfit`), `:77-81` (`firstMisfit`), `:110-115` (`toPlacementJob`); new export `jobScopePause`
- Modify: `apps/api/src/fleet/jobs/placement.service.ts:68` and `:118-119` (the two `pauses.match(jobGateKeys(job))` calls)
- Modify: `apps/api/src/fleet/dashboard/attention-unplaceable.ts:68` (the dry-run's pause check)
- Modify: `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts:104` (`PlacementMisfitDto.reason` enum)
- Test: `apps/api/src/fleet/jobs/placement-rules.spec.ts`

**Interfaces:**
- Consumes: `isConfigKind` (B1-1, `../common/config-jobs`), `RunnerCapabilities.configJobs` (B1-1).
- Produces: `PlacementJob.command: string`; `MisfitReason` gains `'config_jobs'` (in `PERMANENT_MISFITS`);
  `jobScopePause<T>(job: { command: string; projectId: string; repoId: string; pinnedRunnerId: string | null }, match: (keys: readonly string[]) => T | null): T | null`.

- [ ] **Step 1: Write the failing tests**

In `apps/api/src/fleet/jobs/placement-rules.spec.ts`, change the `job` factory so every existing case keeps working, then add
the new block at the end of the top-level `describe`:

```ts
const job = (over: Partial<PlacementJob> = {}): PlacementJob => ({
  command: 'RUN', repoId: 'repo-1', provider: 'github', profiles: ['fast'], selectorLabels: ['linux'], pinnedRunnerId: null, bashMode: 'raw', ...over,
});
```

Add `jobScopePause` to the import list from `./placement-rules`, then:

```ts
  describe('config kinds (fleet S3 §3, D470)', () => {
    const cfg = (over: Partial<PlacementJob> = {}) => job({ command: 'CONFIG_EDIT', profiles: [], ...over });
    const s3 = (over: Partial<RunnerCapabilities> = {}) => caps({ configJobs: true, ...over });

    it('fits an S3 runner even when every agent check would fail', () => {
      const broken = s3({
        nax: { version: '1', protocols: ['acp'] }, credentials: [], sandbox: { available: false, probedAt: 'x' },
        interaction: TG_FAILED, approvals: undefined,
      });
      expect(misfit(cfg({ bashMode: 'gated' }), runner({ capabilities: broken }))).toBeNull();
      expect(misfit(cfg({ command: 'CONFIG_DRIFT' }), runner({ capabilities: broken }))).toBeNull();
    });

    it('gives a runner without the configJobs capability the permanent misfit config_jobs', () => {
      expect(misfit(cfg(), runner())).toBe('config_jobs');
      expect(PERMANENT_MISFITS.has('config_jobs')).toBe(true);
    });

    it('keeps the tools check', () => {
      expect(misfit(cfg({ provider: 'gitlab' }), runner({ capabilities: s3() }))).toBe('tools');
      expect(misfit(cfg(), runner({ capabilities: s3({ tools: { git: false, gh: true, glab: true } }) }))).toBe('tools');
    });

    it('skips budget_paused but keeps disabled, offline, labels, busy_repo and capacity', () => {
      const ok = runner({ capabilities: s3() });
      expect(misfit(cfg(), { ...ok, budgetPaused: true })).toBeNull();
      expect(misfit(job(), { ...runner(), budgetPaused: true })).toBe('budget_paused');
      expect(misfit(cfg(), { ...ok, enabled: false })).toBe('disabled');
      expect(misfit(cfg(), { ...ok, lastSeenAt: new Date(NOW.getTime() - 91_000) })).toBe('offline');
      expect(misfit(cfg({ selectorLabels: ['mac'] }), ok)).toBe('labels');
      expect(misfit(cfg(), ok, { active: 0, repoIds: new Set(['repo-1']) })).toBe('busy_repo');
      expect(misfit(cfg(), ok, { active: 1, repoIds: new Set(['other']) })).toBe('capacity');
    });

    it('carries the command through toPlacementJob', () => {
      const record = { command: 'CONFIG_DRIFT', repoId: 'repo-1', profiles: [], selectorLabels: [], pinnedRunnerId: null, bashMode: 'raw' as const };
      expect(toPlacementJob(record as never, { provider: 'github' }).command).toBe('CONFIG_DRIFT');
    });

    it('never holds a config job on a job-scope budget pause', () => {
      const match = jest.fn(() => ({ id: 'policy-1' }));
      const scope = { projectId: 'p1', repoId: 'repo-1', pinnedRunnerId: null };
      expect(jobScopePause({ command: 'CONFIG_EDIT', ...scope }, match)).toBeNull();
      expect(match).not.toHaveBeenCalled();
      expect(jobScopePause({ command: 'RUN', ...scope }, match)).toEqual({ id: 'policy-1' });
      expect(match).toHaveBeenCalledWith(['global', 'project:p1', 'repo:repo-1']);
    });
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bunx jest src/fleet/jobs/placement-rules.spec.ts`
Expected: FAIL — TypeScript "Object literal may only specify known properties, and 'command' does not exist in type 'PlacementJob'".

- [ ] **Step 3: Implement**

In `apps/api/src/fleet/jobs/placement-rules.ts`:

```ts
import type { RunnerCapabilities, BashMode } from '../common/protocol';
import { isRunnerOnline } from '../common/runner-online';
import { isConfigKind } from '../common/config-jobs';
import { jobGateKeys } from '../budgets/budget-rules';
import type { FleetJobRecord, FleetRepoRef } from './domain/fleet-job.domain';

/** The first placement rule a runner fails (spec §4), reported per runner at dispatch. */
export type MisfitReason =
  | 'disabled' | 'offline' | 'budget_paused' | 'labels' | 'executor' | 'protocol' | 'provider_missing'
  | 'provider_unavailable' | 'sandbox' | 'interaction' | 'tools' | 'approvals_relay' | 'busy_repo' | 'capacity'
  | 'config_jobs';
```

Add `'config_jobs'` to the `PERMANENT_MISFITS` set literal (an S3 job can never run on a runner that predates S3; the runner
must be upgraded, which re-enrolls its capabilities). Add `command: string;` as the first field of `PlacementJob`.

Split the tools check out and route config kinds at the top of `capabilityMisfit`:

```ts
function toolsMisfit(job: PlacementJob, caps: RunnerCapabilities): MisfitReason | null {
  const forgeTool = job.provider === 'github' ? caps.tools.gh : caps.tools.glab;
  return !caps.tools.git || !forgeTool ? 'tools' : null;
}

function capabilityMisfit(job: PlacementJob, caps: RunnerCapabilities): MisfitReason | null {
  // Fleet S3 D470: a config job runs no agent, so only the S3 capability and the forge tools matter.
  if (isConfigKind(job.command)) return caps.configJobs === true ? toolsMisfit(job, caps) : 'config_jobs';
  // ... existing body unchanged down to the #207 base-config interaction line ...
  if (job.profiles.length === 0 && caps.interaction?.ok === false) return 'interaction';
  return toolsMisfit(job, caps);
}
```

(Replace the last three lines of the old body — `const forgeTool = ...`, `if (!caps.tools.git || !forgeTool) return 'tools';`,
`return null;` — with `return toolsMisfit(job, caps);`.)

In `firstMisfit` replace `if (runner.budgetPaused) return 'budget_paused';` with:

```ts
  // Fleet S3 D470: config jobs spend nothing, so a runner's budget pause does not hold them.
  if (runner.budgetPaused && !isConfigKind(job.command)) return 'budget_paused';
```

Replace `toPlacementJob`:

```ts
export const toPlacementJob = (
  job: Pick<FleetJobRecord, 'command' | 'repoId' | 'profiles' | 'selectorLabels' | 'pinnedRunnerId' | 'bashMode'>,
  repo: Pick<FleetRepoRef, 'provider'>,
): PlacementJob => ({
  command: job.command, repoId: job.repoId, provider: repo.provider, profiles: job.profiles, selectorLabels: job.selectorLabels,
  pinnedRunnerId: job.pinnedRunnerId, bashMode: job.bashMode,
});

/** S1b §2.3 pre-assign pause check; config jobs spend nothing, so a pause never holds or cancels them (fleet S3 D470). */
export function jobScopePause<T>(
  job: { command: string; projectId: string; repoId: string; pinnedRunnerId: string | null },
  match: (keys: readonly string[]) => T | null,
): T | null {
  return isConfigKind(job.command) ? null : match(jobGateKeys(job));
}
```

If `placement-rules.ts` importing `../budgets/budget-rules` creates an import cycle reported by `bun run lint` (check with
`grep -n "placement-rules" apps/api/src/fleet/budgets/budget-rules.ts`; today it has none), move `jobScopePause` into
`apps/api/src/fleet/budgets/budget-rules.ts` instead and import it from there in the three callers below.

In `apps/api/src/fleet/jobs/placement.service.ts` replace both `const paused = pauses.match(jobGateKeys(job));` with:

```ts
      const paused = jobScopePause(job, (keys) => pauses.match(keys));
```

(add `jobScopePause` to the `./placement-rules` import; drop the now-unused `jobGateKeys` import if lint flags it).

In `apps/api/src/fleet/dashboard/attention-unplaceable.ts` replace
`if (input.pauses.match(jobGateKeys(job))) return emit('budget_paused', 'warning', [], 0);` with:

```ts
    if (jobScopePause(job, (keys) => input.pauses.match(keys) ?? null)) return emit('budget_paused', 'warning', [], 0);
```

(import `jobScopePause` from `../jobs/placement-rules`; remove the unused `jobGateKeys` import).

In `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts`, `PlacementMisfitDto.reason` enum: append `'config_jobs'`.

- [ ] **Step 4: Run the tests**

Run: `cd apps/api && bunx jest src/fleet/jobs src/fleet/dashboard && bun run type-check`
Expected: PASS; type-check 0. (Existing dashboard/placement specs build `PlacementJob`s through `toPlacementJob` from rows that
already carry `command`; if a spec builds a `PlacementJob` literal, add `command: 'RUN'` to it.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/fleet/jobs apps/api/src/fleet/dashboard/attention-unplaceable.ts
git commit -m "feat(fleet): S3 placement - config kinds skip agent and budget checks, config_jobs misfit (D470)"
```

---

### Task B1-5: Mirror `configResult`; config jobs pass through UPLOADING with no bundle (spec §3, D475, D476)

**Files:**
- Create: `apps/api/src/fleet/repo-config/config-result.ts`
- Test: `apps/api/src/fleet/repo-config/config-result.spec.ts`
- Modify: `apps/api/src/fleet/sync/event-payloads.ts:84-110` (`mirror`)
- Modify: `apps/api/src/fleet/jobs/job-transitions.service.ts:31` (repo `Pick`), `:51` (after `update`)
- Test: `apps/api/src/fleet/sync/event-payloads.spec.ts`, `apps/api/src/fleet/jobs/job-transitions.service.spec.ts`, `apps/api/src/fleet/sync/job-report.processor.spec.ts`

**Interfaces:**
- Consumes: `CONFIG_RESULT_LIMITS`, `ConfigJobResult`, `isConfigKind` (B1-1); `FleetJobPatch.configResult`, `IFleetJobRepository.copyConfigResult` (B1-2).
- Produces: `parseConfigResult(raw: unknown): ConfigJobResult | null` (exported from `apps/api/src/fleet/repo-config/config-result.ts`);
  snapshot `configResult` reaches `FleetJob.configResult`; every terminal transition of a config job copies it to `FleetConfigEdit.result`.

- [ ] **Step 1: Write the failing parser test**

Create `apps/api/src/fleet/repo-config/config-result.spec.ts`:

```ts
import { parseConfigResult } from './config-result';

describe('parseConfigResult (fleet S3 §3, D475)', () => {
  it.each(['ok', 'no_changes', 'drift', 'conflict', 'invalid', 'push_failed', 'pr_failed', 'timeout'])('accepts outcome %s', (outcome) => {
    expect(parseConfigResult({ outcome })).toEqual({ outcome });
  });

  it('keeps files and output within bounds and strips unknown keys', () => {
    const files = Array.from({ length: 50 }, (_, i) => `.nax/rules/r${i}.md`);
    const output = 'x'.repeat(8_192);
    expect(parseConfigResult({ outcome: 'conflict', files, output, extra: 1 })).toEqual({ outcome: 'conflict', files, output });
    expect(parseConfigResult({ outcome: 'drift', files: [] })).toEqual({ outcome: 'drift', files: [] });
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['an unknown outcome', { outcome: 'done' }],
    ['a missing outcome', { files: [] }],
    ['51 files', { outcome: 'drift', files: Array.from({ length: 51 }, (_, i) => `f${i}`) }],
    ['a 513-char file', { outcome: 'drift', files: ['x'.repeat(513)] }],
    ['an empty file name', { outcome: 'drift', files: [''] }],
    ['a non-string file', { outcome: 'drift', files: [7] }],
    ['output over 8 KiB (UTF-8 bytes)', { outcome: 'invalid', output: 'é'.repeat(4_097) }],
    ['a non-string output', { outcome: 'invalid', output: { text: 'x' } }],
  ])('rejects %s', (_label, raw) => {
    expect(parseConfigResult(raw)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bunx jest src/fleet/repo-config/config-result.spec.ts`
Expected: FAIL, "Cannot find module './config-result'".

- [ ] **Step 3: Implement the parser**

Create `apps/api/src/fleet/repo-config/config-result.ts`:

```ts
import { CONFIG_RESULT_LIMITS } from '../common/config-jobs';
import type { ConfigJobOutcome, ConfigJobResult } from '../common/config-jobs';

const OUTCOMES: readonly ConfigJobOutcome[] = ['ok', 'no_changes', 'drift', 'conflict', 'invalid', 'push_failed', 'pr_failed', 'timeout'];

const isFile = (f: unknown): f is string => typeof f === 'string' && f.length > 0 && f.length <= CONFIG_RESULT_LIMITS.maxFileChars;

/** Runner-reported config job result (untrusted, spec §3). Null when any field breaks its bound: one mirrored field, dropped whole. */
export function parseConfigResult(raw: unknown): ConfigJobResult | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { outcome, files, output } = raw as Record<string, unknown>;
  if (typeof outcome !== 'string' || !(OUTCOMES as readonly string[]).includes(outcome)) return null;
  if (files !== undefined && (!Array.isArray(files) || files.length > CONFIG_RESULT_LIMITS.maxFiles || !files.every(isFile))) return null;
  if (output !== undefined && (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > CONFIG_RESULT_LIMITS.maxOutputBytes)) return null;
  return {
    outcome: outcome as ConfigJobOutcome,
    ...(files !== undefined ? { files: [...(files as string[])] } : {}),
    ...(output !== undefined ? { output: output as string } : {}),
  };
}
```

Run: `cd apps/api && bunx jest src/fleet/repo-config/config-result.spec.ts` — Expected: PASS.

- [ ] **Step 4: Write the failing mirror, transition and report tests**

Append to `apps/api/src/fleet/sync/event-payloads.spec.ts` inside `describe('interpretEvent', ...)`:

```ts
  it('mirrors a valid configResult and drops an invalid one without rejecting the snapshot (fleet S3 D475)', () => {
    expect(interpretEvent('snapshot', { configResult: { outcome: 'drift', files: ['AGENTS.md'] } }))
      .toEqual({ kind: 'mirror', patch: { configResult: { outcome: 'drift', files: ['AGENTS.md'] } } });
    expect(interpretEvent('snapshot', { configResult: { outcome: 'nope' }, currentPhase: 'x' }))
      .toEqual({ kind: 'mirror', patch: { currentPhase: 'x' } });
  });
```

Append to `apps/api/src/fleet/jobs/job-transitions.service.spec.ts`: give the shared `repo` mock a `copyConfigResult: jest.fn()`
entry, then add inside `describe('JobTransitionsService', ...)`:

```ts
  describe('config jobs (fleet S3 D475)', () => {
    it.each([['COMPLETED', 'runner'], ['FAILED', 'runner'], ['CRASHED', 'server']] as const)(
      'copies configResult into the edit row on UPLOADING -> %s', async (to, by) => {
        repo.update.mockImplementationOnce(async (_id: string, patch: Record<string, unknown>) => job({ ...(patch as Partial<FleetJobRecord>), command: 'CONFIG_EDIT' }));
        await svc.apply({ job: job({ command: 'CONFIG_EDIT', state: 'UPLOADING' }), to, by, now: NOW, actor: ACTOR });
        expect(repo.copyConfigResult).toHaveBeenCalledWith('j1');
      });

    it('does not copy for a non-terminal step or for a nax job', async () => {
      repo.update.mockImplementationOnce(async (_id: string, patch: Record<string, unknown>) => job({ ...(patch as Partial<FleetJobRecord>), command: 'CONFIG_EDIT' }));
      await svc.apply({ job: job({ command: 'CONFIG_EDIT', state: 'RUNNING' }), to: 'UPLOADING', by: 'runner', now: NOW, actor: ACTOR });
      await svc.apply({ job: job({ state: 'UPLOADING' }), to: 'COMPLETED', by: 'runner', now: NOW, actor: ACTOR });
      expect(repo.copyConfigResult).not.toHaveBeenCalled();
    });
  });
```

Append to `apps/api/src/fleet/sync/job-report.processor.spec.ts`:

```ts
describe('JobReportProcessor config job end (fleet S3 D476: UPLOADING with no bundle)', () => {
  it('applies snapshot(configResult) -> UPLOADING -> COMPLETED in one report with no bundle and no ingest', async () => {
    const repo = makeRepo();
    repo.seed({ ...runningJob, command: 'CONFIG_EDIT', bashMode: 'raw', maxCostUsd: '0' });
    const transitions = {
      apply: jest.fn(async ({ job, to }: { job: FleetJobRecord; to: string }) => {
        const after = await repo.update(job.id, { state: to as FleetJobRecord['state'] });
        return { job: after, live: { id: `live-${to}`, type: 'fleet_job', projectId: 'p1', jobId: job.id, state: to, at: NOW.toISOString() }, approvalLive: [] };
      }),
    };
    const fence = { holds: () => true, abandon: jest.fn() };
    const live = { event: jest.fn(() => ({ id: 'job-live', type: 'fleet_job', projectId: 'p1', jobId: 'job-1', state: 'RUNNING', at: NOW.toISOString() })) };
    const processor = new JobReportProcessor(repo as never, transitions as never, live as never, fence as never, { record: jest.fn() } as never,
      { signal: jest.fn() } as never, { openBash: jest.fn() } as never, { run: (fn: () => unknown) => fn() } as never);
    const configResult = { outcome: 'ok', files: ['.nax/context.md', 'AGENTS.md'] };

    const out = await processor.process('r1', {
      jobId: 'job-1', leaseEpoch: 1, events: [
        { seq: 1, type: 'snapshot', payload: { configResult, resultBranch: 'nax-config/job-1', resultSha: 'abc1234', resultPrUrl: 'https://github.com/acme/app/pull/9' } as never },
        { seq: 2, type: 'state', payload: { to: 'UPLOADING' } },
        { seq: 3, type: 'state', payload: { to: 'COMPLETED', reason: 'ok' } },
      ],
    }, NOW);

    expect(out.ack).toEqual({ jobId: 'job-1', ackedSeq: 3 });
    expect(transitions.apply.mock.calls.map(([a]) => a.to)).toEqual(['UPLOADING', 'COMPLETED']);
    expect(transitions.apply.mock.calls[1][0]).toEqual(expect.objectContaining({ reason: 'ok' }));
    expect(repo.update).toHaveBeenCalledWith('job-1', expect.objectContaining({ configResult, resultBranch: 'nax-config/job-1', resultPrUrl: 'https://github.com/acme/app/pull/9' }));
  });
});
```

(This proves the server path: `JobReportProcessor` never consults artifacts; ingest only starts from
`BundleService.upload` → `ingestRepo.enqueue` (`apps/api/src/fleet/artifacts/bundle.service.ts:73`), and `FleetSweeper` keys on
runner silence (`fleet-sweeper.ts:52-60`), not on a missing bundle. No other path reacts to UPLOADING without a bundle.)

- [ ] **Step 5: Run them to verify they fail**

Run: `cd apps/api && bunx jest src/fleet/sync/event-payloads.spec.ts src/fleet/jobs/job-transitions.service.spec.ts src/fleet/sync/job-report.processor.spec.ts`
Expected: FAIL — the mirror test gets `patch: {}`; the transition test sees `copyConfigResult` not called; the report test's
last assertion fails (no `configResult` in the patch).

- [ ] **Step 6: Implement mirror and copy**

In `apps/api/src/fleet/sync/event-payloads.ts` add `import { parseConfigResult } from '../repo-config/config-result';` and,
inside `mirror()`, before `const entries`:

```ts
  const configResult = p.configResult === undefined ? undefined : parseConfigResult(p.configResult) ?? undefined;
```

and append the entry `['configResult', configResult],` after `['postRun', postRunStages(p.postRun)],`.

In `apps/api/src/fleet/jobs/job-transitions.service.ts`:
- import `isConfigKind` from `'../common/config-jobs'`;
- widen the repo type: `Pick<IFleetJobRepository, 'update' | 'appendEvent' | 'withdrawPendingCommands' | 'copyConfigResult'>`;
- right after `const after = await this.repo.update(job.id, patch);` add:

```ts
    // Fleet S3 D475: the config job's last reported result becomes its edit row's record, in this transaction.
    if (terminal && isConfigKind(after.command)) await this.repo.copyConfigResult(after.id);
```

- [ ] **Step 7: Run the tests**

Run: `cd apps/api && bunx jest src/fleet && bun run type-check`
Expected: PASS; type-check 0.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/fleet/repo-config apps/api/src/fleet/sync apps/api/src/fleet/jobs/job-transitions.service.ts apps/api/src/fleet/jobs/job-transitions.service.spec.ts
git commit -m "feat(fleet): S3 mirror configResult from snapshots and record it on the terminal state (D475, D476)"
```

---

### Task B1-6: Forge REST reads for `.nax/` (spec §4.1)

**Files:**
- Create: `apps/api/src/fleet/git-broker/forge-tree.ts`
- Modify: `apps/api/src/fleet/git-broker/github-app-client.ts` (three methods after `getPullRequest`, `:128`)
- Modify: `apps/api/src/fleet/git-broker/gitlab-access-checker.ts` (three methods after `getMergeRequest`, `:52`)
- Test: `apps/api/src/fleet/git-broker/github-app-client.spec.ts`, `apps/api/src/fleet/git-broker/gitlab-access-checker.spec.ts`

**Interfaces:**
- Consumes: `FleetHttpClient.request` (JSON only, no redirects; `apps/api/src/fleet/git-broker/fleet-http-client.ts`).
- Produces (`forge-tree.ts`): `interface ForgeTreeEntry { path: string; type: 'blob' | 'tree'; sha: string; size: number | null }`,
  `interface ForgeFile { sha: string; size: number; content: Buffer }`.
- Produces (`GitHubAppClient`):
  - `getBranchHead(token: string, owner: string, name: string, branch: string): Promise<string>` (commit SHA; `repo_not_found` on 404)
  - `getTree(token: string, owner: string, name: string, treeish: string, recursive: boolean): Promise<{ entries: ForgeTreeEntry[]; truncated: boolean }>`
  - `getFile(token: string, owner: string, name: string, path: string, ref: string): Promise<ForgeFile | null>` (null on 404 or a non-file)
- Produces (`GitLabAccessChecker`):
  - `getBranchHead(token: string, owner: string, name: string, branch: string): Promise<string>`
  - `listTree(token: string, owner: string, name: string, path: string, ref: string): Promise<ForgeTreeEntry[]>` (recursive, paged 100 at a time, at most 10 pages; `[]` on 404)
  - `getFile(token: string, owner: string, name: string, path: string, ref: string): Promise<ForgeFile | null>`
- All throw `RepoCheckException('provider_error')` on any other non-2xx or a malformed body.

- [ ] **Step 1: Write the failing GitHub tests**

Append inside `describe('GitHubAppClient', ...)` in `apps/api/src/fleet/git-broker/github-app-client.spec.ts`:

```ts
  describe('.nax reads (fleet S3 §4.1)', () => {
    const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

    it('reads the branch head commit and sends the token', async () => {
      forge.routes.set('GET /repos/acme/app/git/ref/heads/trunk', () => ({ status: 200, body: { object: { sha: 'c0ffee1', type: 'commit' } } }));
      await expect(client.getBranchHead('ghs_t', 'acme', 'app', 'trunk')).resolves.toBe('c0ffee1');
      expect(forge.requests.at(-1)?.headers.authorization).toBe('Bearer ghs_t');
      forge.routes.clear();
      await expect(client.getBranchHead('ghs_t', 'acme', 'app', 'trunk')).rejects.toMatchObject({ reason: 'repo_not_found' });
    });

    it('maps a tree and its truncated flag; drops non blob/tree entries', async () => {
      forge.routes.set('GET /repos/acme/app/git/trees/t1', () => ({
        status: 200,
        body: { truncated: false, tree: [
          { path: 'rules', type: 'tree', sha: 's1' }, { path: 'rules/a.md', type: 'blob', sha: 's2', size: 12 }, { path: 'sub', type: 'commit', sha: 's3' },
        ] },
      }));
      await expect(client.getTree('t', 'acme', 'app', 't1', true)).resolves.toEqual({
        truncated: false,
        entries: [{ path: 'rules', type: 'tree', sha: 's1', size: null }, { path: 'rules/a.md', type: 'blob', sha: 's2', size: 12 }],
      });
      expect(forge.requests.at(-1)?.path).toBe('/repos/acme/app/git/trees/t1');
    });

    it('reads a file at a ref, decoding base64', async () => {
      forge.routes.set('GET /repos/acme/app/contents/.nax/rules/a.md', () => ({ status: 200, body: { type: 'file', sha: 'b1', size: 5, encoding: 'base64', content: b64('hello') } }));
      const file = await client.getFile('t', 'acme', 'app', '.nax/rules/a.md', 'c0ffee1');
      expect(file).toEqual({ sha: 'b1', size: 5, content: Buffer.from('hello') });
    });

    it('returns null for a missing file or a directory, provider_error for 500', async () => {
      await expect(client.getFile('t', 'acme', 'app', '.nax/x.md', 'r')).resolves.toBeNull();
      forge.routes.set('GET /repos/acme/app/contents/.nax', () => ({ status: 200, body: [{ type: 'file' }] }));
      await expect(client.getFile('t', 'acme', 'app', '.nax', 'r')).resolves.toBeNull();
      forge.routes.set('GET /repos/acme/app/contents/.nax/x.md', () => ({ status: 500, body: {} }));
      await expect(client.getFile('t', 'acme', 'app', '.nax/x.md', 'r')).rejects.toBeInstanceOf(RepoCheckException);
    });
  });
```

- [ ] **Step 2: Write the failing GitLab tests**

Append inside `describe('GitLabAccessChecker', ...)` in `apps/api/src/fleet/git-broker/gitlab-access-checker.spec.ts`:

```ts
  describe('.nax reads (fleet S3 §4.1)', () => {
    const P = `/api/v4/projects/${encodeURIComponent('grp/sub/app')}`;

    it('reads the branch head', async () => {
      forge.routes.set(`GET ${P}/repository/branches/main`, () => ({ status: 200, body: { commit: { id: 'c1' } } }));
      await expect(checker.getBranchHead('glpat', 'grp/sub', 'app', 'main')).resolves.toBe('c1');
      expect(forge.requests.at(-1)?.headers['private-token']).toBe('glpat');
    });

    it('pages the recursive tree until a short page, and returns [] when the path is missing', async () => {
      const page = (n: number, count: number) => Array.from({ length: count }, (_, i) => ({ id: `s${n}-${i}`, path: `.nax/rules/r${n}-${i}.md`, type: 'blob' }));
      let calls = 0;
      forge.routes.set(`GET ${P}/repository/tree`, () => ({ status: 200, body: page(++calls, calls === 1 ? 100 : 3) }));
      const entries = await checker.listTree('t', 'grp/sub', 'app', '.nax', 'c1');
      expect(entries).toHaveLength(103);
      expect(entries[0]).toEqual({ path: '.nax/rules/r1-0.md', type: 'blob', sha: 's1-0', size: null });
      forge.routes.set(`GET ${P}/repository/tree`, () => ({ status: 404, body: { message: '404 Tree Not Found' } }));
      await expect(checker.listTree('t', 'grp/sub', 'app', '.nax', 'c1')).resolves.toEqual([]);
    });

    it('stops after 10 full pages', async () => {
      forge.routes.set(`GET ${P}/repository/tree`, () => ({ status: 200, body: Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, path: `.nax/r${i}.md`, type: 'blob' })) }));
      await expect(checker.listTree('t', 'grp/sub', 'app', '.nax', 'c1')).rejects.toMatchObject({ reason: 'provider_error' });
    });

    it('reads a file with its blob id; null on 404', async () => {
      const FILE = `GET ${P}/repository/files/${encodeURIComponent('.nax/context.md')}`;
      forge.routes.set(FILE, () => ({ status: 200, body: { blob_id: 'b9', size: 2, encoding: 'base64', content: Buffer.from('hi').toString('base64') } }));
      await expect(checker.getFile('t', 'grp/sub', 'app', '.nax/context.md', 'c1')).resolves.toEqual({ sha: 'b9', size: 2, content: Buffer.from('hi') });
      forge.routes.delete(FILE);
      await expect(checker.getFile('t', 'grp/sub', 'app', '.nax/context.md', 'c1')).resolves.toBeNull();
    });
  });
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd apps/api && bunx jest src/fleet/git-broker/github-app-client.spec.ts src/fleet/git-broker/gitlab-access-checker.spec.ts -t "nax reads"`
Expected: FAIL — "client.getBranchHead is not a function".

- [ ] **Step 4: Implement**

Create `apps/api/src/fleet/git-broker/forge-tree.ts`:

```ts
/** Fleet S3 §4.1: one entry of a forge tree listing. `sha` is the git object id (what `git rev-parse HEAD:<path>` prints). */
export interface ForgeTreeEntry {
  path: string;
  type: 'blob' | 'tree';
  sha: string;
  /** GitHub reports blob sizes; GitLab tree listings do not (null). */
  size: number | null;
}

export interface ForgeFile {
  sha: string;
  size: number;
  content: Buffer;
}
```

In `apps/api/src/fleet/git-broker/github-app-client.ts` add `import type { ForgeFile, ForgeTreeEntry } from './forge-tree';`
and, after `getPullRequest`:

```ts
  private repoPath(owner: string, name: string): string {
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  }

  /** Fleet S3 §4.1: the commit a branch points at. */
  async getBranchHead(token: string, owner: string, name: string, branch: string): Promise<string> {
    const ref = branch.split('/').map(encodeURIComponent).join('/');
    const res = await this.http.request('GET', `${this.api}${this.repoPath(owner, name)}/git/ref/heads/${ref}`, this.headers(token));
    if (res.status === 404) throw new RepoCheckException('repo_not_found');
    if (res.status !== 200) throw new RepoCheckException('provider_error');
    const sha = obj(obj(res.body).object).sha;
    if (typeof sha !== 'string') throw new RepoCheckException('provider_error');
    return sha;
  }

  /** Fleet S3 §4.1: a tree by commit or tree SHA. Entries other than blob/tree (submodules) are dropped. */
  async getTree(token: string, owner: string, name: string, treeish: string, recursive: boolean): Promise<{ entries: ForgeTreeEntry[]; truncated: boolean }> {
    const query = recursive ? '?recursive=1' : '';
    const res = await this.http.request('GET', `${this.api}${this.repoPath(owner, name)}/git/trees/${encodeURIComponent(treeish)}${query}`, this.headers(token));
    if (res.status !== 200) throw new RepoCheckException('provider_error');
    const body = obj(res.body);
    if (!Array.isArray(body.tree)) throw new RepoCheckException('provider_error');
    const entries = body.tree.flatMap((raw): ForgeTreeEntry[] => {
      const e = obj(raw);
      if ((e.type !== 'blob' && e.type !== 'tree') || typeof e.path !== 'string' || typeof e.sha !== 'string') return [];
      return [{ path: e.path, type: e.type, sha: e.sha, size: typeof e.size === 'number' ? e.size : null }];
    });
    return { entries, truncated: body.truncated === true };
  }

  /** Fleet S3 §4.1: one file at a ref (contents API, base64). Null when absent or not a file. */
  async getFile(token: string, owner: string, name: string, path: string, ref: string): Promise<ForgeFile | null> {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    const res = await this.http.request('GET', `${this.api}${this.repoPath(owner, name)}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, this.headers(token));
    if (res.status === 404) return null;
    if (res.status !== 200) throw new RepoCheckException('provider_error');
    const b = obj(res.body);
    if (b.type !== 'file') return null;
    if (typeof b.sha !== 'string' || typeof b.size !== 'number' || b.encoding !== 'base64' || typeof b.content !== 'string') {
      throw new RepoCheckException('provider_error');
    }
    return { sha: b.sha, size: b.size, content: Buffer.from(b.content, 'base64') };
  }
```

In `apps/api/src/fleet/git-broker/gitlab-access-checker.ts` add `import type { ForgeFile, ForgeTreeEntry } from './forge-tree';`
and, after `getMergeRequest`:

```ts
  private project(owner: string, name: string): string {
    return `${this.vcsConfig.gitlabApiUrl.replace(/\/+$/, '')}/projects/${encodeURIComponent(`${owner}/${name}`)}`;
  }

  /** Fleet S3 §4.1: the commit a branch points at. */
  async getBranchHead(token: string, owner: string, name: string, branch: string): Promise<string> {
    const res = await this.http.request('GET', `${this.project(owner, name)}/repository/branches/${encodeURIComponent(branch)}`, { 'private-token': token });
    if (res.status === 404) throw new RepoCheckException('repo_not_found');
    if (res.status !== 200) throw new RepoCheckException('provider_error');
    const id = obj(obj(res.body).commit).id;
    if (typeof id !== 'string') throw new RepoCheckException('provider_error');
    return id;
  }

  static readonly TREE_PAGE = 100;
  static readonly TREE_MAX_PAGES = 10;

  /**
   * Fleet S3 §4.1: recursive tree under `path` at `ref`. FleetHttpClient exposes no headers, so paging stops at the first short
   * page; more than TREE_MAX_PAGES full pages is refused (a `.nax/` that large is not a config dir).
   */
  async listTree(token: string, owner: string, name: string, path: string, ref: string): Promise<ForgeTreeEntry[]> {
    const out: ForgeTreeEntry[] = [];
    for (let page = 1; page <= GitLabAccessChecker.TREE_MAX_PAGES; page += 1) {
      const query = `path=${encodeURIComponent(path)}&ref=${encodeURIComponent(ref)}&recursive=true&per_page=${GitLabAccessChecker.TREE_PAGE}&page=${page}`;
      const res = await this.http.request('GET', `${this.project(owner, name)}/repository/tree?${query}`, { 'private-token': token });
      if (res.status === 404) return [];
      if (res.status !== 200 || !Array.isArray(res.body)) throw new RepoCheckException('provider_error');
      for (const raw of res.body) {
        const e = obj(raw);
        if ((e.type === 'blob' || e.type === 'tree') && typeof e.path === 'string' && typeof e.id === 'string') {
          out.push({ path: e.path, type: e.type, sha: e.id, size: null });
        }
      }
      if (res.body.length < GitLabAccessChecker.TREE_PAGE) return out;
    }
    throw new RepoCheckException('provider_error');
  }

  /** Fleet S3 §4.1: one file at a ref (files API, base64). Null when absent. */
  async getFile(token: string, owner: string, name: string, path: string, ref: string): Promise<ForgeFile | null> {
    const res = await this.http.request('GET', `${this.project(owner, name)}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`, { 'private-token': token });
    if (res.status === 404) return null;
    if (res.status !== 200) throw new RepoCheckException('provider_error');
    const b = obj(res.body);
    if (typeof b.blob_id !== 'string' || typeof b.size !== 'number' || b.encoding !== 'base64' || typeof b.content !== 'string') {
      throw new RepoCheckException('provider_error');
    }
    return { sha: b.blob_id, size: b.size, content: Buffer.from(b.content, 'base64') };
  }
```

(The fake forge matches on the raw request path, so `?query` is ignored and the encoded project path is part of the key —
the tests above rely on that.)

- [ ] **Step 5: Run the tests**

Run: `cd apps/api && bunx jest src/fleet/git-broker`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/fleet/git-broker
git commit -m "feat(fleet): S3 forge reads - branch head, tree and file for GitHub and GitLab"
```

---

### Task B1-7: `FleetRepoFilesReader` and its errors (spec §4.1, D468)

**Files:**
- Create: `apps/api/src/fleet/repo-config/repo-config.exceptions.ts`
- Create: `apps/api/src/fleet/repo-config/fleet-repo-files.reader.ts`
- Create: `apps/api/src/fleet/repo-config/github-fleet-repo-files.reader.ts`
- Create: `apps/api/src/fleet/repo-config/gitlab-fleet-repo-files.reader.ts`
- Create: `apps/api/src/fleet/repo-config/fleet-repo-files.router.ts`
- Test: `apps/api/src/fleet/repo-config/fleet-repo-files.reader.spec.ts`

**Interfaces:**
- Consumes: B1-6 forge methods; `GitHubAppClient.mintInstallationToken(installationId: bigint, repoName: string)`;
  `GitLabTokenSource.resolve(projectId: string, owner: string, name: string): Promise<string>`; `naxPathGroup`, `NAX_CONFIG_LIMITS` (B1-1 mirror);
  `FleetRepoRef` (`apps/api/src/fleet/jobs/domain/fleet-job.domain.ts`).
- Produces:
  - `NaxFileEntry { path: string; size: number | null; blobSha: string; group: NaxPathGroup }`, `NaxFileList { baseSha; defaultBranch; files: NaxFileEntry[] }`, `NaxFileContent { path; blobSha; content: string }`
  - `interface FleetRepoFilesReader { list(repo: FleetRepoRef): Promise<NaxFileList>; read(repo: FleetRepoRef, path: string, ref: string): Promise<NaxFileContent> }`, token `FLEET_REPO_FILES_READER`
  - helpers `toNaxEntries(entries: ForgeTreeEntry[]): NaxFileEntry[]`, `decodeNaxFile(path: string, file: ForgeFile): NaxFileContent`, `forgeCall<T>(fn: () => Promise<T>): Promise<T>`
  - classes `GithubFleetRepoFilesReader`, `GitlabFleetRepoFilesReader`, `FleetRepoFilesRouter` (implements the interface, picks by `repo.provider`)
  - exceptions: `RepoUnreachableException(reason)` 409 prefix `fleet.repoUnreachable`; `ForgeErrorException()` 502 prefix `fleet.forge`;
    `NaxFileUnreadableException(reason: 'too_large' | 'not_text')` 422 prefix `fleet.naxFile`; `ConfigJobActiveException(activeJobId)` 409 prefix `fleet.configJobActive`.

- [ ] **Step 1: Write the failing reader tests**

Create `apps/api/src/fleet/repo-config/fleet-repo-files.reader.spec.ts`:

```ts
import { RepoCheckException } from '../git-broker/repo-check.exception';
import type { FleetRepoRef } from '../jobs/domain/fleet-job.domain';
import { decodeNaxFile, forgeCall, toNaxEntries } from './fleet-repo-files.reader';
import { GithubFleetRepoFilesReader } from './github-fleet-repo-files.reader';
import { GitlabFleetRepoFilesReader } from './gitlab-fleet-repo-files.reader';
import { FleetRepoFilesRouter } from './fleet-repo-files.router';
import { ForgeErrorException, NaxFileUnreadableException, RepoUnreachableException } from './repo-config.exceptions';

const GH: FleetRepoRef = { id: 'repo-1', projectId: 'p1', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'trunk', githubInstallationId: BigInt(77) };
const GL: FleetRepoRef = { ...GH, id: 'repo-2', provider: 'gitlab', owner: 'grp/sub', githubInstallationId: null };

describe('toNaxEntries', () => {
  it('keeps allowlisted blobs only, sorted by group then path', () => {
    const out = toNaxEntries([
      { path: '.nax/status.json', type: 'blob', sha: 'x', size: 1 },
      { path: '.nax/profiles/fast.env', type: 'blob', sha: 'x', size: 1 },
      { path: '.nax/rules', type: 'tree', sha: 'x', size: null },
      { path: '.nax/config.json', type: 'blob', sha: 'c', size: 3 },
      { path: '.nax/rules/z.md', type: 'blob', sha: 'z', size: 4 },
      { path: '.nax/rules/a.md', type: 'blob', sha: 'a', size: 5 },
      { path: '.nax/context.md', type: 'blob', sha: 'k', size: null },
    ]);
    expect(out).toEqual([
      { path: '.nax/rules/a.md', size: 5, blobSha: 'a', group: 'rules' },
      { path: '.nax/rules/z.md', size: 4, blobSha: 'z', group: 'rules' },
      { path: '.nax/context.md', size: null, blobSha: 'k', group: 'context' },
      { path: '.nax/config.json', size: 3, blobSha: 'c', group: 'config' },
    ]);
  });
});

describe('decodeNaxFile', () => {
  it('decodes UTF-8 text', () => {
    expect(decodeNaxFile('.nax/context.md', { sha: 's', size: 3, content: Buffer.from('hé') })).toEqual({ path: '.nax/context.md', blobSha: 's', content: 'hé' });
  });
  it.each([
    ['too_large', { sha: 's', size: 262_145, content: Buffer.alloc(262_145, 97) }],
    ['not_text', { sha: 's', size: 2, content: Buffer.from([0xff, 0xfe]) }],
    ['not_text', { sha: 's', size: 3, content: Buffer.from('a\u0000b') }],
  ])('refuses %s', (reason, file) => {
    expect(() => decodeNaxFile('.nax/context.md', file)).toThrow(NaxFileUnreadableException);
    try { decodeNaxFile('.nax/context.md', file); } catch (e) { expect((e as NaxFileUnreadableException).reason).toBe(reason); }
  });
});

describe('forgeCall', () => {
  it.each(['vcs_connection_missing', 'vcs_connection_mismatch', 'vcs_encryption_key_missing', 'app_not_installed', 'github_app_not_configured', 'gitlab_token_invalid', 'repo_not_found'])(
    'maps %s to 409 repo_unreachable', async (reason) => {
      await expect(forgeCall(async () => { throw new RepoCheckException(reason as never); })).rejects.toBeInstanceOf(RepoUnreachableException);
    });
  it.each(['provider_error', 'provider_unreachable'])('maps %s to 502', async (reason) => {
    await expect(forgeCall(async () => { throw new RepoCheckException(reason as never); })).rejects.toBeInstanceOf(ForgeErrorException);
  });
  it('passes other errors through', async () => {
    const boom = new Error('boom');
    await expect(forgeCall(async () => { throw boom; })).rejects.toBe(boom);
  });
});

describe('GithubFleetRepoFilesReader', () => {
  const github = {
    mintInstallationToken: jest.fn(async () => ({ token: 'ghs_t', expiresAt: new Date() })),
    getBranchHead: jest.fn(async () => 'c0ffee1'),
    getTree: jest.fn(async (_t: string, _o: string, _n: string, treeish: string) => treeish === 'c0ffee1'
      ? { truncated: false, entries: [{ path: '.nax', type: 'tree', sha: 'naxTree', size: null }, { path: 'src', type: 'tree', sha: 'x', size: null }] }
      : { truncated: false, entries: [{ path: 'context.md', type: 'blob', sha: 'k', size: 9 }, { path: 'features/x/prd.json', type: 'blob', sha: 'f', size: 1 }] }),
    getFile: jest.fn(async () => ({ sha: 'k', size: 2, content: Buffer.from('hi') })),
  };
  const reader = new GithubFleetRepoFilesReader(github as never);
  afterEach(() => jest.clearAllMocks());

  it('lists .nax from the default-branch head with one mint', async () => {
    await expect(reader.list(GH)).resolves.toEqual({ baseSha: 'c0ffee1', defaultBranch: 'trunk', files: [{ path: '.nax/context.md', size: 9, blobSha: 'k', group: 'context' }] });
    expect(github.mintInstallationToken).toHaveBeenCalledTimes(1);
    expect(github.mintInstallationToken).toHaveBeenCalledWith(BigInt(77), 'app');
    expect(github.getTree).toHaveBeenLastCalledWith('ghs_t', 'acme', 'app', 'naxTree', true);
  });

  it('returns no files when the repo has no .nax dir', async () => {
    github.getTree.mockResolvedValueOnce({ truncated: false, entries: [] });
    await expect(reader.list(GH)).resolves.toEqual({ baseSha: 'c0ffee1', defaultBranch: 'trunk', files: [] });
  });

  it('refuses a truncated .nax tree (502) and a repo without an installation (409)', async () => {
    github.getTree.mockResolvedValueOnce({ truncated: false, entries: [{ path: '.nax', type: 'tree', sha: 'n', size: null }] })
      .mockResolvedValueOnce({ truncated: true, entries: [] });
    await expect(reader.list(GH)).rejects.toBeInstanceOf(ForgeErrorException);
    await expect(reader.list({ ...GH, githubInstallationId: null })).rejects.toBeInstanceOf(RepoUnreachableException);
  });

  it('reads one file at a ref; a missing file is 404', async () => {
    await expect(reader.read(GH, '.nax/context.md', 'c0ffee1')).resolves.toEqual({ path: '.nax/context.md', blobSha: 'k', content: 'hi' });
    expect(github.getFile).toHaveBeenCalledWith('ghs_t', 'acme', 'app', '.nax/context.md', 'c0ffee1');
    github.getFile.mockResolvedValueOnce(null);
    await expect(reader.read(GH, '.nax/context.md', 'c0ffee1')).rejects.toMatchObject({ status: 404 });
  });
});

describe('GitlabFleetRepoFilesReader', () => {
  const gitlab = {
    getBranchHead: jest.fn(async () => 'c1'),
    listTree: jest.fn(async () => [{ path: '.nax/rules/a.md', type: 'blob', sha: 'a', size: null }]),
    getFile: jest.fn(async () => ({ sha: 'a', size: 1, content: Buffer.from('x') })),
  };
  const tokens = { resolve: jest.fn(async () => 'glpat') };
  const reader = new GitlabFleetRepoFilesReader(gitlab as never, tokens as never);

  it('lists with the project token and a null size', async () => {
    await expect(reader.list(GL)).resolves.toEqual({ baseSha: 'c1', defaultBranch: 'trunk', files: [{ path: '.nax/rules/a.md', size: null, blobSha: 'a', group: 'rules' }] });
    expect(tokens.resolve).toHaveBeenCalledWith('p1', 'grp/sub', 'app');
    expect(gitlab.listTree).toHaveBeenCalledWith('glpat', 'grp/sub', 'app', '.nax', 'c1');
  });

  it('maps a missing VcsConnection to 409 repo_unreachable', async () => {
    tokens.resolve.mockRejectedValueOnce(new RepoCheckException('vcs_connection_missing'));
    await expect(reader.list(GL)).rejects.toBeInstanceOf(RepoUnreachableException);
  });
});

describe('FleetRepoFilesRouter', () => {
  it('routes by provider', async () => {
    const gh = { list: jest.fn(async () => 'gh'), read: jest.fn() };
    const gl = { list: jest.fn(async () => 'gl'), read: jest.fn() };
    const router = new FleetRepoFilesRouter(gh as never, gl as never);
    await expect(router.list(GH)).resolves.toBe('gh');
    await expect(router.list(GL)).resolves.toBe('gl');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bunx jest src/fleet/repo-config/fleet-repo-files.reader.spec.ts`
Expected: FAIL, "Cannot find module './fleet-repo-files.reader'".

- [ ] **Step 3: Implement exceptions and shared reader code**

Create `apps/api/src/fleet/repo-config/repo-config.exceptions.ts`:

```ts
import { AppException } from '@nathapp/nestjs-common';

/** 409: koda cannot obtain read access to the repo (spec §4.1). `reason` is a RepoCheckReason or `no_installation`. */
export class RepoUnreachableException extends AppException {
  constructor(readonly reason: string) {
    super(409, { reason }, 'fleet.repoUnreachable', 409);
  }
}

/** 502: the forge answered badly or not at all; the message never carries forge text (spec §4.1). */
export class ForgeErrorException extends AppException {
  constructor() {
    super(502, {}, 'fleet.forge', 502);
  }
}

/** 422: a `.nax/` file over 256 KiB or not UTF-8 text; the editor shows it read-only (spec §4.1). */
export class NaxFileUnreadableException extends AppException {
  constructor(readonly reason: 'too_large' | 'not_text') {
    super(422, { reason }, 'fleet.naxFile', 422);
  }
}

/** 409: the repo already has an active config job (spec §1, D465). */
export class ConfigJobActiveException extends AppException {
  constructor(readonly activeJobId: string) {
    super(409, { activeJobId }, 'fleet.configJobActive', 409);
  }
}
```

Create `apps/api/src/fleet/repo-config/fleet-repo-files.reader.ts`:

```ts
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { NAX_CONFIG_LIMITS, naxPathGroup } from '../common/nax-config-paths';
import type { NaxPathGroup } from '../common/nax-config-paths';
import type { ForgeFile, ForgeTreeEntry } from '../git-broker/forge-tree';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import type { FleetRepoRef } from '../jobs/domain/fleet-job.domain';
import { ForgeErrorException, NaxFileUnreadableException, RepoUnreachableException } from './repo-config.exceptions';

export const FLEET_REPO_FILES_READER = Symbol('FLEET_REPO_FILES_READER');

export interface NaxFileEntry { path: string; size: number | null; blobSha: string; group: NaxPathGroup }
export interface NaxFileList { baseSha: string; defaultBranch: string; files: NaxFileEntry[] }
export interface NaxFileContent { path: string; blobSha: string; content: string }

/** Fleet S3 §4.1: reads a fleet repo's allowlisted `.nax/` files through the forge API; no caching (D468). */
export interface FleetRepoFilesReader {
  list(repo: FleetRepoRef): Promise<NaxFileList>;
  /** `ref` is the commit the list call returned as baseSha. 404 when the file is absent at that ref. */
  read(repo: FleetRepoRef, path: string, ref: string): Promise<NaxFileContent>;
}

const GROUP_ORDER: readonly NaxPathGroup[] = ['rules', 'context', 'config', 'profiles', 'constitution'];

export function toNaxEntries(entries: readonly ForgeTreeEntry[]): NaxFileEntry[] {
  return entries
    .flatMap((e): NaxFileEntry[] => {
      const group = e.type === 'blob' ? naxPathGroup(e.path) : null;
      return group ? [{ path: e.path, size: e.size, blobSha: e.sha, group }] : [];
    })
    .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || a.path.localeCompare(b.path));
}

export function decodeNaxFile(path: string, file: ForgeFile): NaxFileContent {
  if (file.content.length > NAX_CONFIG_LIMITS.maxFileBytes) throw new NaxFileUnreadableException('too_large');
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(file.content);
  } catch {
    throw new NaxFileUnreadableException('not_text');
  }
  if (content.includes('\u0000')) throw new NaxFileUnreadableException('not_text');
  return { path, blobSha: file.sha, content };
}

const FORGE_DOWN = new Set(['provider_error', 'provider_unreachable']);

/** Maps forge/token failures: access problems -> 409 repo_unreachable, forge faults -> 502 (spec §4.1). */
export async function forgeCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof RepoCheckException) {
      throw FORGE_DOWN.has(error.reason) ? new ForgeErrorException() : new RepoUnreachableException(error.reason);
    }
    throw error;
  }
}

export function fileNotFound(): NotFoundAppException {
  return new NotFoundAppException({}, 'fleet.naxFile');
}
```

- [ ] **Step 4: Implement the readers and the router**

Create `apps/api/src/fleet/repo-config/github-fleet-repo-files.reader.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { GitHubAppClient } from '../git-broker/github-app-client';
import type { FleetRepoRef } from '../jobs/domain/fleet-job.domain';
import { decodeNaxFile, fileNotFound, forgeCall, FleetRepoFilesReader, NaxFileContent, NaxFileList, toNaxEntries } from './fleet-repo-files.reader';
import { ForgeErrorException, RepoUnreachableException } from './repo-config.exceptions';

/** GitHub: a fresh installation token per request (D468; the broker's cache is keyed by job and epoch). */
@Injectable()
export class GithubFleetRepoFilesReader implements FleetRepoFilesReader {
  constructor(private readonly github: GitHubAppClient) {}

  private async token(repo: FleetRepoRef): Promise<string> {
    if (repo.githubInstallationId === null) throw new RepoUnreachableException('no_installation');
    return (await this.github.mintInstallationToken(repo.githubInstallationId, repo.name)).token;
  }

  async list(repo: FleetRepoRef): Promise<NaxFileList> {
    return forgeCall(async () => {
      const token = await this.token(repo);
      const baseSha = await this.github.getBranchHead(token, repo.owner, repo.name, repo.defaultBranch);
      const root = await this.github.getTree(token, repo.owner, repo.name, baseSha, false);
      const nax = root.entries.find((e) => e.path === '.nax' && e.type === 'tree');
      if (!nax) return { baseSha, defaultBranch: repo.defaultBranch, files: [] };
      const sub = await this.github.getTree(token, repo.owner, repo.name, nax.sha, true);
      if (sub.truncated) throw new ForgeErrorException();
      return { baseSha, defaultBranch: repo.defaultBranch, files: toNaxEntries(sub.entries.map((e) => ({ ...e, path: `.nax/${e.path}` }))) };
    });
  }

  async read(repo: FleetRepoRef, path: string, ref: string): Promise<NaxFileContent> {
    const file = await forgeCall(async () => this.github.getFile(await this.token(repo), repo.owner, repo.name, path, ref));
    if (!file) throw fileNotFound();
    return decodeNaxFile(path, file);
  }
}
```

Create `apps/api/src/fleet/repo-config/gitlab-fleet-repo-files.reader.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { GitLabAccessChecker } from '../git-broker/gitlab-access-checker';
import { GitLabTokenSource } from '../git-broker/gitlab-token.source';
import type { FleetRepoRef } from '../jobs/domain/fleet-job.domain';
import { decodeNaxFile, fileNotFound, forgeCall, FleetRepoFilesReader, NaxFileContent, NaxFileList, toNaxEntries } from './fleet-repo-files.reader';

/** GitLab: the project's VcsConnection token, as the git broker uses it (D468). */
@Injectable()
export class GitlabFleetRepoFilesReader implements FleetRepoFilesReader {
  constructor(
    private readonly gitlab: GitLabAccessChecker,
    private readonly tokens: GitLabTokenSource,
  ) {}

  async list(repo: FleetRepoRef): Promise<NaxFileList> {
    return forgeCall(async () => {
      const token = await this.tokens.resolve(repo.projectId, repo.owner, repo.name);
      const baseSha = await this.gitlab.getBranchHead(token, repo.owner, repo.name, repo.defaultBranch);
      const entries = await this.gitlab.listTree(token, repo.owner, repo.name, '.nax', baseSha);
      return { baseSha, defaultBranch: repo.defaultBranch, files: toNaxEntries(entries) };
    });
  }

  async read(repo: FleetRepoRef, path: string, ref: string): Promise<NaxFileContent> {
    const file = await forgeCall(async () => this.gitlab.getFile(await this.tokens.resolve(repo.projectId, repo.owner, repo.name), repo.owner, repo.name, path, ref));
    if (!file) throw fileNotFound();
    return decodeNaxFile(path, file);
  }
}
```

Create `apps/api/src/fleet/repo-config/fleet-repo-files.router.ts`:

```ts
import { Injectable } from '@nestjs/common';
import type { FleetRepoRef } from '../jobs/domain/fleet-job.domain';
import type { FleetRepoFilesReader, NaxFileContent, NaxFileList } from './fleet-repo-files.reader';
import { GithubFleetRepoFilesReader } from './github-fleet-repo-files.reader';
import { GitlabFleetRepoFilesReader } from './gitlab-fleet-repo-files.reader';

@Injectable()
export class FleetRepoFilesRouter implements FleetRepoFilesReader {
  constructor(
    private readonly github: GithubFleetRepoFilesReader,
    private readonly gitlab: GitlabFleetRepoFilesReader,
  ) {}

  private pick(repo: FleetRepoRef): FleetRepoFilesReader {
    return repo.provider === 'github' ? this.github : this.gitlab;
  }

  list(repo: FleetRepoRef): Promise<NaxFileList> {
    return this.pick(repo).list(repo);
  }

  read(repo: FleetRepoRef, path: string, ref: string): Promise<NaxFileContent> {
    return this.pick(repo).read(repo, path, ref);
  }
}
```

- [ ] **Step 4b: Review Focus — non-conforming names under `.nax/` are left out, not fatal**

Append inside `describe('GithubFleetRepoFilesReader', ...)` in the reader spec:

```ts
  it('leaves out files whose names fall outside the allowlist (spaces, non-ASCII) and lists the rest', async () => {
    github.getTree
      .mockResolvedValueOnce({ truncated: false, entries: [{ path: '.nax', type: 'tree', sha: 'naxTree', size: null }] })
      .mockResolvedValueOnce({ truncated: false, entries: [
        { path: 'rules/my rule.md', type: 'blob', sha: 's1', size: 1 },
        { path: 'rules/规则.md', type: 'blob', sha: 's2', size: 1 },
        { path: 'rules/ok.md', type: 'blob', sha: 's3', size: 1 },
      ] });
    await expect(reader.list(GH)).resolves.toEqual({ baseSha: 'c0ffee1', defaultBranch: 'trunk', files: [{ path: '.nax/rules/ok.md', size: 1, blobSha: 's3', group: 'rules' }] });
  });
```

Expected behaviour: such files are not editable through S3 (the allowlist segment rule), so they are filtered like any other non-allowlisted path; listing never throws because of them.

- [ ] **Step 5: Run the tests**

Run: `cd apps/api && bunx jest src/fleet/repo-config`
Expected: PASS. (`NotFoundAppException` exposes `status` 404 via `getStatus()`; if `toMatchObject({ status: 404 })` does not match
the exception shape in this repo, assert `rejects.toBeInstanceOf(NotFoundAppException)` instead — same intent.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/fleet/repo-config
git commit -m "feat(fleet): S3 FleetRepoFilesReader for GitHub and GitLab with repo_unreachable/forge error mapping (D468)"
```

---

### Task B1-8: Edit-set validation (spec §1 limits, §2)

**Files:**
- Create: `apps/api/src/fleet/repo-config/config-edit-input.ts`
- Test: `apps/api/src/fleet/repo-config/config-edit-input.spec.ts`

**Interfaces:**
- Consumes: `isAllowedNaxPath`, `NAX_CONFIG_LIMITS` (B1-1 mirror); `ConfigFileEdit` (B1-1).
- Produces (all throw `ValidationAppException({ reason }, 'fleet.configEditInput')` → 400):
  - `validateConfigEdits(raw: unknown): ConfigFileEdit[]` (1..50 edits; allowlisted paths; unique paths case-insensitively; put has string content, delete has none and a non-null baseSha; baseSha null or a 40/64-hex git id; UTF-8 bytes per file ≤ 262144 and total ≤ 1048576; no NUL)
  - `validatePrTitle(raw: unknown): string` (trimmed, 1..200 chars, no line breaks)
  - `validatePrBody(raw: unknown): string | null` (absent/null → null; ≤ 8192 UTF-8 bytes)
  - `validateBaseSha(raw: unknown): string`
  - `const GIT_OBJECT_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/fleet/repo-config/config-edit-input.spec.ts`:

```ts
import { ValidationAppException } from '@nathapp/nestjs-common';
import { validateBaseSha, validateConfigEdits, validatePrBody, validatePrTitle } from './config-edit-input';

const SHA = 'a'.repeat(40);
const put = (path: string, content = 'x', baseSha: string | null = null) => ({ path, op: 'put', content, baseSha });
const reasonOf = (fn: () => unknown): string => {
  // ValidationAppException carries its i18n args on `.args` (see dispatch-input.spec.ts:55).
  try { fn(); } catch (e) { expect(e).toBeInstanceOf(ValidationAppException); return (e as { args: { reason: string } }).args.reason; }
  throw new Error('did not throw');
};

describe('validateConfigEdits (fleet S3 §1, §2)', () => {
  it('returns a clean copy of a valid edit set', () => {
    const edits = validateConfigEdits([put('.nax/rules/a.md', '# a', SHA), { path: '.nax/profiles/old.json', op: 'delete', baseSha: SHA, extra: 1 }]);
    expect(edits).toEqual([
      { path: '.nax/rules/a.md', op: 'put', content: '# a', baseSha: SHA },
      { path: '.nax/profiles/old.json', op: 'delete', baseSha: SHA },
    ]);
  });

  it('accepts exactly 50 edits and 256 KiB per file', () => {
    expect(validateConfigEdits(Array.from({ length: 50 }, (_, i) => put(`.nax/rules/r${i}.md`)))).toHaveLength(50);
    expect(validateConfigEdits([put('.nax/context.md', 'x'.repeat(262_144))])).toHaveLength(1);
  });

  it.each([
    ['not an array', 'x', 'edits'],
    ['empty', [], 'edits'],
    ['51 edits', Array.from({ length: 51 }, (_, i) => put(`.nax/rules/r${i}.md`)), 'edits'],
    ['an env profile', [put('.nax/profiles/fast.env')], '.nax/profiles/fast.env'],
    ['a generated file', [put('AGENTS.md')], 'AGENTS.md'],
    ['a traversal', [put('.nax/rules/../config.json')], 'path'],
    ['a duplicate path', [put('.nax/context.md'), put('.nax/context.md')], 'duplicate'],
    ['a case-insensitive duplicate', [put('.nax/rules/A.md'), put('.nax/rules/a.md')], 'duplicate'],
    ['an unknown op', [{ path: '.nax/context.md', op: 'move', baseSha: null }], 'op'],
    ['put without content', [{ path: '.nax/context.md', op: 'put', baseSha: null }], 'content'],
    ['delete with content', [{ path: '.nax/context.md', op: 'delete', content: 'x', baseSha: SHA }], 'content'],
    ['delete of a new file', [{ path: '.nax/context.md', op: 'delete', baseSha: null }], 'baseSha'],
    ['a bad baseSha', [put('.nax/context.md', 'x', 'xyz')], 'baseSha'],
    ['an uppercase baseSha', [put('.nax/context.md', 'x', 'A'.repeat(40))], 'baseSha'],
    ['a file over 256 KiB (UTF-8 bytes)', [put('.nax/context.md', 'é'.repeat(131_073))], 'size'],
    ['over 1 MiB in total', Array.from({ length: 5 }, (_, i) => put(`.nax/rules/r${i}.md`, 'x'.repeat(220_000))), 'size'],
    ['a NUL in content', [put('.nax/context.md', 'a\u0000b')], 'content'],
    ['a non-object entry', ['x'], 'edit'],
  ])('refuses %s', (_label, raw, fragment) => {
    expect(reasonOf(() => validateConfigEdits(raw))).toContain(fragment);
  });
});

describe('validatePrTitle / validatePrBody / validateBaseSha', () => {
  it('trims and bounds the title', () => {
    expect(validatePrTitle('  Tighten rules  ')).toBe('Tighten rules');
    expect(validatePrTitle('t'.repeat(200))).toHaveLength(200);
    for (const bad of ['', '   ', 't'.repeat(201), 'a\nb', 42, undefined]) expect(() => validatePrTitle(bad)).toThrow(ValidationAppException);
  });

  it('bounds the body and maps absent to null', () => {
    expect(validatePrBody(undefined)).toBeNull();
    expect(validatePrBody(null)).toBeNull();
    expect(validatePrBody('why')).toBe('why');
    expect(() => validatePrBody('x'.repeat(8_193))).toThrow(ValidationAppException);
    expect(() => validatePrBody(5)).toThrow(ValidationAppException);
  });

  it('accepts a sha1 or sha256 commit id only', () => {
    expect(validateBaseSha(SHA)).toBe(SHA);
    expect(validateBaseSha('b'.repeat(64))).toBe('b'.repeat(64));
    for (const bad of ['abc', 'g'.repeat(40), 'a'.repeat(41), null]) expect(() => validateBaseSha(bad)).toThrow(ValidationAppException);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bunx jest src/fleet/repo-config/config-edit-input.spec.ts`
Expected: FAIL, "Cannot find module './config-edit-input'".

- [ ] **Step 3: Implement**

Create `apps/api/src/fleet/repo-config/config-edit-input.ts`:

```ts
import { ValidationAppException } from '@nathapp/nestjs-common';
import { isAllowedNaxPath, NAX_CONFIG_LIMITS } from '../common/nax-config-paths';
import type { ConfigFileEdit } from '../common/config-jobs';

/** A git commit or blob id: SHA-1 (40) or SHA-256 (64), lowercase hex. */
export const GIT_OBJECT_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function fail(reason: string): never {
  throw new ValidationAppException({ reason }, 'fleet.configEditInput');
}

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');
const shown = (p: unknown): string => (typeof p === 'string' ? p.slice(0, 200) : typeof p);

function edit(raw: unknown): ConfigFileEdit {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('edit must be an object');
  const { path, op, content, baseSha } = raw as Record<string, unknown>;
  if (typeof path !== 'string' || !isAllowedNaxPath(path)) fail(`path not allowed: ${shown(path)}`);
  if (op !== 'put' && op !== 'delete') fail(`op must be put or delete: ${path}`);
  if (baseSha !== null && (typeof baseSha !== 'string' || !GIT_OBJECT_RE.test(baseSha))) fail(`baseSha must be null or a git object id: ${path}`);
  if (op === 'put') {
    if (typeof content !== 'string') fail(`content required for put: ${path}`);
    if (content.includes('\u0000')) fail(`content must be text: ${path}`);
    if (bytes(content) > NAX_CONFIG_LIMITS.maxFileBytes) fail(`size over ${NAX_CONFIG_LIMITS.maxFileBytes} bytes: ${path}`);
    return { path, op, content, baseSha: baseSha as string | null };
  }
  if (content !== undefined) fail(`content not allowed for delete: ${path}`);
  if (baseSha === null) fail(`baseSha required for delete: ${path}`);
  return { path, op, baseSha: baseSha as string };
}

/** Spec §1 limits and the §2 allowlist; the runner re-checks every path (spec §5 step 3). */
export function validateConfigEdits(raw: unknown): ConfigFileEdit[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > NAX_CONFIG_LIMITS.maxEdits) fail(`edits must hold 1..${NAX_CONFIG_LIMITS.maxEdits} items`);
  const edits = raw.map(edit);
  const seen = new Set<string>();
  for (const e of edits) {
    // macOS clones are case-insensitive: two paths differing only by case would write one file.
    const key = e.path.toLowerCase();
    if (seen.has(key)) fail(`duplicate path: ${e.path}`);
    seen.add(key);
  }
  const total = edits.reduce((sum, e) => sum + (e.content === undefined ? 0 : bytes(e.content)), 0);
  if (total > NAX_CONFIG_LIMITS.maxTotalBytes) fail(`size over ${NAX_CONFIG_LIMITS.maxTotalBytes} bytes in total`);
  return edits;
}

export function validatePrTitle(raw: unknown): string {
  const title = typeof raw === 'string' ? raw.trim() : '';
  if (title.length === 0 || title.length > NAX_CONFIG_LIMITS.maxPrTitleChars || /[\r\n]/.test(title)) {
    fail(`prTitle must be 1..${NAX_CONFIG_LIMITS.maxPrTitleChars} characters on one line`);
  }
  return title;
}

export function validatePrBody(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || bytes(raw) > NAX_CONFIG_LIMITS.maxPrBodyBytes) fail(`prBody must be text of at most ${NAX_CONFIG_LIMITS.maxPrBodyBytes} bytes`);
  return raw;
}

export function validateBaseSha(raw: unknown): string {
  if (typeof raw !== 'string' || !GIT_OBJECT_RE.test(raw)) fail('baseSha must be a git commit id');
  return raw;
}
```


- [ ] **Step 3b: Review Focus — an emptied file is a valid put**

Append inside `describe('validateConfigEdits (fleet S3 §1, §2)', ...)` in `config-edit-input.spec.ts`:

```ts
  it('accepts an empty string as put content (emptying a rule file)', () => {
    expect(validateConfigEdits([put('.nax/rules/a.md', '', SHA)])).toEqual([{ path: '.nax/rules/a.md', op: 'put', content: '', baseSha: SHA }]);
  });
```

The implementation must test `typeof content === 'string'`, never truthiness; fix `config-edit-input.ts` if this fails.

- [ ] **Step 4: Run the tests**

Run: `cd apps/api && bunx jest src/fleet/repo-config/config-edit-input.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/fleet/repo-config/config-edit-input.ts apps/api/src/fleet/repo-config/config-edit-input.spec.ts
git commit -m "feat(fleet): S3 config edit-set validation (limits, allowlist, case-insensitive duplicates)"
```

---

### Task B1-9: Config edit store, `ConfigJobsService` and `FleetJobDto.configEdit` (spec §4.2, §4.3)

**Files:**
- Create: `apps/api/src/fleet/repo-config/domain/config-edit.domain.ts`
- Create: `apps/api/src/fleet/repo-config/prisma-config-edit.repository.ts`
- Create: `apps/api/src/fleet/repo-config/config-edit-store.module.ts`
- Create: `apps/api/src/fleet/repo-config/dto/config-edit.dto.ts`
- Create: `apps/api/src/fleet/repo-config/config-jobs.service.ts`
- Modify: `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts:30` (`command` enum), `:69-72` (new `configEdit` property), `:90` (`from`)
- Modify: `apps/api/src/fleet/jobs/fleet-jobs.service.ts:44-56` (constructor), `:183-186` (`withDetail`)
- Modify: `apps/api/src/fleet/jobs/fleet-jobs.module.ts:21` (import `ConfigEditStoreModule`)
- Test: `apps/api/src/fleet/repo-config/config-jobs.service.spec.ts`, `apps/api/src/fleet/jobs/fleet-jobs.service.spec.ts`

**Interfaces:**
- Consumes: B1-2 `createJob`/`DuplicateActiveJobError`/`findActiveJobId`/`appendEvent`/`lockById`; B1-7 `FLEET_REPO_FILES_READER`,
  `ConfigJobActiveException`; B1-8 validators; `FenceService.holds/abandon`; `FleetFenceException`
  (`apps/api/src/fleet/artifacts/bundle.exceptions.ts`); `PlacementService.placeJob`; `FleetJobLivePublisher`; `FleetActivityService.record`.
- Produces:
  - `CONFIG_EDIT_REPOSITORY` token; `ConfigEditRecord { id; jobId; mode: ConfigEditMode; edits: ConfigFileEdit[]; prTitle: string | null; prBody: string | null; baseSha: string; result: ConfigJobResult | null; createdAt: Date }`;
    `IConfigEditRepository { create(data: NewConfigEdit): Promise<ConfigEditRecord>; findByJobId(jobId: string): Promise<ConfigEditRecord | null> }`;
    `NewConfigEdit = Pick<ConfigEditRecord, 'jobId' | 'mode' | 'edits' | 'prTitle' | 'prBody' | 'baseSha'>`
  - `export const CONFIG_JOB_FEATURE = 'nax-config'` (in `config-jobs.service.ts`)
  - `ConfigJobsService` methods:
    - `listFiles(projectId: string, repoId: string): Promise<NaxFileList>`
    - `readFile(projectId: string, repoId: string, path: string, ref: string | undefined): Promise<NaxFileContent>`
    - `submitEdit(actorId: string, projectId: string, repoId: string, body: SubmitConfigEditDto): Promise<DispatchResultDto>`
    - `submitRegenerate(actorId: string, projectId: string, repoId: string, body: RegenerateConfigDto): Promise<DispatchResultDto>`
    - `submitDrift(actorId: string, projectId: string, repoId: string): Promise<DispatchResultDto>`
    - `getEditSet(projectId: string, jobId: string): Promise<ConfigEditPayloadDto>`
    - `fetchForRunner(runnerId: string, jobId: string, leaseEpochRaw: string | undefined): Promise<ConfigEditPayloadDto>`
  - DTOs (`dto/config-edit.dto.ts`): `ConfigFileEditDto`, `SubmitConfigEditDto { baseSha; edits: ConfigFileEditDto[]; prTitle; prBody? }`, `RegenerateConfigDto { prTitle; prBody? }`,
    `NaxFileEntryDto`, `NaxFileListDto`, `NaxFileContentDto`, `ConfigJobResultDto`, `ConfigEditPayloadDto`, `FleetJobConfigEditDto { mode; files: string[]; prTitle: string | null; result: ConfigJobResultDto | null }`
  - `FleetJobDto.configEdit: FleetJobConfigEditDto | null` — set on single-job responses (detail, cancel, requeue, config submit) for config kinds; null on list pages and for nax jobs.
    `result` = `FleetConfigEdit.result` once the job is terminal, else the live `FleetJob.configResult`.

- [ ] **Step 1: Write the failing service tests**

Create `apps/api/src/fleet/repo-config/config-jobs.service.spec.ts`:

```ts
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { DuplicateActiveJobError, FleetJobRecord, FleetRepoRef } from '../jobs/domain/fleet-job.domain';
import { FleetFenceException } from '../artifacts/bundle.exceptions';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { CONFIG_JOB_FEATURE, ConfigJobsService } from './config-jobs.service';
import { ConfigJobActiveException } from './repo-config.exceptions';

const NOW = new Date('2026-10-08T09:00:00.000Z');
const SHA = 'a'.repeat(40);
const REPO: FleetRepoRef = { id: 'repo-1', projectId: 'p1', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'trunk', githubInstallationId: BigInt(77) };

const record = (over: Partial<FleetJobRecord> = {}): FleetJobRecord => ({
  id: 'job-1', projectId: 'p1', repoId: 'repo-1', ref: 'trunk', command: 'CONFIG_EDIT', feature: CONFIG_JOB_FEATURE, planFrom: null, profiles: [],
  maxCostUsd: '0', bashMode: 'raw', approvalTimeoutSec: 600, selectorLabels: [], pinnedRunnerId: null, runnerId: null, runnerBootId: null,
  leaseEpoch: 0, state: 'QUEUED', stateReason: null, requestedById: 'u1', queuedAt: NOW, assignedAt: null, startedAt: null, finishedAt: null,
  cancelRequestedAt: null, naxRunId: null, naxLogRunId: null, naxCostRunId: null, progress: null, currentStoryId: null, currentPhase: null,
  costSpentUsd: '0', costCarriedUsd: '0', firstStartedAt: null, cancelReason: null, scheduleId: null, coalescedCount: 0, scheduleCountedAt: null,
  lastHeartbeatAt: null, finishResult: null, escalationReason: null, exitCode: null, resultBranch: null, resultSha: null, resultPrUrl: null,
  wipPush: null, stories: null, storiesTruncated: false, postRun: null, configResult: null, eventSeq: 0, ackedRunnerSeq: 0, attributedAt: null,
  updatedAt: NOW, ...over,
});

function setup() {
  const jobs = {
    findRepo: jest.fn(async (id: string) => (id === 'repo-1' ? REPO : id === 'foreign' ? { ...REPO, id, projectId: 'p2' } : null)),
    createJob: jest.fn(async (data: Partial<FleetJobRecord>) => record({ ...data } as Partial<FleetJobRecord>)),
    appendEvent: jest.fn(),
    findActiveJobId: jest.fn(async () => 'job-active'),
    findById: jest.fn(async () => record()),
    lockById: jest.fn(async () => record()),
  };
  const edits = {
    create: jest.fn(async (d: Record<string, unknown>) => ({ id: 'e1', result: null, createdAt: NOW, ...d })),
    findByJobId: jest.fn(async () => ({ id: 'e1', jobId: 'job-1', mode: 'edit', edits: [{ path: '.nax/context.md', op: 'put', content: '# x', baseSha: null }], prTitle: 'T', prBody: null, baseSha: SHA, result: null, createdAt: NOW })),
  };
  const reader = { list: jest.fn(async () => ({ baseSha: 'b'.repeat(40), defaultBranch: 'trunk', files: [] })), read: jest.fn(async () => ({ path: '.nax/context.md', blobSha: 'k', content: 'x' })) };
  const activity = { record: jest.fn() };
  const live = { event: jest.fn(() => ({ id: 'l' })), publish: jest.fn() };
  const placement = { placeJob: jest.fn(async () => ({ assigned: false, runnerId: null, leaseEpoch: null, misfits: [] })) };
  const fence = { holds: jest.fn((j: FleetJobRecord, r: string, e: number) => j.runnerId === r && j.leaseEpoch === e), abandon: jest.fn() };
  const tx = { run: (fn: () => unknown) => fn() };
  const svc = new ConfigJobsService(jobs as never, edits as never, reader as never, activity as never, live as never, placement as never, fence as never, tx as never);
  return { svc, jobs, edits, reader, activity, placement, fence };
}

describe('ConfigJobsService (fleet S3 §4)', () => {
  const body = { baseSha: SHA, edits: [{ path: '.nax/context.md', op: 'put' as const, content: '# x', baseSha: null }], prTitle: ' Tighten ', prBody: undefined };

  it('creates a CONFIG_EDIT job with the fixed columns, its edit row and a QUEUED event, then places it', async () => {
    const { svc, jobs, edits, placement, activity } = setup();
    const res = await svc.submitEdit('u1', 'p1', 'repo-1', body);
    expect(jobs.createJob).toHaveBeenCalledWith({
      projectId: 'p1', repoId: 'repo-1', ref: 'trunk', command: 'CONFIG_EDIT', feature: 'nax-config', planFrom: null, profiles: [],
      maxCostUsd: '0', bashMode: 'raw', approvalTimeoutSec: 600, selectorLabels: [], pinnedRunnerId: null, requestedById: 'u1',
    });
    expect(edits.create).toHaveBeenCalledWith({ jobId: 'job-1', mode: 'edit', edits: body.edits, prTitle: 'Tighten', prBody: null, baseSha: SHA });
    expect(jobs.appendEvent).toHaveBeenCalledWith('job-1', { leaseEpoch: 0, runnerSeq: null, type: 'state', payload: { from: null, to: 'QUEUED', by: 'server', reason: null } });
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'job.dispatched', payload: expect.objectContaining({ command: 'CONFIG_EDIT', mode: 'edit', files: ['.nax/context.md'] }) }));
    expect(placement.placeJob).toHaveBeenCalledWith('job-1');
    expect(res.job.configEdit).toEqual({ mode: 'edit', files: ['.nax/context.md'], prTitle: 'Tighten', result: null });
  });

  it('answers 409 config_job_active naming the active job', async () => {
    const { svc, jobs } = setup();
    jobs.createJob.mockRejectedValueOnce(new DuplicateActiveJobError());
    await expect(svc.submitEdit('u1', 'p1', 'repo-1', body)).rejects.toEqual(expect.any(ConfigJobActiveException));
    expect(jobs.findActiveJobId).toHaveBeenCalledWith('repo-1', 'nax-config');
  });

  it('refuses a repo of another project (404) and an invalid edit set (400) before any write', async () => {
    const { svc, jobs } = setup();
    await expect(svc.submitEdit('u1', 'p1', 'foreign', body)).rejects.toBeInstanceOf(NotFoundAppException);
    await expect(svc.submitEdit('u1', 'p1', 'repo-1', { ...body, edits: [{ path: '.nax/profiles/x.env', op: 'put', content: 'K=V', baseSha: null }] }))
      .rejects.toBeInstanceOf(ValidationAppException);
    await expect(svc.submitEdit('u1', 'p1', 'repo-1', { ...body, prTitle: '' })).rejects.toBeInstanceOf(ValidationAppException);
    expect(jobs.createJob).not.toHaveBeenCalled();
  });

  it('regenerate and drift read the current head as baseSha and carry no edits', async () => {
    const { svc, jobs, edits } = setup();
    await svc.submitRegenerate('u1', 'p1', 'repo-1', { prTitle: 'Regenerate agent files' });
    expect(edits.create).toHaveBeenLastCalledWith({ jobId: 'job-1', mode: 'regenerate', edits: [], prTitle: 'Regenerate agent files', prBody: null, baseSha: 'b'.repeat(40) });
    await svc.submitDrift('u1', 'p1', 'repo-1');
    expect(jobs.createJob).toHaveBeenLastCalledWith(expect.objectContaining({ command: 'CONFIG_DRIFT', feature: 'nax-config' }));
    expect(edits.create).toHaveBeenLastCalledWith({ jobId: 'job-1', mode: 'drift', edits: [], prTitle: null, prBody: null, baseSha: 'b'.repeat(40) });
  });

  it('reads a file at the given ref or the default branch, refusing a non-allowlisted path', async () => {
    const { svc, reader } = setup();
    await svc.readFile('p1', 'repo-1', '.nax/context.md', undefined);
    expect(reader.read).toHaveBeenLastCalledWith(REPO, '.nax/context.md', 'trunk');
    await svc.readFile('p1', 'repo-1', '.nax/context.md', SHA);
    expect(reader.read).toHaveBeenLastCalledWith(REPO, '.nax/context.md', SHA);
    await expect(svc.readFile('p1', 'repo-1', '.nax/profiles/x.env', undefined)).rejects.toBeInstanceOf(ValidationAppException);
    await expect(svc.readFile('p1', 'repo-1', '.nax/context.md', 'feature/x')).rejects.toBeInstanceOf(ValidationAppException);
  });

  describe('fetchForRunner (spec §3, D478)', () => {
    it('returns the edit set to the lease holder in ASSIGNED or RUNNING', async () => {
      const { svc, jobs } = setup();
      for (const state of ['ASSIGNED', 'RUNNING'] as const) {
        jobs.lockById.mockResolvedValueOnce(record({ runnerId: 'r1', leaseEpoch: 2, state }));
        await expect(svc.fetchForRunner('r1', 'job-1', '2')).resolves.toEqual({
          mode: 'edit', edits: [{ path: '.nax/context.md', op: 'put', content: '# x', baseSha: null }], prTitle: 'T', prBody: null, baseSha: SHA,
        });
      }
    });

    it('fences another runner or a stale epoch with ABANDON + 409', async () => {
      const { svc, jobs, fence } = setup();
      jobs.lockById.mockResolvedValue(record({ runnerId: 'r1', leaseEpoch: 2, state: 'RUNNING' }));
      await expect(svc.fetchForRunner('r2', 'job-1', '2')).rejects.toBeInstanceOf(FleetFenceException);
      await expect(svc.fetchForRunner('r1', 'job-1', '1')).rejects.toBeInstanceOf(FleetFenceException);
      expect(fence.abandon).toHaveBeenCalledTimes(2);
    });

    it('answers 409 jobState outside ASSIGNED/RUNNING, 404 for a nax job or an unknown job, 400 for a bad epoch', async () => {
      const { svc, jobs } = setup();
      jobs.lockById.mockResolvedValueOnce(record({ runnerId: 'r1', leaseEpoch: 2, state: 'UPLOADING' }));
      await expect(svc.fetchForRunner('r1', 'job-1', '2')).rejects.toBeInstanceOf(ConflictAppException);
      jobs.lockById.mockResolvedValueOnce(record({ runnerId: 'r1', leaseEpoch: 2, state: 'RUNNING', command: 'RUN' }));
      await expect(svc.fetchForRunner('r1', 'job-1', '2')).rejects.toBeInstanceOf(NotFoundAppException);
      jobs.lockById.mockResolvedValueOnce(null);
      await expect(svc.fetchForRunner('r1', 'job-1', '2')).rejects.toBeInstanceOf(NotFoundAppException);
      await expect(svc.fetchForRunner('r1', 'job-1', 'x')).rejects.toBeInstanceOf(ValidationAppException);
      await expect(svc.fetchForRunner('r1', 'job-1', undefined)).rejects.toBeInstanceOf(ValidationAppException);
    });
  });
});
```

Append to `apps/api/src/fleet/jobs/fleet-jobs.service.spec.ts`: add `configResult: null,` to `record` (next to `postRun: null`), pass a
12th constructor argument `configEdits as never` where `configEdits = { findByJobId: jest.fn() }`, and add:

```ts
  describe('configEdit on the detail (fleet S3 §4.3)', () => {
    const cfg = (state: string, configResult: unknown) => ({ ...record('jc'), command: 'CONFIG_DRIFT', state, configResult }) as never;
    const row = { mode: 'drift', edits: [], prTitle: null, result: { outcome: 'drift', files: ['AGENTS.md'] } };

    it('shows the live result while active and the stored result once terminal; null for a nax job', async () => {
      configEdits.findByJobId.mockResolvedValue(row);
      repo.findById.mockResolvedValueOnce(cfg('RUNNING', { outcome: 'drift', files: [] }));
      expect((await service.get(projectId, 'jc')).configEdit).toEqual({ mode: 'drift', files: [], prTitle: null, result: { outcome: 'drift', files: [] } });
      repo.findById.mockResolvedValueOnce(cfg('COMPLETED', null));
      expect((await service.get(projectId, 'jc')).configEdit).toEqual({ mode: 'drift', files: [], prTitle: null, result: { outcome: 'drift', files: ['AGENTS.md'] } });
      repo.findById.mockResolvedValueOnce(jobA);
      expect((await service.get(projectId, 'ja')).configEdit).toBeNull();
    });
  });
```

(Declare `let configEdits: { findByJobId: jest.Mock };` beside the other mocks and create it in `beforeEach`.)

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && bunx jest src/fleet/repo-config/config-jobs.service.spec.ts src/fleet/jobs/fleet-jobs.service.spec.ts`
Expected: FAIL — "Cannot find module './config-jobs.service'" and `configEdit` undefined.

- [ ] **Step 3: Store, DTOs and the job DTO field**

Create `apps/api/src/fleet/repo-config/domain/config-edit.domain.ts`:

```ts
import type { ConfigEditMode, ConfigFileEdit, ConfigJobResult } from '../../common/config-jobs';

export const CONFIG_EDIT_REPOSITORY = Symbol('CONFIG_EDIT_REPOSITORY');

export interface ConfigEditRecord {
  id: string;
  jobId: string;
  mode: ConfigEditMode;
  edits: ConfigFileEdit[];
  prTitle: string | null;
  prBody: string | null;
  baseSha: string;
  result: ConfigJobResult | null;
  createdAt: Date;
}

export type NewConfigEdit = Pick<ConfigEditRecord, 'jobId' | 'mode' | 'edits' | 'prTitle' | 'prBody' | 'baseSha'>;

export interface IConfigEditRepository {
  /** Inside the dispatch transaction. */
  create(data: NewConfigEdit): Promise<ConfigEditRecord>;
  findByJobId(jobId: string): Promise<ConfigEditRecord | null>;
}
```

Create `apps/api/src/fleet/repo-config/prisma-config-edit.repository.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { FleetConfigEdit as Row, Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { ConfigEditMode, ConfigFileEdit, ConfigJobResult } from '../common/config-jobs';
import { ConfigEditRecord, IConfigEditRepository, NewConfigEdit } from './domain/config-edit.domain';

const toRecord = (r: Row): ConfigEditRecord => ({
  ...r,
  mode: r.mode as ConfigEditMode,
  edits: r.edits as unknown as ConfigFileEdit[],
  result: r.result as unknown as ConfigJobResult | null,
});

@Injectable()
export class PrismaConfigEditRepository implements IConfigEditRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  /** Transaction-scoped inside txManager.run (nestjs-prisma ALS proxy). */
  private get db() {
    return this.prisma.client;
  }

  async create(data: NewConfigEdit): Promise<ConfigEditRecord> {
    return toRecord(await this.db.fleetConfigEdit.create({ data: { ...data, edits: data.edits as unknown as Prisma.InputJsonValue } }));
  }

  async findByJobId(jobId: string): Promise<ConfigEditRecord | null> {
    const r = await this.db.fleetConfigEdit.findUnique({ where: { jobId } });
    return r ? toRecord(r) : null;
  }
}
```

Create `apps/api/src/fleet/repo-config/config-edit-store.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { CONFIG_EDIT_REPOSITORY } from './domain/config-edit.domain';
import { PrismaConfigEditRepository } from './prisma-config-edit.repository';

/** Fleet S3: FleetConfigEdit storage, importable by jobs (detail DTO) and repo-config without a module cycle (ApprovalStoreModule pattern). */
@Module({
  imports: [PrismaModule],
  providers: [PrismaConfigEditRepository, { provide: CONFIG_EDIT_REPOSITORY, useExisting: PrismaConfigEditRepository }],
  exports: [CONFIG_EDIT_REPOSITORY],
})
export class ConfigEditStoreModule {}
```

Create `apps/api/src/fleet/repo-config/dto/config-edit.dto.ts`:

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import type { ConfigEditMode, ConfigJobOutcome } from '../../common/config-jobs';
import type { NaxPathGroup } from '../../common/nax-config-paths';

const OUTCOMES = ['ok', 'no_changes', 'drift', 'conflict', 'invalid', 'push_failed', 'pr_failed', 'timeout'];
const GROUPS = ['rules', 'context', 'config', 'profiles', 'constitution'];

/** Shape only; config-edit-input.ts enforces the allowlist, sizes and duplicates (spec §1, §2). */
export class ConfigFileEditDto {
  @ApiProperty({ maxLength: 512 }) @IsString() @MaxLength(512) declare path: string;
  @ApiProperty({ enum: ['put', 'delete'] }) @IsIn(['put', 'delete']) declare op: 'put' | 'delete';
  @ApiPropertyOptional({ description: 'Required for put, forbidden for delete; UTF-8, at most 256 KiB' }) @IsOptional() @IsString() content?: string;
  @ApiProperty({ type: String, nullable: true, description: 'Blob SHA the file was loaded at; null for a new file' })
  @IsOptional() @IsString() @MaxLength(64) declare baseSha: string | null;
}

export class SubmitConfigEditDto {
  @ApiProperty({ description: 'Default-branch commit the files were read at (nax-files baseSha)' }) @IsString() @MaxLength(64) declare baseSha: string;
  @ApiProperty({ type: [ConfigFileEditDto], maxItems: 50 })
  @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => ConfigFileEditDto) declare edits: ConfigFileEditDto[];
  @ApiProperty({ maxLength: 200 }) @IsString() @MaxLength(400) declare prTitle: string;
  @ApiPropertyOptional({ description: 'At most 8 KiB' }) @IsOptional() @IsString() prBody?: string;
}

export class RegenerateConfigDto {
  @ApiProperty({ maxLength: 200 }) @IsString() @MaxLength(400) declare prTitle: string;
  @ApiPropertyOptional() @IsOptional() @IsString() prBody?: string;
}

export class NaxFileEntryDto {
  @ApiProperty() declare path: string;
  @ApiPropertyOptional({ type: Number, nullable: true, description: 'Null on GitLab (tree listings carry no size)' }) declare size: number | null;
  @ApiProperty() declare blobSha: string;
  @ApiProperty({ enum: GROUPS }) declare group: NaxPathGroup;
}

export class NaxFileListDto {
  @ApiProperty() declare baseSha: string;
  @ApiProperty() declare defaultBranch: string;
  @ApiProperty({ type: [NaxFileEntryDto] }) declare files: NaxFileEntryDto[];
}

export class NaxFileContentDto {
  @ApiProperty() declare path: string;
  @ApiProperty() declare blobSha: string;
  @ApiProperty() declare content: string;
}

export class ConfigJobResultDto {
  @ApiProperty({ enum: OUTCOMES }) declare outcome: ConfigJobOutcome;
  @ApiPropertyOptional({ type: [String] }) files?: string[];
  @ApiPropertyOptional({ description: 'nax output tail, at most 8 KiB' }) output?: string;
}

export class ConfigEditPayloadDto {
  @ApiProperty({ enum: ['edit', 'regenerate', 'drift'] }) declare mode: ConfigEditMode;
  @ApiProperty({ type: [ConfigFileEditDto] }) declare edits: ConfigFileEditDto[];
  @ApiPropertyOptional({ type: String, nullable: true }) declare prTitle: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare prBody: string | null;
  @ApiProperty() declare baseSha: string;
}

export class FleetJobConfigEditDto {
  @ApiProperty({ enum: ['edit', 'regenerate', 'drift'] }) declare mode: ConfigEditMode;
  @ApiProperty({ type: [String], description: 'Edited paths (contents via GET .../config-edit)' }) declare files: string[];
  @ApiPropertyOptional({ type: String, nullable: true }) declare prTitle: string | null;
  @ApiPropertyOptional({ type: ConfigJobResultDto, nullable: true }) declare result: ConfigJobResultDto | null;
}
```

(The title DTO bound is 400 so a padded title reaches `validatePrTitle`, which trims and enforces 200.)

In `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts`:
- `import { FleetJobConfigEditDto } from '../../repo-config/dto/config-edit.dto';`
- change the `command` line to `@ApiProperty({ enum: ['RUN', 'PLAN', 'CONFIG_EDIT', 'CONFIG_DRIFT'] }) declare command: 'RUN' | 'PLAN' | 'CONFIG_EDIT' | 'CONFIG_DRIFT';`
- after the `tickets` property:

```ts
  @ApiPropertyOptional({ type: FleetJobConfigEditDto, nullable: true, description: 'Config job edit summary (fleet S3 §4.3). Null for nax jobs and on list pages.' })
  declare configEdit: FleetJobConfigEditDto | null;
```

- in `from()`, add `configEdit: null` next to `tickets: null`.

- [ ] **Step 4: `ConfigJobsService` and the jobs-detail hook**

Create `apps/api/src/fleet/repo-config/config-jobs.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FleetJobState } from '../../common/enums';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { FleetFenceException } from '../artifacts/bundle.exceptions';
import { isConfigKind } from '../common/config-jobs';
import type { ConfigEditMode, ConfigFileEdit } from '../common/config-jobs';
import { isAllowedNaxPath } from '../common/nax-config-paths';
import { DEFAULT_APPROVAL_TIMEOUT_SEC } from '../common/protocol';
import { FleetJobLivePublisher } from '../jobs/fleet-job-live.publisher';
import { PlacementService } from '../jobs/placement.service';
import { DuplicateActiveJobError, FLEET_JOB_REPOSITORY, FleetJobRecord, FleetRepoRef, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { DispatchResultDto, FleetJobDto } from '../jobs/dto/fleet-job.dto';
import { FenceService } from '../sync/fence.service';
import { GIT_OBJECT_RE, validateBaseSha, validateConfigEdits, validatePrBody, validatePrTitle } from './config-edit-input';
import { CONFIG_EDIT_REPOSITORY, ConfigEditRecord, IConfigEditRepository } from './domain/config-edit.domain';
import { ConfigEditPayloadDto, RegenerateConfigDto, SubmitConfigEditDto } from './dto/config-edit.dto';
import { FLEET_REPO_FILES_READER, FleetRepoFilesReader, NaxFileContent, NaxFileList } from './fleet-repo-files.reader';
import { ConfigJobActiveException } from './repo-config.exceptions';

/** Fixed feature for config jobs: the active (repoId, feature) index then serializes them per repo (D465). */
export const CONFIG_JOB_FEATURE = 'nax-config';
const FETCH_STATES: readonly string[] = [FleetJobState.ASSIGNED, FleetJobState.RUNNING];

const toPayload = (e: ConfigEditRecord): ConfigEditPayloadDto =>
  Object.assign(new ConfigEditPayloadDto(), { mode: e.mode, edits: e.edits, prTitle: e.prTitle, prBody: e.prBody, baseSha: e.baseSha });

@Injectable()
export class ConfigJobsService {
  constructor(
    @Inject(FLEET_JOB_REPOSITORY) private readonly jobs: Pick<IFleetJobRepository, 'findRepo' | 'createJob' | 'appendEvent' | 'findActiveJobId' | 'findById' | 'lockById'>,
    @Inject(CONFIG_EDIT_REPOSITORY) private readonly edits: IConfigEditRepository,
    @Inject(FLEET_REPO_FILES_READER) private readonly reader: FleetRepoFilesReader,
    private readonly activity: FleetActivityService,
    private readonly live: FleetJobLivePublisher,
    private readonly placement: PlacementService,
    private readonly fence: FenceService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  async listFiles(projectId: string, repoId: string): Promise<NaxFileList> {
    return this.reader.list(await this.repoIn(projectId, repoId));
  }

  /** `ref` defaults to the default branch; otherwise it must be a commit id (the list call's baseSha). */
  async readFile(projectId: string, repoId: string, path: string, ref: string | undefined): Promise<NaxFileContent> {
    if (!isAllowedNaxPath(path)) throw new ValidationAppException({ reason: `path not allowed: ${String(path).slice(0, 200)}` }, 'fleet.configEditInput');
    if (ref !== undefined && !GIT_OBJECT_RE.test(ref)) throw new ValidationAppException({ reason: 'ref must be a commit id' }, 'fleet.configEditInput');
    const repo = await this.repoIn(projectId, repoId);
    return this.reader.read(repo, path, ref ?? repo.defaultBranch);
  }

  async submitEdit(actorId: string, projectId: string, repoId: string, body: SubmitConfigEditDto): Promise<DispatchResultDto> {
    const repo = await this.repoIn(projectId, repoId);
    const edits = validateConfigEdits(body.edits);
    const prTitle = validatePrTitle(body.prTitle);
    const prBody = validatePrBody(body.prBody);
    const baseSha = validateBaseSha(body.baseSha);
    return this.create(actorId, repo, 'edit', edits, prTitle, prBody, baseSha);
  }

  async submitRegenerate(actorId: string, projectId: string, repoId: string, body: RegenerateConfigDto): Promise<DispatchResultDto> {
    const repo = await this.repoIn(projectId, repoId);
    const prTitle = validatePrTitle(body.prTitle);
    const prBody = validatePrBody(body.prBody);
    const { baseSha } = await this.reader.list(repo);
    return this.create(actorId, repo, 'regenerate', [], prTitle, prBody, baseSha);
  }

  async submitDrift(actorId: string, projectId: string, repoId: string): Promise<DispatchResultDto> {
    const repo = await this.repoIn(projectId, repoId);
    const { baseSha } = await this.reader.list(repo);
    return this.create(actorId, repo, 'drift', [], null, null, baseSha);
  }

  /** "Reopen edits" (spec §6): the full stored edit set of a config job in this project. */
  async getEditSet(projectId: string, jobId: string): Promise<ConfigEditPayloadDto> {
    const job = await this.jobs.findById(jobId);
    if (!job || job.projectId !== projectId || !isConfigKind(job.command)) throw new NotFoundAppException({}, 'fleet.jobs');
    const edit = await this.edits.findByJobId(jobId);
    if (!edit) throw new NotFoundAppException({}, 'fleet.jobs');
    return toPayload(edit);
  }

  /** Spec §3, D478: bundle-upload fence pattern; the runner fetches before it reports RUNNING. */
  async fetchForRunner(runnerId: string, jobId: string, leaseEpochRaw: string | undefined): Promise<ConfigEditPayloadDto> {
    const leaseEpoch = Number(leaseEpochRaw);
    if (leaseEpochRaw === undefined || !Number.isInteger(leaseEpoch) || leaseEpoch < 0) {
      throw new ValidationAppException({ reason: 'leaseEpoch' }, 'fleet.configEditInput');
    }
    const outcome = await this.txManager.run(async () => {
      const job = await this.jobs.lockById(jobId);
      if (!job || !isConfigKind(job.command)) return { kind: 'missing' as const };
      if (!this.fence.holds(job, runnerId, leaseEpoch)) {
        await this.fence.abandon(runnerId, job, leaseEpoch);
        return { kind: 'fenced' as const };
      }
      if (!FETCH_STATES.includes(job.state)) return { kind: 'state' as const, state: job.state };
      const edit = await this.edits.findByJobId(jobId);
      return edit ? { kind: 'ok' as const, edit } : { kind: 'missing' as const };
    });
    // Throw after commit so a stale lease's ABANDON is not rolled back (bundle.service.ts pattern).
    if (outcome.kind === 'missing') throw new NotFoundAppException({}, 'fleet.jobs');
    if (outcome.kind === 'fenced') throw new FleetFenceException();
    if (outcome.kind === 'state') throw new ConflictAppException({ state: outcome.state }, 'fleet.jobState');
    return toPayload(outcome.edit);
  }

  private async repoIn(projectId: string, repoId: string): Promise<FleetRepoRef> {
    const repo = await this.jobs.findRepo(repoId);
    if (!repo || repo.projectId !== projectId) throw new NotFoundAppException({}, 'fleet.repos');
    return repo;
  }

  private async create(
    actorId: string, repo: FleetRepoRef, mode: ConfigEditMode, edits: ConfigFileEdit[], prTitle: string | null, prBody: string | null, baseSha: string,
  ): Promise<DispatchResultDto> {
    const command = mode === 'drift' ? 'CONFIG_DRIFT' : 'CONFIG_EDIT';
    let job: FleetJobRecord;
    let edit: ConfigEditRecord;
    try {
      ({ job, edit } = await this.txManager.run(async () => {
        const created = await this.jobs.createJob({
          projectId: repo.projectId, repoId: repo.id, ref: repo.defaultBranch, command, feature: CONFIG_JOB_FEATURE, planFrom: null, profiles: [],
          maxCostUsd: '0', bashMode: 'raw', approvalTimeoutSec: DEFAULT_APPROVAL_TIMEOUT_SEC, selectorLabels: [], pinnedRunnerId: null, requestedById: actorId,
        });
        const row = await this.edits.create({ jobId: created.id, mode, edits, prTitle, prBody, baseSha });
        await this.jobs.appendEvent(created.id, { leaseEpoch: 0, runnerSeq: null, type: 'state', payload: { from: null, to: 'QUEUED', by: 'server', reason: null } });
        await this.activity.record({
          actorType: 'USER', actorId, action: 'job.dispatched', entityType: 'job', entityId: created.id, jobId: created.id,
          projectId: repo.projectId, responsibleUserId: actorId,
          payload: { repoId: repo.id, feature: CONFIG_JOB_FEATURE, command, ref: repo.defaultBranch, mode, files: edits.map((e) => e.path) },
        });
        return { job: created, edit: row };
      }));
    } catch (error) {
      if (!(error instanceof DuplicateActiveJobError)) throw error;
      throw new ConfigJobActiveException((await this.jobs.findActiveJobId(repo.id, CONFIG_JOB_FEATURE)) ?? 'unknown');
    }
    this.live.publish([this.live.event(job)]);
    const outcome = await this.placement.placeJob(job.id);
    const fresh = (await this.jobs.findById(job.id)) ?? job;
    return Object.assign(new DispatchResultDto(), {
      job: Object.assign(FleetJobDto.from(fresh), { tickets: [], configEdit: { mode, files: edit.edits.map((e) => e.path), prTitle: edit.prTitle, result: null } }),
      placement: { assigned: outcome.assigned, runnerId: outcome.runnerId, misfits: outcome.misfits },
    });
  }
}
```

In `apps/api/src/fleet/jobs/fleet-jobs.service.ts`:
- imports: `import { isConfigKind } from '../common/config-jobs';`, `import { CONFIG_EDIT_REPOSITORY, type IConfigEditRepository } from '../repo-config/domain/config-edit.domain';`, `import type { FleetJobConfigEditDto } from '../repo-config/dto/config-edit.dto';`
- constructor, last parameter: `@Inject(CONFIG_EDIT_REPOSITORY) private readonly configEdits: Pick<IConfigEditRepository, 'findByJobId'>,`
- replace `withDetail`:

```ts
  /** C9 D460: single-job responses (detail, cancel, requeue) carry the linked tickets; lists keep null. S3 §4.3 adds configEdit. */
  private async withDetail(r: FleetJobRecord): Promise<FleetJobDto> {
    return Object.assign(await this.withPending(r), { tickets: await this.fleetTickets.forJob(r.id), configEdit: await this.configEditFor(r) });
  }

  /** S3 §4.3: the stored result once the job is terminal (copied in the terminal transition), else the live mirror. */
  private async configEditFor(r: FleetJobRecord): Promise<FleetJobConfigEditDto | null> {
    if (!isConfigKind(r.command)) return null;
    const edit = await this.configEdits.findByJobId(r.id);
    if (!edit) return null;
    return { mode: edit.mode, files: edit.edits.map((e) => e.path), prTitle: edit.prTitle, result: isTerminal(r.state) ? edit.result : r.configResult };
  }
```

In `apps/api/src/fleet/jobs/fleet-jobs.module.ts` add `ConfigEditStoreModule` (from `'../repo-config/config-edit-store.module'`) to `imports`.

- [ ] **Step 5: Run the tests**

Run: `cd apps/api && bunx jest src/fleet/repo-config src/fleet/jobs src/fleet/fleet.module.spec.ts && bun run type-check`
Expected: PASS; type-check 0.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/fleet/repo-config apps/api/src/fleet/jobs
git commit -m "feat(fleet): S3 ConfigJobsService, config edit store and FleetJobDto.configEdit (D465, D466)"
```

---

### Task B1-10: Project routes, module wiring and i18n (spec §4.1-§4.3, S3-6)

**Files:**
- Create: `apps/api/src/fleet/repo-config/project-repo-config.controller.ts`
- Create: `apps/api/src/fleet/repo-config/project-job-config-edit.controller.ts`
- Create: `apps/api/src/fleet/repo-config/repo-config.module.ts`
- Modify: `apps/api/src/fleet/fleet.module.ts` (import `RepoConfigModule`)
- Modify: `apps/api/src/fleet/fleet.module.spec.ts` (assert `ConfigJobsService` resolves)
- Modify: `apps/api/src/i18n/en/fleet.json`, `apps/api/src/i18n/zh/fleet.json`
- Test: `apps/api/test/integration/fleet/fleet-repo-config-api.integration.spec.ts`

**Interfaces:**
- Consumes: `ConfigJobsService` (B1-9); `ProjectMembershipGuard`, `ProjectPermission`, `CurrentProject`, `isUserPrincipal` (as in `fleet-jobs.controller.ts`).
- Produces routes (all under `/api`):
  - `GET projects/:slug/fleet/repos/:repoId/nax-files` → `NaxFileListDto` (any user member)
  - `GET projects/:slug/fleet/repos/:repoId/nax-files/content?path=&ref=` → `NaxFileContentDto` (any user member)
  - `POST projects/:slug/fleet/repos/:repoId/config-edits` (`CREATE FleetJob`) → 201 `DispatchResultDto`
  - `POST projects/:slug/fleet/repos/:repoId/config-edits/regenerate` (`CREATE FleetJob`) → 201 `DispatchResultDto`
  - `POST projects/:slug/fleet/repos/:repoId/drift-checks` (`CREATE FleetJob`) → 201 `DispatchResultDto`
  - `GET projects/:slug/fleet/jobs/:id/config-edit` → `ConfigEditPayloadDto` (any user member)
  - `RepoConfigModule` (exports nothing).

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/test/integration/fleet/fleet-repo-config-api.integration.spec.ts`:

```ts
/**
 * Fleet S3 §4 — .nax reads through the forge, config job submission, permissions (PG + fake GitHub).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-repo-config-api.integration.spec.ts
 */
import request from 'supertest';
import { generateKeyPairSync } from 'crypto';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FakeForge, startFakeForge } from '../../helpers/fake-forge';
import { FLEET_CAPS, FleetHttpWorld, insertRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const ENV_KEYS = ['GITHUB_API_URL', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_FILE', 'GITHUB_APP_SLUG'] as const;
const HEAD = 'c'.repeat(40);
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describeIntegration('fleet repo config API (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let forge: FakeForge;
  let world: FleetHttpWorld;
  const saved: Record<string, string | undefined> = {};
  const auth = (who: keyof FleetHttpWorld['tokens']) => ({ Authorization: `Bearer ${world.tokens[who]}` });
  const base = () => `/api/projects/web/fleet/repos/${world.repoId}`;
  const edit = { baseSha: HEAD, prTitle: 'Tighten testing rule', edits: [{ path: '.nax/rules/testing.md', op: 'put', content: '# Testing\n', baseSha: 'b'.repeat(40) }] };

  beforeAll(async () => {
    forge = await startFakeForge();
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const keyFile = join(mkdtempSync(join(tmpdir(), 'gh-app-')), 'app.pem');
    writeFileSync(keyFile, privateKey.export({ type: 'pkcs1', format: 'pem' }));
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    Object.assign(process.env, { GITHUB_API_URL: forge.url, GITHUB_APP_ID: '4242', GITHUB_APP_PRIVATE_KEY_FILE: keyFile, GITHUB_APP_SLUG: 'koda-fleet' });
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
  });
  beforeEach(() => {
    forge.routes.clear();
    forge.routes.set('POST /app/installations/77/access_tokens', () => ({ status: 201, body: { token: 'ghs_1', expires_at: '2099-01-01T00:00:00Z' } }));
    forge.routes.set('GET /repos/acme/app/git/ref/heads/trunk', () => ({ status: 200, body: { object: { sha: HEAD } } }));
    forge.routes.set(`GET /repos/acme/app/git/trees/${HEAD}`, () => ({ status: 200, body: { truncated: false, tree: [{ path: '.nax', type: 'tree', sha: 'naxTree' }] } }));
    forge.routes.set('GET /repos/acme/app/git/trees/naxTree', () => ({
      status: 200,
      body: { truncated: false, tree: [
        { path: 'context.md', type: 'blob', sha: 'k'.repeat(40), size: 9 },
        { path: 'rules/testing.md', type: 'blob', sha: 'b'.repeat(40), size: 4 },
        { path: 'profiles/fast.env', type: 'blob', sha: 'e'.repeat(40), size: 4 },
        { path: 'features/x/prd.json', type: 'blob', sha: 'f'.repeat(40), size: 2 },
      ] },
    }));
    forge.routes.set('GET /repos/acme/app/contents/.nax/context.md', () => ({ status: 200, body: { type: 'file', sha: 'k'.repeat(40), size: 9, encoding: 'base64', content: b64('# Context') } }));
  });
  afterAll(async () => {
    await app.close();
    await forge.close();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('lets a VIEWER list the allowlisted files at the default-branch head (no .env, no feature files)', async () => {
    const list = data<{ baseSha: string; files: Array<{ path: string; group: string }> }>(await request(server).get(`${base()}/nax-files`).set(auth('viewer')).expect(200));
    expect(list.baseSha).toBe(HEAD);
    expect(list.files.map((f) => [f.path, f.group])).toEqual([['.nax/rules/testing.md', 'rules'], ['.nax/context.md', 'context']]);
  });

  it('reads one file for a VIEWER and refuses a non-allowlisted path with 400', async () => {
    const file = data<{ content: string; blobSha: string }>(
      await request(server).get(`${base()}/nax-files/content`).query({ path: '.nax/context.md', ref: HEAD }).set(auth('viewer')).expect(200),
    );
    expect(file).toEqual({ path: '.nax/context.md', blobSha: 'k'.repeat(40), content: '# Context' });
    await request(server).get(`${base()}/nax-files/content`).query({ path: '.nax/profiles/fast.env' }).set(auth('viewer')).expect(400);
  });

  it('answers 403 for an outsider and 404 for a repo of another project', async () => {
    await request(server).get(`${base()}/nax-files`).set(auth('outsider')).expect(403);
    await request(server).get(`/api/projects/web/fleet/repos/${world.foreignRepoId}/nax-files`).set(auth('dev')).expect(404);
  });

  it('maps a forge failure to 502 and a missing installation token to 409 repo_unreachable', async () => {
    forge.routes.set('GET /repos/acme/app/git/ref/heads/trunk', () => ({ status: 500, body: {} }));
    await request(server).get(`${base()}/nax-files`).set(auth('dev')).expect(502);
    forge.routes.delete('POST /app/installations/77/access_tokens');
    await request(server).get(`${base()}/nax-files`).set(auth('dev')).expect(409);
  });

  it('refuses edits from a VIEWER (403) and invalid edit sets (400)', async () => {
    await request(server).post(`${base()}/config-edits`).set(auth('viewer')).send(edit).expect(403);
    await request(server).post(`${base()}/config-edits`).set(auth('dev')).send({ ...edit, edits: [{ ...edit.edits[0], path: 'AGENTS.md' }] }).expect(400);
    await request(server).post(`${base()}/config-edits`).set(auth('dev')).send({ ...edit, edits: [] }).expect(400);
    await request(server).post(`${base()}/config-edits`).set(auth('dev')).send({ ...edit, prTitle: '' }).expect(400);
  });

  it('queues a CONFIG_EDIT for a DEVELOPER, stores the edit set, and serializes config jobs per repo (409)', async () => {
    const res = data<{ job: { id: string; command: string; state: string; ref: string; feature: string; maxCostUsd: string; configEdit: unknown } }>(
      await request(server).post(`${base()}/config-edits`).set(auth('dev')).send(edit).expect(201),
    );
    expect(res.job).toEqual(expect.objectContaining({
      command: 'CONFIG_EDIT', state: 'QUEUED', ref: 'trunk', feature: 'nax-config', maxCostUsd: '0',
      configEdit: { mode: 'edit', files: ['.nax/rules/testing.md'], prTitle: 'Tighten testing rule', result: null },
    }));
    const row = await prisma.fleetConfigEdit.findUniqueOrThrow({ where: { jobId: res.job.id } });
    expect(row).toEqual(expect.objectContaining({ mode: 'edit', baseSha: HEAD, prTitle: 'Tighten testing rule' }));

    const dup = await request(server).post(`${base()}/drift-checks`).set(auth('dev')).expect(409);
    expect(JSON.stringify(dup.body)).toContain(res.job.id);

    const detail = data<{ configEdit: unknown }>(await request(server).get(`/api/projects/web/fleet/jobs/${res.job.id}`).set(auth('viewer')).expect(200));
    expect(detail.configEdit).toEqual({ mode: 'edit', files: ['.nax/rules/testing.md'], prTitle: 'Tighten testing rule', result: null });
    const set = data<{ edits: unknown[]; baseSha: string }>(await request(server).get(`/api/projects/web/fleet/jobs/${res.job.id}/config-edit`).set(auth('viewer')).expect(200));
    expect(set.edits).toEqual(edit.edits);
    expect(set.baseSha).toBe(HEAD);

    await prisma.fleetJob.update({ where: { id: res.job.id }, data: { state: 'CANCELLED' } });
  });

  it('does not offer config kinds on the generic dispatch endpoint', async () => {
    await request(server).post('/api/projects/web/fleet/jobs').set(auth('dev'))
      .send({ repoId: world.repoId, command: 'CONFIG_EDIT', feature: 'nax-config', maxCostUsd: 1 }).expect(400);
  });

  it('places on an S3 runner and reports config_jobs for an older one', async () => {
    const old = await insertRunner(prisma, { name: 'old-box' });
    const drift = data<{ job: { id: string; state: string }; placement: { misfits: Array<{ runnerId: string; reason: string }> } }>(
      await request(server).post(`${base()}/drift-checks`).set(auth('dev')).expect(201),
    );
    expect(drift.job.state).toBe('QUEUED');
    expect(drift.placement.misfits).toEqual(expect.arrayContaining([expect.objectContaining({ runnerId: old.id, reason: 'config_jobs' })]));
    await prisma.fleetJob.update({ where: { id: drift.job.id }, data: { state: 'CANCELLED' } });
    await prisma.runner.update({ where: { id: old.id }, data: { enabled: false } });

    const s3 = await insertRunner(prisma, { name: 's3-box', capabilities: { ...FLEET_CAPS, configJobs: true } });
    const regen = data<{ job: { state: string; runnerId: string } }>(
      await request(server).post(`${base()}/config-edits/regenerate`).set(auth('dev')).send({ prTitle: 'Regenerate agent files' }).expect(201),
    );
    expect(regen.job).toEqual(expect.objectContaining({ state: 'ASSIGNED', runnerId: s3.id }));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-repo-config-api.integration.spec.ts`
Expected: FAIL — routes answer 404.

- [ ] **Step 3: Controllers and module**

Create `apps/api/src/fleet/repo-config/project-repo-config.controller.ts`:

```ts
import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CaslPermissionAction, Principal } from '@nathapp/nestjs-auth';
import { ForbiddenAppException, JsonResponse } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { isUserPrincipal } from '../../auth/principal/koda-principal.types';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { ProjectPermission } from '../../projects/project-permission.decorator';
import { DispatchResultDto } from '../jobs/dto/fleet-job.dto';
import { ConfigJobsService } from './config-jobs.service';
import { NaxFileContentDto, NaxFileListDto, RegenerateConfigDto, SubmitConfigEditDto } from './dto/config-edit.dto';

@ApiTags('fleet')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/fleet/repos/:repoId')
@UseGuards(ProjectMembershipGuard)
export class ProjectRepoConfigController {
  constructor(private readonly configJobs: ConfigJobsService) {}

  @Get('nax-files')
  @ApiOperation({ summary: "The repo's allowlisted .nax files at the default-branch head (project member)" })
  @ApiResponse({ status: 200, type: NaxFileListDto })
  @ApiResponse({ status: 409, description: 'koda cannot read the repo (fleet.repoUnreachable)' })
  @ApiResponse({ status: 502, description: 'The forge failed' })
  async list(@Param('repoId') repoId: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    if (!isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'projects');
    return JsonResponse.Ok(await this.configJobs.listFiles(ctx.project.id, repoId));
  }

  @Get('nax-files/content')
  @ApiOperation({ summary: 'One allowlisted .nax file at a commit (project member)' })
  @ApiQuery({ name: 'path', required: true })
  @ApiQuery({ name: 'ref', required: false, description: 'Commit id from nax-files baseSha; defaults to the default branch' })
  @ApiResponse({ status: 200, type: NaxFileContentDto })
  @ApiResponse({ status: 422, description: 'Over 256 KiB or not UTF-8 text (fleet.naxFile)' })
  async read(
    @Param('repoId') repoId: string, @Query('path') path: string, @Query('ref') ref: string | undefined,
    @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal,
  ) {
    if (!isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'projects');
    return JsonResponse.Ok(await this.configJobs.readFile(ctx.project.id, repoId, path, ref || undefined));
  }

  @Post('config-edits')
  @HttpCode(201)
  @ProjectPermission([CaslPermissionAction.CREATE, 'FleetJob'])
  @ApiOperation({ summary: 'Queue a CONFIG_EDIT job: a runner applies the edits, regenerates, validates and opens a PR (project DEVELOPER+)' })
  @ApiResponse({ status: 201, type: DispatchResultDto })
  @ApiResponse({ status: 409, description: 'A config job is already active for this repo (fleet.configJobActive)' })
  async submitEdit(@Param('repoId') repoId: string, @Body() body: SubmitConfigEditDto, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.configJobs.submitEdit(principal.id, ctx.project.id, repoId, body));
  }

  @Post('config-edits/regenerate')
  @HttpCode(201)
  @ProjectPermission([CaslPermissionAction.CREATE, 'FleetJob'])
  @ApiOperation({ summary: 'Queue a regenerate PR (CONFIG_EDIT with no file edits) (project DEVELOPER+)' })
  @ApiResponse({ status: 201, type: DispatchResultDto })
  async submitRegenerate(@Param('repoId') repoId: string, @Body() body: RegenerateConfigDto, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.configJobs.submitRegenerate(principal.id, ctx.project.id, repoId, body));
  }

  @Post('drift-checks')
  @HttpCode(201)
  @ProjectPermission([CaslPermissionAction.CREATE, 'FleetJob'])
  @ApiOperation({ summary: 'Queue a read-only CONFIG_DRIFT job (project DEVELOPER+)' })
  @ApiResponse({ status: 201, type: DispatchResultDto })
  async submitDrift(@Param('repoId') repoId: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.configJobs.submitDrift(principal.id, ctx.project.id, repoId));
  }
}
```

Create `apps/api/src/fleet/repo-config/project-job-config-edit.controller.ts`:

```ts
import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { ForbiddenAppException, JsonResponse } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { isUserPrincipal } from '../../auth/principal/koda-principal.types';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { ConfigJobsService } from './config-jobs.service';
import { ConfigEditPayloadDto } from './dto/config-edit.dto';

@ApiTags('fleet')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/fleet/jobs')
@UseGuards(ProjectMembershipGuard)
export class ProjectJobConfigEditController {
  constructor(private readonly configJobs: ConfigJobsService) {}

  @Get(':id/config-edit')
  @ApiOperation({ summary: "A config job's full edit set, for Reopen edits (project member)" })
  @ApiResponse({ status: 200, type: ConfigEditPayloadDto })
  async get(@Param('id') id: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    if (!isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'projects');
    return JsonResponse.Ok(await this.configJobs.getEditSet(ctx.project.id, id));
  }
}
```

Create `apps/api/src/fleet/repo-config/repo-config.module.ts` (the runner controller is added to it in B1-11):

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { GitBrokerModule } from '../git-broker/git-broker.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { SyncModule } from '../sync/sync.module';
import { ConfigEditStoreModule } from './config-edit-store.module';
import { ConfigJobsService } from './config-jobs.service';
import { FLEET_REPO_FILES_READER } from './fleet-repo-files.reader';
import { FleetRepoFilesRouter } from './fleet-repo-files.router';
import { GithubFleetRepoFilesReader } from './github-fleet-repo-files.reader';
import { GitlabFleetRepoFilesReader } from './gitlab-fleet-repo-files.reader';
import { ProjectJobConfigEditController } from './project-job-config-edit.controller';
import { ProjectRepoConfigController } from './project-repo-config.controller';

/** Fleet S3 (spec docs/superpowers/specs/2026-10-07-fleet-s3-repo-config-and-credential-board-design.md). */
@Module({
  imports: [PrismaModule, ProjectAccessModule, FleetActivityModule, GitBrokerModule, FleetJobsModule, SyncModule, ConfigEditStoreModule],
  controllers: [ProjectRepoConfigController, ProjectJobConfigEditController],
  providers: [
    GithubFleetRepoFilesReader, GitlabFleetRepoFilesReader, FleetRepoFilesRouter,
    { provide: FLEET_REPO_FILES_READER, useExisting: FleetRepoFilesRouter },
    ConfigJobsService,
  ],
})
export class RepoConfigModule {}
```

In `apps/api/src/fleet/fleet.module.ts` import `RepoConfigModule` from `'./repo-config/repo-config.module'` and append it to the
`imports` array. In `apps/api/src/fleet/fleet.module.spec.ts` add `import { ConfigJobsService } from './repo-config/config-jobs.service';`
and `expect(module.get(ConfigJobsService)).toBeDefined();` in the "compiles" test.

- [ ] **Step 4: i18n**

In `apps/api/src/i18n/en/fleet.json` add before the closing brace (keep valid JSON, comma after `"ticketJobs"`):

```json
  "repoUnreachable": { "409": "koda cannot read this repository: {reason}" },
  "forge": { "502": "The repository host did not answer correctly; try again later" },
  "naxFile": { "404": "This file does not exist at that commit", "422": "This file cannot be edited here: {reason}" },
  "configJobActive": { "409": "A config job is already active for this repository: {activeJobId}" },
  "configEditInput": { "-2": "Invalid config edit: {reason}" }
```

In `apps/api/src/i18n/zh/fleet.json`:

```json
  "repoUnreachable": { "409": "koda 无法读取该仓库：{reason}" },
  "forge": { "502": "代码托管平台未正确响应，请稍后重试" },
  "naxFile": { "404": "该文件在此提交中不存在", "422": "此文件无法在此编辑：{reason}" },
  "configJobActive": { "409": "该仓库已有进行中的配置任务：{activeJobId}" },
  "configEditInput": { "-2": "配置编辑无效：{reason}" }
```

- [ ] **Step 5: Run the tests**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-repo-config-api.integration.spec.ts && bunx jest src/fleet/fleet.module.spec.ts src/i18n`
Expected: PASS. (If `src/i18n` has an en/zh key-parity spec, it covers the new keys; if the folder has no spec, jest reports
"No tests found" for that path — that is fine.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/fleet apps/api/src/i18n apps/api/test/integration/fleet/fleet-repo-config-api.integration.spec.ts
git commit -m "feat(fleet): S3 project routes for .nax reads and config jobs; i18n (S3-6)"
```

---

### Task B1-11: Runner-authenticated, lease-fenced `config-edit` fetch (spec §3, D478)

**Files:**
- Create: `apps/api/src/fleet/repo-config/runner-config-edit.controller.ts`
- Modify: `apps/api/src/fleet/repo-config/repo-config.module.ts` (`controllers`)
- Test: `apps/api/test/integration/fleet/fleet-runner-config-edit.integration.spec.ts`

**Interfaces:**
- Consumes: `ConfigJobsService.fetchForRunner(runnerId, jobId, leaseEpochRaw)` (B1-9); `@RunnerRoute()`, `RunnerPrincipal` (as in `bundle-upload.controller.ts`).
- Produces: `GET /api/fleet/runner/jobs/:jobId/config-edit?leaseEpoch=<n>` → 200 `ConfigEditPayloadDto` (`{ ret: 0, data }` envelope, like every route); 400 bad epoch; 404 unknown/non-config job; 409 `fleet.fence` (ABANDON queued) or `fleet.jobState`. B2's `ServerClient.getConfigEdit` calls exactly this.

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/test/integration/fleet/fleet-runner-config-edit.integration.spec.ts`:

```ts
/**
 * Fleet S3 §3 — the runner's lease-fenced edit-set fetch (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-runner-config-edit.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { enrollRunner, FLEET_CAPS, FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const CAPS = { ...FLEET_CAPS, configJobs: true as const };
const EDITS = [{ path: '.nax/context.md', op: 'put', content: '# x', baseSha: null }];

describeIntegration('fleet runner config-edit fetch (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let box1: { runnerId: string; apiKey: string };
  let box2: { runnerId: string; apiKey: string };
  let n = 0;

  const job = async (over: { command?: string; state?: string; runnerId?: string; leaseEpoch?: number; withEdit?: boolean } = {}) => {
    const created = await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: over.command ?? 'CONFIG_EDIT', feature: `cfg-${++n}`, profiles: [],
        selectorLabels: [], maxCostUsd: new Prisma.Decimal(0), requestedById: world.ids.dev, state: over.state ?? 'ASSIGNED',
        runnerId: over.runnerId ?? box1.runnerId, leaseEpoch: over.leaseEpoch ?? 1,
      },
    });
    if (over.withEdit !== false) {
      await prisma.fleetConfigEdit.create({ data: { jobId: created.id, mode: 'edit', edits: EDITS, prTitle: 'T', baseSha: 'a'.repeat(40) } });
    }
    return created.id;
  };
  const fetchAs = (runner: { apiKey: string }, jobId: string, epoch: string | null = '1') =>
    request(server).get(`/api/fleet/runner/jobs/${jobId}/config-edit`).query(epoch === null ? {} : { leaseEpoch: epoch }).set({ Authorization: `Bearer ${runner.apiKey}` });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    box1 = await enrollRunner(server, world.tokens.root, 'box-1', { capabilities: CAPS });
    box2 = await enrollRunner(server, world.tokens.root, 'box-2', { capabilities: CAPS });
  });
  afterAll(async () => {
    await app.close();
  });

  it.each(['ASSIGNED', 'RUNNING'])('serves the edit set to the holder in %s', async (state) => {
    const id = await job({ state });
    expect(data(await fetchAs(box1, id).expect(200))).toEqual({ mode: 'edit', edits: EDITS, prTitle: 'T', prBody: null, baseSha: 'a'.repeat(40) });
  });

  it('fences a stale epoch and another runner with 409 and queues ABANDON', async () => {
    const id = await job({ leaseEpoch: 2 });
    await fetchAs(box1, id, '1').expect(409);
    await fetchAs(box2, id, '2').expect(409);
    const abandons = await prisma.fleetCommand.findMany({ where: { jobId: id, type: 'ABANDON' } });
    expect(abandons.map((c) => c.runnerId).sort()).toEqual([box1.runnerId, box2.runnerId].sort());
  });

  it('answers 409 in UPLOADING, 404 for a nax job or a job without an edit row, 400 without a valid epoch', async () => {
    await fetchAs(box1, await job({ state: 'UPLOADING' })).expect(409);
    await fetchAs(box1, await job({ command: 'RUN', withEdit: false })).expect(404);
    await fetchAs(box1, await job({ withEdit: false })).expect(404);
    const id = await job();
    await fetchAs(box1, id, null).expect(400);
    await fetchAs(box1, id, '-1').expect(400);
  });

  it('refuses a user token (runner route only)', async () => {
    const id = await job();
    await request(server).get(`/api/fleet/runner/jobs/${id}/config-edit`).query({ leaseEpoch: '1' }).set({ Authorization: `Bearer ${world.tokens.root}` }).expect(401);
  });
});
```

(If the last assertion gets 403 instead of 401, check `fleet-admin-guards.integration.spec.ts` for what `@RunnerRoute` answers a
user principal today and assert that same status — the route must refuse it either way.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-runner-config-edit.integration.spec.ts`
Expected: FAIL — 404 for every call (route missing).

- [ ] **Step 3: Implement**

Create `apps/api/src/fleet/repo-config/runner-config-edit.controller.ts`:

```ts
import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { RunnerRoute } from '../../auth/guards/runner-route.decorator';
import type { RunnerPrincipal } from '../../auth/principal/koda-principal.types';
import { ConfigJobsService } from './config-jobs.service';
import { ConfigEditPayloadDto } from './dto/config-edit.dto';

@ApiTags('fleet-runner')
@ApiBearerAuth()
@RunnerRoute()
@Controller('fleet/runner/jobs')
export class RunnerConfigEditController {
  constructor(private readonly configJobs: ConfigJobsService) {}

  @Get(':jobId/config-edit')
  @ApiOperation({ summary: "A config job's edit set for the lease holder (fleet S3 §3); fetched before RUNNING" })
  @ApiResponse({ status: 200, type: ConfigEditPayloadDto })
  @ApiResponse({ status: 409, description: 'Stale lease (ABANDON queued), or the job is not ASSIGNED/RUNNING' })
  async get(@Principal() runner: RunnerPrincipal, @Param('jobId') jobId: string, @Query('leaseEpoch') leaseEpoch: string | undefined) {
    return JsonResponse.Ok(await this.configJobs.fetchForRunner(runner.id, jobId, leaseEpoch));
  }
}
```

Add `RunnerConfigEditController` (import from `'./runner-config-edit.controller'`) to the `controllers` array of `RepoConfigModule`.

- [ ] **Step 4: Run the tests**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-runner-config-edit.integration.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/fleet/repo-config apps/api/test/integration/fleet/fleet-runner-config-edit.integration.spec.ts
git commit -m "feat(fleet): S3 runner config-edit fetch with the bundle-upload lease fence (D478)"
```

---

### Task B1-12: Attribution on config PRs; analytics excludes config kinds (spec §5 step 8, §6, D479)

**Files:**
- Test: `apps/api/src/fleet/sync/pr-attribution.service.spec.ts` (new `describe`)
- Modify: `apps/api/src/fleet/analytics/prisma-analytics.repository.ts:139-146` (`countJobs`), `:162-174` (`topJobs`)
- Test: `apps/api/test/integration/fleet/fleet-analytics-config-jobs.integration.spec.ts`

**Interfaces:**
- Consumes: `PrAttributionService.attribute(jobId, now)` (unchanged); `insertAnalyticsJob` (`apps/api/test/helpers/fleet-analytics-fixtures.ts`).
- Produces: `countJobs`-based panels (`finishResults`, `escalationReasons`) and `topJobs` only see `command IN ('RUN', 'PLAN')`.

- [ ] **Step 1: Write the failing analytics test and the attribution pin**

Append to `apps/api/src/fleet/sync/pr-attribution.service.spec.ts`:

```ts
import { PrAttributionService } from './pr-attribution.service';

describe('PrAttributionService on a config job PR (fleet S3 §5 step 8: attribution replaces a PR body footer)', () => {
  it('posts "Dispatched by <name> via koda job <id>" for a terminal CONFIG_EDIT with a PR on its own repo', async () => {
    const repo = {
      findById: jest.fn(async () => ({ id: 'job-9', state: 'COMPLETED', command: 'CONFIG_EDIT', resultPrUrl: 'https://github.com/acme/app/pull/12', repoId: 'repo-1', leaseEpoch: 1, requestedById: 'u1' })),
      findRepo: jest.fn(async () => ({ id: 'repo-1', projectId: 'p1', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', githubInstallationId: BigInt(77) })),
      claimAttribution: jest.fn(async () => true),
      findUserDisplayName: jest.fn(async () => 'Dev One'),
    };
    const github = { commentOnPullRequest: jest.fn(async () => true) };
    const svc = new PrAttributionService(repo as never, github as never, {} as never, {} as never);
    await expect(svc.attribute('job-9')).resolves.toBe('posted');
    expect(github.commentOnPullRequest).toHaveBeenCalledWith(BigInt(77), 'acme', 'app', 12, 'Dispatched by Dev One via koda job job-9', expect.objectContaining({ jobId: 'job-9' }));
  });
});
```

(This passes already — it pins that no attribution guard on `command` is ever added; spec §5 step 8 relies on it.)

Create `apps/api/test/integration/fleet/fleet-analytics-config-jobs.integration.spec.ts`:

```ts
/**
 * Fleet S3 D479 — analytics job panels ignore config jobs (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-analytics-config-jobs.integration.spec.ts
 */
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { seedFleetBase } from '../../helpers/fleet-fixtures';
import { insertAnalyticsJob } from '../../helpers/fleet-analytics-fixtures';
import { PrismaAnalyticsRepository } from '../../../src/fleet/analytics/prisma-analytics.repository';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet analytics excludes config jobs (PG)', () => {
  const prisma = new PrismaClient();
  const repo = new PrismaAnalyticsRepository({ client: prisma } as unknown as PrismaService<PrismaClient>);
  const from = new Date('2026-09-28T00:00:00Z');
  const to = new Date('2026-10-12T00:00:00Z');
  let projectId: string;
  let runJob: string;

  beforeAll(async () => {
    await resetDb();
    const base = await seedFleetBase(prisma);
    projectId = base.projectId;
    const owner = { projectId, repoId: base.repoId, requestedById: base.adminId };
    runJob = await insertAnalyticsJob(prisma, owner, { costSpentUsd: '0.3', finishResult: 'promoted', escalationReason: 'x' });
    // Real config jobs carry no finishResult/escalationReason; set them here so the filter, not NULL-skipping, is what is tested.
    await insertAnalyticsJob(prisma, owner, { command: 'CONFIG_EDIT', feature: 'nax-config', finishResult: 'promoted', escalationReason: 'x' });
    await insertAnalyticsJob(prisma, owner, { command: 'CONFIG_DRIFT', feature: 'nax-config-2' });
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('counts finish results and escalation reasons of nax jobs only', async () => {
    expect(await repo.finishResults(projectId, from, to)).toEqual([{ value: 'promoted', count: 1 }]);
    expect(await repo.escalationReasons(projectId, from, to)).toEqual([{ value: 'x', count: 1 }]);
  });

  it('lists nax jobs only in topJobs', async () => {
    expect((await repo.topJobs(projectId, from, to, 10)).map((j) => j.jobId)).toEqual([runJob]);
  });
});
```

- [ ] **Step 2: Run them to verify the analytics test fails**

Run: `cd apps/api && bunx jest src/fleet/sync/pr-attribution.service.spec.ts && bun run test:scoped test/integration/fleet/fleet-analytics-config-jobs.integration.spec.ts`
Expected: attribution PASS; analytics FAIL — counts 2 and topJobs lists three jobs.

- [ ] **Step 3: Implement**

In `apps/api/src/fleet/analytics/prisma-analytics.repository.ts` add near the top (after the imports):

```ts
/** Fleet S3 D479: config jobs are not agent runs; job-level panels ignore them. */
const NAX_JOBS = Prisma.sql`j."command" IN ('RUN', 'PLAN')`;
```

In `countJobs`, change the WHERE line to:

```ts
      WHERE j."projectId" = ${projectId} AND j."finishedAt" >= ${from} AND j."finishedAt" < ${to} AND ${column} IS NOT NULL AND ${NAX_JOBS}
```

In `topJobs`, change its WHERE line to:

```ts
      WHERE j."projectId" = ${projectId} AND j."finishedAt" >= ${from} AND j."finishedAt" < ${to} AND ${NAX_JOBS}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-analytics-config-jobs.integration.spec.ts test/integration/fleet/fleet-analytics-repository.integration.spec.ts`
Expected: PASS (the existing repository spec is unchanged: it seeds RUN/PLAN jobs only).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/fleet/analytics/prisma-analytics.repository.ts apps/api/src/fleet/sync/pr-attribution.service.spec.ts apps/api/test/integration/fleet/fleet-analytics-config-jobs.integration.spec.ts
git commit -m "feat(fleet): S3 analytics excludes config jobs; pin attribution on config PRs (D479)"
```

---

### Task B1-13: OpenAPI and CLI client regeneration; API gates

**Files:**
- Modify: `openapi.json`, `apps/cli/src/generated/**` (generated)
- Modify (only if it fails): `apps/api/src/fleet/fleet-openapi.contract.spec.ts`

**Interfaces:**
- Consumes: every route and DTO of B1-9..B1-11.
- Produces: `openapi.json` containing the six new routes; regenerated CLI client (Part C adds the two CLI commands on top of it).

- [ ] **Step 1: Regenerate**

```bash
bun run generate
git diff --stat openapi.json apps/cli/src/generated | tail -3
grep -c '"/api/projects/{slug}/fleet/repos/{repoId}/nax-files"' openapi.json
grep -c '"/api/fleet/runner/jobs/{jobId}/config-edit"' openapi.json
```

Expected: both greps print `1`; the diff touches `openapi.json` and generated client files only.

- [ ] **Step 2: Run the contract spec and the API gates**

```bash
cd apps/api && bunx jest src/fleet/fleet-openapi.contract.spec.ts
cd ../.. && bun run lint && bun run type-check
cd apps/api && bun run test && bun run test:integration
```

Expected: all exit 0. If `fleet-openapi.contract.spec.ts` enumerates fleet routes or tags and fails on the new ones, add the six
routes to its expected list exactly as the failure message prints them (that spec pins the public contract; extending it is the
intended change). If `bun run test:integration` reports a failure outside `test/integration/fleet/`, re-run that file alone once
to rule out the known local login-throttle 429 cascade before investigating.

- [ ] **Step 3: Commit**

```bash
git add openapi.json apps/cli/src/generated apps/api/src/fleet/fleet-openapi.contract.spec.ts
git commit -m "chore(fleet): regenerate openapi.json and the CLI client for S3 config jobs"
```

## Part B2 — PR 2 (2/2): Runner

Branch: the PR 2 branch `feat/fleet-s3-2-config-jobs` (cut in Part B1's first task). Part B1 has already landed, on the
same branch, the protocol types (`packages/fleet-protocol/src/config-jobs.ts`, `nax-config-paths.ts`,
`FleetJobKindName` with the config kinds, `RunnerCapabilities.configJobs?`, `SnapshotEventPayload.configResult?`), the
migration, and the API endpoints including `GET /fleet/runner/jobs/:jobId/config-edit?leaseEpoch=`. Every command
below runs from the repo root unless it says `cd`.

Decisions this part relies on (already in the spec's Decisions table):

| # | Decision |
|---|---|
| D480 | Config jobs use the runner's shared per-repo clone (`<workspaceRoot>/<owner>/<name>`, under the repo mutex, `ensureClone` + `cleanWorkspace`) and a detached checkout of `origin/<defaultBranch>`, not a separate fresh clone: same isolation as every other job, no second copy of the repo. |
| D481 | The edit fetch, credentials and checkout run while ASSIGNED (`prepareConfigJob`), so a failure there is ASSIGNED -> FAILED (spec §3 "fetch or clone"); RUNNING is emitted after a clean checkout. |
| D482 | `JobExecutor` gains `prepareConfigJob(job, options)` and `runConfigJob(job, ctx)`; `runConfigJob` returns `ConfigJobRun` (`result` / `failed` / `stopped`), because a setup error and a cancel are not config outcomes. |
| D483 | The config timeout and heartbeat are runner `Tuning` constants (`configJobTimeoutMs` 600 000, `configHeartbeatMs` 30 000), not environment variables: runner tuning is code-only (D42). |
| D484 | Every nax / gh / glab call of a config job is spawned detached (own process group); its pid and pgid are written to the journal row while it runs and cleared after. git calls are not tracked: commit, push and status carry the remaining deadline as their timeout, the short rev-parse calls keep git's default; cancel, halt and the deadline are also checked between steps. |
| D485 | A config job found RUNNING or UPLOADING by READOPT is rejected (`config job interrupted by a runner restart`), so the server marks it CRASHED; requeue is manual. One found ASSIGNED with no pid re-prepares (nothing was pushed yet). |
| D486 | `matchesProcess` for a config job is true when the recorded pid's argv contains the job's clone path (nax calls pass `-d <repoDir>`) or the job branch `nax-config/<jobId>` (gh / glab calls). |
| D487 | The job branch is pushed with `--force` to `refs/heads/nax-config/<jobId>`: the namespace belongs to the job, and a requeued attempt replaces the previous attempt's commit (an open PR follows it). |
| D488 | The terminal state event carries `reason = outcome` for COMPLETED too (`ok`, `no_changes`, `drift`), so the job page can tell "no changes" from "PR opened" without reading `configResult`. |
| D489 | A cancel that arrives after the config job produced a result does not hide it: a `result` is reported as is; only a run the executor actually stopped ends CANCELLED. |
| D490 | Per-package `.nax/mono/**/config.json` is checked with a JSON-object parse only: nax 0.83.x has no CLI entry point that loads a package overlay (`nax config --json -d <pkg>` walks up to the root `.nax/` and loads the root config; overlays load only inside `loadConfigForWorkdir` during runs). Recorded as a limitation. |
| D491 | The runner trims `configResult` to a 12 KiB serialized budget (output tail first, then trailing file names) so the snapshot always fits the 16 KiB event payload cap: the spec's caps (50 x 512-char paths + 8 KiB) can add up to more than 16 KiB. |

### File Structure

Create:
- `apps/runner/src/executor/config-job/types.ts` — `ProcResult`, `RunProc`, `StoppedError`, `DeadlineError`, `checkpoint()`, `remainingMs()`.
- `apps/runner/src/executor/config-job/subprocess.ts` — `trackedRun()`: detached spawn, pgid callback, stop and deadline polling, capped output.
- `apps/runner/src/executor/config-job/payload.ts` — `parseConfigEditPayload()` (D30: re-validate what the server sent).
- `apps/runner/src/executor/config-job/checkout.ts` — `prepareConfigCheckout()`: detached checkout of `origin/<defaultBranch>`.
- `apps/runner/src/executor/config-job/staleness.ts` — `currentBlob()`, `findConflicts()`.
- `apps/runner/src/executor/config-job/apply-edits.ts` — `applyEdits()` with allowlist re-check and symlink refusal.
- `apps/runner/src/executor/config-job/drift.ts` — `changedFiles()` from `git status --porcelain=v1 -z`.
- `apps/runner/src/executor/config-job/regenerate.ts` — `regenerate()`: `nax generate` / `--all-packages`.
- `apps/runner/src/executor/config-job/validate.ts` — `validateConfig()`: rules lint, root config, edited profiles, package configs.
- `apps/runner/src/executor/config-job/commit-push.ts` — `configBranchName()`, `commitAndPushConfig()`.
- `apps/runner/src/executor/config-job/open-pr.ts` — `openPullRequest()` for gh / glab with the existing-PR fallback.
- `apps/runner/src/executor/config-job/result-fit.ts` — `fitConfigResult()`, `tailBytes()`.
- `apps/runner/src/executor/config-job/config-job.ts` — `runConfigJob()` orchestrator.
- `apps/runner/src/supervisor/config-edit-fetch.ts` — `ConfigEditSource`, `fetchConfigEdit()` with retry and 409 = stale.
- `apps/runner/src/supervisor/heartbeat.ts` — `startHeartbeat()`.
- `apps/runner/test/fixtures/fake-nax-config.ts` — fake `nax generate` and `nax rules lint`.
- Specs beside each new module (`*.spec.ts`), `apps/runner/test/unit/config-job.spec.ts`, `apps/runner/src/supervisor/job-run-config.spec.ts`, `apps/runner/test/integration/config-jobs.integration.spec.ts`.

Modify:
- `apps/runner/src/supervisor/assign-parser.ts:41-55` — accept config kinds.
- `apps/runner/test/helpers/assign.ts` — `assignFor` for config kinds.
- `apps/runner/src/capabilities/capability-probe.ts:21-28`, `apps/runner/src/capabilities/nax-probe.ts:151-163` — report `configJobs: true`.
- `apps/runner/src/sync/http.ts` — `ServerClient.getConfigEdit()`.
- `apps/runner/src/nax/nax-cli.ts:54` — export `readCapped`.
- `apps/runner/src/executor/job-executor.ts` — `ConfigJobContext`, `ConfigJobRun`, two new methods.
- `apps/runner/src/executor/host-executor.ts` — shared `prepareWorkspace`, `prepareConfigJob`, `runConfigJob`, config `matchesProcess`.
- `apps/runner/test/helpers/fake-executor.ts` — scriptable config methods.
- `apps/runner/src/supervisor/job-run.ts` — `runConfig` / `finishConfig`, `configEdits` dep, tuning fields.
- `apps/runner/src/supervisor/supervisor.ts:100-104` — READOPT rejects interrupted config jobs.
- `apps/runner/src/daemon/tuning.ts`, `apps/runner/src/daemon/daemon.ts:134-155` — wiring.
- `apps/runner/test/fixtures/fake-nax.ts`, `apps/runner/test/fixtures/fake-nax-probe.ts`, `apps/runner/test/fixtures/fake-gh.ts`.
- `apps/runner/test/integration/harness/world.ts` — config helpers and seed files.
- `.nax/mono/apps/runner/context.md` (+ regenerated `apps/runner/AGENTS.md` etc. via `nax generate`).

---

### Task B2-1: assign parser accepts the config kinds

**Files:**
- Modify: `apps/runner/src/supervisor/assign-parser.ts:41-55`
- Modify: `apps/runner/test/helpers/assign.ts`
- Test: `apps/runner/src/supervisor/assign-parser.spec.ts`

**Interfaces:**
- Consumes: `isConfigKind`, `FleetJobKindName` (with `CONFIG_EDIT | CONFIG_DRIFT`) from `@nathapp/fleet-protocol` (Part B1).
- Produces: `parseAssign` returns `{ ok: true, assign }` for a config ASSIGN with `planFrom: null`, `profiles: []`, `maxCostUsd: "0"`, `bashMode: 'raw'`; `assignFor(command: FleetJobKindName, over?)` test helper.

- [ ] **Step 1: Extend the test helper**

Replace `apps/runner/test/helpers/assign.ts` with:

```ts
import { isConfigKind, type AssignPayload, type FleetJobKindName } from '@nathapp/fleet-protocol';

export function assignFor(command: FleetJobKindName = 'RUN', over: Partial<AssignPayload> = {}): AssignPayload {
  const config = isConfigKind(command);
  return {
    jobId: 'j1', command,
    repo: { provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', cloneUrl: 'https://github.com/acme/app.git' },
    ref: 'main', feature: config ? 'nax-config' : 'feat', planFrom: command === 'PLAN' ? 'docs/spec.md' : null, profiles: [],
    maxCostUsd: config ? '0' : '5', bashMode: 'raw', approvalTimeoutSec: 600,
    gitIdentity: { name: 'koda-fleet[bot]', email: 'koda-fleet[bot]@users.noreply.github.com' }, ...over,
  };
}
```

- [ ] **Step 2: Write the failing tests**

Append to `apps/runner/src/supervisor/assign-parser.spec.ts`:

```ts
describe('parseAssign: config jobs (S3 §3)', () => {
  test.each(['CONFIG_EDIT', 'CONFIG_DRIFT'] as const)('accepts a well-formed %s payload with cost "0"', (command) => {
    const a = assignFor(command);
    expect(a.maxCostUsd).toBe('0');
    expect(parseAssign(cmd(a))).toEqual({ ok: true, assign: a });
  });
  test.each([
    ['a planFrom', { ...assignFor('CONFIG_EDIT'), planFrom: 'docs/x.md' }, 'planFrom'],
    ['a profile', { ...assignFor('CONFIG_EDIT'), profiles: ['fast'] }, 'profiles'],
    ['a gated bash mode', { ...assignFor('CONFIG_DRIFT'), bashMode: 'gated' }, 'bashMode'],
  ])('rejects a config job with %s', (_label, payload, detail) => {
    expect(parseAssign(cmd(payload))).toEqual({ ok: false, detail: `invalid ${detail}` });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/runner && bun test src/supervisor/assign-parser.spec.ts`
Expected: FAIL — the two `accepts` cases return `{ ok: false, detail: 'invalid command' }`.

- [ ] **Step 4: Implement**

In `apps/runner/src/supervisor/assign-parser.ts`, change the import line 1 to:

```ts
import { isConfigKind, type AssignPayload, type BashMode, type FleetCommandOut, type FleetJobKindName } from '@nathapp/fleet-protocol';
```

Replace line 41 (`if (p['command'] !== 'RUN' && p['command'] !== 'PLAN') return bad('command');`) with:

```ts
  const command = p['command'];
  if (typeof command !== 'string' || (command !== 'RUN' && command !== 'PLAN' && !isConfigKind(command))) return bad('command');
  const isConfig = isConfigKind(command);
```

Replace line 53 (the profiles check) with:

```ts
  if (!Array.isArray(profiles) || profiles.length > 8 || (isConfig && profiles.length > 0) || !profiles.every((n) => typeof n === 'string' && PROFILE_NAME.test(n) && !n.startsWith(RESERVED_PREFIX))) return bad('profiles');
```

Replace line 55 (the bashMode check) with:

```ts
  if (typeof p['bashMode'] !== 'string' || !BASH_MODES.includes(p['bashMode']) || ((isPlan || isConfig) && p['bashMode'] !== 'raw')) return bad('bashMode');
```

and in the returned object replace `command: p['command'],` with `command: command as FleetJobKindName,`. The planFrom rule on line 51 already rejects a non-null planFrom for every non-PLAN kind. `COST_RE` (`/^\d+(\.\d{1,4})?$/`, `executor/nax-process.ts:7`) already accepts `"0"`; the new test pins it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/runner && bun test src/supervisor/assign-parser.spec.ts`
Expected: PASS (all old and new cases).

- [ ] **Step 6: Commit**

```bash
git add apps/runner/src/supervisor/assign-parser.ts apps/runner/src/supervisor/assign-parser.spec.ts apps/runner/test/helpers/assign.ts
git commit -m "feat(runner): accept CONFIG_EDIT and CONFIG_DRIFT assigns (S3 §3)"
```

---

### Task B2-2: runners report `configJobs: true`

**Files:**
- Modify: `apps/runner/src/capabilities/capability-probe.ts:21-28`
- Modify: `apps/runner/src/capabilities/nax-probe.ts:151-163`
- Test: `apps/runner/src/capabilities/capability-probe.spec.ts`, `apps/runner/src/capabilities/nax-probe.spec.ts`

**Interfaces:**
- Consumes: `RunnerCapabilities.configJobs?: true` (Part B1).
- Produces: every capability report from an S3 runner carries `configJobs: true`; placement (Part B1) gives config jobs the permanent misfit `config_jobs` without it.

- [ ] **Step 1: Write the failing tests (tighten the two exact-match expectations)**

In `apps/runner/src/capabilities/capability-probe.spec.ts`, the first `StaticCapabilityProbe` test (line 21) becomes:

```ts
    expect(first).toEqual({ capabilities: { ...stat(), configJobs: true, sandbox: { available: true, probedAt: '2026-10-01T00:00:00.000Z' } }, warnings: [] });
```

In `apps/runner/src/capabilities/nax-probe.spec.ts`, the first `NaxCapabilityProbe` test's `expect(capabilities).toEqual({...})` (lines 76-91) gains, after `executors: ['host'],`:

```ts
      configJobs: true,
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/runner && bun test src/capabilities`
Expected: FAIL — both `toEqual`s miss `configJobs: true`.

- [ ] **Step 3: Implement**

In `capability-probe.ts`, `StaticCapabilityProbe.probe()` returns:

```ts
    // S3 §3: config jobs are a feature of this runner build, not something runner.json declares.
    return { capabilities: { ...rest, configJobs: true, sandbox: { ...sandbox, probedAt: this.now().toISOString() } }, warnings: [] };
```

In `nax-probe.ts`, in the capabilities object built at lines 155-163, add after `executors: ['host'],`:

```ts
        configJobs: true,
```

- [ ] **Step 4: Pin that the server keeps the field**

In `test/integration/capabilities.integration.spec.ts:18-25` (a `toMatchObject` on the stored runner row) add `configJobs: true,` after `executors: ['host'],`, so the integration run (Task B2-11 gates) proves Part B1's capability validator accepts and stores it. The other `toMatchObject` assertions (`test/unit/daemon.spec.ts`, `harness.integration.spec.ts`) need no change.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/runner && bun test src test/unit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/runner/src/capabilities apps/runner/test/unit apps/runner/test/integration/capabilities.integration.spec.ts
git commit -m "feat(runner): report configJobs capability (S3 §3)"
```

---

### Task B2-3: fetch and re-validate the edit set

**Files:**
- Modify: `apps/runner/src/sync/http.ts`
- Create: `apps/runner/src/executor/config-job/payload.ts`
- Create: `apps/runner/src/supervisor/config-edit-fetch.ts`
- Test: `apps/runner/src/sync/http.spec.ts`, `apps/runner/src/executor/config-job/payload.spec.ts`, `apps/runner/src/supervisor/config-edit-fetch.spec.ts`

**Interfaces:**
- Consumes: `ConfigEditPayload`, `ConfigFileEdit`, `ConfigJobKind`, `NAX_CONFIG_LIMITS`, `isAllowedNaxPath` (Part B1); `ServerError` (`sync/http.ts`).
- Produces:
  - `ServerClient.getConfigEdit(jobId: string, leaseEpoch: number, signal?: AbortSignal): Promise<ConfigEditPayload>`
  - `parseConfigEditPayload(raw: unknown, command: ConfigJobKind): ConfigEditPayload | null`
  - `interface ConfigEditSource { fetch(jobId: string, leaseEpoch: number): Promise<unknown> }`
  - `type ConfigEditFetch = { kind: 'ok'; payload: ConfigEditPayload } | { kind: 'stale' } | { kind: 'failed'; reason: string }`
  - `fetchConfigEdit(input: FetchConfigEditInput): Promise<ConfigEditFetch>`; `CONFIG_FETCH_BACKOFF_MS = [2_000, 8_000]`

- [ ] **Step 1: Write the failing client test**

Append to `apps/runner/src/sync/http.spec.ts` inside `describe('ServerClient', ...)`:

```ts
  test('getConfigEdit GETs the fenced config-edit route with the lease epoch and unwraps data (S3 §3)', async () => {
    let seen = null as { url: string; init: RequestInit | undefined } | null;
    const payload = { mode: 'drift', edits: [], prTitle: null, prBody: null, baseSha: 'a'.repeat(40) };
    const c = client(async (url, init) => { seen = { url, init }; return ok(payload); });
    await expect(c.getConfigEdit('job 1', 3)).resolves.toEqual(payload);
    expect(seen?.url).toBe('https://koda.example.com/koda/api/fleet/runner/jobs/job%201/config-edit?leaseEpoch=3');
    expect(seen?.init?.method).toBe('GET');
    expect((seen?.init?.headers as Record<string, string>)['authorization']).toBe('Bearer kr_secret');
    const fenced = await client(async () => new Response(JSON.stringify({ ret: 1, message: 'stale lease' }), { status: 409 })).getConfigEdit('j', 1).catch((e) => e);
    expect(fenced).toBeInstanceOf(ServerError);
    expect(fenced).toMatchObject({ status: 409 });
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/runner && bun test src/sync/http.spec.ts`
Expected: FAIL — `c.getConfigEdit is not a function`.

- [ ] **Step 3: Implement the client method**

In `apps/runner/src/sync/http.ts`, change the protocol import to
`import type { ConfigEditPayload, EnrollRequest, EnrollResponse, RunnerIdentity, SyncRequest, SyncResponse } from '@nathapp/fleet-protocol';`
and add after `me()`:

```ts
  /** S3 §3: the edit set of a config job, fenced by the lease epoch like the bundle upload (409 = not ours any more). */
  async getConfigEdit(jobId: string, leaseEpoch: number, signal?: AbortSignal): Promise<ConfigEditPayload> {
    const url = `${this.url(`/fleet/runner/jobs/${encodeURIComponent(jobId)}/config-edit`)}?leaseEpoch=${leaseEpoch}`;
    const response = await this.send(url, { method: 'GET', headers: { ...this.bearer(), 'accept-language': 'en' } }, this.options.requestTimeoutMs ?? 15_000, signal);
    return this.json<ConfigEditPayload>(response);
  }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/runner && bun test src/sync/http.spec.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing payload parser tests**

Create `apps/runner/src/executor/config-job/payload.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { NAX_CONFIG_LIMITS } from '@nathapp/fleet-protocol';
import { parseConfigEditPayload } from './payload';

const SHA = 'a'.repeat(40);
const BLOB = 'b'.repeat(40);
const edit = (over: Record<string, unknown> = {}) => ({ path: '.nax/rules/style.md', op: 'put', content: '# style\n', baseSha: BLOB, ...over });
const payload = (over: Record<string, unknown> = {}) => ({ mode: 'edit', edits: [edit()], prTitle: 'Tighten rules', prBody: null, baseSha: SHA, ...over });

describe('parseConfigEditPayload (D30)', () => {
  test('returns a clean copy of a well-formed edit, regenerate and drift payload', () => {
    expect(parseConfigEditPayload({ ...payload(), extra: 1 }, 'CONFIG_EDIT')).toEqual(payload() as never);
    const regenerate = payload({ mode: 'regenerate', edits: [] });
    expect(parseConfigEditPayload(regenerate, 'CONFIG_EDIT')).toEqual(regenerate as never);
    const drift = payload({ mode: 'drift', edits: [], prTitle: null });
    expect(parseConfigEditPayload(drift, 'CONFIG_DRIFT')).toEqual(drift as never);
  });
  test('accepts a new file (baseSha null) and a delete (no content)', () => {
    const p = payload({ edits: [edit({ path: '.nax/rules/new.md', baseSha: null }), { path: '.nax/constitution.md', op: 'delete', baseSha: BLOB }] });
    expect(parseConfigEditPayload(p, 'CONFIG_EDIT')).toEqual(p as never);
  });
  test.each([
    ['not an object', 'x', 'CONFIG_EDIT'],
    ['a drift mode on CONFIG_EDIT', payload({ mode: 'drift', edits: [], prTitle: null }), 'CONFIG_EDIT'],
    ['an edit mode on CONFIG_DRIFT', payload(), 'CONFIG_DRIFT'],
    ['an empty edit list in edit mode', payload({ edits: [] }), 'CONFIG_EDIT'],
    ['edits in regenerate mode', payload({ mode: 'regenerate' }), 'CONFIG_EDIT'],
    ['a bad commit sha', payload({ baseSha: 'xyz' }), 'CONFIG_EDIT'],
    ['an .env profile', payload({ edits: [edit({ path: '.nax/profiles/prod.env' })] }), 'CONFIG_EDIT'],
    ['a path outside the allowlist', payload({ edits: [edit({ path: 'src/index.ts' })] }), 'CONFIG_EDIT'],
    ['a traversal', payload({ edits: [edit({ path: '.nax/rules/../../x.md' })] }), 'CONFIG_EDIT'],
    ['a duplicate path', payload({ edits: [edit(), edit()] }), 'CONFIG_EDIT'],
    ['an unknown op', payload({ edits: [edit({ op: 'chmod' })] }), 'CONFIG_EDIT'],
    ['a put without content', payload({ edits: [edit({ content: undefined })] }), 'CONFIG_EDIT'],
    ['a delete with content', payload({ edits: [{ path: '.nax/context.md', op: 'delete', content: 'x', baseSha: BLOB }] }), 'CONFIG_EDIT'],
    ['a NUL in content', payload({ edits: [edit({ content: 'a\0b' })] }), 'CONFIG_EDIT'],
    ['a bad blob sha', payload({ edits: [edit({ baseSha: 'nope' })] }), 'CONFIG_EDIT'],
    ['a file over the size limit', payload({ edits: [edit({ content: 'x'.repeat(NAX_CONFIG_LIMITS.maxFileBytes + 1) })] }), 'CONFIG_EDIT'],
    ['too many edits', payload({ edits: Array.from({ length: NAX_CONFIG_LIMITS.maxEdits + 1 }, (_, i) => edit({ path: `.nax/rules/r${i}.md` })) }), 'CONFIG_EDIT'],
    ['a missing PR title', payload({ prTitle: '' }), 'CONFIG_EDIT'],
    ['a PR title with a newline', payload({ prTitle: 'a\nb' }), 'CONFIG_EDIT'],
    ['a PR title on a drift', payload({ mode: 'drift', edits: [], prTitle: 'x' }), 'CONFIG_DRIFT'],
    ['a PR body over the limit', payload({ prBody: 'x'.repeat(NAX_CONFIG_LIMITS.maxPrBodyBytes + 1) }), 'CONFIG_EDIT'],
  ] as const)('rejects %s', (_label, raw, command) => {
    expect(parseConfigEditPayload(raw, command)).toBeNull();
  });
  test('rejects a total over the limit even when each file fits', () => {
    const per = Math.floor(NAX_CONFIG_LIMITS.maxFileBytes * 0.9);
    const count = Math.ceil(NAX_CONFIG_LIMITS.maxTotalBytes / per) + 1;
    const edits = Array.from({ length: Math.min(count, NAX_CONFIG_LIMITS.maxEdits) }, (_, i) => edit({ path: `.nax/rules/r${i}.md`, content: 'x'.repeat(per) }));
    expect(parseConfigEditPayload(payload({ edits }), 'CONFIG_EDIT')).toBeNull();
  });
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `cd apps/runner && bun test src/executor/config-job/payload.spec.ts`
Expected: FAIL — `Cannot find module './payload'`.

- [ ] **Step 7: Implement the parser**

Create `apps/runner/src/executor/config-job/payload.ts`:

```ts
import { NAX_CONFIG_LIMITS, isAllowedNaxPath, type ConfigEditMode, type ConfigEditPayload, type ConfigFileEdit, type ConfigJobKind } from '@nathapp/fleet-protocol';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const SHA = /^[0-9a-f]{40,64}$/;
const MODES: readonly ConfigEditMode[] = ['edit', 'regenerate', 'drift'];
const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');
const hasControl = (v: string): boolean => [...v].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);

function parseEdit(raw: unknown): ConfigFileEdit | null {
  if (!isObj(raw)) return null;
  const { path, op, content, baseSha } = raw;
  if (typeof path !== 'string' || !isAllowedNaxPath(path)) return null;
  if (baseSha !== null && (typeof baseSha !== 'string' || !SHA.test(baseSha))) return null;
  if (op === 'delete') return content === undefined ? { path, op, baseSha } : null;
  if (op !== 'put' || typeof content !== 'string' || content.includes('\0') || bytes(content) > NAX_CONFIG_LIMITS.maxFileBytes) return null;
  return { path, op, content, baseSha };
}

function parseEdits(raw: unknown, mode: ConfigEditMode): ConfigFileEdit[] | null {
  if (!Array.isArray(raw) || raw.length > NAX_CONFIG_LIMITS.maxEdits) return null;
  if (mode === 'edit' ? raw.length === 0 : raw.length > 0) return null;
  const edits = raw.map(parseEdit);
  if (edits.some((e) => e === null)) return null;
  const clean = edits as ConfigFileEdit[];
  if (new Set(clean.map((e) => e.path)).size !== clean.length) return null;
  const total = clean.reduce((sum, e) => sum + (e.content === undefined ? 0 : bytes(e.content)), 0);
  return total > NAX_CONFIG_LIMITS.maxTotalBytes ? null : clean;
}

/**
 * D30, S3 §3: the server is trusted to deliver, not to be well formed. Every path is re-checked against the shared
 * allowlist (never a `.env` profile), every limit is re-applied, and only validated fields are copied.
 */
export function parseConfigEditPayload(raw: unknown, command: ConfigJobKind): ConfigEditPayload | null {
  if (!isObj(raw)) return null;
  const mode = raw['mode'];
  if (typeof mode !== 'string' || !MODES.includes(mode as ConfigEditMode)) return null;
  const typedMode = mode as ConfigEditMode;
  if ((command === 'CONFIG_DRIFT') !== (typedMode === 'drift')) return null;
  const baseSha = raw['baseSha'];
  if (typeof baseSha !== 'string' || !SHA.test(baseSha)) return null;
  const edits = parseEdits(raw['edits'], typedMode);
  if (edits === null) return null;
  const prTitle = raw['prTitle'] ?? null;
  if (typedMode === 'drift' ? prTitle !== null : typeof prTitle !== 'string' || prTitle.length === 0 || prTitle.length > NAX_CONFIG_LIMITS.maxPrTitleChars || hasControl(prTitle)) return null;
  const prBody = raw['prBody'] ?? null;
  if (prBody !== null && (typeof prBody !== 'string' || prBody.includes('\0') || bytes(prBody) > NAX_CONFIG_LIMITS.maxPrBodyBytes)) return null;
  return { mode: typedMode, edits, prTitle: prTitle as string | null, prBody: prBody as string | null, baseSha };
}
```

- [ ] **Step 8: Run them to verify they pass**

Run: `cd apps/runner && bun test src/executor/config-job/payload.spec.ts`
Expected: PASS.

- [ ] **Step 9: Write the failing fetch tests**

Create `apps/runner/src/supervisor/config-edit-fetch.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { createMemoryLogger } from '../logger';
import { NetworkError, ServerError } from '../sync/http';
import { fakeTime } from '../../test/helpers/fake-time';
import { CONFIG_FETCH_BACKOFF_MS, fetchConfigEdit, type ConfigEditSource } from './config-edit-fetch';

const good = { mode: 'drift', edits: [], prTitle: null, prBody: null, baseSha: 'a'.repeat(40) };
const run = (source: ConfigEditSource | undefined, halted = () => false) => {
  const time = fakeTime();
  return { time, result: fetchConfigEdit({ source, jobId: 'j1', leaseEpoch: 2, command: 'CONFIG_DRIFT', sleep: time.sleep, isHalted: halted, log: createMemoryLogger() }) };
};

describe('fetchConfigEdit (S3 §3)', () => {
  test('returns the validated payload', async () => {
    const seen: Array<[string, number]> = [];
    expect(await run({ fetch: async (id, epoch) => { seen.push([id, epoch]); return good; } }).result).toEqual({ kind: 'ok', payload: good as never });
    expect(seen).toEqual([['j1', 2]]);
  });
  test('a 409 is stale: the server has fenced the lease and sends ABANDON', async () => {
    expect(await run({ fetch: async () => { throw new ServerError(409, 'stale lease', null); } }).result).toEqual({ kind: 'stale' });
  });
  test('another 4xx fails at once; an invalid payload fails', async () => {
    expect(await run({ fetch: async () => { throw new ServerError(404, 'no', null); } }).result).toEqual({ kind: 'failed', reason: 'config edit fetch refused (404)' });
    expect(await run({ fetch: async () => ({ ...good, mode: 'edit' }) }).result).toEqual({ kind: 'failed', reason: 'invalid config edit payload' });
  });
  test('network errors and 5xx are retried with the back-off, then fail', async () => {
    let calls = 0;
    const r = run({ fetch: async () => { calls += 1; throw calls === 1 ? new NetworkError('down') : new ServerError(503, 'busy', null); } });
    expect(await r.result).toEqual({ kind: 'failed', reason: 'config edit fetch failed' });
    expect(calls).toBe(CONFIG_FETCH_BACKOFF_MS.length + 1);
    expect(r.time.nowMs() - Date.parse('2026-10-01T00:00:00.000Z')).toBe(CONFIG_FETCH_BACKOFF_MS.reduce((a, b) => a + b, 0));
  });
  test('a retry recovers', async () => {
    let calls = 0;
    expect(await run({ fetch: async () => { calls += 1; if (calls === 1) throw new NetworkError('blip'); return good; } }).result).toMatchObject({ kind: 'ok' });
  });
  test('a halt during the back-off stops without a verdict', async () => {
    let halted = false;
    const r = run({ fetch: async () => { halted = true; throw new NetworkError('down'); } }, () => halted);
    expect(await r.result).toEqual({ kind: 'stale' });
  });
  test('a runner built without a source fails the job', async () => {
    expect(await run(undefined).result).toEqual({ kind: 'failed', reason: 'config jobs are not wired in this runner' });
  });
});
```

- [ ] **Step 10: Run them to verify they fail**

Run: `cd apps/runner && bun test src/supervisor/config-edit-fetch.spec.ts`
Expected: FAIL — `Cannot find module './config-edit-fetch'`.

- [ ] **Step 11: Implement the fetch**

Create `apps/runner/src/supervisor/config-edit-fetch.ts`:

```ts
import type { ConfigEditPayload, ConfigJobKind } from '@nathapp/fleet-protocol';
import { errorMessage } from '../errors';
import { parseConfigEditPayload } from '../executor/config-job/payload';
import type { Logger } from '../logger';
import { ServerError } from '../sync/http';
import type { Sleep } from '../time';

/** Built in daemon.ts over `ServerClient.getConfigEdit`; rejects with ServerError / NetworkError. */
export interface ConfigEditSource {
  fetch(jobId: string, leaseEpoch: number): Promise<unknown>;
}

export type ConfigEditFetch = { kind: 'ok'; payload: ConfigEditPayload } | { kind: 'stale' } | { kind: 'failed'; reason: string };

/** Same shape as the PLAN push back-off (D77): three attempts in all. */
export const CONFIG_FETCH_BACKOFF_MS: readonly number[] = [2_000, 8_000];

export interface FetchConfigEditInput {
  readonly source: ConfigEditSource | undefined;
  readonly jobId: string;
  readonly leaseEpoch: number;
  readonly command: ConfigJobKind;
  readonly sleep: Sleep;
  /** An ABANDON (halt) during the back-off: stop and report nothing. */
  readonly isHalted: () => boolean;
  readonly log: Logger;
}

/** S3 §3, D478: a 409 is the lease fence (ABANDON follows); another 4xx is final; anything else is retried. */
export async function fetchConfigEdit(input: FetchConfigEditInput): Promise<ConfigEditFetch> {
  if (!input.source) return { kind: 'failed', reason: 'config jobs are not wired in this runner' };
  for (let attempt = 0; ; attempt += 1) {
    try {
      const payload = parseConfigEditPayload(await input.source.fetch(input.jobId, input.leaseEpoch), input.command);
      return payload ? { kind: 'ok', payload } : { kind: 'failed', reason: 'invalid config edit payload' };
    } catch (error) {
      if (error instanceof ServerError && error.status === 409) return { kind: 'stale' };
      if (error instanceof ServerError && error.status >= 400 && error.status < 500) return { kind: 'failed', reason: `config edit fetch refused (${error.status})` };
      input.log.warn('config edit fetch failed', { jobId: input.jobId, attempt, error: errorMessage(error) });
    }
    const backoff = CONFIG_FETCH_BACKOFF_MS[attempt];
    if (backoff === undefined) return { kind: 'failed', reason: 'config edit fetch failed' };
    if (input.isHalted()) return { kind: 'stale' };
    await input.sleep(backoff);
    if (input.isHalted()) return { kind: 'stale' };
  }
}
```

- [ ] **Step 12: Run them to verify they pass**

Run: `cd apps/runner && bun test src/supervisor/config-edit-fetch.spec.ts src/executor/config-job/payload.spec.ts src/sync/http.spec.ts`
Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add apps/runner/src/sync/http.ts apps/runner/src/sync/http.spec.ts apps/runner/src/executor/config-job/payload.ts apps/runner/src/executor/config-job/payload.spec.ts apps/runner/src/supervisor/config-edit-fetch.ts apps/runner/src/supervisor/config-edit-fetch.spec.ts
git commit -m "feat(runner): fetch and re-validate config edit sets (S3 §3, D478)"
```

---
### Task B2-4: tracked subprocesses, step clock and result fitting

**Files:**
- Modify: `apps/runner/src/nax/nax-cli.ts:54` (export `readCapped`)
- Create: `apps/runner/src/executor/config-job/types.ts`
- Create: `apps/runner/src/executor/config-job/subprocess.ts`
- Create: `apps/runner/src/executor/config-job/result-fit.ts`
- Test: `apps/runner/src/executor/config-job/subprocess.spec.ts`, `apps/runner/src/executor/config-job/result-fit.spec.ts`

**Interfaces:**
- Consumes: `signalGroup` (`executor/nax-process.ts`), `byteLength` (`sync/batch.ts`), `CONFIG_RESULT_LIMITS`, `ConfigJobResult` (Part B1).
- Produces:
  - `interface ProcResult { code: number; stdout: string; stderr: string; timedOut: boolean; stopped: boolean; spawnError?: string }`
  - `interface ProcOptions { cwd: string; env: Readonly<Record<string, string | undefined>>; deadlineMs: number }`
  - `type RunProc = (argv: readonly string[], options: ProcOptions) => Promise<ProcResult>`
  - `interface StepClock { nowMs: () => number; deadlineMs: number; isStopped: () => boolean }`
  - `class StoppedError`, `class DeadlineError`, `checkpoint(clock: StepClock): void`, `remainingMs(clock: StepClock): number`, `raiseIfInterrupted(result: ProcResult): void`
  - `trackedRun(argv, options: TrackedRunOptions): Promise<ProcResult>` where `TrackedRunOptions = ProcOptions & { nowMs; isStopped; onProcess(proc: { pid: number; pgid: number } | null): void; killGraceMs?: number }`
  - `tailBytes(text: string, maxBytes: number): string`, `fitConfigResult(result: ConfigJobResult): ConfigJobResult`, `CONFIG_RESULT_BUDGET_BYTES = 12_288`

- [ ] **Step 1: Export the capped reader**

In `apps/runner/src/nax/nax-cli.ts` line 54 change `async function readCapped(` to `export async function readCapped(`. No behaviour change.

- [ ] **Step 2: Write the failing subprocess tests**

Create `apps/runner/src/executor/config-job/subprocess.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { isProcessAlive } from '../nax-process';
import { waitFor } from '../../../test/helpers/wait';
import { trackedRun, type TrackedRunOptions } from './subprocess';
import { DeadlineError, StoppedError, checkpoint, raiseIfInterrupted, remainingMs } from './types';

const opts = (over: Partial<TrackedRunOptions> = {}) => {
  const seen: Array<{ pid: number; pgid: number } | null> = [];
  const options: TrackedRunOptions = {
    cwd: process.cwd(), env: process.env, deadlineMs: Date.now() + 30_000, nowMs: () => Date.now(), isStopped: () => false,
    onProcess: (proc) => { seen.push(proc); }, ...over,
  };
  return { options, seen };
};

describe('trackedRun (D484)', () => {
  test('captures exit code and both streams, and reports the process group then null', async () => {
    const { options, seen } = opts();
    const r = await trackedRun(['sh', '-c', 'echo out; echo err >&2; exit 3'], options);
    expect(r).toMatchObject({ code: 3, stdout: 'out\n', stderr: 'err\n', timedOut: false, stopped: false });
    expect(seen).toHaveLength(2);
    expect(seen[0]?.pid).toBeGreaterThan(1);
    expect(seen[0]?.pgid).toBe(seen[0]?.pid);
    expect(seen[1]).toBeNull();
  });
  test('a stop kills the whole group, grandchildren included', async () => {
    let stop = false;
    const { options } = opts({ isStopped: () => stop });
    setTimeout(() => { stop = true; }, 300);
    const started = Date.now();
    const r = await trackedRun(['sh', '-c', 'sleep 30 & echo $!; wait'], options);
    expect(r.stopped).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    const grandchild = Number(r.stdout.trim());
    await waitFor(() => !isProcessAlive(grandchild), { timeoutMs: 3_000 });
  });
  test('the deadline ends a call as timedOut', async () => {
    const { options } = opts({ deadlineMs: Date.now() + 300 });
    const r = await trackedRun(['sleep', '30'], options);
    expect(r).toMatchObject({ timedOut: true, stopped: false });
  });
  test('a group that ignores SIGTERM gets SIGKILL after the grace', async () => {
    const { options } = opts({ deadlineMs: Date.now() + 200, killGraceMs: 300 });
    const r = await trackedRun(['sh', '-c', 'trap "" TERM; sleep 30'], options);
    expect(r.timedOut).toBe(true);
  });
  test('a missing executable is a spawn error, not a throw', async () => {
    const { options, seen } = opts();
    const r = await trackedRun(['/nonexistent/koda-no-such-tool'], options);
    expect(r).toMatchObject({ code: 127, timedOut: false, stopped: false });
    expect(r.spawnError).toBeDefined();
    expect(seen).toEqual([]);
  });
});

describe('step clock', () => {
  test('checkpoint throws StoppedError before DeadlineError; remainingMs is at least 1', () => {
    expect(() => checkpoint({ nowMs: () => 0, deadlineMs: 10, isStopped: () => true })).toThrow(StoppedError);
    expect(() => checkpoint({ nowMs: () => 10, deadlineMs: 10, isStopped: () => false })).toThrow(DeadlineError);
    expect(() => checkpoint({ nowMs: () => 9, deadlineMs: 10, isStopped: () => false })).not.toThrow();
    expect(remainingMs({ nowMs: () => 50, deadlineMs: 10, isStopped: () => false })).toBe(1);
  });
  test('raiseIfInterrupted maps a stopped or timed-out result', () => {
    const base = { code: 0, stdout: '', stderr: '', timedOut: false, stopped: false };
    expect(() => raiseIfInterrupted({ ...base, stopped: true })).toThrow(StoppedError);
    expect(() => raiseIfInterrupted({ ...base, timedOut: true })).toThrow(DeadlineError);
    expect(() => raiseIfInterrupted(base)).not.toThrow();
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd apps/runner && bun test src/executor/config-job/subprocess.spec.ts`
Expected: FAIL — `Cannot find module './subprocess'`.

- [ ] **Step 4: Implement the types**

Create `apps/runner/src/executor/config-job/types.ts`:

```ts
/** One finished nax / gh / glab call of a config job (D484). */
export interface ProcResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** The job's deadline ended the call. */
  readonly timedOut: boolean;
  /** A cancel or halt ended the call. */
  readonly stopped: boolean;
  /** The executable could not be started at all. */
  readonly spawnError?: string;
}

export interface ProcOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Absolute, on the job's clock: the config job's hard timeout (spec §5 lifecycle). */
  readonly deadlineMs: number;
}

export type RunProc = (argv: readonly string[], options: ProcOptions) => Promise<ProcResult>;

export interface StepClock {
  readonly nowMs: () => number;
  readonly deadlineMs: number;
  /** A cancel was requested or the run was halted (ABANDON, daemon stop). */
  readonly isStopped: () => boolean;
}

export class StoppedError extends Error {
  constructor() {
    super('config job stopped');
    this.name = 'StoppedError';
  }
}

export class DeadlineError extends Error {
  constructor() {
    super('config job timed out');
    this.name = 'DeadlineError';
  }
}

/** Called between steps: a stop wins over the deadline. */
export function checkpoint(clock: StepClock): void {
  if (clock.isStopped()) throw new StoppedError();
  if (clock.nowMs() >= clock.deadlineMs) throw new DeadlineError();
}

/** The timeout a git call gets: what is left of the job's budget, never 0 (0 would mean "no timeout" to some callers). */
export function remainingMs(clock: StepClock): number {
  return Math.max(1, clock.deadlineMs - clock.nowMs());
}

export function raiseIfInterrupted(result: ProcResult): void {
  if (result.stopped) throw new StoppedError();
  if (result.timedOut) throw new DeadlineError();
}
```

- [ ] **Step 5: Implement trackedRun**

Create `apps/runner/src/executor/config-job/subprocess.ts`:

```ts
import { readCapped } from '../../nax/nax-cli';
import { signalGroup } from '../nax-process';
import type { ProcOptions, ProcResult } from './types';

/** Bounds a runaway; nax generate / lint / gh print kilobytes. */
export const OUTPUT_CAP_BYTES = 262_144;
export const STOP_POLL_MS = 200;
export const KILL_GRACE_MS = 5_000;

export interface TrackedRunOptions extends ProcOptions {
  readonly nowMs: () => number;
  readonly isStopped: () => boolean;
  /** D484: the caller journals the pid and pgid while the call runs, and clears them with `null` after. */
  readonly onProcess: (proc: { pid: number; pgid: number } | null) => void;
  readonly killGraceMs?: number;
}

/**
 * D484: detached, so the child leads its own session and process group (pgid = pid, as `spawnNax`) and a stop, the
 * deadline or the existing cancel path (SIGTERM to the journaled pgid) reaches its grandchildren too (the gh shim and
 * gh). SIGTERM first, SIGKILL after the grace.
 */
export async function trackedRun(argv: readonly string[], options: TrackedRunOptions): Promise<ProcResult> {
  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  try {
    proc = Bun.spawn([...argv], { cwd: options.cwd, env: { ...options.env }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', detached: true });
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code ?? 'SPAWN_FAILED';
    return { code: 127, stdout: '', stderr: `${argv[0] ?? 'command'}: cannot start (${errno})`, timedOut: false, stopped: false, spawnError: errno };
  }
  const pgid = proc.pid;
  options.onProcess({ pid: proc.pid, pgid });
  const grace = options.killGraceMs ?? KILL_GRACE_MS;
  let done = false;
  let stopped = false;
  let timedOut = false;
  let termAt: number | null = null;
  void (async () => {
    while (!done) {
      await Bun.sleep(STOP_POLL_MS);
      if (done) return;
      const now = options.nowMs();
      if (termAt === null) {
        if (options.isStopped()) stopped = true;
        else if (now >= options.deadlineMs) timedOut = true;
        else continue;
        signalGroup(pgid, 'SIGTERM');
        termAt = now;
      } else if (now - termAt >= grace) {
        signalGroup(pgid, 'SIGKILL');
        return;
      }
    }
  })();
  try {
    const [stdout, stderr, code] = await Promise.all([readCapped(proc.stdout, OUTPUT_CAP_BYTES), readCapped(proc.stderr, OUTPUT_CAP_BYTES), proc.exited]);
    return { code, stdout: stdout.text, stderr: stderr.text, timedOut, stopped };
  } finally {
    done = true;   // the watcher never signals after this: the pgid may be reused
    options.onProcess(null);
  }
}
```

- [ ] **Step 6: Run the subprocess tests to verify they pass**

Run: `cd apps/runner && bun test src/executor/config-job/subprocess.spec.ts`
Expected: PASS.

- [ ] **Step 7: Write the failing result-fit tests**

Create `apps/runner/src/executor/config-job/result-fit.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { CONFIG_RESULT_LIMITS } from '@nathapp/fleet-protocol';
import { byteLength } from '../../sync/batch';
import { CONFIG_RESULT_BUDGET_BYTES, fitConfigResult, tailBytes } from './result-fit';

describe('tailBytes', () => {
  test('keeps the end, never splits a multi-byte character', () => {
    expect(tailBytes('abcdef', 3)).toBe('def');
    expect(tailBytes('short', 100)).toBe('short');
    const euros = '€'.repeat(10);   // 3 bytes each
    const tail = tailBytes(euros, 7);
    expect(tail).toBe('€€');
    expect(tail.includes('�')).toBe(false);
  });
});

describe('fitConfigResult (D491)', () => {
  test('a small result is unchanged', () => {
    expect(fitConfigResult({ outcome: 'conflict', files: ['.nax/rules/a.md'] })).toEqual({ outcome: 'conflict', files: ['.nax/rules/a.md'] });
    expect(fitConfigResult({ outcome: 'ok' })).toEqual({ outcome: 'ok' });
  });
  test('the output tail is capped at the protocol limit and keeps the end', () => {
    const output = `${'x'.repeat(20_000)}THE END`;
    const fitted = fitConfigResult({ outcome: 'invalid', output });
    expect(Buffer.byteLength(fitted.output ?? '')).toBeLessThanOrEqual(CONFIG_RESULT_LIMITS.maxOutputBytes);
    expect(fitted.output?.endsWith('THE END')).toBe(true);
  });
  test('the worst case the spec allows fits the snapshot budget; the outcome always survives', () => {
    const files = Array.from({ length: 60 }, (_, i) => `.nax/rules/${String(i).padStart(3, '0')}${'p'.repeat(490)}.md`);
    const fitted = fitConfigResult({ outcome: 'invalid', files, output: 'o'.repeat(9_000) });
    expect(byteLength(fitted)).toBeLessThanOrEqual(CONFIG_RESULT_BUDGET_BYTES);
    expect(fitted.outcome).toBe('invalid');
    expect((fitted.files ?? []).length).toBeLessThanOrEqual(CONFIG_RESULT_LIMITS.maxFiles);
    expect(fitted.files?.[0]).toBe(files[0]);
  });
  test('a path over the limit is dropped rather than cut (a cut path names the wrong file)', () => {
    expect(fitConfigResult({ outcome: 'drift', files: ['a'.repeat(CONFIG_RESULT_LIMITS.maxFileChars + 1), 'CLAUDE.md'] })).toEqual({ outcome: 'drift', files: ['CLAUDE.md'] });
  });
});
```

- [ ] **Step 8: Run them to verify they fail**

Run: `cd apps/runner && bun test src/executor/config-job/result-fit.spec.ts`
Expected: FAIL — `Cannot find module './result-fit'`.

- [ ] **Step 9: Implement**

Create `apps/runner/src/executor/config-job/result-fit.ts`:

```ts
import { CONFIG_RESULT_LIMITS, type ConfigJobOutcome, type ConfigJobResult } from '@nathapp/fleet-protocol';
import { byteLength } from '../../sync/batch';

/** D491: leaves room in the 16 KiB snapshot payload for the result fields and the heartbeat. */
export const CONFIG_RESULT_BUDGET_BYTES = 12_288;

/** The last `maxBytes` bytes of `text`, starting on a character boundary. */
export function tailBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) return text;
  let start = buf.byteLength - maxBytes;
  while (start < buf.byteLength && ((buf[start] ?? 0) & 0xc0) === 0x80) start += 1;
  return buf.subarray(start).toString('utf8');
}

const build = (outcome: ConfigJobOutcome, files: string[] | undefined, output: string | undefined): ConfigJobResult => ({
  outcome, ...(files !== undefined ? { files } : {}), ...(output ? { output } : {}),
});

/** D491: the protocol caps first, then the output tail halves and trailing files drop until the result fits. */
export function fitConfigResult(result: ConfigJobResult): ConfigJobResult {
  const files = result.files?.filter((file) => file.length <= CONFIG_RESULT_LIMITS.maxFileChars).slice(0, CONFIG_RESULT_LIMITS.maxFiles);
  let fitted = build(result.outcome, files, result.output === undefined ? undefined : tailBytes(result.output, CONFIG_RESULT_LIMITS.maxOutputBytes));
  while (byteLength(fitted) > CONFIG_RESULT_BUDGET_BYTES) {
    if (fitted.output) fitted = build(fitted.outcome, fitted.files, tailBytes(fitted.output, Math.floor(Buffer.byteLength(fitted.output) / 2)));
    else if (fitted.files && fitted.files.length > 0) fitted = build(fitted.outcome, fitted.files.slice(0, -1), undefined);
    else break;
  }
  return fitted;
}
```

- [ ] **Step 10: Run them to verify they pass**

Run: `cd apps/runner && bun test src/executor/config-job src/nax`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add apps/runner/src/nax/nax-cli.ts apps/runner/src/executor/config-job/types.ts apps/runner/src/executor/config-job/subprocess.ts apps/runner/src/executor/config-job/subprocess.spec.ts apps/runner/src/executor/config-job/result-fit.ts apps/runner/src/executor/config-job/result-fit.spec.ts
git commit -m "feat(runner): tracked config-job subprocesses and result fitting (D484, D491)"
```

---

### Task B2-5: git steps — checkout, staleness, apply, drift

**Files:**
- Create: `apps/runner/src/executor/config-job/checkout.ts`
- Create: `apps/runner/src/executor/config-job/staleness.ts`
- Create: `apps/runner/src/executor/config-job/apply-edits.ts`
- Create: `apps/runner/src/executor/config-job/drift.ts`
- Test: `apps/runner/src/executor/config-job/git-steps.spec.ts`

**Interfaces:**
- Consumes: `Git` (`executor/git.ts`), `resolveRef` (`executor/refs.ts`), `isAllowedNaxPath`, `ConfigFileEdit` (Part B1).
- Produces:
  - `prepareConfigCheckout(git: Git, repoDir: string, defaultBranch: string): Promise<{ ok: true; sha: string } | { ok: false; reason: string }>`
  - `currentBlob(git: Git, repoDir: string, path: string): Promise<string | null>`
  - `findConflicts(git: Git, repoDir: string, edits: readonly ConfigFileEdit[]): Promise<string[]>`
  - `applyEdits(repoDir: string, edits: readonly ConfigFileEdit[]): Promise<{ ok: true } | { ok: false; output: string }>`
  - `changedFiles(git: Git, repoDir: string, timeoutMs?: number): Promise<string[]>`

- [ ] **Step 1: Write the failing tests**

Create `apps/runner/src/executor/config-job/git-steps.spec.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGit } from '../git';
import { git as sh, isolateGit, makeOrigin, pushCommit } from '../../../test/helpers/git-fixture';
import { makeTempDirs } from '../../../test/helpers/tmp';
import { applyEdits } from './apply-edits';
import { prepareConfigCheckout } from './checkout';
import { changedFiles } from './drift';
import { currentBlob, findConflicts } from './staleness';

const tmp = makeTempDirs();
beforeAll(() => isolateGit());
afterAll(() => tmp.cleanup());
const exists = (p: string) => stat(p).then(() => true, () => false);

async function clone() {
  const base = await tmp.make('cfg-git');
  const origin = await makeOrigin(base, 'app', { files: { 'README.md': 'x\n', '.nax/context.md': '# ctx\n', '.nax/rules/a.md': '# a\n', '.nax/config.json': '{}\n' } });
  const repoDir = join(base, 'clone');
  await sh(base, 'clone', '-q', origin.url, repoDir);
  return { base, origin, repoDir, git: createGit() };
}

describe('prepareConfigCheckout', () => {
  test('detaches at origin/<defaultBranch> after an upstream push, discarding local edits', async () => {
    const w = await clone();
    const upstream = await pushCommit(w.base, w.origin.url, 'main', '.nax/rules/a.md', '# a v2\n');
    await sh(w.repoDir, 'fetch', '-q', 'origin');
    await writeFile(join(w.repoDir, '.nax/context.md'), 'dirty');
    expect(await prepareConfigCheckout(w.git, w.repoDir, 'main')).toEqual({ ok: true, sha: upstream });
    expect(await sh(w.repoDir, 'rev-parse', 'HEAD')).toBe(upstream);
    expect(await readFile(join(w.repoDir, '.nax/context.md'), 'utf8')).toBe('# ctx\n');
  });
  test('a default branch missing on origin is a fixed reason', async () => {
    const w = await clone();
    expect(await prepareConfigCheckout(w.git, w.repoDir, 'trunk')).toEqual({ ok: false, reason: 'checkout: default branch not found' });
  });
});

describe('staleness (S3-5)', () => {
  test('a file unchanged upstream does not conflict; a changed one does; a new file must be absent', async () => {
    const w = await clone();
    const blobA = await currentBlob(w.git, w.repoDir, '.nax/rules/a.md');
    const blobCtx = await currentBlob(w.git, w.repoDir, '.nax/context.md');
    expect(blobA).toMatch(/^[0-9a-f]{40}$/);
    expect(await currentBlob(w.git, w.repoDir, '.nax/rules/missing.md')).toBeNull();
    await pushCommit(w.base, w.origin.url, 'main', '.nax/rules/a.md', '# a changed upstream\n');
    await pushCommit(w.base, w.origin.url, 'main', '.nax/rules/new.md', '# created upstream\n');
    await sh(w.repoDir, 'fetch', '-q', 'origin');
    await prepareConfigCheckout(w.git, w.repoDir, 'main');
    const conflicts = await findConflicts(w.git, w.repoDir, [
      { path: '.nax/rules/a.md', op: 'put', content: 'mine', baseSha: blobA },
      { path: '.nax/context.md', op: 'put', content: 'mine', baseSha: blobCtx },
      { path: '.nax/rules/new.md', op: 'put', content: 'mine', baseSha: null },
      { path: '.nax/rules/fresh.md', op: 'put', content: 'mine', baseSha: null },
    ]);
    expect(conflicts).toEqual(['.nax/rules/a.md', '.nax/rules/new.md']);
  });
  test('a delete of a file already deleted upstream conflicts', async () => {
    const w = await clone();
    const blobA = await currentBlob(w.git, w.repoDir, '.nax/rules/a.md');
    const work = join(w.base, 'rm');
    await sh(w.base, 'clone', '-q', w.origin.url, work);
    await sh(work, 'rm', '-q', '.nax/rules/a.md');
    await sh(work, 'commit', '-q', '-m', 'rm');
    await sh(work, 'push', '-q', 'origin', 'main');
    await sh(w.repoDir, 'fetch', '-q', 'origin');
    await prepareConfigCheckout(w.git, w.repoDir, 'main');
    expect(await findConflicts(w.git, w.repoDir, [{ path: '.nax/rules/a.md', op: 'delete', baseSha: blobA }])).toEqual(['.nax/rules/a.md']);
  });
});

describe('applyEdits', () => {
  test('writes, creates nested directories and deletes', async () => {
    const w = await clone();
    expect(await applyEdits(w.repoDir, [
      { path: '.nax/rules/a.md', op: 'put', content: '# a edited\n', baseSha: null },
      { path: '.nax/mono/apps/api/context.md', op: 'put', content: '# api\n', baseSha: null },
      { path: '.nax/context.md', op: 'delete', baseSha: null },
    ])).toEqual({ ok: true });
    expect(await readFile(join(w.repoDir, '.nax/rules/a.md'), 'utf8')).toBe('# a edited\n');
    expect(await readFile(join(w.repoDir, '.nax/mono/apps/api/context.md'), 'utf8')).toBe('# api\n');
    expect(await exists(join(w.repoDir, '.nax/context.md'))).toBe(false);
  });
  test('refuses a path outside the allowlist and an .env profile, writing nothing for them', async () => {
    const w = await clone();
    expect(await applyEdits(w.repoDir, [{ path: 'src/x.ts', op: 'put', content: 'x', baseSha: null }])).toEqual({ ok: false, output: 'path not allowed: src/x.ts' });
    expect(await applyEdits(w.repoDir, [{ path: '.nax/profiles/prod.env', op: 'put', content: 'KEY=1', baseSha: null }])).toEqual({ ok: false, output: 'path not allowed: .nax/profiles/prod.env' });
    expect(await exists(join(w.repoDir, '.nax/profiles/prod.env'))).toBe(false);
  });
  test('refuses a symlinked directory or file on the path (no write escapes the clone)', async () => {
    const w = await clone();
    const outside = join(w.base, 'outside');
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(w.repoDir, '.nax/mono'));
    expect(await applyEdits(w.repoDir, [{ path: '.nax/mono/apps/api/context.md', op: 'put', content: 'pwn', baseSha: null }]))
      .toEqual({ ok: false, output: 'refused symlink: .nax/mono' });
    expect(await exists(join(outside, 'apps/api/context.md'))).toBe(false);
    await symlink(join(outside, 'target.md'), join(w.repoDir, '.nax/rules/link.md'));
    expect(await applyEdits(w.repoDir, [{ path: '.nax/rules/link.md', op: 'put', content: 'pwn', baseSha: null }]))
      .toEqual({ ok: false, output: 'refused symlink: .nax/rules/link.md' });
    expect(await exists(join(outside, 'target.md'))).toBe(false);
  });
});

describe('changedFiles (D469)', () => {
  test('lists modified, deleted and untracked files, sorted, renames by their new name', async () => {
    const w = await clone();
    expect(await changedFiles(w.git, w.repoDir)).toEqual([]);
    await writeFile(join(w.repoDir, 'CLAUDE.md'), 'gen');
    await mkdir(join(w.repoDir, 'apps/api'), { recursive: true });
    await writeFile(join(w.repoDir, 'apps/api/CLAUDE.md'), 'gen');
    await writeFile(join(w.repoDir, '.nax/context.md'), 'changed');
    await sh(w.repoDir, 'mv', 'README.md', 'README2.md');
    expect(await changedFiles(w.git, w.repoDir)).toEqual(['.nax/context.md', 'CLAUDE.md', 'README2.md', 'apps/api/CLAUDE.md']);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/runner && bun test src/executor/config-job/git-steps.spec.ts`
Expected: FAIL — `Cannot find module './apply-edits'`.

- [ ] **Step 3: Implement checkout and staleness**

Create `apps/runner/src/executor/config-job/checkout.ts`:

```ts
import type { Git } from '../git';
import { resolveRef } from '../refs';

/** D480: the latest default branch, detached; `-f` drops whatever a previous job left in the shared clone. */
export async function prepareConfigCheckout(git: Git, repoDir: string, defaultBranch: string): Promise<{ ok: true; sha: string } | { ok: false; reason: string }> {
  const ref = await resolveRef(git, repoDir, defaultBranch);
  if (!ref.ok || ref.kind !== 'remote-branch') return { ok: false, reason: 'checkout: default branch not found' };
  await git.ok(['checkout', '-f', '--detach', ref.sha], { cwd: repoDir });
  return { ok: true, sha: ref.sha };
}
```

Create `apps/runner/src/executor/config-job/staleness.ts`:

```ts
import type { ConfigFileEdit } from '@nathapp/fleet-protocol';
import type { Git } from '../git';

/** The object id at HEAD for `path`, or null when the path is absent. A directory yields its tree id, which never equals a blob id. */
export async function currentBlob(git: Git, repoDir: string, path: string): Promise<string | null> {
  const result = await git.run(['rev-parse', '--verify', '--quiet', '--end-of-options', `HEAD:${path}`], { cwd: repoDir });
  return result.code === 0 ? result.stdout.trim() : null;
}

/** S3-5: an edit conflicts when the file at HEAD is not the version it was loaded at (null = must not exist). */
export async function findConflicts(git: Git, repoDir: string, edits: readonly ConfigFileEdit[]): Promise<string[]> {
  const conflicts: string[] = [];
  for (const edit of edits) {
    if ((await currentBlob(git, repoDir, edit.path)) !== edit.baseSha) conflicts.push(edit.path);
  }
  return conflicts;
}
```

- [ ] **Step 4: Implement apply and drift**

Create `apps/runner/src/executor/config-job/apply-edits.ts`:

```ts
import { lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { isAllowedNaxPath, type ConfigFileEdit } from '@nathapp/fleet-protocol';

type Applied = { ok: true } | { ok: false; output: string };
const fail = (output: string): Applied => ({ ok: false, output });

/** The first existing symlink on `path` (each directory, then the file), relative to `root`. */
async function symlinkOnPath(root: string, path: string): Promise<string | null> {
  let current = root;
  for (const segment of path.split('/')) {
    current = join(current, segment);
    const info = await lstat(current).catch(() => null);
    if (info === null) return null;
    if (info.isSymbolicLink()) return relative(root, current);
  }
  return null;
}

/**
 * S3 spec §5 step 3: every path is checked again against the shared allowlist (never `.env`), no existing symlink on
 * the way is followed, and the parent's real path must stay inside the clone.
 */
export async function applyEdits(repoDir: string, edits: readonly ConfigFileEdit[]): Promise<Applied> {
  const root = await realpath(repoDir);
  for (const edit of edits) {
    if (!isAllowedNaxPath(edit.path)) return fail(`path not allowed: ${edit.path}`);
    const link = await symlinkOnPath(root, edit.path);
    if (link !== null) return fail(`refused symlink: ${link}`);
    const target = join(root, edit.path);
    if (edit.op === 'delete') {
      await rm(target, { force: true });
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    const parent = await realpath(dirname(target));
    if (parent !== root && !parent.startsWith(`${root}${sep}`)) return fail(`path escapes the clone: ${edit.path}`);
    await writeFile(target, edit.content ?? '', 'utf8');
  }
  return { ok: true };
}
```

Create `apps/runner/src/executor/config-job/drift.ts`:

```ts
import type { Git } from '../git';

/** D469: what `nax generate` changed, from porcelain v1 with NUL separators (a rename's source path follows its entry). */
export async function changedFiles(git: Git, repoDir: string, timeoutMs?: number): Promise<string[]> {
  const out = await git.ok(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: repoDir, ...(timeoutMs ? { timeoutMs } : {}) });
  const tokens = out.split('\0');
  const files = new Set<string>();
  for (let i = 0; i < tokens.length; i += 1) {
    const entry = tokens[i] ?? '';
    if (entry.length < 4) continue;
    files.add(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') i += 1;
  }
  return [...files].sort();
}
```

- [ ] **Step 4b: Review Focus — non-ASCII content is written byte-exact**

Append inside `describe('applyEdits', ...)` in `git-steps.spec.ts`:

```ts
  test('writes UTF-8 content with non-ASCII characters byte for byte', async () => {
    const w = await clone();
    const content = '# 规则 ✓\n- café\r\n';
    expect(await applyEdits(w.repoDir, [{ path: '.nax/rules/zh.md', op: 'put', content, baseSha: null }])).toEqual({ ok: true });
    expect(await readFile(join(w.repoDir, '.nax/rules/zh.md'))).toEqual(Buffer.from(content, 'utf8'));
  });
```

- [ ] **Step 5: Run them to verify they pass**

Run: `cd apps/runner && bun test src/executor/config-job/git-steps.spec.ts`
Expected: PASS. (`git mv` in the drift test stages a rename, so porcelain shows `R  README2.md\0README.md`; the test pins that the source is skipped.)

- [ ] **Step 6: Commit**

```bash
git add apps/runner/src/executor/config-job/checkout.ts apps/runner/src/executor/config-job/staleness.ts apps/runner/src/executor/config-job/apply-edits.ts apps/runner/src/executor/config-job/drift.ts apps/runner/src/executor/config-job/git-steps.spec.ts
git commit -m "feat(runner): config-job checkout, staleness, apply and drift steps (S3 §5, D469, D480)"
```

---
### Task B2-6: nax steps — regenerate and validate (with the fake nax)

**Files:**
- Create: `apps/runner/test/fixtures/fake-nax-config.ts`
- Modify: `apps/runner/test/fixtures/fake-nax.ts` (after the `answerProbe` block, ~line 36)
- Modify: `apps/runner/test/fixtures/fake-nax-probe.ts` (`config()`)
- Create: `apps/runner/src/executor/config-job/regenerate.ts`
- Create: `apps/runner/src/executor/config-job/validate.ts`
- Test: `apps/runner/src/executor/config-job/nax-steps.spec.ts`

**Interfaces:**
- Consumes: `ProcResult`, `raiseIfInterrupted` (B2-4); `trackedRun` (B2-4, tests only); `parseNaxJson` (`nax/nax-cli.ts`); `PROFILE_NAME` (`executor/nax-process.ts`); `sanitizeDiagnostic` (`diagnostics.ts`); `ConfigFileEdit`, `ConfigJobResult` (Part B1).
- Produces:
  - `type NaxRun = (args: readonly string[]) => Promise<ProcResult>` (bound by the orchestrator to the job's clone, env and deadline)
  - `describeFailure(label: string, result: ProcResult): string`
  - `regenerate(nax: NaxRun, repoDir: string): Promise<{ ok: true; ran: string[] } | { ok: false; output: string }>`
  - `validateConfig(nax: NaxRun, repoDir: string, edits: readonly ConfigFileEdit[]): Promise<ConfigJobResult | null>` (null = valid)
  - Fake nax: `nax generate [-d dir] [--all-packages]`, `nax rules lint [-d dir]`; marker `FAKE_LINT_FAIL` in a rule fails lint, `FAKE_GENERATE_FAIL` in a context fails generate, env `FAKE_NAX_GENERATE_SLEEP_MS` slows generate; `config --json` fails `CONFIG_PARSE_ERROR` on an unparsable `<dir>/.nax/config.json` and finds repo profiles in `<dir>/.nax/profiles/<name>.json`.

- [ ] **Step 1: Add the fake nax config tools**

Create `apps/runner/test/fixtures/fake-nax-config.ts`:

```ts
/**
 * The fake `nax generate` and `nax rules lint` for config jobs (S3 §5). `generate` writes CLAUDE.md and AGENTS.md from
 * `.nax/context.md`; `--all-packages` writes `<pkg>/CLAUDE.md` for every `.nax/mono/<pkg>/context.md`. Markers in the
 * input files make them fail: `FAKE_GENERATE_FAIL` in a context file, `FAKE_LINT_FAIL` in a rule.
 * `FAKE_NAX_GENERATE_SLEEP_MS` holds `generate` (cancel / restart tests).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

export interface ToolAnswer {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

const flagValue = (args: readonly string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function walk(dir: string, name: (file: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path, name) : name(entry) ? [path] : [];
  });
}

function hold(): void {
  const ms = Number(process.env['FAKE_NAX_GENERATE_SLEEP_MS'] ?? 0);
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function generate(args: readonly string[], dir: string): ToolAnswer {
  hold();
  if (args.includes('--all-packages')) {
    const mono = join(dir, '.nax', 'mono');
    const written = walk(mono, (file) => file === 'context.md').map((path) => {
      const text = readFileSync(path, 'utf8');
      if (text.includes('FAKE_GENERATE_FAIL')) throw new Error(`generate failed for ${relative(dir, path)}`);
      const pkg = relative(mono, dirname(path));
      mkdirSync(join(dir, pkg), { recursive: true });
      writeFileSync(join(dir, pkg, 'CLAUDE.md'), `<!-- generated by fake nax -->\n${text}`);
      return `${pkg}/CLAUDE.md`;
    });
    return { stdout: `generated ${written.length} package file(s)`, stderr: '', code: 0 };
  }
  const context = join(dir, '.nax', 'context.md');
  if (!existsSync(context)) return { stdout: '', stderr: 'nax generate: .nax/context.md not found', code: 1 };
  const text = readFileSync(context, 'utf8');
  if (text.includes('FAKE_GENERATE_FAIL')) return { stdout: '', stderr: 'nax generate: context.md is malformed', code: 1 };
  for (const name of ['CLAUDE.md', 'AGENTS.md']) writeFileSync(join(dir, name), `<!-- generated by fake nax -->\n${text}`);
  return { stdout: 'generated 2 file(s)', stderr: '', code: 0 };
}

function rulesLint(dir: string): ToolAnswer {
  const bad = walk(join(dir, '.nax', 'rules'), (file) => file.endsWith('.md')).find((path) => readFileSync(path, 'utf8').includes('FAKE_LINT_FAIL'));
  return bad
    ? { stdout: '', stderr: `rules lint: ${relative(dir, bad)}: banned marker FAKE_LINT_FAIL`, code: 1 }
    : { stdout: 'rules lint: ok', stderr: '', code: 0 };
}

export function answerConfigTool(args: readonly string[], cwd: string): ToolAnswer | null {
  const dir = flagValue(args, '-d') ?? cwd;
  try {
    if (args[0] === 'generate') return generate(args, dir);
    if (args[0] === 'rules' && args[1] === 'lint') return rulesLint(dir);
  } catch (error) {
    return { stdout: '', stderr: `nax: ${(error as Error).message}`, code: 1 };
  }
  return null;
}
```

In `apps/runner/test/fixtures/fake-nax.ts`, add `import { answerConfigTool } from './fake-nax-config';` beside the other fixture imports, and right after the `if (probed) { ... }` block insert:

```ts
const tool = answerConfigTool(args, process.cwd());   // S3: generate and rules lint (config jobs)
if (tool) {
  if (tool.stdout) process.stdout.write(`${tool.stdout}\n`);
  if (tool.stderr) process.stderr.write(`${tool.stderr}\n`);
  process.exit(tool.code);
}
```

In `apps/runner/test/fixtures/fake-nax-probe.ts`, in `config()` after `const dir = ...`:

```ts
  const rootConfig = join(dir, '.nax', 'config.json');
  if (existsSync(rootConfig) && readJson(rootConfig) === null) return failure('CONFIG_PARSE_ERROR');   // S3: config validation
```

and change the profile lookup line in the loop to also try the repo's own profiles:

```ts
    const file = readJson(join(naxHome, 'profiles', `${name}.json`)) ?? readJson(join(dir, '.nax', 'fake-profiles', `${name}.json`)) ?? readJson(join(dir, '.nax', 'profiles', `${name}.json`));
```

Update the header comment of `fake-nax-probe.ts` with one line: `- an unparsable <dir>/.nax/config.json fails CONFIG_PARSE_ERROR; <dir>/.nax/profiles/<name>.json is a repo profile (S3)`.

- [ ] **Step 2: Write the failing tests**

Create `apps/runner/src/executor/config-job/nax-steps.spec.ts`:

```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { makeTempDirs } from '../../../test/helpers/tmp';
import { regenerate } from './regenerate';
import { trackedRun } from './subprocess';
import { validateConfig } from './validate';
import type { NaxRun } from './regenerate';

const FAKE = join(import.meta.dir, '..', '..', '..', 'test', 'fixtures', 'fake-nax.ts');
const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const exists = (p: string) => stat(p).then(() => true, () => false);

async function repo(files: Record<string, string>) {
  const dir = await tmp.make('cfg-nax');
  const naxHome = join(dir, '.naxhome');
  await mkdir(join(naxHome, 'profiles'), { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  const calls: string[][] = [];
  const nax: NaxRun = (args) => {
    calls.push([...args]);
    return trackedRun([process.execPath, FAKE, ...args], {
      cwd: dir, env: { ...process.env, NAX_GLOBAL_CONFIG_DIR: naxHome }, deadlineMs: Date.now() + 30_000,
      nowMs: () => Date.now(), isStopped: () => false, onProcess: () => undefined,
    });
  };
  return { dir, nax, calls };
}

describe('regenerate (spec §5 step 4)', () => {
  test('root context only: one generate call', async () => {
    const r = await repo({ '.nax/context.md': '# ctx\n' });
    expect(await regenerate(r.nax, r.dir)).toEqual({ ok: true, ran: ['generate'] });
    expect(await readFile(join(r.dir, 'CLAUDE.md'), 'utf8')).toContain('# ctx');
    expect(r.calls).toEqual([['generate', '-d', r.dir]]);
  });
  test('root and package contexts: both calls, package files written', async () => {
    const r = await repo({ '.nax/context.md': '# ctx\n', '.nax/mono/apps/api/context.md': '# api\n' });
    expect(await regenerate(r.nax, r.dir)).toEqual({ ok: true, ran: ['generate', 'generate --all-packages'] });
    expect(await exists(join(r.dir, 'apps/api/CLAUDE.md'))).toBe(true);
  });
  test('package contexts without a root context: only --all-packages', async () => {
    const r = await repo({ '.nax/mono/apps/web/context.md': '# web\n' });
    expect(await regenerate(r.nax, r.dir)).toEqual({ ok: true, ran: ['generate --all-packages'] });
  });
  test('no context at all: nothing runs', async () => {
    const r = await repo({ '.nax/config.json': '{}' });
    expect(await regenerate(r.nax, r.dir)).toEqual({ ok: true, ran: [] });
    expect(r.calls).toEqual([]);
  });
  test('a failing generate is a failure with the nax output, without the clone path', async () => {
    const r = await repo({ '.nax/context.md': 'FAKE_GENERATE_FAIL' });
    const result = await regenerate(r.nax, r.dir);
    expect(result).toMatchObject({ ok: false });
    expect((result as { output: string }).output).toContain('$ nax generate (exit 1)');
    expect((result as { output: string }).output).toContain('context.md is malformed');
    expect((result as { output: string }).output).not.toContain(r.dir);
  });
});

describe('validateConfig (spec §5 step 6)', () => {
  test('a clean repo with an edited profile and package config is valid', async () => {
    const r = await repo({ '.nax/config.json': '{}', '.nax/rules/a.md': '# a\n', '.nax/profiles/fast.json': '{}' });
    expect(await validateConfig(r.nax, r.dir, [
      { path: '.nax/profiles/fast.json', op: 'put', content: '{}', baseSha: null },
      { path: '.nax/mono/apps/api/config.json', op: 'put', content: '{"quality":{}}', baseSha: null },
    ])).toBeNull();
    expect(r.calls).toEqual([
      ['rules', 'lint', '-d', r.dir],
      ['config', '--json', '-d', r.dir],
      ['config', '--profile', 'fast', '--json', '-d', r.dir],
    ]);
  });
  test('a lint failure is invalid with the lint text, and stops there', async () => {
    const r = await repo({ '.nax/config.json': '{}', '.nax/rules/bad.md': 'FAKE_LINT_FAIL' });
    const result = await validateConfig(r.nax, r.dir, []);
    expect(result?.outcome).toBe('invalid');
    expect(result?.output).toContain('.nax/rules/bad.md: banned marker FAKE_LINT_FAIL');
    expect(r.calls).toHaveLength(1);
  });
  test('an unparsable root config is invalid with nax\'s error code', async () => {
    const r = await repo({ '.nax/config.json': '{ nope' });
    expect(await validateConfig(r.nax, r.dir, [])).toEqual({ outcome: 'invalid', output: 'nax config --json: CONFIG_PARSE_ERROR: fake-nax: CONFIG_PARSE_ERROR' });
  });
  test('a profile nax rejects is invalid', async () => {
    const r = await repo({ '.nax/config.json': '{}', '.nax/profiles/broken.json': JSON.stringify({ fakeError: 'PROFILE_INVALID' }) });
    expect(await validateConfig(r.nax, r.dir, [{ path: '.nax/profiles/broken.json', op: 'put', content: '{}', baseSha: null }]))
      .toEqual({ outcome: 'invalid', output: 'nax config --profile broken --json: PROFILE_INVALID: fake-nax: PROFILE_INVALID' });
  });
  test('a profile file name nax could not load is invalid without calling nax', async () => {
    const r = await repo({ '.nax/config.json': '{}' });
    expect(await validateConfig(r.nax, r.dir, [{ path: '.nax/profiles/-bad.json', op: 'put', content: '{}', baseSha: null }]))
      .toEqual({ outcome: 'invalid', output: 'invalid profile file name: .nax/profiles/-bad.json' });
  });
  test('a package config that is not a JSON object is invalid (D490)', async () => {
    const r = await repo({ '.nax/config.json': '{}' });
    expect(await validateConfig(r.nax, r.dir, [{ path: '.nax/mono/apps/api/config.json', op: 'put', content: '[1]', baseSha: null }]))
      .toEqual({ outcome: 'invalid', output: '.nax/mono/apps/api/config.json: not a JSON object' });
  });
  test('a deleted profile is not validated', async () => {
    const r = await repo({ '.nax/config.json': '{}' });
    expect(await validateConfig(r.nax, r.dir, [{ path: '.nax/profiles/old.json', op: 'delete', baseSha: 'a'.repeat(40) }])).toBeNull();
    expect(r.calls.map((c) => c[0])).toEqual(['rules', 'config']);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd apps/runner && bun test src/executor/config-job/nax-steps.spec.ts`
Expected: FAIL — `Cannot find module './regenerate'`.

- [ ] **Step 4: Implement regenerate**

Create `apps/runner/src/executor/config-job/regenerate.ts`:

```ts
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { sanitizeDiagnostic } from '../../diagnostics';
import { raiseIfInterrupted, type ProcResult } from './types';

/** One nax call in the job's clone, with the job's env and deadline already bound (D484). */
export type NaxRun = (args: readonly string[]) => Promise<ProcResult>;

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

/** What the job page shows for a failed nax call: the command (never the runner's clone path), the exit code, stderr then stdout. */
export function describeFailure(label: string, result: ProcResult): string {
  return sanitizeDiagnostic(`$ ${label} (exit ${result.code})\n${result.stderr}${result.stdout}`);
}

async function hasPackageContext(repoDir: string): Promise<boolean> {
  const mono = join(repoDir, '.nax', 'mono');
  if (!(await exists(mono))) return false;
  for await (const _found of new Bun.Glob('**/context.md').scan({ cwd: mono, onlyFiles: true, followSymlinks: false })) return true;
  return false;
}

/**
 * S3 spec §5 step 4: root files when `.nax/context.md` exists, package files when any `.nax/mono/**\/context.md`
 * exists (`--all-packages` writes package files only, so both calls are needed); neither: nothing to regenerate.
 */
export async function regenerate(nax: NaxRun, repoDir: string): Promise<{ ok: true; ran: string[] } | { ok: false; output: string }> {
  const steps: Array<{ label: string; args: string[] }> = [];
  if (await exists(join(repoDir, '.nax', 'context.md'))) steps.push({ label: 'generate', args: ['generate', '-d', repoDir] });
  if (await hasPackageContext(repoDir)) steps.push({ label: 'generate --all-packages', args: ['generate', '--all-packages', '-d', repoDir] });
  const ran: string[] = [];
  for (const step of steps) {
    const result = await nax(step.args);
    raiseIfInterrupted(result);
    if (result.code !== 0) return { ok: false, output: describeFailure(`nax ${step.label}`, result) };
    ran.push(step.label);
  }
  return { ok: true, ran };
}
```

- [ ] **Step 5: Implement validate**

Create `apps/runner/src/executor/config-job/validate.ts`:

```ts
import type { ConfigFileEdit, ConfigJobResult } from '@nathapp/fleet-protocol';
import { sanitizeDiagnostic } from '../../diagnostics';
import { parseNaxJson } from '../../nax/nax-cli';
import { PROFILE_NAME } from '../nax-process';
import { describeFailure, type NaxRun } from './regenerate';
import { raiseIfInterrupted, type ProcResult } from './types';

const PROFILE_FILE = /^\.nax\/profiles\/([^/]+)\.json$/;
const PACKAGE_CONFIG = /^\.nax\/mono\/.+\/config\.json$/;
const invalid = (output: string): ConfigJobResult => ({ outcome: 'invalid', output });

function errorMessageOf(stdout: string): string | null {
  try {
    const doc = JSON.parse(stdout) as { error?: { message?: unknown } };
    return typeof doc.error?.message === 'string' ? doc.error.message : null;
  } catch {
    return null;
  }
}

/** nax's JSON verdict for `config --json` (never the exit code, D96): null when nax printed a config document. */
function configError(result: ProcResult): string | null {
  const parsed = parseNaxJson(result);
  if (parsed.ok) return null;
  const message = errorMessageOf(result.stdout);
  return sanitizeDiagnostic(message ? `${parsed.code}: ${message}` : parsed.code);
}

function isJsonObject(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

/**
 * S3 spec §5 step 6, in order, first failure wins: `nax rules lint` (the whole repo), the root config, each added or
 * changed repo profile, each added or changed package config (D490: a JSON-object check, nax has no command for it).
 */
export async function validateConfig(nax: NaxRun, repoDir: string, edits: readonly ConfigFileEdit[]): Promise<ConfigJobResult | null> {
  const lint = await nax(['rules', 'lint', '-d', repoDir]);
  raiseIfInterrupted(lint);
  if (lint.code !== 0) return invalid(describeFailure('nax rules lint', lint));
  const root = await nax(['config', '--json', '-d', repoDir]);
  raiseIfInterrupted(root);
  const rootError = configError(root);
  if (rootError) return invalid(`nax config --json: ${rootError}`);
  const puts = edits.filter((edit) => edit.op === 'put');
  for (const edit of puts) {
    const name = PROFILE_FILE.exec(edit.path)?.[1];
    if (name === undefined) continue;
    if (!PROFILE_NAME.test(name)) return invalid(`invalid profile file name: ${edit.path}`);
    const result = await nax(['config', '--profile', name, '--json', '-d', repoDir]);
    raiseIfInterrupted(result);
    const error = configError(result);
    if (error) return invalid(`nax config --profile ${name} --json: ${error}`);
  }
  const badPackage = puts.find((edit) => PACKAGE_CONFIG.test(edit.path) && !isJsonObject(edit.content ?? ''));
  return badPackage ? invalid(`${badPackage.path}: not a JSON object`) : null;
}
```

- [ ] **Step 6: Run them to verify they pass**

Run: `cd apps/runner && bun test src/executor/config-job/nax-steps.spec.ts test/unit/fake-nax.spec.ts test/unit/fake-nax-probe.spec.ts`
Expected: PASS (the two fixture specs prove the fake-nax change kept its old behaviour).

- [ ] **Step 7: Commit**

```bash
git add apps/runner/test/fixtures apps/runner/src/executor/config-job/regenerate.ts apps/runner/src/executor/config-job/validate.ts apps/runner/src/executor/config-job/nax-steps.spec.ts
git commit -m "feat(runner): config-job regenerate and validate steps (S3 §5, D490)"
```

---

### Task B2-7: commit, push and open the PR

**Files:**
- Create: `apps/runner/src/executor/config-job/commit-push.ts`
- Create: `apps/runner/src/executor/config-job/open-pr.ts`
- Modify: `apps/runner/test/fixtures/fake-gh.ts`
- Test: `apps/runner/src/executor/config-job/commit-push.spec.ts`, `apps/runner/src/executor/config-job/open-pr.spec.ts`

**Interfaces:**
- Consumes: `validateBranchName` (`executor/branch.ts`), `isAuthFailure`, `NO_CREDENTIALS_REASON`, `Git` (`executor/git.ts`), `PLAN_PUSH_BACKOFF_MS` (`executor/plan-commit.ts`), `assertSegment` (`paths/safe-segment.ts`), `ProcResult`, `raiseIfInterrupted` (B2-4).
- Produces:
  - `CONFIG_BRANCH_PREFIX = 'nax-config/'`, `configBranchName(jobId: string): string`
  - `commitAndPushConfig(input: ConfigPushInput): Promise<ConfigPushResult>` with `ConfigPushResult = { kind: 'pushed'; branch: string; sha: string; files: string[] } | { kind: 'no_changes' } | { kind: 'push_failed'; output: string }`
  - `openPullRequest(input: OpenPrInput): Promise<{ ok: true; url: string } | { ok: false; output: string }>`, `lastUrl(text: string): string | null`
  - Fake gh: `pr view <branch> ... --json url --jq .url` prints `FAKE_GH_EXISTING_PR_URL` or exits 1; `FAKE_GH_CREATE_EXIT` makes `pr create` fail.

- [ ] **Step 1: Write the failing commit/push tests**

Create `apps/runner/src/executor/config-job/commit-push.spec.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGit } from '../git';
import { git as sh, isolateGit, makeOrigin } from '../../../test/helpers/git-fixture';
import { makeTempDirs } from '../../../test/helpers/tmp';
import { prepareConfigCheckout } from './checkout';
import { commitAndPushConfig, configBranchName, type ConfigPushInput } from './commit-push';

const tmp = makeTempDirs();
beforeAll(() => isolateGit());
afterAll(() => tmp.cleanup());
const identity = { name: 'koda-fleet[bot]', email: 'bot@koda.test' };

async function clone() {
  const base = await tmp.make('cfg-push');
  const origin = await makeOrigin(base, 'app', { files: { '.nax/rules/a.md': '# a\n' } });
  const repoDir = join(base, 'clone');
  await sh(base, 'clone', '-q', origin.url, repoDir);
  await prepareConfigCheckout(createGit(), repoDir, 'main');
  const input = (over: Partial<ConfigPushInput> = {}): ConfigPushInput => ({
    git: createGit(), repoDir, jobId: 'cj1', defaultBranch: 'main', title: 'Tighten rules', identity, credentialHelper: null,
    timeoutMs: () => 60_000, sleep: async () => undefined, ...over,
  });
  return { base, origin, repoDir, input };
}

describe('configBranchName', () => {
  test('is nax-config/<jobId> and refuses an unsafe job id', () => {
    expect(configBranchName('cj1')).toBe('nax-config/cj1');
    expect(() => configBranchName('../x')).toThrow();
  });
});

describe('commitAndPushConfig (spec §5 step 7, D487)', () => {
  test('commits every change as the job identity with the PR title and pushes the job branch', async () => {
    const w = await clone();
    await writeFile(join(w.repoDir, '.nax/rules/a.md'), '# a edited\n');
    await writeFile(join(w.repoDir, 'CLAUDE.md'), 'generated\n');
    const result = await commitAndPushConfig(w.input());
    expect(result).toMatchObject({ kind: 'pushed', branch: 'nax-config/cj1', files: ['.nax/rules/a.md', 'CLAUDE.md'] });
    const sha = (result as { sha: string }).sha;
    expect(await sh(w.origin.dir, 'rev-parse', 'nax-config/cj1')).toBe(sha);
    expect(await sh(w.origin.dir, 'log', '-1', '--format=%s|%an|%ae', 'nax-config/cj1')).toBe('Tighten rules|koda-fleet[bot]|bot@koda.test');
    expect(await sh(w.origin.dir, 'rev-parse', 'nax-config/cj1~1')).toBe(await sh(w.origin.dir, 'rev-parse', 'main'));
  });
  test('nothing changed: no_changes, nothing pushed', async () => {
    const w = await clone();
    expect(await commitAndPushConfig(w.input())).toEqual({ kind: 'no_changes' });
    await expect(sh(w.origin.dir, 'rev-parse', '--verify', 'nax-config/cj1')).rejects.toThrow();
  });
  test('a requeued attempt replaces the previous attempt\'s branch (force push)', async () => {
    const w = await clone();
    await writeFile(join(w.repoDir, '.nax/rules/a.md'), '# attempt 1\n');
    await commitAndPushConfig(w.input());
    await prepareConfigCheckout(createGit(), w.repoDir, 'main');
    await writeFile(join(w.repoDir, '.nax/rules/a.md'), '# attempt 2\n');
    const second = await commitAndPushConfig(w.input());
    expect(second.kind).toBe('pushed');
    expect(await sh(w.origin.dir, 'show', 'nax-config/cj1:.nax/rules/a.md')).toBe('# attempt 2');
  });
  test('a push that keeps failing is push_failed after the back-off', async () => {
    const w = await clone();
    await writeFile(join(w.repoDir, '.nax/rules/a.md'), '# x\n');
    await sh(w.repoDir, 'remote', 'set-url', 'origin', `file://${join(w.base, 'gone.git')}`);
    const slept: number[] = [];
    const result = await commitAndPushConfig(w.input({ sleep: async (ms) => { slept.push(ms); } }));
    expect(result).toMatchObject({ kind: 'push_failed' });
    expect((result as { output: string }).output).toContain('git push failed');
    expect(slept).toEqual([2_000, 8_000]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/runner && bun test src/executor/config-job/commit-push.spec.ts`
Expected: FAIL — `Cannot find module './commit-push'`.

- [ ] **Step 3: Implement commit and push**

Create `apps/runner/src/executor/config-job/commit-push.ts`:

```ts
import type { GitIdentity } from '@nathapp/fleet-protocol';
import { sanitizeDiagnostic } from '../../diagnostics';
import { assertSegment } from '../../paths/safe-segment';
import { systemSleep } from '../../time';
import { validateBranchName } from '../branch';
import { NO_CREDENTIALS_REASON, isAuthFailure, type Git } from '../git';
import { PLAN_PUSH_BACKOFF_MS } from '../plan-commit';

export const CONFIG_BRANCH_PREFIX = 'nax-config/';

export const configBranchName = (jobId: string): string => `${CONFIG_BRANCH_PREFIX}${assertSegment('jobId', jobId)}`;

export interface ConfigPushInput {
  readonly git: Git;
  readonly repoDir: string;
  readonly jobId: string;
  readonly defaultBranch: string;
  readonly title: string;
  readonly identity: GitIdentity;
  readonly credentialHelper: string | null;
  /** What is left of the job's budget, re-read for every git call. */
  readonly timeoutMs: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export type ConfigPushResult =
  | { kind: 'pushed'; branch: string; sha: string; files: string[] }
  | { kind: 'no_changes' }
  | { kind: 'push_failed'; output: string };

/** D487: `--force` onto the job's own branch; D77's back-off; an auth failure is not retried. */
async function pushWithRetry(input: ConfigPushInput, branch: string): Promise<string | null> {
  const sleep = input.sleep ?? systemSleep;
  for (let attempt = 0; ; attempt += 1) {
    const push = await input.git.run(['push', '--force', 'origin', `HEAD:refs/heads/${branch}`], { cwd: input.repoDir, credentialHelper: input.credentialHelper, timeoutMs: input.timeoutMs() });
    if (push.code === 0) return null;
    if (isAuthFailure(push.stderr)) return NO_CREDENTIALS_REASON;
    const backoff = PLAN_PUSH_BACKOFF_MS[attempt];
    if (backoff === undefined) return sanitizeDiagnostic(`git push failed: ${push.stderr.trim()}`).slice(0, 2_000);
    await sleep(backoff);
  }
}

/** S3 spec §5 step 7: everything the edit and `nax generate` changed, on `nax-config/<jobId>`, as the assigned identity. */
export async function commitAndPushConfig(input: ConfigPushInput): Promise<ConfigPushResult> {
  const { git, repoDir } = input;
  const at = () => ({ cwd: repoDir, timeoutMs: input.timeoutMs() });
  await git.ok(['add', '-A'], at());
  const files = (await git.ok(['diff', '--cached', '--name-only', '-z'], at())).split('\0').filter(Boolean).sort();
  if (files.length === 0) return { kind: 'no_changes' };
  const branch = configBranchName(input.jobId);
  if (!(await validateBranchName(git, repoDir, branch, input.defaultBranch))) throw new Error(`invalid config branch ${branch}`);
  await git.ok(['checkout', '-B', branch], at());
  const { name, email } = input.identity;
  // D69: the identity is passed explicitly, so the clone's config cannot fail or alter the commit.
  await git.ok(['-c', `user.name=${name}`, '-c', `user.email=${email}`, '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-q', '-m', input.title], {
    ...at(), env: { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email },
  });
  const failure = await pushWithRetry(input, branch);
  if (failure) return { kind: 'push_failed', output: failure };
  return { kind: 'pushed', branch, sha: (await git.ok(['rev-parse', 'HEAD'], at())).trim(), files };
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `cd apps/runner && bun test src/executor/config-job/commit-push.spec.ts`
Expected: PASS.

- [ ] **Step 5: Check the glab flags against the installed CLI**

Run: `glab mr view --help 2>&1 | grep -E -- '--output|-F,' ; glab mr create --help 2>&1 | grep -E -- '--source-branch|--target-branch|--yes|--description'`
Expected: `--output` (alias `-F`) for `mr view`, and the four `mr create` flags. If `mr view` only lists `-F, --format`, use `['-F', 'json']` in place of `['--output', 'json']` in Step 7 and in the test below. If glab is not installed on the machine, keep `--output` (glab >= 1.36) and say so in the PR description.

- [ ] **Step 6: Write the failing PR tests**

Create `apps/runner/src/executor/config-job/open-pr.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { lastUrl, openPullRequest, type OpenPrInput } from './open-pr';
import { StoppedError, type ProcResult } from './types';

const res = (code: number, stdout = '', stderr = '', over: Partial<ProcResult> = {}): ProcResult => ({ code, stdout, stderr, timedOut: false, stopped: false, ...over });
const input = (answers: ProcResult[], over: Partial<OpenPrInput> = {}) => {
  const calls: string[][] = [];
  const run = async (argv: readonly string[]) => { calls.push([...argv]); return answers.shift() ?? res(1); };
  return { calls, input: { run, provider: 'github', repoSlug: 'acme/app', base: 'main', head: 'nax-config/cj1', title: 'T', body: null, ...over } as OpenPrInput };
};

describe('lastUrl', () => {
  test('takes the last http(s) URL in the output', () => {
    expect(lastUrl('Creating pull request\nhttps://github.com/acme/app/pull/12\n')).toBe('https://github.com/acme/app/pull/12');
    expect(lastUrl('!3 T (nax-config/cj1)\n https://gitlab.com/acme/app/-/merge_requests/3\n')).toBe('https://gitlab.com/acme/app/-/merge_requests/3');
    expect(lastUrl('no url here')).toBeNull();
  });
});

describe('openPullRequest (spec §5 step 8, D472)', () => {
  test('GitHub: gh pr create with repo, base, head, title and body', async () => {
    const t = input([res(0, 'https://github.com/acme/app/pull/12\n')], { body: 'Why' });
    expect(await openPullRequest(t.input)).toEqual({ ok: true, url: 'https://github.com/acme/app/pull/12' });
    expect(t.calls).toEqual([['gh', 'pr', 'create', '--repo', 'acme/app', '--base', 'main', '--head', 'nax-config/cj1', '--title', 'T', '--body', 'Why']]);
  });
  test('GitHub: a failed create falls back to the PR that already exists for the branch', async () => {
    const t = input([res(1, '', 'a pull request for branch "nax-config/cj1" already exists'), res(0, 'https://github.com/acme/app/pull/9\n')]);
    expect(await openPullRequest(t.input)).toEqual({ ok: true, url: 'https://github.com/acme/app/pull/9' });
    expect(t.calls[1]).toEqual(['gh', 'pr', 'view', 'nax-config/cj1', '--repo', 'acme/app', '--json', 'url', '--jq', '.url']);
  });
  test('GitLab: glab mr create, fallback reads web_url from mr view json', async () => {
    const t = input([res(1, '', 'already exists'), res(0, JSON.stringify({ web_url: 'https://gitlab.com/acme/app/-/merge_requests/4' }))], { provider: 'gitlab' });
    expect(await openPullRequest(t.input)).toEqual({ ok: true, url: 'https://gitlab.com/acme/app/-/merge_requests/4' });
    expect(t.calls).toEqual([
      ['glab', 'mr', 'create', '--repo', 'acme/app', '--source-branch', 'nax-config/cj1', '--target-branch', 'main', '--title', 'T', '--description', '', '--yes'],
      ['glab', 'mr', 'view', 'nax-config/cj1', '--repo', 'acme/app', '--output', 'json'],
    ]);
  });
  test('no PR and no existing one: a failure that says the branch is pushed', async () => {
    const t = input([res(1, '', 'HTTP 422'), res(1, '', 'no pull requests found')]);
    const result = await openPullRequest(t.input);
    expect(result).toMatchObject({ ok: false });
    expect((result as { output: string }).output).toContain('gh pr create failed (exit 1)');
    expect((result as { output: string }).output).toContain('the branch is pushed; open the PR by hand');
  });
  test('a create that exits 0 without a URL is not a success', async () => {
    const t = input([res(0, 'done'), res(1)]);
    expect((await openPullRequest(t.input)).ok).toBe(false);
  });
  test('a stop during the call surfaces as StoppedError', async () => {
    const t = input([res(143, '', '', { stopped: true })]);
    await expect(openPullRequest(t.input)).rejects.toBeInstanceOf(StoppedError);
  });
});
```

- [ ] **Step 7: Implement**

Create `apps/runner/src/executor/config-job/open-pr.ts`:

```ts
import { sanitizeDiagnostic } from '../../diagnostics';
import { raiseIfInterrupted, type ProcResult } from './types';

export interface OpenPrInput {
  /** gh / glab in the clone, the job's shims first on PATH (D88), deadline bound (D484). */
  readonly run: (argv: readonly string[]) => Promise<ProcResult>;
  readonly provider: 'github' | 'gitlab';
  /** `owner/name`; a GitLab owner may be a group path. */
  readonly repoSlug: string;
  readonly base: string;
  readonly head: string;
  readonly title: string;
  readonly body: string | null;
}

export type OpenPrResult = { ok: true; url: string } | { ok: false; output: string };

const URL_RE = /https?:\/\/[^\s"'<>]+/g;

export function lastUrl(text: string): string | null {
  const candidate = text.match(URL_RE)?.at(-1);
  return candidate && URL.canParse(candidate) ? candidate : null;
}

async function existingUrl(input: OpenPrInput): Promise<string | null> {
  if (input.provider === 'github') {
    const view = await input.run(['gh', 'pr', 'view', input.head, '--repo', input.repoSlug, '--json', 'url', '--jq', '.url']);
    raiseIfInterrupted(view);
    return view.code === 0 ? lastUrl(view.stdout) : null;
  }
  const view = await input.run(['glab', 'mr', 'view', input.head, '--repo', input.repoSlug, '--output', 'json']);
  raiseIfInterrupted(view);
  if (view.code !== 0) return null;
  try {
    const doc = JSON.parse(view.stdout) as { web_url?: unknown };
    return typeof doc.web_url === 'string' ? lastUrl(doc.web_url) : null;
  } catch {
    return null;
  }
}

/**
 * S3 spec §5 step 8, D472: as nax's finish phase, through gh / glab. A retry after a crash finds the PR it opened
 * the first time. No footer: PrAttributionService comments on the PR.
 */
export async function openPullRequest(input: OpenPrInput): Promise<OpenPrResult> {
  const create = input.provider === 'github'
    ? ['gh', 'pr', 'create', '--repo', input.repoSlug, '--base', input.base, '--head', input.head, '--title', input.title, '--body', input.body ?? '']
    : ['glab', 'mr', 'create', '--repo', input.repoSlug, '--source-branch', input.head, '--target-branch', input.base, '--title', input.title, '--description', input.body ?? '', '--yes'];
  const created = await input.run(create);
  raiseIfInterrupted(created);
  const url = created.code === 0 ? lastUrl(created.stdout) : null;
  if (url) return { ok: true, url };
  const existing = await existingUrl(input);
  if (existing) return { ok: true, url: existing };
  const detail = sanitizeDiagnostic(`${create.slice(0, 3).join(' ')} failed (exit ${created.code}): ${created.stderr}${created.stdout}`).trim();
  return { ok: false, output: `${detail}\n(the branch is pushed; open the PR by hand)` };
}
```

- [ ] **Step 8: Extend the fake gh**

Replace the `if/else` chain at the end of `apps/runner/test/fixtures/fake-gh.ts` (lines 9-11) with:

```ts
if (args[0] === '--version') console.log('gh version 0.0.0-fake');
else if (args[0] === 'pr' && args[1] === 'create') {
  const fail = process.env['FAKE_GH_CREATE_EXIT'];
  if (fail) {
    console.error('a pull request for this branch already exists');
    process.exit(Number(fail));
  }
  console.log(process.env['FAKE_GH_PR_URL'] ?? 'https://example.test/koda/pull/7');
} else if (args[0] === 'pr' && args[1] === 'view') {
  const existing = process.env['FAKE_GH_EXISTING_PR_URL'];
  if (!existing) {
    console.error('no pull requests found for branch');
    process.exit(1);
  }
  console.log(existing);
}
process.exit(Number(process.env['FAKE_GH_EXIT'] ?? 0));
```

and add to the header comment: `S3: FAKE_GH_CREATE_EXIT fails pr create; pr view prints FAKE_GH_EXISTING_PR_URL or exits 1.`

- [ ] **Step 9: Run them to verify they pass**

Run: `cd apps/runner && bun test src/executor/config-job test/unit`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/runner/src/executor/config-job/commit-push.ts apps/runner/src/executor/config-job/commit-push.spec.ts apps/runner/src/executor/config-job/open-pr.ts apps/runner/src/executor/config-job/open-pr.spec.ts apps/runner/test/fixtures/fake-gh.ts
git commit -m "feat(runner): config-job commit, force-push and PR with existing-PR fallback (D472, D487)"
```

---
### Task B2-8: the config-job orchestrator on the executor seam

**Files:**
- Modify: `apps/runner/src/executor/job-executor.ts`
- Create: `apps/runner/src/executor/config-job/config-job.ts`
- Modify: `apps/runner/src/executor/host-executor.ts:70-100` (extract `prepareWorkspace`), `:132-136` (`matchesProcess`), new methods
- Modify: `apps/runner/test/helpers/fake-executor.ts`
- Test: `apps/runner/test/unit/config-job.spec.ts`

**Interfaces:**
- Consumes: everything from B2-3..B2-7; `CredentialProvider` (`credentials/broker.ts`); `withoutCredentialVars` (`credentials/credential-env.ts`); `reasonFromError` (`executor/git.ts`); `readProcessCommand` (`executor/pid-registry.ts`); `isConfigKind`, `ConfigEditPayload`, `ConfigJobResult` (Part B1).
- Produces (in `executor/job-executor.ts`):
  - `interface ConfigJobContext { payload: ConfigEditPayload; deadlineMs: number; isStopped: () => boolean; onProcess: (proc: { pid: number; pgid: number } | null) => void; step: (message: string) => void }`
  - `type ConfigJobRun = { kind: 'result'; result: ConfigJobResult; resultBranch?: string; resultSha?: string; resultPrUrl?: string } | { kind: 'failed'; reason: string } | { kind: 'stopped' }`
  - `JobExecutor.prepareConfigJob(job: JobRow, options?: PrepareOptions): Promise<PrepareOutcome>` and `JobExecutor.runConfigJob(job: JobRow, ctx: ConfigJobContext): Promise<ConfigJobRun>`
  - `runConfigJob(deps: ConfigJobDeps, job: JobRow, dirs: { repoDir: string; jobDir: string }, ctx: ConfigJobContext): Promise<ConfigJobRun>` in `config-job/config-job.ts`
  - `FakeExecutor.configPrepare`, `.configRun`, `.configContexts`, `.onConfigRun`

- [ ] **Step 1: Extend the executor seam**

In `apps/runner/src/executor/job-executor.ts` add `import type { ConfigEditPayload, ConfigJobResult } from '@nathapp/fleet-protocol';` and, before `export interface JobExecutor`:

```ts
/** S3 §5: what a JobRun hands the config executor. `deadlineMs` is on the executor's `nowMs` clock. */
export interface ConfigJobContext {
  readonly payload: ConfigEditPayload;
  readonly deadlineMs: number;
  /** A cancel was requested or the run was halted. */
  readonly isStopped: () => boolean;
  /** D484: the running subprocess (journaled for cancel and READOPT), or null between subprocesses. */
  readonly onProcess: (proc: { pid: number; pgid: number } | null) => void;
  /** One line per step, sent as a lifecycle event. */
  readonly step: (message: string) => void;
}

/** D482: a config outcome, or a runner error (`failed`), or a run the executor stopped (cancel / halt). */
export type ConfigJobRun =
  | { kind: 'result'; result: ConfigJobResult; resultBranch?: string; resultSha?: string; resultPrUrl?: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'stopped' };
```

and inside `JobExecutor` after `releaseApprovals`:

```ts
  /** S3 D480, D481: credentials, the shared clone, a detached checkout of origin/<defaultBranch>. No profile, no job check. */
  prepareConfigJob(job: JobRow, options?: PrepareOptions): Promise<PrepareOutcome>;
  /** S3 §5 steps 2-8 on the prepared clone. Never throws. */
  runConfigJob(job: JobRow, ctx: ConfigJobContext): Promise<ConfigJobRun>;
```

In `apps/runner/test/helpers/fake-executor.ts` import `ConfigJobContext, ConfigJobRun` from the executor module and add to the class:

```ts
  configPrepare: PrepareOutcome = { ok: true, branch: null };
  configRun: ConfigJobRun = {
    kind: 'result', result: { outcome: 'ok', files: ['.nax/rules/a.md', 'CLAUDE.md'] },
    resultBranch: 'nax-config/j1', resultSha: 'd'.repeat(40), resultPrUrl: 'https://example.test/pr/9',
  };
  readonly configContexts: ConfigJobContext[] = [];
  onConfigRun: (ctx: ConfigJobContext) => Promise<void> = async () => undefined;

  async prepareConfigJob(job: JobRow, options: PrepareOptions = {}): Promise<PrepareOutcome> {
    this.note('prepareConfigJob', job);
    this.prepareOptions.push(options);
    return this.configPrepare;
  }

  async runConfigJob(job: JobRow, ctx: ConfigJobContext): Promise<ConfigJobRun> {
    this.note('runConfigJob', job);
    this.configContexts.push(ctx);
    await this.onConfigRun(ctx);
    return this.configRun;
  }
```

Run: `cd apps/runner && bun run type-check`
Expected: FAIL only in `src/executor/host-executor.ts` ("Class 'HostExecutor' incorrectly implements interface 'JobExecutor'"). Step 5 fixes it.

- [ ] **Step 2: Write the failing executor tests**

Create `apps/runner/test/unit/config-job.spec.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type { AssignPayload, ConfigEditPayload } from '@nathapp/fleet-protocol';
import type { ConfigJobContext } from '../../src/executor/job-executor';
import { HostExecutor } from '../../src/executor/host-executor';
import { createGit } from '../../src/executor/git';
import { Journal } from '../../src/journal/journal';
import type { JobRow } from '../../src/journal/types';
import { createMemoryLogger } from '../../src/logger';
import { jobDirFor } from '../../src/paths/safe-segment';
import { assignFor } from '../helpers/assign';
import { installFakeGh } from '../helpers/fake-gh';
import { git as sh, isolateGit, makeOrigin } from '../helpers/git-fixture';
import { NO_APPROVALS } from '../helpers/no-approvals';
import { NO_CREDENTIALS } from '../helpers/no-credentials';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
const FAKE = join(import.meta.dir, '..', 'fixtures', 'fake-nax.ts');
const SEED = { 'README.md': 'x\n', '.nax/context.md': '# ctx\n', '.nax/rules/a.md': '# a\n', '.nax/config.json': '{}\n' };
let ghLog = '';
const savedPath = process.env['PATH'];
beforeAll(async () => {
  isolateGit();
  const gh = await installFakeGh(await tmp.make('gh'));
  ghLog = gh.logPath;
  process.env['PATH'] = `${gh.binDir}${delimiter}${savedPath ?? ''}`;
  process.env['FAKE_GH_LOG'] = gh.logPath;
});
afterAll(async () => {
  process.env['PATH'] = savedPath;
  for (const k of ['FAKE_GH_LOG', 'FAKE_GH_CREATE_EXIT', 'FAKE_NAX_GENERATE_SLEEP_MS']) delete process.env[k];
  await tmp.cleanup();
});

async function world(command: 'CONFIG_EDIT' | 'CONFIG_DRIFT', files: Record<string, string> = SEED) {
  const base = await tmp.make('cfg-host');
  const origin = await makeOrigin(base, 'origin', { files });
  const workspaceRoot = join(base, 'ws');
  const assign: AssignPayload = assignFor(command, { jobId: 'cjob1', repo: { provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', cloneUrl: origin.url } });
  const journal = Journal.open(':memory:');
  const row: JobRow = journal.insertJob({ assign, leaseEpoch: 1, repoKey: 'acme/app', jobDir: jobDirFor(workspaceRoot, 'cjob1') }).row;
  const ex = new HostExecutor({
    config: { workspaceRoot, naxCommand: ['bun', FAKE], naxHome: join(base, 'naxhome') }, git: createGit(), log: createMemoryLogger(),
    nowMs: () => Date.now(), sleep: async () => undefined, credentials: NO_CREDENTIALS, approvals: NO_APPROVALS,
  });
  const repoDir = join(workspaceRoot, 'acme', 'app');
  const blob = (path: string) => sh(origin.dir, 'rev-parse', `main:${path}`);
  const head = () => sh(origin.dir, 'rev-parse', 'main');
  const steps: string[] = [];
  const procs: Array<{ pid: number; pgid: number } | null> = [];
  const ctx = (payload: ConfigEditPayload, over: Partial<ConfigJobContext> = {}): ConfigJobContext => ({
    payload, deadlineMs: Date.now() + 60_000, isStopped: () => false, onProcess: (p) => { procs.push(p); }, step: (m) => { steps.push(m); }, ...over,
  });
  return { base, origin, repoDir, row, ex, blob, head, ctx, steps, procs };
}
const branchOnOrigin = (w: { origin: { dir: string } }) => sh(w.origin.dir, 'rev-parse', '--verify', 'nax-config/cjob1').then(() => true, () => false);

describe('HostExecutor config jobs (S3 §5)', () => {
  test('edit: staleness ok, apply, regenerate, validate, commit, push, PR', async () => {
    const w = await world('CONFIG_EDIT');
    expect(await w.ex.prepareConfigJob(w.row)).toEqual({ ok: true, branch: null });
    const run = await w.ex.runConfigJob(w.row, w.ctx({
      mode: 'edit', baseSha: await w.head(), prTitle: 'Tighten rule a', prBody: 'Because',
      edits: [{ path: '.nax/rules/a.md', op: 'put', content: '# a tightened\n', baseSha: await w.blob('.nax/rules/a.md') }],
    }));
    expect(run).toEqual({
      kind: 'result', result: { outcome: 'ok', files: ['.nax/rules/a.md', 'AGENTS.md', 'CLAUDE.md'] },
      resultBranch: 'nax-config/cjob1', resultSha: await sh(w.origin.dir, 'rev-parse', 'nax-config/cjob1'), resultPrUrl: 'https://example.test/koda/pull/7',
    });
    expect(await sh(w.origin.dir, 'show', 'nax-config/cjob1:.nax/rules/a.md')).toBe('# a tightened');
    const gh = (await readFile(ghLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { argv: string[] }).at(-1);
    expect(gh?.argv).toEqual(['pr', 'create', '--repo', 'acme/app', '--base', 'main', '--head', 'nax-config/cjob1', '--title', 'Tighten rule a', '--body', 'Because']);
    expect(w.steps).toEqual(expect.arrayContaining(['applied 1 edit(s)', 'regenerated: generate', 'validated', 'pushed nax-config/cjob1', 'opened https://example.test/koda/pull/7']));
    expect(w.procs.length).toBeGreaterThan(0);
    expect(w.procs.at(-1)).toBeNull();
  });
  test('edit: a file changed upstream since it was loaded is a conflict; nothing is pushed', async () => {
    const w = await world('CONFIG_EDIT');
    await w.ex.prepareConfigJob(w.row);
    const run = await w.ex.runConfigJob(w.row, w.ctx({
      mode: 'edit', baseSha: await w.head(), prTitle: 'T', prBody: null,
      edits: [{ path: '.nax/rules/a.md', op: 'put', content: 'mine', baseSha: 'f'.repeat(40) }],
    }));
    expect(run).toEqual({ kind: 'result', result: { outcome: 'conflict', files: ['.nax/rules/a.md'] } });
    expect(await branchOnOrigin(w)).toBe(false);
  });
  test('edit: a rule nax lint rejects is invalid; nothing is pushed', async () => {
    const w = await world('CONFIG_EDIT');
    await w.ex.prepareConfigJob(w.row);
    const run = await w.ex.runConfigJob(w.row, w.ctx({
      mode: 'edit', baseSha: await w.head(), prTitle: 'T', prBody: null,
      edits: [{ path: '.nax/rules/bad.md', op: 'put', content: 'FAKE_LINT_FAIL', baseSha: null }],
    }));
    expect(run).toMatchObject({ kind: 'result', result: { outcome: 'invalid' } });
    expect((run as { result: { output: string } }).result.output).toContain('banned marker FAKE_LINT_FAIL');
    expect(await branchOnOrigin(w)).toBe(false);
  });
  test('drift: lists the generated files nax would change, pushes nothing', async () => {
    const w = await world('CONFIG_DRIFT');
    await w.ex.prepareConfigJob(w.row);
    const run = await w.ex.runConfigJob(w.row, w.ctx({ mode: 'drift', baseSha: await w.head(), prTitle: null, prBody: null, edits: [] }));
    expect(run).toEqual({ kind: 'result', result: { outcome: 'drift', files: ['AGENTS.md', 'CLAUDE.md'] } });
    expect(await branchOnOrigin(w)).toBe(false);
  });
  test('regenerate on an up-to-date repo is no_changes', async () => {
    const generated = '<!-- generated by fake nax -->\n# ctx\n';
    const w = await world('CONFIG_EDIT', { ...SEED, 'CLAUDE.md': generated, 'AGENTS.md': generated });
    await w.ex.prepareConfigJob(w.row);
    const run = await w.ex.runConfigJob(w.row, w.ctx({ mode: 'regenerate', baseSha: await w.head(), prTitle: 'Regenerate', prBody: null, edits: [] }));
    expect(run).toEqual({ kind: 'result', result: { outcome: 'no_changes' } });
  });
  test('a failed PR keeps the pushed branch in the result', async () => {
    const w = await world('CONFIG_EDIT');
    await w.ex.prepareConfigJob(w.row);
    process.env['FAKE_GH_CREATE_EXIT'] = '1';
    try {
      const run = await w.ex.runConfigJob(w.row, w.ctx({ mode: 'regenerate', baseSha: await w.head(), prTitle: 'R', prBody: null, edits: [] }));
      expect(run).toMatchObject({ kind: 'result', result: { outcome: 'pr_failed', files: ['AGENTS.md', 'CLAUDE.md'] }, resultBranch: 'nax-config/cjob1' });
      expect((run as { result: { output: string } }).result.output).toContain('open the PR by hand');
    } finally {
      delete process.env['FAKE_GH_CREATE_EXIT'];
    }
  });
  test('a stop during a slow nax call ends the run as stopped', async () => {
    const w = await world('CONFIG_DRIFT');
    await w.ex.prepareConfigJob(w.row);
    process.env['FAKE_NAX_GENERATE_SLEEP_MS'] = '20000';
    try {
      let stop = false;
      setTimeout(() => { stop = true; }, 500);
      const started = Date.now();
      const run = await w.ex.runConfigJob(w.row, w.ctx({ mode: 'drift', baseSha: await w.head(), prTitle: null, prBody: null, edits: [] }, { isStopped: () => stop }));
      expect(run).toEqual({ kind: 'stopped' });
      expect(Date.now() - started).toBeLessThan(8_000);
    } finally {
      delete process.env['FAKE_NAX_GENERATE_SLEEP_MS'];
    }
  });
  test('the deadline ends the run as timeout', async () => {
    const w = await world('CONFIG_DRIFT');
    await w.ex.prepareConfigJob(w.row);
    process.env['FAKE_NAX_GENERATE_SLEEP_MS'] = '20000';
    try {
      const run = await w.ex.runConfigJob(w.row, w.ctx({ mode: 'drift', baseSha: await w.head(), prTitle: null, prBody: null, edits: [] }, { deadlineMs: Date.now() + 800 }));
      expect(run).toEqual({ kind: 'result', result: { outcome: 'timeout' } });
    } finally {
      delete process.env['FAKE_NAX_GENERATE_SLEEP_MS'];
    }
  });
  test('prepare fails cleanly when the default branch is missing on origin', async () => {
    const w = await world('CONFIG_EDIT');
    const row: JobRow = { ...w.row, assign: { ...w.row.assign, repo: { ...w.row.assign.repo, defaultBranch: 'trunk' } } };
    expect(await w.ex.prepareConfigJob(row)).toEqual({ ok: false, reason: 'checkout: default branch not found' });
  });
  test('matchesProcess (D486): the clone path or the job branch in argv', async () => {
    const w = await world('CONFIG_EDIT');
    await w.ex.prepareConfigJob(w.row);
    const proc = Bun.spawn(['sh', '-c', 'sleep 30', w.repoDir], { stdout: 'ignore', stderr: 'ignore' });
    try {
      expect(await w.ex.matchesProcess({ ...w.row, pid: proc.pid, pgid: proc.pid })).toBe(true);
      expect(await w.ex.matchesProcess({ ...w.row, jobId: 'other', jobDir: w.row.jobDir, pid: proc.pid, pgid: proc.pid, assign: { ...w.row.assign, repo: { ...w.row.assign.repo, name: 'other' } } })).toBe(false);
      expect(await w.ex.matchesProcess({ ...w.row, pid: null })).toBe(false);
    } finally {
      proc.kill('SIGKILL');
    }
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd apps/runner && bun test test/unit/config-job.spec.ts`
Expected: FAIL — `w.ex.prepareConfigJob is not a function`.

- [ ] **Step 4: Implement the orchestrator**

Create `apps/runner/src/executor/config-job/config-job.ts`:

```ts
import { appendFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type { ConfigJobResult } from '@nathapp/fleet-protocol';
import type { CredentialProvider } from '../../credentials/broker';
import { withoutCredentialVars } from '../../credentials/credential-env';
import type { JobRow } from '../../journal/types';
import { reasonFromError, type Git } from '../git';
import type { ConfigJobContext, ConfigJobRun } from '../job-executor';
import { applyEdits } from './apply-edits';
import { commitAndPushConfig } from './commit-push';
import { changedFiles } from './drift';
import { openPullRequest } from './open-pr';
import { regenerate, type NaxRun } from './regenerate';
import { findConflicts } from './staleness';
import { trackedRun } from './subprocess';
import { DeadlineError, StoppedError, checkpoint, remainingMs, type ProcResult, type StepClock } from './types';
import { validateConfig } from './validate';

export interface ConfigJobDeps {
  readonly git: Git;
  readonly naxCommand: readonly string[];
  readonly naxHome: string;
  readonly credentials: CredentialProvider;
  readonly nowMs: () => number;
  /** The push back-off; tests inject a no-op. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ConfigJobDirs {
  readonly repoDir: string;
  readonly jobDir: string;
}

type Env = Readonly<Record<string, string | undefined>>;

const outcome = (result: ConfigJobResult, fields: { resultBranch?: string; resultSha?: string; resultPrUrl?: string } = {}): ConfigJobRun => ({ kind: 'result', result, ...fields });

/** The job's stdout / stderr streams (S2a log shipping) get every call's output, headed by the command. */
async function logCall(dirs: ConfigJobDirs, argv: readonly string[], result: ProcResult): Promise<void> {
  const head = `$ ${argv.join(' ')} (exit ${result.code})\n`;
  await appendFile(join(dirs.jobDir, 'nax.stdout'), `${head}${result.stdout}`);
  await appendFile(join(dirs.jobDir, 'nax.stderr'), `${head}${result.stderr}`);
}

/** gh / glab from the job's PATH, so the shim in `<jobDir>/bin` answers first (D88); a missing tool fails the call, not the job. */
const resolveTool = (argv: readonly string[], path: string): string[] => [Bun.which(argv[0] ?? '', { PATH: path }) ?? argv[0] ?? '', ...argv.slice(1)];

/**
 * S3 spec §5 steps 2-8 on a clone `prepareConfigJob` left detached at origin/<defaultBranch>. Never throws: a stop is
 * `stopped`, the deadline is outcome `timeout`, any other error is `failed` with a fixed-vocabulary reason.
 */
export async function runConfigJob(deps: ConfigJobDeps, job: JobRow, dirs: ConfigJobDirs, ctx: ConfigJobContext): Promise<ConfigJobRun> {
  const clock: StepClock = { nowMs: deps.nowMs, deadlineMs: ctx.deadlineMs, isStopped: ctx.isStopped };
  const { payload } = ctx;
  const { repoDir } = dirs;
  const { repo, gitIdentity } = job.assign;
  const inheritedPath = process.env['PATH'] ?? '';
  const naxEnv: Env = { ...withoutCredentialVars(process.env), NAX_GLOBAL_CONFIG_DIR: deps.naxHome, PATH: inheritedPath };
  const call = async (argv: readonly string[], env: Env): Promise<ProcResult> => {
    checkpoint(clock);
    const result = await trackedRun(argv, { cwd: repoDir, env, deadlineMs: ctx.deadlineMs, nowMs: deps.nowMs, isStopped: ctx.isStopped, onProcess: ctx.onProcess });
    await logCall(dirs, argv, result);
    return result;
  };
  const nax: NaxRun = (args) => call([...deps.naxCommand, ...args], naxEnv);
  try {
    checkpoint(clock);
    if (payload.mode === 'edit') {
      const conflicts = await findConflicts(deps.git, repoDir, payload.edits);
      if (conflicts.length > 0) return outcome({ outcome: 'conflict', files: conflicts });
      const applied = await applyEdits(repoDir, payload.edits);
      if (!applied.ok) return outcome({ outcome: 'invalid', output: applied.output });
      ctx.step(`applied ${payload.edits.length} edit(s)`);
    }
    const regenerated = await regenerate(nax, repoDir);
    if (!regenerated.ok) return outcome({ outcome: 'invalid', output: regenerated.output });
    ctx.step(regenerated.ran.length > 0 ? `regenerated: ${regenerated.ran.join(', ')}` : 'nothing to regenerate');
    if (payload.mode === 'drift') {
      const files = await changedFiles(deps.git, repoDir, remainingMs(clock));
      ctx.step(files.length > 0 ? `drift: ${files.length} file(s)` : 'no drift');
      return outcome({ outcome: 'drift', files });
    }
    const problem = await validateConfig(nax, repoDir, payload.edits);
    if (problem) return outcome(problem);
    ctx.step('validated');
    if (payload.prTitle === null) return { kind: 'failed', reason: 'config edit has no PR title' };
    checkpoint(clock);
    const acquired = await deps.credentials.acquire(job, { wait: true, isCancelled: ctx.isStopped });
    if (!acquired.ok) {
      if (acquired.cancelled) throw new StoppedError();
      return { kind: 'failed', reason: acquired.reason };
    }
    const pushed = await commitAndPushConfig({
      git: deps.git, repoDir, jobId: job.jobId, defaultBranch: repo.defaultBranch, title: payload.prTitle, identity: gitIdentity,
      credentialHelper: acquired.credentials.helper, timeoutMs: () => remainingMs(clock), ...(deps.sleep ? { sleep: deps.sleep } : {}),
    });
    if (pushed.kind === 'no_changes') {
      ctx.step('no changes to commit');
      return outcome({ outcome: 'no_changes' });
    }
    if (pushed.kind === 'push_failed') return outcome({ outcome: 'push_failed', output: pushed.output });
    ctx.step(`pushed ${pushed.branch}`);
    const { binDir } = acquired.credentials;
    const toolPath = binDir ? `${binDir}${delimiter}${inheritedPath}` : inheritedPath;
    const toolEnv: Env = { ...naxEnv, PATH: toolPath };
    const pr = await openPullRequest({
      run: (argv) => call(resolveTool(argv, toolPath), toolEnv), provider: repo.provider, repoSlug: `${repo.owner}/${repo.name}`,
      base: repo.defaultBranch, head: pushed.branch, title: payload.prTitle, body: payload.prBody,
    });
    const fields = { resultBranch: pushed.branch, resultSha: pushed.sha };
    if (!pr.ok) return outcome({ outcome: 'pr_failed', files: pushed.files, output: pr.output }, fields);
    ctx.step(`opened ${pr.url}`);
    return outcome({ outcome: 'ok', files: pushed.files }, { ...fields, resultPrUrl: pr.url });
  } catch (error) {
    if (error instanceof StoppedError) return { kind: 'stopped' };
    if (error instanceof DeadlineError) return outcome({ outcome: 'timeout' });
    return { kind: 'failed', reason: reasonFromError(error) };
  }
}
```

- [ ] **Step 5: Wire the HostExecutor**

In `apps/runner/src/executor/host-executor.ts`:

1. Add imports:

```ts
import { isConfigKind } from '@nathapp/fleet-protocol';
import { prepareConfigCheckout } from './config-job/checkout';
import { configBranchName } from './config-job/commit-push';
import { runConfigJob } from './config-job/config-job';
```

and add `ConfigJobContext, ConfigJobRun` to the `./job-executor` type import.

2. Line 45: `CANCELLED` must also fit the narrower failure type `prepareWorkspace` returns:

```ts
const CANCELLED = { ok: false, reason: 'cancelled', cancelled: true } as const satisfies PrepareOutcome;
```

3. Replace `prepare` (lines 70-100) with a shared workspace step plus the two prepares:

```ts
  /** Design §2 steps 1-2, shared by nax jobs and config jobs (D480): attempt files wiped, credentials, clone, clean. */
  private async prepareWorkspace(job: JobRow, cancelled: () => boolean): Promise<{ ok: true; repoDir: string; jobDir: string; outDir: string } | { ok: false; reason: string; cancelled?: true }> {
    const { repoDir, jobDir, outDir } = this.dirs(job);
    if (cancelled()) return CANCELLED;
    await Promise.all(ATTEMPT_FILES.map((name) => rm(join(jobDir, name), { recursive: true, force: true })));
    await mkdir(jobDir, { recursive: true, mode: 0o700 });
    await chmod(jobDir, 0o700);   // D93: it holds the shims
    const acquired = await this.deps.credentials.acquire(job, { wait: true, isCancelled: cancelled });
    if (!acquired.ok) return acquired.cancelled ? CANCELLED : { ok: false, reason: acquired.reason };
    const { helper } = acquired.credentials;
    await ensureClone(this.deps.git, { repoDir, cloneUrl: job.assign.repo.cloneUrl, identity: job.assign.gitIdentity, credentialHelper: helper });
    if (cancelled()) return CANCELLED;
    await cleanWorkspace(this.deps.git, repoDir, helper);
    if (cancelled()) return CANCELLED;
    return { ok: true, repoDir, jobDir, outDir };
  }

  async prepare(job: JobRow, options: PrepareOptions = {}): Promise<PrepareOutcome> {
    const cancelled = (): boolean => options.isCancelled?.() === true;   // D66: polled at every step boundary
    try {
      const workspace = await this.prepareWorkspace(job, cancelled);
      if (!workspace.ok) return workspace;
      const { repoDir, jobDir, outDir } = workspace;
      const { assign } = job;
      const checkout = await prepareCheckout({ git: this.deps.git, repoDir, assign });
      if (!checkout.ok) return { ok: false, reason: checkout.reason };
      const mismatch = await (this.deps.jobCheck ?? NO_JOB_CHECK).check(assign, repoDir);   // D104
      if (mismatch !== null) return { ok: false, reason: mismatch };
      if (assign.command === 'PLAN') await this.moveStalePlanFiles(repoDir, jobDir, assign.feature);
      if (cancelled()) return CANCELLED;
      await mkdir(outDir, { recursive: true });
      const relay = assign.bashMode === 'raw' ? undefined
        : { bashMode: assign.bashMode, approvalTimeoutSec: assign.approvalTimeoutSec, endpoint: await this.deps.approvals.open(job) };
      await writeJobProfile(this.deps.config.naxHome, job.jobId, outDir, projectNameFor(assign.repo.owner, assign.repo.name), relay);
      return { ok: true, branch: checkout.branch };
    } catch (error) {
      return { ok: false, reason: reasonFromError(error) };
    }
  }

  async prepareConfigJob(job: JobRow, options: PrepareOptions = {}): Promise<PrepareOutcome> {
    const cancelled = (): boolean => options.isCancelled?.() === true;
    try {
      const workspace = await this.prepareWorkspace(job, cancelled);
      if (!workspace.ok) return workspace;
      const checkout = await prepareConfigCheckout(this.deps.git, workspace.repoDir, job.assign.repo.defaultBranch);
      return checkout.ok ? { ok: true, branch: null } : { ok: false, reason: checkout.reason };
    } catch (error) {
      return { ok: false, reason: reasonFromError(error) };
    }
  }

  runConfigJob(job: JobRow, ctx: ConfigJobContext): Promise<ConfigJobRun> {
    const { repoDir, jobDir } = this.dirs(job);
    const { git, credentials, nowMs, sleep } = this.deps;
    return runConfigJob({ git, naxCommand: this.deps.config.naxCommand, naxHome: this.deps.config.naxHome, credentials, nowMs, ...(sleep ? { sleep } : {}) }, job, { repoDir, jobDir }, ctx);
  }
```

4. Replace `matchesProcess` (lines 132-136):

```ts
  async matchesProcess(job: JobRow): Promise<boolean> {
    if (job.pid === null) return false;
    const command = await readProcessCommand(job.pid);
    if (command === null) return false;
    // D486: a config job's nax calls carry `-d <clone>`; its gh / glab calls carry the job branch.
    if (isConfigKind(job.command)) return command.includes(this.dirs(job).repoDir) || command.includes(configBranchName(job.jobId));
    return command.includes(jobProfileName(job.jobId));
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/runner && bun test test/unit/config-job.spec.ts test/unit/host-executor.spec.ts test/unit/host-executor-auth.spec.ts && bun run type-check`
Expected: PASS; the existing HostExecutor specs prove the `prepareWorkspace` extraction changed nothing for RUN / PLAN.

- [ ] **Step 7: Commit**

```bash
git add apps/runner/src/executor apps/runner/test/helpers/fake-executor.ts apps/runner/test/unit/config-job.spec.ts
git commit -m "feat(runner): config-job orchestrator behind the executor seam (S3 §5, D480-D482, D486)"
```

---
### Task B2-9: JobRun routes config kinds (fetch, RUNNING, heartbeat, report)

**Files:**
- Create: `apps/runner/src/supervisor/heartbeat.ts`
- Modify: `apps/runner/src/supervisor/job-run.ts` (imports, `JobRunTuning`, `JobRunDeps`, `lifecycle` lines 109-119, new `runConfig` / `finishConfig`)
- Test: `apps/runner/src/supervisor/heartbeat.spec.ts`, `apps/runner/src/supervisor/job-run-config.spec.ts`

**Interfaces:**
- Consumes: `fetchConfigEdit`, `ConfigEditSource` (B2-3); `fitConfigResult` (B2-4); `ConfigJobRun`, `JobExecutor.prepareConfigJob/runConfigJob` (B2-8); `isConfigKind`, `ConfigJobKind`, `CONFIG_COMPLETED_OUTCOMES`, `SnapshotEventPayload.configResult` (Part B1).
- Produces:
  - `JobRunDeps.configEdits?: ConfigEditSource`
  - `JobRunTuning.configJobTimeoutMs?: number` (default `CONFIG_JOB_TIMEOUT_MS = 600_000`), `JobRunTuning.configHeartbeatMs?: number` (default `CONFIG_HEARTBEAT_MS = 30_000`)
  - `startHeartbeat(input: { everyMs: number; sleep: Sleep; now: Now; emit: (heartbeatAt: string) => void }): () => void`
  - Emission order for a config job: (fetch while ASSIGNED) -> `prepareConfigJob` -> RUNNING (`pid`/`pgid`/`branch` null) -> step lifecycles and heartbeat snapshots -> snapshot `{ configResult, resultBranch?, resultSha?, resultPrUrl? }` -> UPLOADING -> COMPLETED | FAILED with `reason = outcome` (D488). `failed` run: UPLOADING -> FAILED with its reason, no configResult. `stopped` with a cancel: RUNNING -> CANCELLED. A failure before RUNNING: ASSIGNED -> FAILED / CANCELLED.

- [ ] **Step 1: Write the failing heartbeat test**

Create `apps/runner/src/supervisor/heartbeat.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { fakeTime } from '../../test/helpers/fake-time';
import { startHeartbeat } from './heartbeat';

const settle = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('startHeartbeat', () => {
  test('emits one stamp per interval until stopped, then never again', async () => {
    const time = fakeTime();
    const stamps: string[] = [];
    const stop = startHeartbeat({ everyMs: 30_000, sleep: time.sleep, now: time.now, emit: (at) => { stamps.push(at); } });
    for (let i = 0; i < 4; i += 1) await settle();
    stop();
    const seen = stamps.length;
    expect(seen).toBeGreaterThanOrEqual(2);
    expect(stamps[0]).toBe('2026-10-01T00:00:30.000Z');
    for (let i = 0; i < 4; i += 1) await settle();
    expect(stamps.length).toBe(seen);
  });
  test('a stop before the first interval emits nothing', async () => {
    const time = fakeTime();
    const stamps: string[] = [];
    startHeartbeat({ everyMs: 30_000, sleep: time.sleep, now: time.now, emit: (at) => { stamps.push(at); } })();
    for (let i = 0; i < 3; i += 1) await settle();
    expect(stamps).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/runner && bun test src/supervisor/heartbeat.spec.ts`
Expected: FAIL — `Cannot find module './heartbeat'`.

- [ ] **Step 3: Implement**

Create `apps/runner/src/supervisor/heartbeat.ts`:

```ts
import type { Now, Sleep } from '../time';

/** S3 §3: a config job has no status.json, so the run itself stamps `heartbeatAt` (dashboard `job_silent`, silence sweep). */
export const CONFIG_HEARTBEAT_MS = 30_000;

/** Returns the stop function; the abort also cuts the pending sleep short (systemSleep honours the signal). */
export function startHeartbeat(input: { everyMs: number; sleep: Sleep; now: Now; emit: (heartbeatAt: string) => void }): () => void {
  const abort = new AbortController();
  void (async () => {
    for (;;) {
      await input.sleep(input.everyMs, abort.signal);
      if (abort.signal.aborted) return;
      input.emit(input.now().toISOString());
    }
  })();
  return () => abort.abort();
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/runner && bun test src/supervisor/heartbeat.spec.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing JobRun tests**

Create `apps/runner/src/supervisor/job-run-config.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { ConfigEditPayload, SnapshotEventPayload, StateEventPayload } from '@nathapp/fleet-protocol';
import { Journal } from '../journal/journal';
import { createMemoryLogger } from '../logger';
import { NetworkError, ServerError } from '../sync/http';
import { assignFor } from '../../test/helpers/assign';
import { FakeExecutor } from '../../test/helpers/fake-executor';
import { FakeLogShipping } from '../../test/helpers/fake-log-shipping';
import { fakeTime } from '../../test/helpers/fake-time';
import type { ConfigEditSource } from './config-edit-fetch';
import { JobRun, type JobRunDeps } from './job-run';
import { RepoMutex } from './repo-mutex';

const EDIT: ConfigEditPayload = {
  mode: 'edit', baseSha: 'a'.repeat(40), prTitle: 'Tighten rules', prBody: null,
  edits: [{ path: '.nax/rules/a.md', op: 'put', content: '# a\n', baseSha: 'b'.repeat(40) }],
};

function build(command: 'CONFIG_EDIT' | 'CONFIG_DRIFT' = 'CONFIG_EDIT', source?: ConfigEditSource) {
  const time = fakeTime();
  const journal = Journal.open(':memory:', time.now);
  const ex = new FakeExecutor();
  const logs = new FakeLogShipping(ex.calls);
  const mutex = new RepoMutex();
  const fetched: Array<[string, number]> = [];
  const deps: JobRunDeps = {
    journal, executor: ex, mutex, log: createMemoryLogger(), now: time.now, sleep: time.sleep, logs,
    uploader: { upload: async () => { throw new Error('config jobs never upload a bundle'); } },
    tuning: { statusPollMs: 2_000, killGraceMs: 30_000, ackPollMs: 250, uploadAckWaitMs: 0, logDrainTimeoutMs: 120_000, configJobTimeoutMs: 600_000, configHeartbeatMs: 30_000 },
    configEdits: source ?? { fetch: async (jobId, epoch) => { fetched.push([jobId, epoch]); return command === 'CONFIG_DRIFT' ? { ...EDIT, mode: 'drift', edits: [], prTitle: null } : EDIT; } },
  };
  journal.insertJob({ assign: assignFor(command), leaseEpoch: 1, repoKey: 'acme/app', jobDir: '/w/.jobs/j1' });
  return { time, journal, ex, logs, mutex, fetched, deps, run: new JobRun(deps, 'j1', 1) };
}
type Built = ReturnType<typeof build>;
const events = (b: Built) => b.journal.pendingEvents('j1', 1, 1_000);
const states = (b: Built) => events(b).filter((e) => e.type === 'state').map((e) => e.payload as StateEventPayload);
const stateNames = (b: Built) => states(b).map((s) => s.to);
const snapshots = (b: Built) => events(b).filter((e) => e.type === 'snapshot').map((e) => e.payload as SnapshotEventPayload);
const lifecycles = (b: Built) => events(b).filter((e) => e.type === 'lifecycle').map((e) => (e.payload as { message: string }).message);
const settle = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('config job happy path (S3 §3, §5)', () => {
  test('fetch, prepare, RUNNING, run, result snapshot, UPLOADING, COMPLETED with reason ok; no nax, no bundle', async () => {
    const b = build();
    await b.run.start('prepare');
    expect(b.fetched).toEqual([['j1', 1]]);
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', 'COMPLETED']);
    expect(states(b).at(-1)).toEqual({ to: 'COMPLETED', reason: 'ok' });
    const result = snapshots(b).find((s) => s.configResult);
    expect(result).toEqual({
      configResult: { outcome: 'ok', files: ['.nax/rules/a.md', 'CLAUDE.md'] },
      resultBranch: 'nax-config/j1', resultSha: 'd'.repeat(40), resultPrUrl: 'https://example.test/pr/9',
    });
    const all = events(b);
    const resultAt = all.findIndex((e) => e.type === 'snapshot' && (e.payload as SnapshotEventPayload).configResult);
    const uploadingAt = all.findIndex((e) => e.type === 'state' && (e.payload as StateEventPayload).to === 'UPLOADING');
    expect(resultAt).toBeLessThan(uploadingAt);
    expect(b.ex.calls).toEqual(expect.arrayContaining(['prepareConfigJob:j1', 'runConfigJob:j1', 'logs.register:j1', 'logs.drain:j1', 'cleanup:j1']));
    expect(b.ex.calls.some((c) => c.startsWith('prepare:') || c.startsWith('spawn:') || c.startsWith('collectBundle:'))).toBe(false);
    expect(b.journal.getJob('j1', 1)).toMatchObject({ state: 'COMPLETED', pid: null, pgid: null });
    expect(b.journal.getJob('j1', 1)?.doneAt).not.toBeNull();
    expect(b.mutex.isLocked('acme/app')).toBe(false);
  });
  test('the executor gets the fetched payload and the deadline (now + configJobTimeoutMs)', async () => {
    const b = build();
    const startedAt = b.time.nowMs();
    await b.run.start('prepare');
    expect(b.ex.configContexts[0]?.payload).toEqual(EDIT);
    expect(b.ex.configContexts[0]?.deadlineMs).toBe(startedAt + 600_000);
  });
  test.each([
    ['no_changes', 'COMPLETED'],
    ['drift', 'COMPLETED'],
    ['conflict', 'FAILED'],
    ['invalid', 'FAILED'],
    ['push_failed', 'FAILED'],
    ['pr_failed', 'FAILED'],
    ['timeout', 'FAILED'],
  ] as const)('outcome %s ends %s with reason = outcome (D471, D488)', async (outcome, state) => {
    const b = build();
    b.ex.configRun = { kind: 'result', result: { outcome, files: ['.nax/rules/a.md'] } };
    await b.run.start('prepare');
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', state]);
    expect(states(b).at(-1)).toEqual({ to: state, reason: outcome });
    expect(snapshots(b).find((s) => s.configResult)?.configResult).toEqual({ outcome, files: ['.nax/rules/a.md'] });
  });
  test('an oversized result is trimmed to fit the snapshot (D491)', async () => {
    const b = build();
    b.ex.configRun = { kind: 'result', result: { outcome: 'invalid', output: 'x'.repeat(40_000) } };
    await b.run.start('prepare');
    expect(Buffer.byteLength(snapshots(b).find((s) => s.configResult)?.configResult?.output ?? '')).toBeLessThanOrEqual(8_192);
  });
  test('a runner error inside the run is UPLOADING -> FAILED with its reason and no result', async () => {
    const b = build();
    b.ex.configRun = { kind: 'failed', reason: 'workspace: disk full' };
    await b.run.start('prepare');
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', 'FAILED']);
    expect(states(b).at(-1)).toEqual({ to: 'FAILED', reason: 'workspace: disk full' });
    expect(snapshots(b).some((s) => s.configResult)).toBe(false);
  });
  test('steps become lifecycle events; the running subprocess is journaled', async () => {
    const b = build();
    b.ex.onConfigRun = async (ctx) => {
      ctx.step('applied 1 edit(s)');
      ctx.onProcess({ pid: 777, pgid: 777 });
      expect(b.journal.getJob('j1', 1)).toMatchObject({ pid: 777, pgid: 777 });
      ctx.onProcess(null);
    };
    await b.run.start('prepare');
    expect(lifecycles(b)).toContain('applied 1 edit(s)');
  });
  test('a slow run stamps heartbeat snapshots while RUNNING', async () => {
    const b = build();
    b.ex.onConfigRun = async () => { for (let i = 0; i < 4; i += 1) await settle(); };
    await b.run.start('prepare');
    expect(snapshots(b).filter((s) => s.heartbeatAt).length).toBeGreaterThanOrEqual(2);
  });
});

describe('config job before RUNNING (D481)', () => {
  test('a fenced fetch (409) emits nothing and leaves the job to ABANDON', async () => {
    const b = build('CONFIG_EDIT', { fetch: async () => { throw new ServerError(409, 'stale lease', null); } });
    await b.run.start('prepare');
    expect(stateNames(b)).toEqual([]);
    expect(b.journal.getJob('j1', 1)?.doneAt).toBeNull();
    expect(b.ex.calls).not.toContain('prepareConfigJob:j1');
  });
  test('a fetch that keeps failing is ASSIGNED -> FAILED', async () => {
    const b = build('CONFIG_EDIT', { fetch: async () => { throw new NetworkError('down'); } });
    await b.run.start('prepare');
    expect(states(b)).toEqual([{ to: 'FAILED', reason: 'config edit fetch failed' }]);
    expect(b.journal.getJob('j1', 1)?.doneAt).not.toBeNull();
  });
  test('an invalid payload is ASSIGNED -> FAILED', async () => {
    const b = build('CONFIG_EDIT', { fetch: async () => ({ ...EDIT, edits: [{ path: '.nax/profiles/x.env', op: 'put', content: 'K=1', baseSha: null }] }) });
    await b.run.start('prepare');
    expect(states(b)).toEqual([{ to: 'FAILED', reason: 'invalid config edit payload' }]);
  });
  test('a failed prepare is ASSIGNED -> FAILED with its reason', async () => {
    const b = build();
    b.ex.configPrepare = { ok: false, reason: 'checkout: default branch not found' };
    await b.run.start('prepare');
    expect(states(b)).toEqual([{ to: 'FAILED', reason: 'checkout: default branch not found' }]);
    expect(b.ex.calls).not.toContain('runConfigJob:j1');
  });
  test('a cancel recorded before the start ends CANCELLED without fetching', async () => {
    const b = build();
    b.journal.updateJob('j1', 1, { cancelRequestedAt: '2026-10-01T00:00:00.000Z' });
    await b.run.start('prepare');
    expect(states(b)).toEqual([{ to: 'CANCELLED', reason: 'cancelled before start' }]);
    expect(b.fetched).toEqual([]);
  });
});

describe('config job cancel and halt', () => {
  test('a cancel while RUNNING signals the journaled group and ends RUNNING -> CANCELLED', async () => {
    const b = build();
    b.ex.onConfigRun = async (ctx) => {
      ctx.onProcess({ pid: 777, pgid: 777 });
      b.run.requestCancel();
      expect(ctx.isStopped()).toBe(true);
    };
    b.ex.configRun = { kind: 'stopped' };
    await b.run.start('prepare');
    expect(b.ex.killed).toEqual([{ pgid: 777, signal: 'SIGTERM' }]);
    expect(stateNames(b)).toEqual(['RUNNING', 'CANCELLED']);
  });
  test('a result that arrives after a late cancel is still reported (D489)', async () => {
    const b = build();
    b.ex.onConfigRun = async () => { b.run.requestCancel(); };
    await b.run.start('prepare');
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', 'COMPLETED']);
  });
  test('a halt during the run reports nothing more', async () => {
    const b = build();
    b.ex.onConfigRun = async () => { b.run.halt(); };
    b.ex.configRun = { kind: 'stopped' };
    await b.run.start('prepare');
    expect(stateNames(b)).toEqual(['RUNNING']);
  });
  test('a config job is never resumed from watch: it fails safe', async () => {
    const b = build();
    b.journal.updateJob('j1', 1, { state: 'RUNNING' });
    await b.run.start('watch');
    expect(states(b).at(-1)).toEqual({ to: 'FAILED', reason: 'runner error: a config job cannot be resumed' });
  });
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `cd apps/runner && bun test src/supervisor/job-run-config.spec.ts`
Expected: FAIL — type errors on `configEdits` / `configJobTimeoutMs`, then (once those exist) the happy path calls `prepare:j1` and `spawn:j1`.

- [ ] **Step 7: Implement the routing**

In `apps/runner/src/supervisor/job-run.ts`:

1. Imports (add):

```ts
import { CONFIG_COMPLETED_OUTCOMES, isConfigKind, type ConfigJobKind } from '@nathapp/fleet-protocol';
import { fitConfigResult } from '../executor/config-job/result-fit';
import type { ConfigJobRun } from '../executor/job-executor';
import { fetchConfigEdit, type ConfigEditSource } from './config-edit-fetch';
import { CONFIG_HEARTBEAT_MS, startHeartbeat } from './heartbeat';
```

(merge the `SnapshotEventPayload, StateEventPayload` type import into the same `@nathapp/fleet-protocol` import line).

2. `JobRunTuning` gains:

```ts
  /** S3 §5 lifecycle, D483: a config job's hard timeout. */
  readonly configJobTimeoutMs?: number;
  /** S3 §3, D483: how often a RUNNING config job stamps `heartbeatAt`. */
  readonly configHeartbeatMs?: number;
```

and `JobRunDeps` gains:

```ts
  /** S3 §3: the fenced edit-set fetch (daemon.ts over ServerClient.getConfigEdit). Absent: config jobs fail at once. */
  readonly configEdits?: ConfigEditSource;
```

and below `TICK_WARN_EVERY` add `export const CONFIG_JOB_TIMEOUT_MS = 600_000;`.

3. `lifecycle` starts with the config branch:

```ts
  private async lifecycle(from: RunStart): Promise<void> {
    const { command } = this.mustRow();
    if (isConfigKind(command)) {
      await this.runConfig(from, command);
      return;
    }
    if ((from === 'prepare' || from === 'reprepare') && !(await this.prepareAndSpawn(from === 'reprepare'))) return;
    // ... unchanged
  }
```

4. Add after `prepareAndSpawn` / `endBeforeSpawn`:

```ts
  /** S3 §3, §5, D481: the edit fetch and the checkout happen while ASSIGNED; nothing here spawns nax or uploads a bundle. */
  private async runConfig(from: RunStart, command: ConfigJobKind): Promise<void> {
    if (from === 'watch' || from === 'finish') {
      await this.failSafe(new Error('a config job cannot be resumed'));   // D485: READOPT rejects these before a run exists
      return;
    }
    if (this.cancelRequested()) {
      await this.endBeforeSpawn('CANCELLED', 'cancelled before start');
      return;
    }
    const fetched = await fetchConfigEdit({
      source: this.deps.configEdits, jobId: this.jobId, leaseEpoch: this.leaseEpoch, command, sleep: this.deps.sleep, isHalted: () => this.halted, log: this.deps.log,
    });
    if (this.halted) return;
    if (fetched.kind === 'stale') {
      this.deps.log.warn('config edit fetch fenced (stale lease); waiting for ABANDON', { jobId: this.jobId, leaseEpoch: this.leaseEpoch });
      return;
    }
    if (fetched.kind === 'failed') {
      await this.endBeforeSpawn('FAILED', fetched.reason);
      return;
    }
    const stopped = (): boolean => this.cancelRequested() || this.halted;
    const prepared = await this.deps.executor.prepareConfigJob(this.mustRow(), { isCancelled: stopped });
    if (this.halted) return;
    if (!prepared.ok) {
      await (prepared.cancelled ? this.endBeforeSpawn('CANCELLED', 'cancelled before start') : this.endBeforeSpawn('FAILED', prepared.reason));
      return;
    }
    if (this.cancelRequested()) {
      await this.endBeforeSpawn('CANCELLED', 'cancelled before start');
      return;
    }
    this.events.transition('RUNNING', undefined, { pid: null, pgid: null, branch: null });
    this.registerLogs();
    // Read the clock before the heartbeat starts: a test clock moves on every sleep.
    const deadlineMs = this.deps.now().getTime() + (this.deps.tuning.configJobTimeoutMs ?? CONFIG_JOB_TIMEOUT_MS);
    const stopHeartbeat = startHeartbeat({
      everyMs: this.deps.tuning.configHeartbeatMs ?? CONFIG_HEARTBEAT_MS, sleep: this.deps.sleep, now: this.deps.now,
      emit: (heartbeatAt) => { if (!this.halted) this.events.snapshot({ heartbeatAt }); },
    });
    let run: ConfigJobRun;
    try {
      run = await this.deps.executor.runConfigJob(this.mustRow(), {
        payload: fetched.payload,
        deadlineMs,
        isStopped: stopped,
        onProcess: (proc) => { this.deps.journal.updateJob(this.jobId, this.leaseEpoch, { pid: proc?.pid ?? null, pgid: proc?.pgid ?? null }); },
        step: (message) => { this.events.lifecycle('info', message); },
      });
    } finally {
      stopHeartbeat();
    }
    if (this.halted) return;
    await this.finishConfig(run);
  }

  /** S3 §3, D471, D476, D488, D489: result snapshot, then UPLOADING with no bundle, then the terminal state. */
  private async finishConfig(run: ConfigJobRun): Promise<void> {
    await this.awaitLogs(this.deps.logs.drain(this.jobId, this.leaseEpoch, this.deps.tuning.logDrainTimeoutMs));
    if (this.halted) return;
    if (run.kind === 'stopped') {
      this.events.transition('CANCELLED', 'cancelled');
      await this.cleanup();
      return;
    }
    if (run.kind === 'failed') {
      this.events.transition('UPLOADING');
      this.events.transition('FAILED', run.reason);
      await this.cleanup();
      return;
    }
    const result = fitConfigResult(run.result);
    this.events.snapshot({
      configResult: result,
      ...(run.resultBranch ? { resultBranch: run.resultBranch } : {}),
      ...(run.resultSha ? { resultSha: run.resultSha } : {}),
      ...(run.resultPrUrl ? { resultPrUrl: run.resultPrUrl } : {}),
    });
    this.events.transition('UPLOADING');
    this.events.transition(CONFIG_COMPLETED_OUTCOMES.includes(result.outcome) ? 'COMPLETED' : 'FAILED', result.outcome);
    await this.cleanup();
  }
```

`requestCancel` already SIGTERMs `row.pgid` while RUNNING (the subprocess `onProcess` journaled), and `failSafe` already goes RUNNING -> UPLOADING -> FAILED and uses `killIfOurs` (config-aware since B2-8), so neither changes.

- [ ] **Step 8: Run them to verify they pass**

Run: `cd apps/runner && bun test src/supervisor`
Expected: PASS (the existing `job-run.spec.ts` RUN / PLAN suites included).

- [ ] **Step 9: Commit**

```bash
git add apps/runner/src/supervisor/heartbeat.ts apps/runner/src/supervisor/heartbeat.spec.ts apps/runner/src/supervisor/job-run.ts apps/runner/src/supervisor/job-run-config.spec.ts
git commit -m "feat(runner): JobRun runs config jobs without nax or a bundle (S3 §3, D476, D481, D488, D489)"
```

---

### Task B2-10: READOPT rejects interrupted config jobs; daemon wiring

**Files:**
- Modify: `apps/runner/src/supervisor/supervisor.ts:100-104`
- Modify: `apps/runner/src/daemon/tuning.ts`, `apps/runner/src/daemon/tuning.spec.ts`
- Modify: `apps/runner/src/daemon/daemon.ts:149-155`
- Test: `apps/runner/src/supervisor/supervisor.spec.ts`

**Interfaces:**
- Consumes: `isConfigKind` (Part B1); `ServerClient.getConfigEdit` (B2-3); `JobRunDeps.configEdits`, `JobRunTuning.configJobTimeoutMs/configHeartbeatMs` (B2-9).
- Produces: `Tuning.configJobTimeoutMs = 600_000`, `Tuning.configHeartbeatMs = 30_000`; a production daemon whose supervisor can run config jobs; READOPT of a RUNNING / UPLOADING config job answers `rejected` with `config job interrupted by a runner restart` (server: CRASHED, `readopt rejected: ...`).

- [ ] **Step 1: Write the failing supervisor tests**

In `apps/runner/src/supervisor/supervisor.spec.ts`, add to `build()`'s `new Supervisor({...})` deps:

```ts
    configEdits: { fetch: async () => ({ mode: 'drift', edits: [], prTitle: null, prBody: null, baseSha: 'a'.repeat(40) }) },
```

change `add`'s `command` parameter type to `FleetJobKindName` (import it from `@nathapp/fleet-protocol`), and append:

```ts
describe('readopt: config jobs (D485)', () => {
  test('a RUNNING config job is rejected and its live subprocess group killed; the server marks it CRASHED', async () => {
    const b = build();
    b.add({}, 1, 'CONFIG_DRIFT');
    b.journal.updateJob('j1', 1, { state: 'RUNNING', pid: 4242, pgid: 4242 });
    b.ex.alive = true;
    expect(await b.supervisor.readopt('j1', 1)).toEqual({ result: 'rejected', detail: 'config job interrupted by a runner restart' });
    expect(b.ex.killed).toEqual([{ pgid: 4242, signal: 'SIGKILL' }]);
    expect(b.ex.calls).toContain('cleanup:j1');
    expect(b.journal.getJob('j1', 1)?.doneAt).not.toBeNull();
  });
  test('a RUNNING config job between subprocesses (no pid) is rejected without a signal', async () => {
    const b = build();
    b.add({}, 1, 'CONFIG_EDIT');
    b.journal.updateJob('j1', 1, { state: 'UPLOADING' });
    expect(await b.supervisor.readopt('j1', 1)).toEqual({ result: 'rejected', detail: 'config job interrupted by a runner restart' });
    expect(b.ex.killed).toEqual([]);
  });
  test('an ASSIGNED config job re-prepares from the start and completes', async () => {
    const b = build();
    b.add({}, 1, 'CONFIG_DRIFT');
    expect(await b.supervisor.readopt('j1', 1)).toEqual({ result: 'ok' });
    await b.supervisor.idle();
    expect(b.ex.calls).toContain('prepareConfigJob:j1');
    expect(stateNames(b).at(-1)).toBe('COMPLETED');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/runner && bun test src/supervisor/supervisor.spec.ts`
Expected: FAIL — the RUNNING case answers `run id mismatch` (it fell through to the RUN path).

- [ ] **Step 3: Implement the READOPT branch**

In `apps/runner/src/supervisor/supervisor.ts` add `import { isConfigKind } from '@nathapp/fleet-protocol';` and, directly after the `if (row.state === 'ASSIGNED' && row.pid === null) { ... }` block (line 103):

```ts
    // D485: a config job's work happens inside this daemon's process (no detached nax to watch), so a restart ends it;
    // the server marks it CRASHED and a requeue starts it over on a fresh lease.
    if (isConfigKind(row.command)) return this.reject(row, 'config job interrupted by a runner restart');
```

(`reject` already runs `killIfOurs` — config-aware since B2-8 — then reap, cleanup and markDone.)

- [ ] **Step 4: Run them to verify they pass**

Run: `cd apps/runner && bun test src/supervisor/supervisor.spec.ts`
Expected: PASS.

- [ ] **Step 5: Add the tuning constants (test first)**

In `apps/runner/src/daemon/tuning.spec.ts`, extend the expected object's last line to:

```ts
      logChunkBytes: 1_048_576, logMaxInFlight: 2, logPutTimeoutMs: 30_000, logBackoffMaxMs: 30_000, logDrainTimeoutMs: 120_000,
      configJobTimeoutMs: 600_000, configHeartbeatMs: 30_000,
```

Run: `cd apps/runner && bun test src/daemon/tuning.spec.ts` — Expected: FAIL (keys missing).

In `apps/runner/src/daemon/tuning.ts` add to `Tuning`:

```ts
  /** S3 §5 lifecycle, D483: a config job's hard timeout. */
  readonly configJobTimeoutMs: number;
  /** S3 §3, D483: the RUNNING config job's heartbeat snapshot interval. */
  readonly configHeartbeatMs: number;
```

and to `TUNING`: `configJobTimeoutMs: 600_000,` and `configHeartbeatMs: 30_000,`.

Run: `cd apps/runner && bun test src/daemon/tuning.spec.ts` — Expected: PASS.

- [ ] **Step 6: Wire the daemon**

In `apps/runner/src/daemon/daemon.ts`, the `new Supervisor({...})` call (lines 149-155) becomes:

```ts
  const supervisor = new Supervisor({
    journal, executor, mutex: new RepoMutex(), uploader, log, now, sleep,
    tuning: {
      statusPollMs: tuning.statusPollMs, killGraceMs: tuning.killGraceMs, ackPollMs: tuning.ackPollMs, uploadAckWaitMs: tuning.uploadAckWaitMs, logDrainTimeoutMs: tuning.logDrainTimeoutMs,
      configJobTimeoutMs: tuning.configJobTimeoutMs, configHeartbeatMs: tuning.configHeartbeatMs,
    },
    readoptHeartbeatMs: tuning.readoptHeartbeatMs,
    logs: shipper,
    configEdits: { fetch: (jobId, leaseEpoch) => client.getConfigEdit(jobId, leaseEpoch) },   // S3 §3
  });
```

- [ ] **Step 7: Run the runner unit suite and the type check**

Run: `cd apps/runner && bun run test && bun run type-check && bun run lint`
Expected: PASS, no lint warnings.

- [ ] **Step 8: Commit**

```bash
git add apps/runner/src/supervisor/supervisor.ts apps/runner/src/supervisor/supervisor.spec.ts apps/runner/src/daemon/tuning.ts apps/runner/src/daemon/tuning.spec.ts apps/runner/src/daemon/daemon.ts
git commit -m "feat(runner): wire config jobs into the daemon; READOPT rejects interrupted ones (D483, D485)"
```

---
### Task B2-11: config jobs end to end against the real API

**Files:**
- Modify: `apps/runner/test/integration/harness/world.ts` (seed files ~line 150, `World` interface, two helpers)
- Create: `apps/runner/test/integration/config-jobs.integration.spec.ts`

**Interfaces:**
- Consumes: Part B1's `POST /projects/:slug/fleet/repos/:repoId/config-edits` (body `{ baseSha, edits, prTitle, prBody? }` -> 201 `DispatchResultDto`), the `FleetConfigEdit` model, `FleetJob.configResult`, the fenced runner route; everything from B2-1..B2-10; the fake nax / fake gh fixtures (B2-6, B2-7).
- Produces: `World.repoId: string`; `World.submitConfigEdit(input: { baseSha: string; edits: ConfigFileEdit[]; prTitle: string; prBody?: string }): Promise<string>`; `World.queueConfigJob(input: { command: 'CONFIG_EDIT' | 'CONFIG_DRIFT'; mode: 'regenerate' | 'drift'; prTitle?: string }): Promise<string>`; `World.configEdit(jobId: string): Promise<{ mode: string; result: unknown }>`.

- [ ] **Step 1: Extend the harness**

In `apps/runner/test/integration/harness/world.ts`:

1. Seed: after `const files: Record<string, string> = { ... };` add

```ts
  files['.nax/context.md'] = '# app context\n';   // S3: config jobs regenerate from it
  files['.nax/rules/a.md'] = '# rule a\n';
```

2. `World` interface gains:

```ts
  readonly repoId: string;
  /** S3: a CONFIG_EDIT through the user route (Part B1). Returns the job id. */
  submitConfigEdit(input: { baseSha: string; edits: ConfigFileEdit[]; prTitle: string; prBody?: string }): Promise<string>;
  /** S3: a regenerate or drift job written straight to the database (placement picks it up on the next sync). */
  queueConfigJob(input: { command: 'CONFIG_EDIT' | 'CONFIG_DRIFT'; mode: 'regenerate' | 'drift'; prTitle?: string }): Promise<string>;
  configEdit(jobId: string): Promise<{ mode: string; result: unknown }>;
```

with `import type { ConfigFileEdit } from '@nathapp/fleet-protocol';` and `git as sh` added to the `git-fixture` import if not already imported.

3. In the `world` object add `repoId,` beside `adminToken: admin,` and these methods:

```ts
    async submitConfigEdit(input) {
      const res = await http('POST', `/projects/web/fleet/repos/${repoId}/config-edits`, { token: admin, body: input });
      if (res.status !== 201) throw new Error(`config edit failed: ${JSON.stringify(res.body)}`);
      return res.body.data.job.id as string;   // Part B1 answers with DispatchResultDto, like dispatch
    },
    async queueConfigJob(input) {
      const [user, project] = await Promise.all([
        prisma.user.findUniqueOrThrow({ where: { email: HARNESS_ADMIN.email } }),
        prisma.project.findUniqueOrThrow({ where: { slug: 'web' } }),
      ]);
      const baseSha = await sh(origin.dir, 'rev-parse', 'main');
      // One transaction: placement must never see the job without its edit row.
      return prisma.$transaction(async (tx) => {
        const job = await tx.fleetJob.create({ data: {
          projectId: project.id, repoId, ref: 'main', command: input.command, feature: 'nax-config', profiles: [], maxCostUsd: 0,
          bashMode: 'raw', selectorLabels: [], requestedById: user.id,
        } });
        await tx.fleetConfigEdit.create({ data: { jobId: job.id, mode: input.mode, edits: [], prTitle: input.prTitle ?? null, prBody: null, baseSha } });
        return job.id;
      });
    },
    async configEdit(jobId) {
      const row = await prisma.fleetConfigEdit.findUniqueOrThrow({ where: { jobId } });
      return { mode: row.mode, result: row.result };
    },
```

(Part B1's `config-edits` route answers 201 with a `DispatchResultDto`, so the id is `data.job.id`. Regenerate and drift jobs go straight to the database because their routes read the default-branch head through the forge API, which the harness forge does not serve.)

- [ ] **Step 2: Write the integration spec**

Create `apps/runner/test/integration/config-jobs.integration.spec.ts`:

```ts
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { git as sh, pushCommit } from '../helpers/git-fixture';
import { createWorld, type EventView, type TestRunner, type World } from './harness';

setDefaultTimeout(120_000);
const enabled = process.env['KODA_DB_TESTS'] === '1';
const runnerStates = (events: EventView[]) => events.filter((e) => e.type === 'state').map((e) => (e.payload as { to: string }).to);
const terminal = (state: string) => ['COMPLETED', 'FAILED', 'CANCELLED', 'CRASHED'].includes(state);
const onOrigin = (world: World, branch: string) => sh(world.origin.dir, 'rev-parse', '--verify', branch).then(() => true, () => false);

describe.skipIf(!enabled)('S3 config jobs against the real API', () => {
  let world: World;
  let runner: TestRunner;
  beforeAll(async () => {
    world = await createWorld();
    runner = await world.addRunner('config');
    await runner.start();
  }, 180_000);
  afterAll(async () => { await world?.close(); });

  test('edit: PR branch with the edit and the regenerated agent files; result stored; no bundle', async () => {
    const baseSha = await sh(world.origin.dir, 'rev-parse', 'main');
    const blob = await sh(world.origin.dir, 'rev-parse', 'main:.nax/rules/a.md');
    const id = await world.submitConfigEdit({
      baseSha, prTitle: 'Tighten rule a', prBody: 'Because',
      edits: [{ path: '.nax/rules/a.md', op: 'put', content: '# rule a, tightened\n', baseSha: blob }, { path: '.nax/rules/b.md', op: 'put', content: '# rule b\n', baseSha: null }],
    });
    const job = await world.waitForJob(id, (j) => terminal(j.state));
    expect(job).toMatchObject({ state: 'COMPLETED', resultBranch: `nax-config/${id}`, resultPrUrl: 'https://example.test/koda/pull/7' });
    expect(job.resultSha).toBe(await sh(world.origin.dir, 'rev-parse', `nax-config/${id}`));
    expect(await sh(world.origin.dir, 'show', `nax-config/${id}:.nax/rules/b.md`)).toBe('# rule b');
    expect(await sh(world.origin.dir, 'show', `nax-config/${id}:CLAUDE.md`)).toContain('# app context');
    expect(await world.configEdit(id)).toEqual({ mode: 'edit', result: { outcome: 'ok', files: ['.nax/rules/a.md', '.nax/rules/b.md', 'AGENTS.md', 'CLAUDE.md'] } });
    const events = await world.events(id);
    expect(runnerStates(events)).toEqual(expect.arrayContaining(['ASSIGNED', 'RUNNING', 'UPLOADING', 'COMPLETED']));
    expect((await world.downloadBundle(id)).status).toBe(404);
  });

  test('conflict: an edited file changed upstream fails the job and pushes nothing', async () => {
    const baseSha = await sh(world.origin.dir, 'rev-parse', 'main');
    const blob = await sh(world.origin.dir, 'rev-parse', 'main:.nax/rules/a.md');
    await pushCommit(world.base, world.origin.url, 'main', '.nax/rules/a.md', '# rule a, changed by a teammate\n');
    const id = await world.submitConfigEdit({ baseSha, prTitle: 'Mine', edits: [{ path: '.nax/rules/a.md', op: 'put', content: '# mine\n', baseSha: blob }] });
    const job = await world.waitForJob(id, (j) => terminal(j.state));
    expect(job).toMatchObject({ state: 'FAILED', stateReason: 'conflict' });
    expect(await world.configEdit(id)).toMatchObject({ result: { outcome: 'conflict', files: ['.nax/rules/a.md'] } });
    expect(await onOrigin(world, `nax-config/${id}`)).toBe(false);
  });

  test('invalid: a rule nax lint rejects opens no PR', async () => {
    const id = await world.submitConfigEdit({
      baseSha: await sh(world.origin.dir, 'rev-parse', 'main'), prTitle: 'Bad rule',
      edits: [{ path: '.nax/rules/bad.md', op: 'put', content: 'FAKE_LINT_FAIL\n', baseSha: null }],
    });
    const job = await world.waitForJob(id, (j) => terminal(j.state));
    expect(job).toMatchObject({ state: 'FAILED', stateReason: 'invalid', resultPrUrl: null });
    const stored = await world.configEdit(id);
    expect((stored.result as { output: string }).output).toContain('banned marker FAKE_LINT_FAIL');
    expect(await onOrigin(world, `nax-config/${id}`)).toBe(false);
  });

  test('drift: lists the stale generated files and pushes nothing', async () => {
    const id = await world.queueConfigJob({ command: 'CONFIG_DRIFT', mode: 'drift' });
    const job = await world.waitForJob(id, (j) => terminal(j.state));
    expect(job.state).toBe('COMPLETED');
    expect(await world.configEdit(id)).toMatchObject({ result: { outcome: 'drift', files: expect.arrayContaining(['AGENTS.md', 'CLAUDE.md']) } });
    expect(await onOrigin(world, `nax-config/${id}`)).toBe(false);
  });

  test('regenerate: a failed create falls back to the PR that already exists', async () => {
    await world.withFake({ FAKE_GH_CREATE_EXIT: '1', FAKE_GH_EXISTING_PR_URL: 'https://example.test/koda/pull/42' }, async () => {
      const id = await world.queueConfigJob({ command: 'CONFIG_EDIT', mode: 'regenerate', prTitle: 'Regenerate agent files' });
      const job = await world.waitForJob(id, (j) => terminal(j.state));
      expect(job).toMatchObject({ state: 'COMPLETED', resultPrUrl: 'https://example.test/koda/pull/42', resultBranch: `nax-config/${id}` });
    });
  });

  test('cancel while nax runs ends CANCELLED long before the slow call would finish', async () => {
    await world.withFake({ FAKE_NAX_GENERATE_SLEEP_MS: '30000' }, async () => {
      const id = await world.queueConfigJob({ command: 'CONFIG_DRIFT', mode: 'drift' });
      await world.waitForJob(id, (j) => j.state === 'RUNNING');
      await Bun.sleep(1_000);
      const started = Date.now();
      await world.cancel(id);
      const job = await world.waitForJob(id, (j) => terminal(j.state), 20_000);
      expect(job.state).toBe('CANCELLED');
      expect(Date.now() - started).toBeLessThan(15_000);
    });
  });

  test('a runner restart mid-job: READOPT rejects it and the server marks it CRASHED (D485)', async () => {
    await world.withFake({ FAKE_NAX_GENERATE_SLEEP_MS: '30000' }, async () => {
      const id = await world.queueConfigJob({ command: 'CONFIG_DRIFT', mode: 'drift' });
      await world.waitForJob(id, (j) => j.state === 'RUNNING');
      await Bun.sleep(1_000);
      runner.crash();
      await runner.start();
      const job = await world.waitForJob(id, (j) => terminal(j.state), 30_000);
      expect(job).toMatchObject({ state: 'CRASHED', stateReason: 'readopt rejected: config job interrupted by a runner restart' });
    });
  });
});
```

- [ ] **Step 3: Build the API and bring up the test database**

Run: `cd apps/api && bun run test:db:up && bun run build`
Expected: the compose test Postgres is healthy on 5433 and `apps/api/dist` is rebuilt with Part B1's routes (the harness runs the built API).

- [ ] **Step 4: Run the integration spec**

Run: `cd apps/runner && KODA_DB_TESTS=1 bun test test/integration/config-jobs.integration.spec.ts`
Expected: PASS, 7 tests. If the restart test reports `stale heartbeat` / `run id mismatch` instead, the READOPT branch of B2-10 is not reached: check it sits right after the ASSIGNED re-prepare branch.

- [ ] **Step 5: Run the whole runner integration suite (the seed files changed)**

Run: `cd apps/runner && KODA_DB_TESTS=1 bun run test:integration`
Expected: PASS (the new `.nax/context.md` and `.nax/rules/a.md` in the seed must not change any RUN / PLAN assertion).

- [ ] **Step 6: Commit**

```bash
git add apps/runner/test/integration
git commit -m "test(runner): config jobs end to end against the real API (S3 §8)"
```

---

### Task B2-12: runner context, spec decisions, PR 2 gates and PR

**Files:**
- Modify: `.nax/mono/apps/runner/context.md` (rule lines 50-51)
- Regenerate: `apps/runner/AGENTS.md`, `apps/runner/CLAUDE.md`, `apps/runner/GEMINI.md`, `apps/runner/codex.md`
- Modify: `docs/superpowers/specs/2026-10-07-fleet-s3-repo-config-and-credential-board-design.md` (Decisions table)

**Interfaces:**
- Consumes: all of Part B1 and B2.
- Produces: PR 2 open against `main`.

- [ ] **Step 1: Update the runner context (never the generated files by hand)**

In `.nax/mono/apps/runner/context.md`, replace the rule line that starts `- Emit only the S1 spec 5.4 runner transitions` with:

```md
- Emit only the S1 spec 5.4 runner transitions (`JobEvents.transition` refuses the rest). A spawned job always goes RUNNING -> UPLOADING -> terminal; a job that never spawned goes ASSIGNED -> FAILED or CANCELLED. A config job (S3: `CONFIG_EDIT`, `CONFIG_DRIFT`) spawns no nax run: it fetches its edit set and checks out while ASSIGNED, then RUNNING -> UPLOADING (no bundle) -> COMPLETED | FAILED with `reason = outcome`, or RUNNING -> CANCELLED.
- Config jobs (`src/executor/config-job/`) re-check every path against the shared `.nax/` allowlist (never a `.env` profile) and never follow a symlink; each nax / gh / glab call is detached and its pid and pgid are journaled while it runs. READOPT rejects a config job that was RUNNING (the server marks it CRASHED).
```

and in the directory map (the `src/...` block near line 23-40) add the line:

```text
src/executor/config-job/  S3 config jobs: payload re-validation, staleness, apply, nax generate / lint / config, commit, push, PR
```

- [ ] **Step 2: Regenerate the agent files**

Run: `nax generate --all-packages`
Expected: `apps/runner/{AGENTS,CLAUDE,GEMINI,codex}.md` change only by the lines above. `git diff --stat` shows no other package's agent files changing; if others change, they were already stale: restore them with `git checkout -- <file>` and mention it in the PR.

- [ ] **Step 3: (Decisions D480-D491 are already in the spec; nothing to record.)**

- [ ] **Step 4: PR 2 gates (all green before any push)**

Run, from the repo root, each one in order:

```bash
bun run type-check
bun run lint
bun run test
bun run generate && git diff --exit-code -- openapi.json apps/cli/src/generated
(cd apps/api && bun run test:db:up && bun run test:integration)
(cd apps/api && bun run build) && (cd apps/runner && KODA_DB_TESTS=1 bun run test:integration)
```

Expected: every command exits 0; the `git diff --exit-code` prints nothing (Part B1 already committed the regenerated contract). Fix any failure before going on; a flaky e2e or integration test is re-run once and named in the PR body if it flaked.

- [ ] **Step 5: Commit the docs and context**

```bash
git add .nax/mono/apps/runner/context.md apps/runner/AGENTS.md apps/runner/CLAUDE.md apps/runner/GEMINI.md apps/runner/codex.md
git commit -m "docs(runner): config-job rules in the runner context"
```

- [ ] **Step 6: Review the whole PR 2 diff before pushing**

Dispatch a fresh reviewer on `git diff main...HEAD` (superpowers:requesting-code-review), with the spec and this plan's Parts B1 and B2 as the requirements. Fix CRITICAL / IMPORTANT findings (at most two fix rounds), re-run Step 4's gates after any fix.

- [ ] **Step 7: Push and open PR 2**

```bash
git push -u origin feat/fleet-s3-2-config-jobs
gh pr create --base main --title "feat(fleet): S3 PR 2 — config jobs (contract, API, runner)" --body "$(cat <<'BODY'
## Summary
- Protocol: CONFIG_EDIT / CONFIG_DRIFT kinds, shared `.nax/` allowlist, `configResult` on the snapshot, `configJobs` capability (Part B1).
- API: repo `.nax/` file reads through the fleet broker tokens, config-edit / regenerate / drift-check routes, fenced runner fetch, placement for config kinds, result mirroring (Part B1).
- Runner: config jobs without nax runs or bundles — fetch while ASSIGNED, per-file staleness, apply with allowlist re-check and symlink refusal, `nax generate` (+ `--all-packages`), `nax rules lint` / `config --json` validation, force-push to `nax-config/<jobId>`, gh / glab PR with existing-PR fallback, 10-minute timeout, journaled process groups for cancel, 30 s heartbeat, READOPT -> CRASHED (D480-D491).

## Test plan
- [x] `bun run type-check`, `bun run lint`, `bun run test`
- [x] `bun run generate` leaves no diff
- [x] API integration suite
- [x] Runner integration suite incl. `config-jobs.integration.spec.ts` (edit, conflict, invalid, drift, existing PR, cancel, restart)
- [ ] Web (PR 3) and the koda-wk live check (spec §8) follow in PR 3

Spec: docs/superpowers/specs/2026-10-07-fleet-s3-repo-config-and-credential-board-design.md
BODY
)"
```

Expected: the PR URL. Then watch CI (`gh pr checks --watch`) and report the result; do not merge without the user's go-ahead.
## Part C — PR 3: Web, CLI and live check

Branch `feat/fleet-s3-3-config-web`, cut from `main` after PR 2 (Parts B1 + B2) merges. Implements spec §6 (web), §7
(CLI), the web/E2E half of §8, and the §8 live check. PRs 1 and 2 are assumed merged: the API serves every endpoint of
spec §4 with the shapes of the contract (`00-contract.md`), the runner executes both config kinds, and placement knows
`config_jobs`.

Conventions every task follows (verified on main `a61c11aa`):

- Web unit tests are Jest in node (`apps/web/package.json` `jest` block): pure `lib/*.ts` tests under
  `apps/web/tests/lib/`, composable tests under `apps/web/tests/composables/` (they set `globalThis.useApi` and
  `import()` the file, see `tests/composables/useFleetJobs.spec.ts`), component tests mount the real SFC with
  `mountSfc` (`tests/helpers/mount-sfc.ts`) plus `uiStubs` / `enI18n` (`tests/helpers/fleet-harness.ts`), page tests
  mix `mountSfc` and source assertions (`tests/pages/fleet-job-detail.spec.ts`).
- `mountSfc` resolves `~/...` imports itself but loads bare specifiers with node's `require`, which cannot load
  TypeScript. Every mount of a file that (transitively) imports `@nathapp/fleet-protocol` therefore passes
  `alias: { '@nathapp/fleet-protocol': protocol }` where `protocol` is the module Jest loaded
  (`import * as protocol from '@nathapp/fleet-protocol'` at the top of the spec; Jest's ts-jest transform compiles the
  workspace package because its real path is outside `node_modules`).
- Locale parity is enforced (`tests/i18n/locale-parity.spec.ts`, `fleet-locale-parity.spec.ts`,
  `used-keys-exist.spec.ts`): every new key goes into both `apps/web/i18n/locales/en.json` and `zh.json` in the same
  task that first uses it.
- Web gates: `cd apps/web && bun run test`, `bun run lint`, `bun run type-check`. CLI gates: `cd apps/cli && bun run
  test`, `bun run lint`, `bun run type-check`.
- Components are imported explicitly by path (as `pages/[project]/fleet/jobs/[id]/index.vue` does), never relied on
  through Nuxt auto-import names, so tests and pages agree on the module.

### File structure

| File | Status | Responsibility |
|---|---|---|
| `apps/web/package.json` | modify | add `"@nathapp/fleet-protocol": "workspace:*"` (D467: the web enforces the shared allowlist) |
| `apps/web/lib/fleet-types.ts` | modify | `FleetJobKind`, widen `FleetJobDto.command`, `FleetJobDto.configEdit`, `MisfitReason` gains `config_jobs` |
| `apps/web/lib/fleet-jobs.ts` | modify | `isConfigJob(job)`, `jobCommandLabelKey(command)` |
| `apps/web/lib/nax-config.ts` | create | wire types for the config endpoints; immutable draft model; tree grouping; new-file targets; JSON and limit checks; `reapplyEdits` |
| `apps/web/lib/nax-config-diff.ts` | create | `lineDiff(before, after)` (no new dependency: none of the web deps ships a diff) |
| `apps/web/composables/useFleetRepoConfig.ts` | create | every HTTP call of the config page and the job panel |
| `apps/web/components/fleet/config/NaxFileTree.vue` | create | grouped file list with status markers |
| `apps/web/components/fleet/config/NaxFileEditor.vue` | create | `MarkdownEditor` for `.md`, guarded textarea for `.json`, read-only view |
| `apps/web/components/fleet/config/NaxChangesPanel.vue` | create | per-file diff, discard, conflict resolve |
| `apps/web/components/fleet/config/ConfigPrDialog.vue` | create | PR title/description dialog (edit and regenerate) |
| `apps/web/components/fleet/config/NewNaxFileDialog.vue` | create | new-file path picker limited to allowed locations |
| `apps/web/components/fleet/config/RepoConfigList.vue` | create | Repos card on the project fleet page |
| `apps/web/components/fleet/config/ConfigJobPanel.vue` | create | config job outcome panel on the job page |
| `apps/web/pages/[project]/fleet/repos/[id]/config.vue` | create | the config page |
| `apps/web/pages/[project]/fleet/index.vue` | modify | Repos card; command and feature labels for config jobs |
| `apps/web/pages/[project]/fleet/jobs/[id]/index.vue` | modify | config panel replaces nax-only sections for config jobs |
| `apps/web/i18n/locales/en.json`, `zh.json` | modify | `fleet.command.*`, `fleet.misfit.config_jobs`, `fleet.config.*` |
| `apps/api/src/fleet/repo-config/fake-fleet-repo-files.reader.ts` | create | test-only in-memory reader (E2E has no forge) |
| `apps/api/src/fleet/schedules/fleet-test-hooks.controller.ts` | modify | `PUT fleet/test-hooks/repos/:repoId/nax-files` seeds the fake reader |
| `apps/api/src/config/fleet.config.ts`, `env.validation.ts` | modify | `FLEET_TEST_FAKE_NAX_FILES` (`testFakeNaxFiles`) |
| `apps/web/playwright.config.ts` | modify | E2E API env `FLEET_TEST_FAKE_NAX_FILES: 'true'` |
| `apps/web/tests/e2e/fixtures/scripted-runner.ts` | modify | `configJobs: true` capability; `getConfigEdit` helper |
| `apps/web/tests/e2e/fixtures/fleet-config-api.ts` | create | E2E helper to seed the fake reader |
| `apps/web/tests/e2e/fleet-config.e2e.spec.ts` | create | spec §8 E2E for the config page and panel |
| `apps/cli/src/commands/fleet-config.ts` | create | `koda fleet nax-files`, `koda fleet drift-check` |
| `apps/cli/src/commands/fleet.ts` | modify | register them |

Tests: `apps/web/tests/lib/nax-config.spec.ts`, `tests/lib/nax-config-diff.spec.ts`, `tests/lib/fleet-jobs.spec.ts`
(extend), `tests/composables/useFleetRepoConfig.spec.ts`, `tests/components/fleet-config-*.spec.ts`,
`tests/pages/fleet-repo-config-page.spec.ts`, `tests/pages/fleet-job-detail.spec.ts` (extend),
`tests/pages/fleet-jobs-list.spec.ts` (extend), `apps/cli/src/commands/fleet-config.spec.ts`,
`apps/api/src/fleet/repo-config/fake-fleet-repo-files.reader.spec.ts`.

---

### Task C0: Cut the PR 3 branch

**Files:** none.

- [ ] **Step 1: Confirm PR 2 is merged and the API surface exists**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda
git fetch origin && git switch main && git pull --ff-only
grep -n "nax-files\|config-edits\|drift-checks" openapi.json | head
grep -n "isAllowedNaxPath\|CONFIG_JOB_KINDS" packages/fleet-protocol/src/index.ts packages/fleet-protocol/src/*.ts | head
```

Expected: the five project routes of spec §4 appear in `openapi.json`, and both protocol exports exist. If either is
missing, stop: PR 2 is not merged.

- [ ] **Step 2: Cut the branch**

```bash
git switch -c feat/fleet-s3-3-config-web
```

---

### Task C1: Web wire types, command labels and config-job helpers

**Files:**
- Modify: `apps/web/lib/fleet-types.ts:141-143` (`MisfitReason`), `:187-238` (`FleetJobDto`)
- Modify: `apps/web/lib/fleet-jobs.ts` (append after `pickActiveJob`, line 197)
- Modify: `apps/web/pages/[project]/fleet/index.vue:172-174`
- Modify: `apps/web/i18n/locales/en.json`, `zh.json` (`fleet.command`, `fleet.misfit.config_jobs`, `fleet.jobs.configFeature`)
- Test: `apps/web/tests/lib/fleet-jobs.spec.ts`, `apps/web/tests/pages/fleet-jobs-list.spec.ts`

**Interfaces:**
- Consumes: API `FleetJobDto.configEdit` (contract).
- Produces:
  - `export type FleetJobKind = 'RUN' | 'PLAN' | 'CONFIG_EDIT' | 'CONFIG_DRIFT'` (fleet-types)
  - `export type ConfigEditModeDto = 'edit' | 'regenerate' | 'drift'`
  - `export type ConfigJobOutcomeDto = 'ok' | 'no_changes' | 'drift' | 'conflict' | 'invalid' | 'push_failed' | 'pr_failed' | 'timeout'`
  - `export interface ConfigJobResultDto { outcome: ConfigJobOutcomeDto; files?: string[]; output?: string }`
  - `export interface FleetJobConfigEditDto { mode: ConfigEditModeDto; files: string[]; prTitle: string | null; result: ConfigJobResultDto | null }`
  - `FleetJobDto.command: FleetJobKind`, `FleetJobDto.configEdit?: FleetJobConfigEditDto | null`
  - `isConfigJob(job: Pick<FleetJobDto, 'command'>): boolean`, `jobCommandLabelKey(command: string): string` (fleet-jobs)

The web keeps hand-written wire types (header comment of `fleet-types.ts`), so these mirror the protocol rather than
import it; only the allowlist (runtime behaviour) is imported, in Task C2.

- [ ] **Step 1: Write the failing lib test** (append to `apps/web/tests/lib/fleet-jobs.spec.ts`)

```ts
import { isConfigJob, jobCommandLabelKey } from '~/lib/fleet-jobs'

describe('config jobs (S3 §6)', () => {
  test('isConfigJob is true only for the two config kinds', () => {
    expect(isConfigJob({ command: 'CONFIG_EDIT' })).toBe(true)
    expect(isConfigJob({ command: 'CONFIG_DRIFT' })).toBe(true)
    expect(isConfigJob({ command: 'RUN' })).toBe(false)
    expect(isConfigJob({ command: 'PLAN' })).toBe(false)
  })

  test('jobCommandLabelKey maps every kind under fleet.command', () => {
    expect(jobCommandLabelKey('CONFIG_EDIT')).toBe('fleet.command.CONFIG_EDIT')
    expect(jobCommandLabelKey('RUN')).toBe('fleet.command.RUN')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && bunx jest tests/lib/fleet-jobs.spec.ts -t "config jobs"`
Expected: FAIL, `isConfigJob is not a function`.

- [ ] **Step 3: Implement the types and helpers**

In `apps/web/lib/fleet-types.ts`, replace the `MisfitReason` union (lines 141-143) with:

```ts
export type MisfitReason =
  | 'disabled' | 'offline' | 'budget_paused' | 'labels' | 'executor' | 'protocol' | 'provider_missing'
  | 'provider_unavailable' | 'sandbox' | 'interaction' | 'tools' | 'approvals_relay' | 'busy_repo' | 'capacity'
  | 'config_jobs'

/** S3 §3: RUN | PLAN, plus the two config kinds that run no nax session. */
export type FleetJobKind = 'RUN' | 'PLAN' | 'CONFIG_EDIT' | 'CONFIG_DRIFT'

/** S3 §1: what a config job was asked to do. */
export type ConfigEditModeDto = 'edit' | 'regenerate' | 'drift'

/** S3 §3: the runner's outcome; ok, no_changes and drift are COMPLETED, the rest FAILED (D471). */
export type ConfigJobOutcomeDto = 'ok' | 'no_changes' | 'drift' | 'conflict' | 'invalid' | 'push_failed' | 'pr_failed' | 'timeout'

export interface ConfigJobResultDto {
  outcome: ConfigJobOutcomeDto
  /** Conflict files, drifted files, or committed files (at most 50). */
  files?: string[]
  /** nax output tail, at most 8 KiB. */
  output?: string
}

/** S3 §4.3: on config jobs only; the edit contents are fetched separately (Reopen edits). */
export interface FleetJobConfigEditDto {
  mode: ConfigEditModeDto
  files: string[]
  prTitle: string | null
  result: ConfigJobResultDto | null
}
```

In `FleetJobDto` (line 192) change `command: 'RUN' | 'PLAN'` to `command: FleetJobKind`, and add after the `tickets?`
field (line 237):

```ts
  /** S3 §4.3: present on config jobs (CONFIG_EDIT, CONFIG_DRIFT); absent or null otherwise. */
  configEdit?: FleetJobConfigEditDto | null
```

`TicketFleetJobDto.command` and `DispatchBody.command` stay `'RUN' | 'PLAN'` (config jobs are never linked to tickets
and never dispatched from the form).

In `apps/web/lib/fleet-jobs.ts`, after `pickActiveJob` (line 197), add:

```ts
/** S3 D465: config jobs share one fixed feature, so at most one is active per repo. */
export const CONFIG_JOB_FEATURE = 'nax-config'

const CONFIG_KINDS: readonly string[] = ['CONFIG_EDIT', 'CONFIG_DRIFT']

/** S3 §6: config jobs replace the nax sections of the job page with the config panel. */
export const isConfigJob = (job: Pick<FleetJobDto, 'command'>): boolean => CONFIG_KINDS.includes(job.command)

/** Translation key for a job kind; codeLabel falls back to the raw code for an unknown one. */
export const jobCommandLabelKey = (command: string): string => `fleet.command.${command}`
```

- [ ] **Step 4: Run the lib test to verify it passes**

Run: `cd apps/web && bunx jest tests/lib/fleet-jobs.spec.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing jobs-list test** (append to `apps/web/tests/pages/fleet-jobs-list.spec.ts`; it already
reads the page source as `page` / `source` — reuse the file's existing reader variable)

```ts
test('S3 §6: the command column shows translated kinds and config jobs show a readable feature', () => {
  const list = readFileSync(path.join(__dirname, '../..', 'pages', '[project]', 'fleet', 'index.vue'), 'utf-8')
  expect(list).toContain("codeLabel(t, te, 'fleet.command', job.command)")
  expect(list).toContain("isConfigJob(job) ? t('fleet.jobs.configFeature') : job.feature")
})
```

(Add `import { readFileSync } from 'node:fs'` and `import path from 'node:path'` at the top if the file lacks them.)

- [ ] **Step 6: Run it to verify it fails**

Run: `cd apps/web && bunx jest tests/pages/fleet-jobs-list.spec.ts -t "S3"`
Expected: FAIL (strings absent).

- [ ] **Step 7: Update the jobs list and locales**

In `apps/web/pages/[project]/fleet/index.vue` change the import on line 6 to
`import { canWorkOnFleet, formatUsd, isConfigJob } from '~/lib/fleet-jobs'`, line 172's link text to
`{{ isConfigJob(job) ? t('fleet.jobs.configFeature') : job.feature }}`, and line 174 to
`<TableCell>{{ codeLabel(t, te, 'fleet.command', job.command) }}</TableCell>`.

`en.json`: under `fleet` add

```json
"command": {
  "RUN": "Run",
  "PLAN": "Plan",
  "CONFIG_EDIT": "Config edit",
  "CONFIG_DRIFT": "Drift check"
},
```

under `fleet.misfit` add `"config_jobs": "Runner is too old for config jobs (upgrade the runner)"`, and under
`fleet.jobs` add `"configFeature": "nax config"`.

`zh.json`, same paths:

```json
"command": {
  "RUN": "运行",
  "PLAN": "规划",
  "CONFIG_EDIT": "配置修改",
  "CONFIG_DRIFT": "漂移检查"
},
```

`fleet.misfit.config_jobs`: `"Runner 版本过旧，不支持配置任务（请升级 Runner）"`; `fleet.jobs.configFeature`: `"nax 配置"`.

- [ ] **Step 8: Run the web tests and type-check**

Run: `cd apps/web && bunx jest tests/pages/fleet-jobs-list.spec.ts tests/lib/fleet-jobs.spec.ts tests/i18n && bun run type-check`
Expected: PASS; type-check clean (the widened `command` type must not break `showDispatchRun`'s `=== 'PLAN'`).

- [ ] **Step 9: Commit**

```bash
git add apps/web/lib/fleet-types.ts apps/web/lib/fleet-jobs.ts apps/web/pages/[project]/fleet/index.vue apps/web/i18n/locales/en.json apps/web/i18n/locales/zh.json apps/web/tests/lib/fleet-jobs.spec.ts apps/web/tests/pages/fleet-jobs-list.spec.ts
git commit -m "feat(web): config job kinds, labels and wire types (S3 §6)"
```

---

### Task C2: Draft model, tree grouping and limits (`lib/nax-config.ts`)

**Files:**
- Modify: `apps/web/package.json` (dependencies)
- Create: `apps/web/lib/nax-config.ts`
- Test: `apps/web/tests/lib/nax-config.spec.ts`

**Interfaces:**
- Consumes: `isAllowedNaxPath`, `naxPathGroup`, `NAX_CONFIG_LIMITS`, `type NaxPathGroup`, `type ConfigFileEdit`,
  `type ConfigEditPayload` from `@nathapp/fleet-protocol` (PR 2).
- Produces (all exported from `~/lib/nax-config`):
  - wire types `NaxFileEntry`, `NaxFileList`, `NaxFileContent` (same shapes as the API contract)
  - `type DraftStatus = 'unchanged' | 'modified' | 'new' | 'deleted'`
  - `interface DraftFile { path: string; baseSha: string | null; original: string | null; content: string | null; conflict: boolean }`
  - `interface ConfigDraft { baseSha: string; files: Readonly<Record<string, DraftFile>> }`
  - `emptyDraft(baseSha: string): ConfigDraft`
  - `editFile(draft, loaded: NaxFileContent, content: string): ConfigDraft`
  - `createFile(draft, path: string, content: string): ConfigDraft`
  - `deleteFile(draft, loaded: NaxFileContent): ConfigDraft`
  - `discardFile(draft, path: string): ConfigDraft`, `discardAll(draft): ConfigDraft`
  - `resolveConflict(draft, path: string): ConfigDraft`
  - `fileStatus(draft, path: string): DraftStatus`
  - `draftEdits(draft): ConfigFileEdit[]`
  - `jsonError(content: string): string | null`
  - `type DraftProblem = { path: string | null; code: 'json' | 'too_many' | 'file_too_large' | 'total_too_large' | 'conflict' }`
  - `draftProblems(draft): DraftProblem[]`
  - `const NAX_GROUP_ORDER: readonly NaxPathGroup[]`
  - `interface TreeGroup { group: NaxPathGroup; files: Array<{ path: string; status: DraftStatus }> }`
  - `groupFiles(entries: readonly NaxFileEntry[], draft: ConfigDraft): TreeGroup[]`

- [ ] **Step 1: Add the workspace dependency**

In `apps/web/package.json` `dependencies`, add `"@nathapp/fleet-protocol": "workspace:*"` (alphabetical, before
`@nuxtjs/color-mode`). Then:

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda && bun install
```

Expected: `bun.lock` gains the workspace link for `apps/web`; nothing else changes.

- [ ] **Step 2: Write the failing tests** (`apps/web/tests/lib/nax-config.spec.ts`)

```ts
import { describe, expect, test } from '@jest/globals'
import {
  createFile, deleteFile, discardAll, discardFile, draftEdits, draftProblems, editFile, emptyDraft, fileStatus,
  groupFiles, jsonError, resolveConflict, type NaxFileContent, type NaxFileEntry,
} from '~/lib/nax-config'

const loaded = (path: string, content: string, blobSha = `sha-${path}`): NaxFileContent => ({ path, blobSha, content })
const entry = (path: string, group: NaxFileEntry['group']): NaxFileEntry => ({ path, size: 10, blobSha: `sha-${path}`, group })

describe('draft model (S3 §6, D474)', () => {
  test('editing to new content marks modified; editing back to the original drops the entry', () => {
    const file = loaded('.nax/context.md', 'old')
    const d1 = editFile(emptyDraft('base1'), file, 'new')
    expect(fileStatus(d1, '.nax/context.md')).toBe('modified')
    expect(draftEdits(d1)).toEqual([{ path: '.nax/context.md', op: 'put', content: 'new', baseSha: 'sha-.nax/context.md' }])
    const d2 = editFile(d1, file, 'old')
    expect(fileStatus(d2, '.nax/context.md')).toBe('unchanged')
    expect(draftEdits(d2)).toEqual([])
  })

  test('the draft is never mutated', () => {
    const d0 = emptyDraft('base1')
    const d1 = editFile(d0, loaded('.nax/context.md', 'a'), 'b')
    expect(d0.files).toEqual({})
    expect(d1).not.toBe(d0)
  })

  test('a created file is new with a null baseSha; editing it keeps it new', () => {
    const d1 = createFile(emptyDraft('b'), '.nax/rules/style.md', '# Style')
    const d2 = createFile(d1, '.nax/rules/style.md', '# Style v2')
    expect(fileStatus(d2, '.nax/rules/style.md')).toBe('new')
    expect(draftEdits(d2)).toEqual([{ path: '.nax/rules/style.md', op: 'put', content: '# Style v2', baseSha: null }])
  })

  test('createFile refuses a path outside the allowlist, including .env profiles', () => {
    expect(() => createFile(emptyDraft('b'), '.nax/profiles/fast.env', 'X=1')).toThrow('not an allowed nax path')
    expect(() => createFile(emptyDraft('b'), 'README.md', 'x')).toThrow('not an allowed nax path')
  })

  test('deleting an existing file emits a delete without content; deleting a new file just forgets it', () => {
    const d1 = deleteFile(emptyDraft('b'), loaded('.nax/rules/old.md', 'x'))
    expect(fileStatus(d1, '.nax/rules/old.md')).toBe('deleted')
    expect(draftEdits(d1)).toEqual([{ path: '.nax/rules/old.md', op: 'delete', baseSha: 'sha-.nax/rules/old.md' }])
    const d2 = createFile(emptyDraft('b'), '.nax/rules/n.md', 'x')
    const d3 = deleteFile(d2, { path: '.nax/rules/n.md', blobSha: '', content: 'x' })
    expect(fileStatus(d3, '.nax/rules/n.md')).toBe('unchanged')
  })

  test('discardFile and discardAll', () => {
    const d1 = createFile(editFile(emptyDraft('b'), loaded('.nax/context.md', 'a'), 'b'), '.nax/rules/x.md', 'x')
    expect(Object.keys(discardFile(d1, '.nax/context.md').files)).toEqual(['.nax/rules/x.md'])
    expect(discardAll(d1).files).toEqual({})
    expect(discardAll(d1).baseSha).toBe('b')
  })

  test('draftEdits are sorted by path', () => {
    const d = createFile(createFile(emptyDraft('b'), '.nax/rules/z.md', 'z'), '.nax/config.json', '{}')
    expect(draftEdits(d).map((e) => e.path)).toEqual(['.nax/config.json', '.nax/rules/z.md'])
  })
})

describe('problems', () => {
  test('jsonError returns the parser message for invalid JSON and null for valid JSON', () => {
    expect(jsonError('{"a":1}')).toBeNull()
    expect(jsonError('{"a":')).toEqual(expect.any(String))
  })

  test('an invalid .json put is a json problem; a .md file is never parsed', () => {
    const d = createFile(createFile(emptyDraft('b'), '.nax/config.json', '{oops'), '.nax/context.md', '{oops')
    expect(draftProblems(d)).toEqual([{ path: '.nax/config.json', code: 'json' }])
  })

  test('limits: 50 edits, 256 KiB per file (bytes, not chars), 1 MiB total', () => {
    let many = emptyDraft('b')
    for (let i = 0; i < 51; i += 1) many = createFile(many, `.nax/rules/r${i}.md`, 'x')
    expect(draftProblems(many)).toContainEqual({ path: null, code: 'too_many' })
    // 87 382 three-byte characters = 262 146 bytes > 262 144
    const big = createFile(emptyDraft('b'), '.nax/context.md', '中'.repeat(87_382))
    expect(draftProblems(big)).toContainEqual({ path: '.nax/context.md', code: 'file_too_large' })
    let total = emptyDraft('b')
    for (let i = 0; i < 5; i += 1) total = createFile(total, `.nax/rules/t${i}.md`, 'a'.repeat(250_000))
    expect(draftProblems(total)).toContainEqual({ path: null, code: 'total_too_large' })
  })

  test('an unresolved conflict is a problem until resolveConflict', () => {
    const d = { baseSha: 'b', files: { '.nax/context.md': { path: '.nax/context.md', baseSha: 's2', original: 'up', content: 'mine', conflict: true } } }
    expect(draftProblems(d)).toEqual([{ path: '.nax/context.md', code: 'conflict' }])
    expect(draftProblems(resolveConflict(d, '.nax/context.md'))).toEqual([])
  })
})

describe('groupFiles', () => {
  test('groups in fixed order, includes new files, marks status, sorts paths', () => {
    const entries = [entry('.nax/rules/b.md', 'rules'), entry('.nax/config.json', 'config'), entry('.nax/rules/a.md', 'rules')]
    const draft = createFile(editFile(emptyDraft('b'), loaded('.nax/rules/b.md', 'x'), 'y'), '.nax/context.md', '# c')
    expect(groupFiles(entries, draft)).toEqual([
      { group: 'rules', files: [{ path: '.nax/rules/a.md', status: 'unchanged' }, { path: '.nax/rules/b.md', status: 'modified' }] },
      { group: 'context', files: [{ path: '.nax/context.md', status: 'new' }] },
      { group: 'config', files: [{ path: '.nax/config.json', status: 'unchanged' }] },
    ])
  })
})
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd apps/web && bunx jest tests/lib/nax-config.spec.ts`
Expected: FAIL, cannot find module `~/lib/nax-config`.

- [ ] **Step 4: Implement `apps/web/lib/nax-config.ts`**

```ts
/**
 * S3 §6: the config page's data model. Wire types mirror the API (spec §4.1); the allowlist and limits are the shared
 * protocol module (D467), so the web refuses exactly what the API and runner refuse. Every function returns a new
 * draft (D474: the draft is page state only).
 */
import {
  isAllowedNaxPath, NAX_CONFIG_LIMITS, naxPathGroup, type ConfigFileEdit, type NaxPathGroup,
} from '@nathapp/fleet-protocol'

export interface NaxFileEntry { path: string; size: number; blobSha: string; group: NaxPathGroup }
export interface NaxFileList { baseSha: string; defaultBranch: string; files: NaxFileEntry[] }
export interface NaxFileContent { path: string; blobSha: string; content: string }

export type DraftStatus = 'unchanged' | 'modified' | 'new' | 'deleted'

/** `original` null = a new file; `content` null = deleted; `conflict` = upstream changed under a reopened edit. */
export interface DraftFile { path: string; baseSha: string | null; original: string | null; content: string | null; conflict: boolean }
export interface ConfigDraft { baseSha: string; files: Readonly<Record<string, DraftFile>> }

export const emptyDraft = (baseSha: string): ConfigDraft => ({ baseSha, files: {} })

const withFile = (draft: ConfigDraft, file: DraftFile): ConfigDraft => ({ ...draft, files: { ...draft.files, [file.path]: file } })

const withoutFile = (draft: ConfigDraft, path: string): ConfigDraft => ({
  ...draft,
  files: Object.fromEntries(Object.entries(draft.files).filter(([key]) => key !== path)),
})

function assertAllowed(path: string): void {
  if (!isAllowedNaxPath(path)) throw new Error(`${path} is not an allowed nax path`)
}

export function editFile(draft: ConfigDraft, loaded: NaxFileContent, content: string): ConfigDraft {
  const current = draft.files[loaded.path]
  if (current && current.original === null) return withFile(draft, { ...current, content })
  const original = current?.original ?? loaded.content
  const baseSha = current?.baseSha ?? loaded.blobSha
  if (content === original && !current?.conflict) return withoutFile(draft, loaded.path)
  return withFile(draft, { path: loaded.path, baseSha, original, content, conflict: current?.conflict ?? false })
}

export function createFile(draft: ConfigDraft, path: string, content: string): ConfigDraft {
  assertAllowed(path)
  const current = draft.files[path]
  return withFile(draft, { path, baseSha: null, original: null, content, conflict: current?.conflict ?? false })
}

export function deleteFile(draft: ConfigDraft, loaded: NaxFileContent): ConfigDraft {
  const current = draft.files[loaded.path]
  if (current && current.original === null) return withoutFile(draft, loaded.path)
  return withFile(draft, {
    path: loaded.path, baseSha: current?.baseSha ?? loaded.blobSha, original: current?.original ?? loaded.content, content: null, conflict: false,
  })
}

export const discardFile = (draft: ConfigDraft, path: string): ConfigDraft => withoutFile(draft, path)
export const discardAll = (draft: ConfigDraft): ConfigDraft => emptyDraft(draft.baseSha)

export function resolveConflict(draft: ConfigDraft, path: string): ConfigDraft {
  const current = draft.files[path]
  return current ? withFile(draft, { ...current, conflict: false }) : draft
}

export function fileStatus(draft: ConfigDraft, path: string): DraftStatus {
  const file = draft.files[path]
  if (!file) return 'unchanged'
  if (file.content === null) return 'deleted'
  return file.original === null ? 'new' : 'modified'
}

export function draftEdits(draft: ConfigDraft): ConfigFileEdit[] {
  return Object.values(draft.files)
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file): ConfigFileEdit => (file.content === null
      ? { path: file.path, op: 'delete', baseSha: file.baseSha }
      : { path: file.path, op: 'put', content: file.content, baseSha: file.baseSha }))
}

export function jsonError(content: string): string | null {
  try {
    JSON.parse(content)
    return null
  }
  catch (err: unknown) {
    return err instanceof Error ? err.message : String(err)
  }
}

export interface DraftProblem { path: string | null; code: 'json' | 'too_many' | 'file_too_large' | 'total_too_large' | 'conflict' }

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length

export function draftProblems(draft: ConfigDraft): DraftProblem[] {
  const files = Object.values(draft.files).slice().sort((a, b) => a.path.localeCompare(b.path))
  const perFile = files.flatMap((file): DraftProblem[] => {
    const problems: DraftProblem[] = []
    if (file.conflict) problems.push({ path: file.path, code: 'conflict' })
    if (file.content === null) return problems
    if (utf8Bytes(file.content) > NAX_CONFIG_LIMITS.maxFileBytes) problems.push({ path: file.path, code: 'file_too_large' })
    if (file.path.endsWith('.json') && jsonError(file.content) !== null) problems.push({ path: file.path, code: 'json' })
    return problems
  })
  const total = files.reduce((sum, file) => sum + (file.content === null ? 0 : utf8Bytes(file.content)), 0)
  return [
    ...perFile,
    ...(files.length > NAX_CONFIG_LIMITS.maxEdits ? [{ path: null, code: 'too_many' } as DraftProblem] : []),
    ...(total > NAX_CONFIG_LIMITS.maxTotalBytes ? [{ path: null, code: 'total_too_large' } as DraftProblem] : []),
  ]
}

export const NAX_GROUP_ORDER: readonly NaxPathGroup[] = ['rules', 'context', 'config', 'profiles', 'constitution']

export interface TreeGroup { group: NaxPathGroup; files: Array<{ path: string; status: DraftStatus }> }

export function groupFiles(entries: readonly NaxFileEntry[], draft: ConfigDraft): TreeGroup[] {
  const paths = [...new Set([...entries.map((e) => e.path), ...Object.keys(draft.files)])]
  return NAX_GROUP_ORDER
    .map((group) => ({
      group,
      files: paths
        .filter((path) => naxPathGroup(path) === group)
        .sort((a, b) => a.localeCompare(b))
        .map((path) => ({ path, status: fileStatus(draft, path) })),
    }))
    .filter((g) => g.files.length > 0)
}
```

- [ ] **Step 4b: Review Focus — CRLF files and delete-then-recreate**

Append to `apps/web/tests/lib/nax-config.spec.ts`:

```ts
describe('review focus (S3 plan)', () => {
  const crlf: NaxFileContent = { path: '.nax/context.md', blobSha: 'b1', content: '# ctx\r\nline\r\n' }

  test('an unedited CRLF file is never in the edit set (a textarea reports LF)', () => {
    const draft = editFile(emptyDraft('base'), crlf, '# ctx\nline\n')
    expect(draftEdits(draft)).toEqual([])
    expect(fileStatus(draft, crlf.path)).toBe('unchanged')
  })

  test('an edited CRLF file keeps CRLF line endings', () => {
    const draft = editFile(emptyDraft('base'), crlf, '# ctx\nline two\n')
    expect(draftEdits(draft)).toEqual([{ path: crlf.path, op: 'put', content: '# ctx\r\nline two\r\n', baseSha: 'b1' }])
  })

  test('deleting then re-creating the same path is a modify against the loaded blob, not a new file', () => {
    const loaded: NaxFileContent = { path: '.nax/rules/a.md', blobSha: 'b2', content: '# a\n' }
    const draft = createFile(deleteFile(emptyDraft('base'), loaded), loaded.path, '# a again\n')
    expect(fileStatus(draft, loaded.path)).toBe('modified')
    expect(draftEdits(draft)).toEqual([{ path: loaded.path, op: 'put', content: '# a again\n', baseSha: 'b2' }])
  })
})
```

Then change `editFile` and `createFile` in `apps/web/lib/nax-config.ts`:

```ts
/** Browsers report textarea values with LF; keep the file's own CRLF endings so an unedited file stays unchanged. */
const matchLineEndings = (original: string | null, content: string): string =>
  original !== null && original.includes('\r\n') && !content.includes('\r') ? content.replace(/\n/g, '\r\n') : content

export function editFile(draft: ConfigDraft, loaded: NaxFileContent, input: string): ConfigDraft {
  const current = draft.files[loaded.path]
  if (current && current.original === null) return withFile(draft, { ...current, content: input })
  const original = current?.original ?? loaded.content
  const baseSha = current?.baseSha ?? loaded.blobSha
  const content = matchLineEndings(original, input)
  if (content === original && !current?.conflict) return withoutFile(draft, loaded.path)
  return withFile(draft, { path: loaded.path, baseSha, original, content, conflict: current?.conflict ?? false })
}

export function createFile(draft: ConfigDraft, path: string, content: string): ConfigDraft {
  assertAllowed(path)
  const current = draft.files[path]
  // Re-creating a file this draft deleted is a modify of the loaded blob (otherwise the runner sees baseSha null
  // for an existing path and reports a conflict).
  if (current && current.original !== null) {
    const next = matchLineEndings(current.original, content)
    return next === current.original && !current.conflict
      ? withoutFile(draft, path)
      : withFile(draft, { ...current, content: next })
  }
  return withFile(draft, { path, baseSha: null, original: null, content, conflict: current?.conflict ?? false })
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/web && bunx jest tests/lib/nax-config.spec.ts`
Expected: PASS.

- [ ] **Step 6: Confirm Nuxt resolves the workspace package**

Run: `cd apps/web && bun run type-check && bun run build`
Expected: both succeed (Vite transpiles the linked `src/index.ts`). If `build` fails to resolve or transpile the
package, add `build: { transpile: ['@nathapp/fleet-protocol'] }` to `apps/web/nuxt.config.ts` and rerun.

- [ ] **Step 7: Commit**

```bash
git add apps/web/package.json bun.lock apps/web/lib/nax-config.ts apps/web/tests/lib/nax-config.spec.ts apps/web/nuxt.config.ts
git commit -m "feat(web): nax config draft model on the shared allowlist (S3 §6, D467, D474)"
```

---
### Task C3: Line diff, new-file targets and Reopen-edits re-application

**Files:**
- Create: `apps/web/lib/nax-config-diff.ts`
- Modify: `apps/web/lib/nax-config.ts` (append)
- Test: `apps/web/tests/lib/nax-config-diff.spec.ts`, `apps/web/tests/lib/nax-config.spec.ts` (append)

**Interfaces:**
- Consumes: Task C2 types and `isAllowedNaxPath`.
- Produces:
  - `interface DiffLine { kind: 'same' | 'add' | 'del'; text: string }`, `interface LineDiff { lines: DiffLine[]; approximate: boolean }`, `lineDiff(before: string, after: string): LineDiff` (nax-config-diff)
  - `newFileTargets(entries: readonly NaxFileEntry[]): string[]` (nax-config)
  - `validateNewPath(path: string, existing: readonly string[]): 'not_allowed' | 'exists' | null`
  - `reapplyEdits(stored: readonly ConfigFileEdit[], latest: NaxFileList, contents: Readonly<Record<string, NaxFileContent>>): ConfigDraft`

No web dependency ships a diff (`apps/web/package.json` checked), so `lineDiff` is a small LCS over lines with the common
prefix and suffix trimmed first; above 2 000 000 table cells it falls back to "all removed, all added" and says so
(`approximate`), which keeps a 256 KiB file from freezing the tab.

- [ ] **Step 1: Write the failing diff tests** (`apps/web/tests/lib/nax-config-diff.spec.ts`)

```ts
import { describe, expect, test } from '@jest/globals'
import { lineDiff } from '~/lib/nax-config-diff'

describe('lineDiff', () => {
  test('identical text is all same lines', () => {
    expect(lineDiff('a\nb', 'a\nb')).toEqual({ lines: [{ kind: 'same', text: 'a' }, { kind: 'same', text: 'b' }], approximate: false })
  })

  test('a changed middle line is one del and one add between same lines', () => {
    expect(lineDiff('a\nb\nc', 'a\nX\nc').lines).toEqual([
      { kind: 'same', text: 'a' }, { kind: 'del', text: 'b' }, { kind: 'add', text: 'X' }, { kind: 'same', text: 'c' },
    ])
  })

  test('a new file (empty before) is only adds; a deleted file (empty after) is only dels', () => {
    expect(lineDiff('', 'x\ny').lines).toEqual([{ kind: 'add', text: 'x' }, { kind: 'add', text: 'y' }])
    expect(lineDiff('x', '').lines).toEqual([{ kind: 'del', text: 'x' }])
  })

  test('an inserted line keeps the rest aligned', () => {
    expect(lineDiff('a\nc', 'a\nb\nc').lines.map((l) => l.kind)).toEqual(['same', 'add', 'same'])
  })

  test('a huge rewrite falls back to an approximate whole replacement', () => {
    const before = Array.from({ length: 2000 }, (_, i) => `old ${i}`).join('\n')
    const after = Array.from({ length: 2000 }, (_, i) => `new ${i}`).join('\n')
    const diff = lineDiff(before, after)
    expect(diff.approximate).toBe(true)
    expect(diff.lines.filter((l) => l.kind === 'del')).toHaveLength(2000)
    expect(diff.lines.filter((l) => l.kind === 'add')).toHaveLength(2000)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/web && bunx jest tests/lib/nax-config-diff.spec.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement `apps/web/lib/nax-config-diff.ts`**

```ts
/** S3 §6 "Review changes": a line diff of a draft file against the version it was loaded at. */
export interface DiffLine { kind: 'same' | 'add' | 'del'; text: string }
export interface LineDiff { lines: DiffLine[]; approximate: boolean }

/** Above this many LCS cells the diff is a whole replacement (keeps a 256 KiB file from freezing the tab). */
const MAX_CELLS = 2_000_000

const toLines = (text: string): string[] => (text === '' ? [] : text.split('\n'))
const same = (text: string): DiffLine => ({ kind: 'same', text })
const del = (text: string): DiffLine => ({ kind: 'del', text })
const add = (text: string): DiffLine => ({ kind: 'add', text })

function lcsDiff(a: readonly string[], b: readonly string[]): DiffLine[] {
  const n = a.length
  const m = b.length
  const w = m + 1
  const dp = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push(same(a[i])); i += 1; j += 1 }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { out.push(del(a[i])); i += 1 }
    else { out.push(add(b[j])); j += 1 }
  }
  return [...out, ...a.slice(i).map(del), ...b.slice(j).map(add)]
}

export function lineDiff(before: string, after: string): LineDiff {
  const a = toLines(before)
  const b = toLines(after)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1 }
  const head = a.slice(0, start).map(same)
  const tail = a.slice(endA).map(same)
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  if (midA.length * midB.length > MAX_CELLS) {
    return { lines: [...head, ...midA.map(del), ...midB.map(add), ...tail], approximate: true }
  }
  return { lines: [...head, ...lcsDiff(midA, midB), ...tail], approximate: false }
}
```

- [ ] **Step 4: Run the diff tests to verify they pass**

Run: `cd apps/web && bunx jest tests/lib/nax-config-diff.spec.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing targets and reapply tests** (append to `apps/web/tests/lib/nax-config.spec.ts`)

```ts
import { newFileTargets, reapplyEdits, validateNewPath, type NaxFileList } from '~/lib/nax-config'

describe('new file targets (S3 §6 "New file")', () => {
  test('suggests missing root files, a rule, a profile, and missing files of known mono packages', () => {
    const entries = [entry('.nax/context.md', 'context'), entry('.nax/mono/apps/api/context.md', 'context')]
    expect(newFileTargets(entries)).toEqual([
      '.nax/rules/new-rule.md',
      '.nax/config.json',
      '.nax/constitution.md',
      '.nax/mono/apps/api/config.json',
      '.nax/profiles/new-profile.json',
    ])
  })

  test('validateNewPath refuses disallowed and existing paths', () => {
    expect(validateNewPath('.nax/rules/x.md', [])).toBeNull()
    expect(validateNewPath('.nax/profiles/p.env', [])).toBe('not_allowed')
    expect(validateNewPath('.nax/Rules/x.md', [])).toBe('not_allowed')
    expect(validateNewPath('.nax/rules/x.md', ['.nax/rules/x.md'])).toBe('exists')
  })
})

describe('reapplyEdits (S3 §6 "Reopen edits")', () => {
  const latest: NaxFileList = {
    baseSha: 'head2',
    defaultBranch: 'main',
    files: [
      { path: '.nax/context.md', size: 3, blobSha: 'ctx-v2', group: 'context' },
      { path: '.nax/rules/a.md', size: 3, blobSha: 'a-v1', group: 'rules' },
      { path: '.nax/rules/taken.md', size: 3, blobSha: 't-v1', group: 'rules' },
    ],
  }
  const contents = {
    '.nax/context.md': { path: '.nax/context.md', blobSha: 'ctx-v2', content: 'upstream' },
    '.nax/rules/a.md': { path: '.nax/rules/a.md', blobSha: 'a-v1', content: 'a' },
    '.nax/rules/taken.md': { path: '.nax/rules/taken.md', blobSha: 't-v1', content: 't' },
  }

  test('an unchanged base re-applies cleanly; a changed base is flagged with both versions kept', () => {
    const draft = reapplyEdits([
      { path: '.nax/rules/a.md', op: 'put', content: 'a2', baseSha: 'a-v1' },
      { path: '.nax/context.md', op: 'put', content: 'mine', baseSha: 'ctx-v1' },
    ], latest, contents)
    expect(draft.baseSha).toBe('head2')
    expect(draft.files['.nax/rules/a.md']).toEqual({ path: '.nax/rules/a.md', baseSha: 'a-v1', original: 'a', content: 'a2', conflict: false })
    expect(draft.files['.nax/context.md']).toEqual({ path: '.nax/context.md', baseSha: 'ctx-v2', original: 'upstream', content: 'mine', conflict: true })
  })

  test('a new file whose path now exists upstream is a conflict against the upstream file', () => {
    const draft = reapplyEdits([{ path: '.nax/rules/taken.md', op: 'put', content: 'mine', baseSha: null }], latest, contents)
    expect(draft.files['.nax/rules/taken.md']).toMatchObject({ baseSha: 't-v1', original: 't', content: 'mine', conflict: true })
  })

  test('an edited file deleted upstream comes back as a flagged new file; a delete of a gone file is dropped', () => {
    const draft = reapplyEdits([
      { path: '.nax/rules/gone.md', op: 'put', content: 'mine', baseSha: 'g-v1' },
      { path: '.nax/rules/also-gone.md', op: 'delete', baseSha: 'x-v1' },
    ], latest, contents)
    expect(draft.files['.nax/rules/gone.md']).toEqual({ path: '.nax/rules/gone.md', baseSha: null, original: null, content: 'mine', conflict: true })
    expect(draft.files['.nax/rules/also-gone.md']).toBeUndefined()
  })

  test('a stored path outside the allowlist is dropped (defence in depth)', () => {
    const draft = reapplyEdits([{ path: '.nax/profiles/p.env', op: 'put', content: 'X=1', baseSha: null }], latest, contents)
    expect(draft.files).toEqual({})
  })
})
```

- [ ] **Step 6: Run them to verify they fail**

Run: `cd apps/web && bunx jest tests/lib/nax-config.spec.ts -t "new file targets|reapplyEdits"`
Expected: FAIL, functions not exported.

- [ ] **Step 7: Append the implementation to `apps/web/lib/nax-config.ts`**

```ts
const ROOT_FILES = ['.nax/config.json', '.nax/constitution.md'] as const
const MONO_FILE = /^\.nax\/mono\/(.+)\/(context\.md|config\.json)$/

/** Suggested paths for "New file": a rule, missing root files, missing files of known mono packages, a profile. */
export function newFileTargets(entries: readonly NaxFileEntry[]): string[] {
  const existing = new Set(entries.map((e) => e.path))
  const packages = [...new Set(entries.map((e) => MONO_FILE.exec(e.path)?.[1]).filter((p): p is string => p !== undefined))].sort()
  const monoMissing = packages.flatMap((pkg) => ['context.md', 'config.json'].map((name) => `.nax/mono/${pkg}/${name}`)).filter((p) => !existing.has(p))
  const rootMissing = ['.nax/context.md', ...ROOT_FILES].filter((p) => !existing.has(p))
  return ['.nax/rules/new-rule.md', ...rootMissing, ...monoMissing, '.nax/profiles/new-profile.json']
}

export function validateNewPath(path: string, existing: readonly string[]): 'not_allowed' | 'exists' | null {
  if (!isAllowedNaxPath(path)) return 'not_allowed'
  return existing.includes(path) ? 'exists' : null
}

function reapplyOne(edit: ConfigFileEdit, latest: NaxFileList, contents: Readonly<Record<string, NaxFileContent>>): DraftFile | null {
  if (!isAllowedNaxPath(edit.path)) return null
  const current = latest.files.find((f) => f.path === edit.path)
  if (edit.op === 'delete') {
    if (!current) return null
    return { path: edit.path, baseSha: current.blobSha, original: contents[edit.path]?.content ?? '', content: null, conflict: current.blobSha !== edit.baseSha }
  }
  const content = edit.content ?? ''
  if (!current) return { path: edit.path, baseSha: null, original: null, content, conflict: edit.baseSha !== null }
  const original = contents[edit.path]?.content ?? ''
  const conflict = current.blobSha !== edit.baseSha
  if (!conflict && content === original) return null
  return { path: edit.path, baseSha: current.blobSha, original, content, conflict }
}

/** Re-applies a failed job's stored edits on the latest files; a file whose base moved is flagged, never merged. */
export function reapplyEdits(
  stored: readonly ConfigFileEdit[], latest: NaxFileList, contents: Readonly<Record<string, NaxFileContent>>,
): ConfigDraft {
  const files = stored.map((edit) => reapplyOne(edit, latest, contents)).filter((f): f is DraftFile => f !== null)
  return { baseSha: latest.baseSha, files: Object.fromEntries(files.map((f) => [f.path, f])) }
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd apps/web && bunx jest tests/lib/nax-config.spec.ts tests/lib/nax-config-diff.spec.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/web/lib/nax-config.ts apps/web/lib/nax-config-diff.ts apps/web/tests/lib/nax-config.spec.ts apps/web/tests/lib/nax-config-diff.spec.ts
git commit -m "feat(web): line diff, new-file targets and Reopen-edits re-application (S3 §6)"
```

---

### Task C4: `useFleetRepoConfig` composable

**Files:**
- Create: `apps/web/composables/useFleetRepoConfig.ts`
- Test: `apps/web/tests/composables/useFleetRepoConfig.spec.ts`

**Interfaces:**
- Consumes: `NaxFileList`, `NaxFileContent` (C2); `FleetJobDto`, `DispatchResultDto`, `FleetPage` (fleet-types; the
  submit endpoints answer `DispatchResultDto` = `{ job, placement }`, like dispatch, B1 / `fleet-job.dto.ts:114`); `pickActiveJob`,
  `CONFIG_JOB_FEATURE` (C1); `ConfigFileEdit`, `ConfigEditPayload` from `@nathapp/fleet-protocol`.
- Produces: `useFleetRepoConfig(slug: string)` returning
  - `list(repoId: string): Promise<NaxFileList>`
  - `read(repoId: string, path: string, ref: string): Promise<NaxFileContent>`
  - `submitEdit(repoId: string, body: { baseSha: string; edits: ConfigFileEdit[]; prTitle: string; prBody?: string }): Promise<DispatchResultDto>`
  - `submitRegenerate(repoId: string, body: { prTitle: string; prBody?: string }): Promise<DispatchResultDto>`
  - `submitDrift(repoId: string): Promise<DispatchResultDto>`
  - `jobEdits(jobId: string): Promise<ConfigEditPayload>`
  - `activeConfigJob(repoId: string): Promise<FleetJobDto | null>`

The repo id is a call argument (not bound at creation) because the job panel regenerates for `job.repoId` and the page
for its route id.

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, jest, test } from '@jest/globals'
import { join } from 'path'

const composablePath = join(__dirname, '../..', 'composables', 'useFleetRepoConfig.ts')
const g = globalThis as Record<string, unknown>
const withApi = (api: Record<string, jest.Mock>) => { g.useApi = () => ({ $api: api }) }

describe('useFleetRepoConfig (S3 §4)', () => {
  beforeEach(() => { g.useApi = undefined })

  test('list and read hit the repo routes with encoded segments and the ref', async () => {
    const get = jest.fn(async () => ({}))
    withApi({ get })
    const { useFleetRepoConfig } = await import(composablePath)
    const api = useFleetRepoConfig('my proj')
    await api.list('r 1')
    await api.read('r1', '.nax/rules/a.md', 'abc123')
    expect(get).toHaveBeenNthCalledWith(1, '/projects/my%20proj/fleet/repos/r%201/nax-files')
    expect(get).toHaveBeenNthCalledWith(2, '/projects/my%20proj/fleet/repos/r1/nax-files/content', { query: { path: '.nax/rules/a.md', ref: 'abc123' } })
  })

  test('submitEdit, submitRegenerate and submitDrift post to their routes; prBody is omitted when empty', async () => {
    const post = jest.fn(async () => ({ job: { id: 'j1' }, placement: { assigned: false, runnerId: null, misfits: [] } }))
    withApi({ post })
    const { useFleetRepoConfig } = await import(composablePath)
    const api = useFleetRepoConfig('p')
    const edits = [{ path: '.nax/context.md', op: 'put', content: 'x', baseSha: 's' }]
    expect((await api.submitEdit('r1', { baseSha: 'b', edits, prTitle: 'T', prBody: '' })).job.id).toBe('j1')
    await api.submitRegenerate('r1', { prTitle: 'Regen', prBody: 'why' })
    await api.submitDrift('r1')
    expect(post).toHaveBeenNthCalledWith(1, '/projects/p/fleet/repos/r1/config-edits', { baseSha: 'b', edits, prTitle: 'T' })
    expect(post).toHaveBeenNthCalledWith(2, '/projects/p/fleet/repos/r1/config-edits/regenerate', { prTitle: 'Regen', prBody: 'why' })
    expect(post).toHaveBeenNthCalledWith(3, '/projects/p/fleet/repos/r1/drift-checks', {})
  })

  test('jobEdits reads the stored edit set; activeConfigJob finds the active nax-config job of the repo', async () => {
    const get = jest.fn(async (path: string) => (path.endsWith('/config-edit')
      ? { mode: 'edit', edits: [], prTitle: 'T', prBody: null, baseSha: 'b' }
      : { records: [{ id: 'old', state: 'FAILED' }, { id: 'live', state: 'RUNNING' }], total: 2, current: 1, size: 20, hasNext: false, hasPrev: false }))
    withApi({ get })
    const { useFleetRepoConfig } = await import(composablePath)
    const api = useFleetRepoConfig('p')
    expect((await api.jobEdits('j9')).mode).toBe('edit')
    expect(get).toHaveBeenCalledWith('/projects/p/fleet/jobs/j9/config-edit')
    expect((await api.activeConfigJob('r1'))?.id).toBe('live')
    expect(get).toHaveBeenCalledWith('/projects/p/fleet/jobs', { query: { repoId: 'r1', feature: 'nax-config', size: '20' } })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && bunx jest tests/composables/useFleetRepoConfig.spec.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement `apps/web/composables/useFleetRepoConfig.ts`**

```ts
import type { ConfigEditPayload, ConfigFileEdit } from '@nathapp/fleet-protocol'
import { apiPath } from '~/lib/api-path'
import { CONFIG_JOB_FEATURE, pickActiveJob } from '~/lib/fleet-jobs'
import type { DispatchResultDto, FleetJobDto, FleetPage } from '~/lib/fleet-types'
import type { NaxFileContent, NaxFileList } from '~/lib/nax-config'

export interface ConfigEditBody { baseSha: string; edits: ConfigFileEdit[]; prTitle: string; prBody?: string }
export interface ConfigPrBody { prTitle: string; prBody?: string }

/** An empty description is not sent (the API stores null). */
const withBody = <T extends { prBody?: string }>(body: T): T => {
  const { prBody, ...rest } = body
  return (prBody && prBody.length > 0 ? { ...rest, prBody } : rest) as T
}

/** S3 §4: the config page's and the config job panel's calls; no page state lives here. */
export function useFleetRepoConfig(slug: string) {
  const { $api } = useApi()
  const repoBase = (repoId: string): string => apiPath`/projects/${slug}/fleet/repos/${repoId}`

  const list = (repoId: string): Promise<NaxFileList> => $api.get<NaxFileList>(`${repoBase(repoId)}/nax-files`)

  const read = (repoId: string, path: string, ref: string): Promise<NaxFileContent> =>
    $api.get<NaxFileContent>(`${repoBase(repoId)}/nax-files/content`, { query: { path, ref } })

  // S3 §4.2 (B1): the three submits answer like dispatch, `{ job, placement }`.
  const submitEdit = (repoId: string, body: ConfigEditBody): Promise<DispatchResultDto> =>
    $api.post<DispatchResultDto>(`${repoBase(repoId)}/config-edits`, withBody(body))

  const submitRegenerate = (repoId: string, body: ConfigPrBody): Promise<DispatchResultDto> =>
    $api.post<DispatchResultDto>(`${repoBase(repoId)}/config-edits/regenerate`, withBody(body))

  const submitDrift = (repoId: string): Promise<DispatchResultDto> =>
    $api.post<DispatchResultDto>(`${repoBase(repoId)}/drift-checks`, {})

  const jobEdits = (jobId: string): Promise<ConfigEditPayload> =>
    $api.get<ConfigEditPayload>(apiPath`/projects/${slug}/fleet/jobs/${jobId}/config-edit`)

  /** S3 §4.2: the job behind a 409 `config_job_active` (D465: one active config job per repo). */
  async function activeConfigJob(repoId: string): Promise<FleetJobDto | null> {
    const res = await $api.get<FleetPage<FleetJobDto>>(apiPath`/projects/${slug}/fleet/jobs`, {
      query: { repoId, feature: CONFIG_JOB_FEATURE, size: '20' },
    })
    return pickActiveJob(res.records ?? [])
  }

  return { list, read, submitEdit, submitRegenerate, submitDrift, jobEdits, activeConfigJob }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/web && bunx jest tests/composables/useFleetRepoConfig.spec.ts`
Expected: PASS. (If Jest cannot load `@nathapp/fleet-protocol` here, it is only a type import and `import type` is
erased; no alias is needed for composables.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/composables/useFleetRepoConfig.ts apps/web/tests/composables/useFleetRepoConfig.spec.ts
git commit -m "feat(web): useFleetRepoConfig for the config endpoints (S3 §4)"
```

---
### Task C5: File tree and editor components

**Files:**
- Create: `apps/web/components/fleet/config/NaxFileTree.vue`, `apps/web/components/fleet/config/NaxFileEditor.vue`
- Modify: `apps/web/i18n/locales/en.json`, `zh.json` (`fleet.config.group`, `.status`, `.tree`, `.editor`)
- Test: `apps/web/tests/components/fleet-config-tree-editor.spec.ts`

**Interfaces:**
- Consumes: `TreeGroup`, `jsonError` (C2).
- Produces:
  - `NaxFileTree` props `{ groups: TreeGroup[]; selected: string | null }`, emits `select(path: string)`; each file button has `data-testid="nax-file"`, `data-path`, `data-status`.
  - `NaxFileEditor` props `{ path: string; modelValue: string; readonly: boolean; tooLarge: boolean }`, emits `update:modelValue(value: string)`; `.json` shows `data-testid="nax-editor-json-error"` while invalid.

Both components import everything they use explicitly except `useI18n` (a Nuxt auto-import, supplied by tests as a
global). The JSON editor is a native `<textarea>` (no editor dependency, spec "Out of scope").

- [ ] **Step 1: Write the failing tests** (`apps/web/tests/components/fleet-config-tree-editor.spec.ts`)

```ts
import { describe, expect, test } from '@jest/globals'
import * as protocol from '@nathapp/fleet-protocol'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n } from '../helpers/fleet-harness'

const alias = { '@nathapp/fleet-protocol': protocol }
const globals = { useI18n: () => enI18n() }
const mdStub = { default: { name: 'MarkdownEditorStub', props: ['modelValue'], emits: ['update:modelValue'], template: '<div data-testid="md-editor" :data-value="modelValue" />' } }

describe('NaxFileTree', () => {
  const mount = (props: Record<string, unknown>) =>
    mountSfc(webFile('components', 'fleet', 'config', 'NaxFileTree.vue'), { props, globals, alias })

  test('renders groups in the given order with status markers and emits select', () => {
    const app = mount({
      selected: '.nax/rules/a.md',
      groups: [
        { group: 'rules', files: [{ path: '.nax/rules/a.md', status: 'modified' }, { path: '.nax/rules/b.md', status: 'unchanged' }] },
        { group: 'config', files: [{ path: '.nax/config.json', status: 'deleted' }] },
      ],
    })
    expect(app.find('[data-testid="nax-file-group"]').map((n) => n.props['data-group'])).toEqual(['rules', 'config'])
    const files = app.find('[data-testid="nax-file"]')
    expect(files.map((n) => [n.props['data-path'], n.props['data-status']])).toEqual([
      ['.nax/rules/a.md', 'modified'], ['.nax/rules/b.md', 'unchanged'], ['.nax/config.json', 'deleted'],
    ])
    expect(files[0].props['aria-current']).toBe('true')
    expect(app.find('[data-testid="nax-file-marker"]').map((n) => app.textOf(n))).toEqual(['Modified', 'Deleted'])
    ;(files[1].props.onClick as () => void)()
    expect(app.emitted('select')).toEqual([['.nax/rules/b.md']])
  })
})

describe('NaxFileEditor', () => {
  const mount = (props: Record<string, unknown>) =>
    mountSfc(webFile('components', 'fleet', 'config', 'NaxFileEditor.vue'), {
      props, globals, alias: { ...alias, '~/components/MarkdownEditor.vue': mdStub },
    })

  test('markdown files use MarkdownEditor', () => {
    const app = mount({ path: '.nax/context.md', modelValue: '# Hi', readonly: false, tooLarge: false })
    expect(app.one('[data-testid="md-editor"]')?.props['data-value']).toBe('# Hi')
  })

  test('json files use a textarea, emit input, and show the parse error while invalid', () => {
    const app = mount({ path: '.nax/config.json', modelValue: '{"a":', readonly: false, tooLarge: false })
    const area = app.one('[data-testid="nax-editor-json"]')
    expect(area?.tag).toBe('textarea')
    expect(app.one('[data-testid="nax-editor-json-error"]')).toBeDefined()
    ;(area?.props.onInput as (e: unknown) => void)({ target: { value: '{}' } })
    expect(app.emitted('update:modelValue')).toEqual([['{}']])
    const valid = mount({ path: '.nax/config.json', modelValue: '{}', readonly: false, tooLarge: false })
    expect(valid.one('[data-testid="nax-editor-json-error"]')).toBeUndefined()
  })

  test('read-only shows the text without an editor; too large shows a notice only', () => {
    const ro = mount({ path: '.nax/context.md', modelValue: 'text', readonly: true, tooLarge: false })
    expect(ro.one('[data-testid="nax-editor-readonly"]')).toBeDefined()
    expect(ro.one('[data-testid="md-editor"]')).toBeUndefined()
    const big = mount({ path: '.nax/context.md', modelValue: '', readonly: false, tooLarge: true })
    expect(big.text()).toContain('too large')
    expect(big.one('[data-testid="md-editor"]')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/web && bunx jest tests/components/fleet-config-tree-editor.spec.ts`
Expected: FAIL, component files missing.

- [ ] **Step 3: Implement `NaxFileTree.vue`**

```vue
<script setup lang="ts">
import type { TreeGroup } from '~/lib/nax-config'

defineProps<{ groups: TreeGroup[]; selected: string | null }>()
const emit = defineEmits<{ (e: 'select', path: string): void }>()
const { t } = useI18n()

/** Paths are shown without the common `.nax/` prefix; the full path stays in data-path and the title. */
const shortPath = (path: string): string => path.replace(/^\.nax\//, '')
</script>

<template>
  <nav class="space-y-4" data-testid="nax-file-tree" :aria-label="t('fleet.config.tree.label')">
    <div v-for="g in groups" :key="g.group" data-testid="nax-file-group" :data-group="g.group">
      <h3 class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{{ t(`fleet.config.group.${g.group}`) }}</h3>
      <ul class="mt-1 space-y-0.5">
        <li v-for="f in g.files" :key="f.path">
          <button
            type="button"
            data-testid="nax-file"
            :data-path="f.path"
            :data-status="f.status"
            :title="f.path"
            :aria-current="selected === f.path ? 'true' : undefined"
            :class="['flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted', selected === f.path ? 'bg-muted font-medium' : '']"
            @click="emit('select', f.path)"
          >
            <span :class="['truncate font-mono text-xs', f.status === 'deleted' ? 'line-through text-muted-foreground' : '']">{{ shortPath(f.path) }}</span>
            <span v-if="f.status !== 'unchanged'" data-testid="nax-file-marker" class="ml-auto shrink-0 text-xs text-primary">{{ t(`fleet.config.status.${f.status}`) }}</span>
          </button>
        </li>
      </ul>
    </div>
  </nav>
</template>
```

- [ ] **Step 4: Implement `NaxFileEditor.vue`**

```vue
<script setup lang="ts">
import { computed } from 'vue'
import MarkdownEditor from '~/components/MarkdownEditor.vue'
import { jsonError } from '~/lib/nax-config'

const props = defineProps<{ path: string; modelValue: string; readonly: boolean; tooLarge: boolean }>()
const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>()
const { t } = useI18n()

const isJson = computed(() => props.path.endsWith('.json'))
const error = computed(() => (isJson.value && !props.readonly ? jsonError(props.modelValue) : null))

function onInput(event: Event): void {
  emit('update:modelValue', (event.target as HTMLTextAreaElement).value)
}
</script>

<template>
  <div class="space-y-2" data-testid="nax-editor">
    <p v-if="tooLarge" class="text-sm text-muted-foreground" data-testid="nax-editor-too-large">{{ t('fleet.config.editor.tooLarge') }}</p>
    <pre v-else-if="readonly" class="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 font-mono text-xs" data-testid="nax-editor-readonly">{{ modelValue }}</pre>
    <template v-else-if="isJson">
      <textarea
        :value="modelValue"
        :aria-label="path"
        spellcheck="false"
        class="min-h-[320px] w-full rounded-md border border-input bg-background p-3 font-mono text-xs"
        data-testid="nax-editor-json"
        @input="onInput"
      />
      <p v-if="error" class="text-sm text-destructive" role="alert" data-testid="nax-editor-json-error">{{ t('fleet.config.editor.jsonError', { error }) }}</p>
    </template>
    <MarkdownEditor v-else :model-value="modelValue" :aria-label="path" @update:model-value="emit('update:modelValue', $event)" />
  </div>
</template>
```

- [ ] **Step 5: Add the locale keys**

`en.json` under `fleet` (create `config`):

```json
"config": {
  "tree": { "label": "nax files" },
  "group": { "rules": "Rules", "context": "Context", "config": "Config", "profiles": "Profiles", "constitution": "Constitution" },
  "status": { "unchanged": "Unchanged", "modified": "Modified", "new": "New", "deleted": "Deleted" },
  "editor": {
    "tooLarge": "This file is too large or not text, so it is shown read-only and cannot be edited here.",
    "jsonError": "Invalid JSON: {error}"
  }
}
```

`zh.json` under `fleet`:

```json
"config": {
  "tree": { "label": "nax 文件" },
  "group": { "rules": "规则", "context": "上下文", "config": "配置", "profiles": "配置档", "constitution": "章程" },
  "status": { "unchanged": "未修改", "modified": "已修改", "new": "新建", "deleted": "已删除" },
  "editor": {
    "tooLarge": "文件过大或不是文本，只能只读查看，无法在此编辑。",
    "jsonError": "JSON 无效：{error}"
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/web && bunx jest tests/components/fleet-config-tree-editor.spec.ts tests/i18n`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/fleet/config/NaxFileTree.vue apps/web/components/fleet/config/NaxFileEditor.vue apps/web/i18n/locales/en.json apps/web/i18n/locales/zh.json apps/web/tests/components/fleet-config-tree-editor.spec.ts
git commit -m "feat(web): nax file tree and editor components (S3 §6)"
```

---

### Task C6: Changes panel, PR dialog and new-file dialog

**Files:**
- Create: `apps/web/components/fleet/config/NaxChangesPanel.vue`, `ConfigPrDialog.vue`, `NewNaxFileDialog.vue`
- Modify: `apps/web/i18n/locales/en.json`, `zh.json` (`fleet.config.changes`, `.prDialog`, `.newFile`)
- Test: `apps/web/tests/components/fleet-config-dialogs.spec.ts`

**Interfaces:**
- Consumes: `ConfigDraft`, `fileStatus`, `validateNewPath` (C2/C3), `lineDiff` (C3), `NAX_CONFIG_LIMITS`.
- Produces:
  - `NaxChangesPanel` props `{ draft: ConfigDraft; readonly: boolean }`, emits `discard(path: string)`, `discardAll()`, `resolve(path: string)`.
  - `ConfigPrDialog` props `{ open: boolean; mode: 'edit' | 'regenerate'; busy: boolean }`, emits `update:open(value: boolean)`, `submit(body: { prTitle: string; prBody: string })`.
  - `NewNaxFileDialog` props `{ open: boolean; targets: string[]; existing: string[] }`, emits `update:open(value: boolean)`, `create(path: string)`.

- [ ] **Step 1: Write the failing tests** (`apps/web/tests/components/fleet-config-dialogs.spec.ts`)

```ts
import { describe, expect, test } from '@jest/globals'
import * as protocol from '@nathapp/fleet-protocol'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import type { FakeNode } from '../helpers/mount-sfc'

const alias = { '@nathapp/fleet-protocol': protocol }
const globals = { useI18n: () => enI18n() }
const mount = (file: string, props: Record<string, unknown>) =>
  mountSfc(webFile('components', 'fleet', 'config', file), { props, globals, alias, components: uiStubs })
const click = (n: FakeNode | undefined): void => { (n?.props.onClick as () => void)() }
const type = (n: FakeNode | undefined, value: string): void => { (n?.props['onUpdate:modelValue'] as (v: string) => void)(value) }

describe('NaxChangesPanel', () => {
  const draft = {
    baseSha: 'b',
    files: {
      '.nax/context.md': { path: '.nax/context.md', baseSha: 's', original: 'a\nb', content: 'a\nX', conflict: false },
      '.nax/rules/n.md': { path: '.nax/rules/n.md', baseSha: null, original: null, content: 'new', conflict: true },
    },
  }

  test('one block per file with +/- lines, conflict badge and resolve; discard emits per file and for all', () => {
    const app = mount('NaxChangesPanel.vue', { draft, readonly: false })
    const blocks = app.find('[data-testid="nax-change"]')
    expect(blocks.map((b) => b.props['data-path'])).toEqual(['.nax/context.md', '.nax/rules/n.md'])
    expect(app.find('[data-testid="nax-diff-line"]', blocks[0]).map((l) => [l.props['data-kind'], app.textOf(l).trim()])).toEqual([
      ['same', 'a'], ['del', '- b'], ['add', '+ X'],
    ])
    expect(app.find('[data-testid="nax-change-conflict"]', blocks[1])).toHaveLength(1)
    click(app.find('[data-testid="nax-change-resolve"]', blocks[1])[0])
    click(app.find('[data-testid="nax-change-discard"]', blocks[0])[0])
    click(app.one('[data-testid="nax-changes-discard-all"]'))
    expect(app.emitted('resolve')).toEqual([['.nax/rules/n.md']])
    expect(app.emitted('discard')).toEqual([['.nax/context.md']])
    expect(app.emitted('discardAll')).toEqual([[]])
  })

  test('read-only hides every action', () => {
    const app = mount('NaxChangesPanel.vue', { draft, readonly: true })
    expect(app.find('[data-testid="nax-change-discard"]')).toHaveLength(0)
    expect(app.find('[data-testid="nax-changes-discard-all"]')).toHaveLength(0)
  })
})

describe('ConfigPrDialog', () => {
  test('submit is disabled until a title is typed; it emits trimmed title and the description', () => {
    const app = mount('ConfigPrDialog.vue', { open: true, mode: 'edit', busy: false })
    const submit = (): FakeNode | undefined => app.one('[data-testid="config-pr-submit"]')
    expect(submit()?.props.disabled).toBe(true)
    type(app.one('[data-testid="config-pr-title"]'), '  Tighten rules  ')
    type(app.one('[data-testid="config-pr-body"]'), 'why')
    expect(submit()?.props.disabled).toBe(false)
    click(submit())
    expect(app.emitted('submit')).toEqual([[{ prTitle: 'Tighten rules', prBody: 'why' }]])
  })

  test('a title over 200 characters or a description over 8 KiB blocks submit with a message', () => {
    const app = mount('ConfigPrDialog.vue', { open: true, mode: 'regenerate', busy: false })
    type(app.one('[data-testid="config-pr-title"]'), 'x'.repeat(201))
    expect(app.one('[data-testid="config-pr-submit"]')?.props.disabled).toBe(true)
    expect(app.one('[data-testid="config-pr-error"]')).toBeDefined()
    type(app.one('[data-testid="config-pr-title"]'), 'ok')
    type(app.one('[data-testid="config-pr-body"]'), 'y'.repeat(8193))
    expect(app.one('[data-testid="config-pr-submit"]')?.props.disabled).toBe(true)
  })

  test('the regenerate mode has its own title', () => {
    const app = mount('ConfigPrDialog.vue', { open: true, mode: 'regenerate', busy: false })
    expect(app.text()).toContain('Open regenerate PR')
  })
})

describe('NewNaxFileDialog', () => {
  test('a suggestion fills the path; create emits only for an allowed, unused path', () => {
    const app = mount('NewNaxFileDialog.vue', { open: true, targets: ['.nax/rules/new-rule.md', '.nax/config.json'], existing: ['.nax/context.md'] })
    click(app.find('[data-testid="new-file-target"]')[1])
    click(app.one('[data-testid="new-file-create"]'))
    expect(app.emitted('create')).toEqual([['.nax/config.json']])
  })

  test('a disallowed or existing path shows an error and disables create', () => {
    const app = mount('NewNaxFileDialog.vue', { open: true, targets: [], existing: ['.nax/context.md'] })
    type(app.one('[data-testid="new-file-path"]'), '.nax/profiles/p.env')
    expect(app.one('[data-testid="new-file-create"]')?.props.disabled).toBe(true)
    expect(app.text()).toContain('not a path the editor can create')
    type(app.one('[data-testid="new-file-path"]'), '.nax/context.md')
    expect(app.text()).toContain('already exists')
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/web && bunx jest tests/components/fleet-config-dialogs.spec.ts`
Expected: FAIL, components missing.

- [ ] **Step 3: Implement `NaxChangesPanel.vue`**

```vue
<script setup lang="ts">
import { computed } from 'vue'
import { fileStatus, type ConfigDraft } from '~/lib/nax-config'
import { lineDiff } from '~/lib/nax-config-diff'

const props = defineProps<{ draft: ConfigDraft; readonly: boolean }>()
const emit = defineEmits<{ (e: 'discard', path: string): void; (e: 'discardAll'): void; (e: 'resolve', path: string): void }>()
const { t } = useI18n()

const PREFIX = { same: '  ', add: '+ ', del: '- ' } as const

const changes = computed(() => Object.values(props.draft.files)
  .slice()
  .sort((a, b) => a.path.localeCompare(b.path))
  .map((file) => ({ file, status: fileStatus(props.draft, file.path), diff: lineDiff(file.original ?? '', file.content ?? '') })))
</script>

<template>
  <section class="space-y-3" data-testid="nax-changes">
    <div class="flex items-center justify-between">
      <h2 class="text-sm font-medium">{{ t('fleet.config.changes.title', { count: changes.length }) }}</h2>
      <Button v-if="!readonly" variant="outline" size="sm" data-testid="nax-changes-discard-all" @click="emit('discardAll')">{{ t('fleet.config.changes.discardAll') }}</Button>
    </div>
    <article v-for="c in changes" :key="c.file.path" class="rounded-md border border-border" data-testid="nax-change" :data-path="c.file.path">
      <header class="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-sm">
        <span class="font-mono text-xs">{{ c.file.path }}</span>
        <Badge variant="outline">{{ t(`fleet.config.status.${c.status}`) }}</Badge>
        <Badge v-if="c.file.conflict" variant="destructive" data-testid="nax-change-conflict">{{ t('fleet.config.changes.conflict') }}</Badge>
        <span class="ml-auto flex gap-2">
          <Button v-if="!readonly && c.file.conflict" size="sm" variant="outline" data-testid="nax-change-resolve" @click="emit('resolve', c.file.path)">{{ t('fleet.config.changes.resolve') }}</Button>
          <Button v-if="!readonly" size="sm" variant="ghost" data-testid="nax-change-discard" @click="emit('discard', c.file.path)">{{ t('fleet.config.changes.discard') }}</Button>
        </span>
      </header>
      <p v-if="c.file.conflict" class="px-3 pt-2 text-xs text-muted-foreground">{{ t('fleet.config.changes.conflictHelp') }}</p>
      <p v-if="c.diff.approximate" class="px-3 pt-2 text-xs text-muted-foreground">{{ t('fleet.config.changes.approximate') }}</p>
      <pre class="max-h-80 overflow-auto p-3 font-mono text-xs"><span
        v-for="(line, i) in c.diff.lines"
        :key="i"
        data-testid="nax-diff-line"
        :data-kind="line.kind"
        :class="['block', line.kind === 'add' ? 'bg-green-500/10' : line.kind === 'del' ? 'bg-red-500/10' : '']"
      >{{ PREFIX[line.kind] }}{{ line.text }}</span></pre>
    </article>
  </section>
</template>
```

- [ ] **Step 4: Implement `ConfigPrDialog.vue`**

```vue
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NAX_CONFIG_LIMITS } from '@nathapp/fleet-protocol'

const props = defineProps<{ open: boolean; mode: 'edit' | 'regenerate'; busy: boolean }>()
const emit = defineEmits<{ (e: 'update:open', value: boolean): void; (e: 'submit', body: { prTitle: string; prBody: string }): void }>()
const { t } = useI18n()

const title = ref('')
const body = ref('')
// A reopened dialog starts empty: a previous, abandoned title must not be resubmitted by accident.
watch(() => props.open, (open) => { if (open) { title.value = ''; body.value = '' } })

const error = computed((): string | null => {
  const trimmed = title.value.trim()
  if (trimmed.length > NAX_CONFIG_LIMITS.maxPrTitleChars) return t('fleet.config.prDialog.titleTooLong', { max: NAX_CONFIG_LIMITS.maxPrTitleChars })
  if (new TextEncoder().encode(body.value).length > NAX_CONFIG_LIMITS.maxPrBodyBytes) return t('fleet.config.prDialog.bodyTooLong')
  return null
})
const canSubmit = computed(() => title.value.trim().length > 0 && error.value === null && !props.busy)

function submit(): void {
  if (canSubmit.value) emit('submit', { prTitle: title.value.trim(), prBody: body.value })
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{{ mode === 'edit' ? t('fleet.config.prDialog.editTitle') : t('fleet.config.prDialog.regenerateTitle') }}</DialogTitle>
        <DialogDescription>{{ mode === 'edit' ? t('fleet.config.prDialog.editHelp') : t('fleet.config.prDialog.regenerateHelp') }}</DialogDescription>
      </DialogHeader>
      <div class="space-y-3">
        <Label for="config-pr-title">{{ t('fleet.config.prDialog.title') }}</Label>
        <Input id="config-pr-title" :model-value="title" data-testid="config-pr-title" @update:model-value="title = String($event)" />
        <Label for="config-pr-body">{{ t('fleet.config.prDialog.body') }}</Label>
        <Textarea id="config-pr-body" :model-value="body" rows="5" data-testid="config-pr-body" @update:model-value="body = String($event)" />
        <p v-if="error" class="text-sm text-destructive" role="alert" data-testid="config-pr-error">{{ error }}</p>
      </div>
      <DialogFooter>
        <Button variant="outline" @click="emit('update:open', false)">{{ t('common.cancel') }}</Button>
        <Button :disabled="!canSubmit" data-testid="config-pr-submit" @click="submit()">{{ t('fleet.config.prDialog.submit') }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
```

(The dialog test mounts with `open: true` from the start, so the `watch` never fires during it; the reset is covered by
the page test in Task C7.)

- [ ] **Step 5: Implement `NewNaxFileDialog.vue`**

```vue
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { validateNewPath } from '~/lib/nax-config'

const props = defineProps<{ open: boolean; targets: string[]; existing: string[] }>()
const emit = defineEmits<{ (e: 'update:open', value: boolean): void; (e: 'create', path: string): void }>()
const { t } = useI18n()

const path = ref('')
watch(() => props.open, (open) => { if (open) path.value = '' })

const problem = computed(() => (path.value.trim() === '' ? null : validateNewPath(path.value.trim(), props.existing)))
const canCreate = computed(() => path.value.trim() !== '' && problem.value === null)

function create(): void {
  if (canCreate.value) emit('create', path.value.trim())
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{{ t('fleet.config.newFile.title') }}</DialogTitle>
        <DialogDescription>{{ t('fleet.config.newFile.help') }}</DialogDescription>
      </DialogHeader>
      <div class="space-y-3">
        <div class="flex flex-wrap gap-2">
          <Button v-for="target in targets" :key="target" size="sm" variant="outline" data-testid="new-file-target" @click="path = target">
            <span class="font-mono text-xs">{{ target }}</span>
          </Button>
        </div>
        <Label for="new-file-path">{{ t('fleet.config.newFile.path') }}</Label>
        <Input id="new-file-path" :model-value="path" class="font-mono" data-testid="new-file-path" @update:model-value="path = String($event)" />
        <p v-if="problem" class="text-sm text-destructive" role="alert" data-testid="new-file-error">{{ t(`fleet.config.newFile.${problem}`) }}</p>
      </div>
      <DialogFooter>
        <Button variant="outline" @click="emit('update:open', false)">{{ t('common.cancel') }}</Button>
        <Button :disabled="!canCreate" data-testid="new-file-create" @click="create()">{{ t('fleet.config.newFile.create') }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
```

- [ ] **Step 6: Add the locale keys** (inside `fleet.config`)

`en.json`:

```json
"changes": {
  "title": "Changes ({count})",
  "discard": "Discard",
  "discardAll": "Discard all",
  "conflict": "Changed upstream",
  "conflictHelp": "This file changed on the default branch after your edit was made. The diff shows the latest version against yours; check it, then mark it resolved.",
  "resolve": "Mark resolved",
  "approximate": "The file changed too much for a line-by-line diff; showing the whole old and new text."
},
"prDialog": {
  "editTitle": "Open a PR with these changes",
  "regenerateTitle": "Open regenerate PR",
  "editHelp": "A runner applies the changes, regenerates the agent files, validates them with nax and opens the PR. Nothing is committed if validation fails.",
  "regenerateHelp": "A runner regenerates the agent files from the current context and opens a PR with the result.",
  "title": "PR title",
  "body": "Description (optional)",
  "titleTooLong": "The title can be at most {max} characters.",
  "bodyTooLong": "The description can be at most 8 KiB.",
  "submit": "Queue job"
},
"newFile": {
  "title": "New nax file",
  "help": "Pick a suggested location or type a path under .nax/ that the editor allows.",
  "path": "Path",
  "create": "Create",
  "not_allowed": "This is not a path the editor can create (rules, context, config, repo profiles .json and the constitution only).",
  "exists": "This file already exists."
}
```

`zh.json`:

```json
"changes": {
  "title": "改动（{count}）",
  "discard": "放弃",
  "discardAll": "全部放弃",
  "conflict": "上游已改动",
  "conflictHelp": "提交这次修改之后，默认分支上的此文件又被改动。差异显示最新版本与你的版本，请检查后标记为已解决。",
  "resolve": "标记为已解决",
  "approximate": "文件改动太大，无法逐行比较，显示完整的旧文本和新文本。"
},
"prDialog": {
  "editTitle": "用这些改动创建 PR",
  "regenerateTitle": "创建重新生成 PR",
  "editHelp": "Runner 会应用改动、重新生成 agent 文件、用 nax 校验并创建 PR。校验失败时不会提交任何内容。",
  "regenerateHelp": "Runner 会根据当前上下文重新生成 agent 文件，并用结果创建 PR。",
  "title": "PR 标题",
  "body": "描述（可选）",
  "titleTooLong": "标题最多 {max} 个字符。",
  "bodyTooLong": "描述最多 8 KiB。",
  "submit": "加入队列"
},
"newFile": {
  "title": "新建 nax 文件",
  "help": "选择一个建议位置，或输入编辑器允许的 .nax/ 下的路径。",
  "path": "路径",
  "create": "创建",
  "not_allowed": "编辑器不能创建此路径（仅限规则、上下文、配置、仓库配置档 .json 和章程）。",
  "exists": "此文件已存在。"
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd apps/web && bunx jest tests/components/fleet-config-dialogs.spec.ts tests/i18n`
Expected: PASS. If `Badge`/`Label` are missing from `uiStubs`, `Badge` and `Label` are already in the list
(`fleet-harness.ts:81-100`); nothing to add.

- [ ] **Step 8: Commit**

```bash
git add apps/web/components/fleet/config/NaxChangesPanel.vue apps/web/components/fleet/config/ConfigPrDialog.vue apps/web/components/fleet/config/NewNaxFileDialog.vue apps/web/i18n/locales/en.json apps/web/i18n/locales/zh.json apps/web/tests/components/fleet-config-dialogs.spec.ts
git commit -m "feat(web): config changes panel, PR dialog and new-file dialog (S3 §6)"
```

---
### Task C7: The config page

**Files:**
- Create: `apps/web/pages/[project]/fleet/repos/[id]/config.vue`
- Modify: `apps/web/i18n/locales/en.json`, `zh.json` (`fleet.config.page`, `fleet.config.problem`)
- Test: `apps/web/tests/pages/fleet-repo-config-page.spec.ts`

**Interfaces:**
- Consumes: `useFleetRepoConfig` (C4); `useFleetDispatchOptions(slug).repoName` (existing); `useProjectViewerRole`,
  `canWorkOnFleet` (existing); every C2/C3 draft function; components from C5/C6.
- Produces: route `/:project/fleet/repos/:id/config`, optional query `reopen=<jobId>` (used by Task C9's
  "Reopen edits" link). Test ids: `config-save`, `config-drift`, `config-new-file`, `config-delete-file`,
  `config-readonly-notice`, `config-active-job-link`, `config-problem`, `config-unreachable`.

Behaviour (spec §6, D474): files load on the client after mount; a file's content is read at the list's `baseSha`
on first select; the draft is page state; Save is enabled only for a DEVELOPER+ with at least one edit, no problems
and no unresolved conflict; a 409 on submit links the active config job (D465) or, when there is none, shows the
API message (`repo_unreachable`); leaving the page with unsaved edits asks for confirmation.

- [ ] **Step 1: Write the failing page test** (`apps/web/tests/pages/fleet-repo-config-page.spec.ts`)

```ts
import { describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import * as protocol from '@nathapp/fleet-protocol'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FakeNode } from '../helpers/mount-sfc'
import { enI18n, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { ApiError } from '../../composables/useApi'

const page = webFile('pages', '[project]', 'fleet', 'repos', '[id]', 'config.vue')
const mdStub = { default: { name: 'Md', props: ['modelValue'], emits: ['update:modelValue'], template: '<textarea data-testid="md-editor" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />' } }

const LIST = {
  baseSha: 'head1',
  defaultBranch: 'main',
  files: [
    { path: '.nax/context.md', size: 5, blobSha: 'ctx1', group: 'context' },
    { path: '.nax/config.json', size: 2, blobSha: 'cfg1', group: 'config' },
  ],
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => { setImmediate(resolve) })
    await Vue.nextTick()
  }
}
const click = (n: FakeNode | undefined): unknown => (n?.props.onClick as () => unknown)()

function harness(opts: { role?: { canManage: boolean; viewerRole: string | null }; query?: Record<string, string>; api?: Record<string, jest.Mock> } = {}) {
  const api = {
    list: jest.fn(async () => LIST),
    read: jest.fn(async (_repo: string, path: string) => ({ path, blobSha: path === '.nax/context.md' ? 'ctx1' : 'cfg1', content: path.endsWith('.json') ? '{}' : 'hello' })),
    submitEdit: jest.fn(async () => ({ job: { id: 'job-new' }, placement: { assigned: false, runnerId: null, misfits: [] } })),
    submitRegenerate: jest.fn(),
    submitDrift: jest.fn(async () => ({ job: { id: 'job-drift' }, placement: { assigned: false, runnerId: null, misfits: [] } })),
    jobEdits: jest.fn(),
    activeConfigJob: jest.fn(async () => null),
    ...(opts.api ?? {}),
  }
  const navigateTo = jest.fn(async () => undefined)
  const toasts = toastRecorder()
  const app = mountSfc(page, {
    components: uiStubs,
    alias: { '@nathapp/fleet-protocol': protocol, '~/composables/useApi': apiModule, '~/components/MarkdownEditor.vue': mdStub },
    globals: {
      definePageMeta: () => undefined,
      useRoute: () => ({ params: { project: 'p', id: 'r1' }, query: opts.query ?? {} }),
      useI18n: () => enI18n(),
      useAppToast: () => toasts,
      useFleetRepoConfig: () => api,
      useFleetDispatchOptions: () => ({ load: async () => undefined, repoName: () => 'acme/app' }),
      useProjectViewerRole: () => ({ data: Vue.ref(opts.role ?? { canManage: false, viewerRole: 'DEVELOPER' }) }),
      navigateTo,
      onBeforeRouteLeave: () => undefined,
    },
  })
  return { app, api, navigateTo, toasts }
}

describe('config page (S3 §6)', () => {
  test('loads the list, reads a file at baseSha on select, edits, and submits the edit set', async () => {
    const { app, api, navigateTo } = harness()
    await flush()
    expect(api.list).toHaveBeenCalledWith('r1')
    click(app.find('[data-testid="nax-file"]').find((n) => n.props['data-path'] === '.nax/context.md'))
    await flush()
    expect(api.read).toHaveBeenCalledWith('r1', '.nax/context.md', 'head1')
    expect(app.one('[data-testid="config-save"]')?.props.disabled).toBe(true)
    ;(app.one('[data-testid="md-editor"]')?.props.onInput as (e: unknown) => void)({ target: { value: 'changed' } })
    await flush()
    expect(app.find('[data-testid="nax-file"]').find((n) => n.props['data-path'] === '.nax/context.md')?.props['data-status']).toBe('modified')
    expect(app.one('[data-testid="config-save"]')?.props.disabled).toBe(false)
    click(app.one('[data-testid="config-save"]'))
    await flush()
    ;(app.find('[data-testid="config-pr-title"]')[0].props['onUpdate:modelValue'] as (v: string) => void)('Edit context')
    await flush()
    click(app.one('[data-testid="config-pr-submit"]'))
    await flush()
    expect(api.submitEdit).toHaveBeenCalledWith('r1', {
      baseSha: 'head1', edits: [{ path: '.nax/context.md', op: 'put', content: 'changed', baseSha: 'ctx1' }], prTitle: 'Edit context', prBody: '',
    })
    expect(navigateTo).toHaveBeenCalledWith('/p/fleet/jobs/job-new')
  })

  test('invalid JSON blocks save and is listed as a problem', async () => {
    const { app } = harness()
    await flush()
    click(app.find('[data-testid="nax-file"]').find((n) => n.props['data-path'] === '.nax/config.json'))
    await flush()
    ;(app.one('[data-testid="nax-editor-json"]')?.props.onInput as (e: unknown) => void)({ target: { value: '{bad' } })
    await flush()
    expect(app.one('[data-testid="config-save"]')?.props.disabled).toBe(true)
    expect(app.find('[data-testid="config-problem"]')).toHaveLength(1)
  })

  test('a VIEWER gets a read-only page: notice, no save/new/delete/drift, read-only editor', async () => {
    const { app } = harness({ role: { canManage: false, viewerRole: 'VIEWER' } })
    await flush()
    click(app.find('[data-testid="nax-file"]')[0])
    await flush()
    expect(app.one('[data-testid="config-readonly-notice"]')).toBeDefined()
    for (const id of ['config-save', 'config-new-file', 'config-delete-file', 'config-drift']) {
      expect(app.one(`[data-testid="${id}"]`)).toBeUndefined()
    }
    expect(app.one('[data-testid="nax-editor-readonly"]')).toBeDefined()
  })

  test('a 409 on drift check links the active config job', async () => {
    const { app } = harness({
      api: {
        submitDrift: jest.fn(async () => { throw new ApiError(409, 'A config job is already active: j-live') }),
        activeConfigJob: jest.fn(async () => ({ id: 'j-live', state: 'RUNNING' })),
      },
    })
    await flush()
    click(app.one('[data-testid="config-drift"]'))
    await flush()
    expect(app.one('[data-testid="config-active-job-link"]')?.props.to).toBe('/p/fleet/jobs/j-live')
  })

  test('a 409 on the list (repo unreachable) shows the message instead of the editor', async () => {
    const { app } = harness({ api: { list: jest.fn(async () => { throw new ApiError(409, 'repo_unreachable') }) } })
    await flush()
    expect(app.textOf(app.one('[data-testid="config-unreachable"]') as FakeNode)).toContain('repo_unreachable')
    expect(app.find('[data-testid="nax-file"]')).toHaveLength(0)
  })

  test('a 422 on read marks the file too large and read-only', async () => {
    const { app } = harness({ api: { read: jest.fn(async () => { throw new ApiError(422, 'too large') }) } })
    await flush()
    click(app.find('[data-testid="nax-file"]')[0])
    await flush()
    expect(app.one('[data-testid="nax-editor-too-large"]')).toBeDefined()
  })

  test('?reopen= re-applies the stored edits on the latest files; a conflict blocks save until resolved', async () => {
    const { app, api } = harness({
      query: { reopen: 'job-failed' },
      api: {
        jobEdits: jest.fn(async () => ({ mode: 'edit', baseSha: 'old', prTitle: 'T', prBody: null, edits: [{ path: '.nax/context.md', op: 'put', content: 'mine', baseSha: 'ctx0' }] })),
      },
    })
    await flush()
    expect(api.jobEdits).toHaveBeenCalledWith('job-failed')
    expect(app.find('[data-testid="nax-change-conflict"]')).toHaveLength(1)
    expect(app.one('[data-testid="config-save"]')?.props.disabled).toBe(true)
    click(app.one('[data-testid="nax-change-resolve"]'))
    await flush()
    expect(app.one('[data-testid="config-save"]')?.props.disabled).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && bunx jest tests/pages/fleet-repo-config-page.spec.ts`
Expected: FAIL, page file missing.

- [ ] **Step 3: Implement `apps/web/pages/[project]/fleet/repos/[id]/config.vue`**

```vue
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ApiError, extractApiError } from '~/composables/useApi'
import { canWorkOnFleet } from '~/lib/fleet-jobs'
import type { DispatchResultDto, FleetJobDto } from '~/lib/fleet-types'
import {
  createFile, deleteFile, discardAll, discardFile, draftEdits, draftProblems, editFile, emptyDraft, groupFiles,
  newFileTargets, reapplyEdits, resolveConflict, type ConfigDraft, type NaxFileContent, type NaxFileList,
} from '~/lib/nax-config'
import NaxFileTree from '~/components/fleet/config/NaxFileTree.vue'
import NaxFileEditor from '~/components/fleet/config/NaxFileEditor.vue'
import NaxChangesPanel from '~/components/fleet/config/NaxChangesPanel.vue'
import ConfigPrDialog from '~/components/fleet/config/ConfigPrDialog.vue'
import NewNaxFileDialog from '~/components/fleet/config/NewNaxFileDialog.vue'

definePageMeta({ layout: 'default' })

/** S3 §6: browse a fleet repo's allowlisted .nax/ files and turn edits into a CONFIG_EDIT job (D474: draft = page state). */
const route = useRoute()
const slug = route.params.project as string
const repoId = route.params.id as string
const reopenJobId = typeof route.query.reopen === 'string' && route.query.reopen !== '' ? route.query.reopen : null
const { t } = useI18n()
const toast = useAppToast()
const configApi = useFleetRepoConfig(slug)
const options = useFleetDispatchOptions(slug)
const { data: viewerRole } = useProjectViewerRole(slug)
const canWork = computed(() => canWorkOnFleet(viewerRole.value))

const list = ref<NaxFileList | null>(null)
const loaded = ref<Record<string, NaxFileContent>>({})
const tooLarge = ref<readonly string[]>([])
const draft = ref<ConfigDraft>(emptyDraft(''))
const selected = ref<string | null>(null)
const pending = ref(true)
const loadFailed = ref(false)
const unreachable = ref<string | null>(null)
const busy = ref(false)
const submitted = ref(false)
const prDialog = ref(false)
const newFileDialog = ref(false)
const activeJob = ref<FleetJobDto | null>(null)

const groups = computed(() => (list.value ? groupFiles(list.value.files, draft.value) : []))
const existingPaths = computed(() => [...new Set([...(list.value?.files.map((f) => f.path) ?? []), ...Object.keys(draft.value.files)])])
const targets = computed(() => (list.value ? newFileTargets(list.value.files) : []).filter((p) => !existingPaths.value.includes(p)))
const edits = computed(() => draftEdits(draft.value))
const problems = computed(() => draftProblems(draft.value))
const canSave = computed(() => canWork.value && edits.value.length > 0 && problems.value.length === 0 && !busy.value)
const selectedDraft = computed(() => (selected.value ? draft.value.files[selected.value] : undefined))
const selectedTooLarge = computed(() => selected.value !== null && tooLarge.value.includes(selected.value))
const selectedContent = computed((): string | null => {
  const path = selected.value
  if (!path) return null
  if (selectedDraft.value) return selectedDraft.value.content
  return loaded.value[path]?.content ?? null
})

async function loadContent(path: string): Promise<void> {
  const current = list.value
  if (!current || loaded.value[path] || !current.files.some((f) => f.path === path)) return
  try {
    const content = await configApi.read(repoId, path, current.baseSha)
    loaded.value = { ...loaded.value, [path]: content }
  }
  catch (err: unknown) {
    if (err instanceof ApiError && err.code === 422) tooLarge.value = [...tooLarge.value, path]
    else toast.error(extractApiError(err))
  }
}

async function reopen(jobId: string, latest: NaxFileList): Promise<void> {
  const stored = await configApi.jobEdits(jobId)
  const paths = stored.edits.map((e) => e.path).filter((p) => latest.files.some((f) => f.path === p))
  const contents = await Promise.all(paths.map((p) => configApi.read(repoId, p, latest.baseSha)))
  loaded.value = Object.fromEntries(contents.map((c) => [c.path, c]))
  draft.value = reapplyEdits(stored.edits, latest, loaded.value)
}

async function load(): Promise<void> {
  pending.value = true
  try {
    const latest = await configApi.list(repoId)
    list.value = latest
    loaded.value = {}
    tooLarge.value = []
    draft.value = emptyDraft(latest.baseSha)
    if (reopenJobId) await reopen(reopenJobId, latest)
    loadFailed.value = false
    unreachable.value = null
  }
  catch (err: unknown) {
    loadFailed.value = true
    unreachable.value = err instanceof ApiError && err.code === 409 ? extractApiError(err) : null
    if (unreachable.value === null) toast.error(extractApiError(err))
  }
  finally {
    pending.value = false
  }
}

onMounted(() => {
  void load()
  void options.load().catch(() => undefined)
})

// D474: the draft lives only here, so leaving with unsaved edits asks first.
onBeforeRouteLeave(() => {
  if (submitted.value || edits.value.length === 0) return true
  return window.confirm(t('fleet.config.page.leaveConfirm'))
})

async function select(path: string): Promise<void> {
  selected.value = path
  await loadContent(path)
}

function onEdit(content: string): void {
  const path = selected.value
  if (!path || !canWork.value) return
  const base = loaded.value[path]
  draft.value = base ? editFile(draft.value, base, content) : createFile(draft.value, path, content)
}

function onCreate(path: string): void {
  draft.value = createFile(draft.value, path, '')
  newFileDialog.value = false
  selected.value = path
}

function onDelete(): void {
  const path = selected.value
  if (!path) return
  const base = loaded.value[path]
  draft.value = base ? deleteFile(draft.value, base) : discardFile(draft.value, path)
}

/** A 409 is the one-active-config-job rule (D465) when a job is active; otherwise it is the API's own message. */
async function showConflict(err: unknown): Promise<void> {
  if (err instanceof ApiError && err.code === 409) {
    activeJob.value = await configApi.activeConfigJob(repoId).catch(() => null)
    if (activeJob.value) return
  }
  toast.error(extractApiError(err))
}

async function submitJob(run: () => Promise<DispatchResultDto>): Promise<void> {
  busy.value = true
  activeJob.value = null
  try {
    const result = await run()
    submitted.value = true
    prDialog.value = false
    await navigateTo(`/${slug}/fleet/jobs/${result.job.id}`)
  }
  catch (err: unknown) {
    await showConflict(err)
  }
  finally {
    busy.value = false
  }
}

const save = (body: { prTitle: string; prBody: string }): Promise<void> =>
  submitJob(() => configApi.submitEdit(repoId, { baseSha: draft.value.baseSha, edits: edits.value, ...body }))

const checkDrift = (): Promise<void> => submitJob(() => configApi.submitDrift(repoId))

const problemText = (p: { path: string | null; code: string }): string =>
  (p.path ? `${p.path}: ` : '') + t(`fleet.config.problem.${p.code}`)
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      :title="t('fleet.config.page.title')"
      :subtitle="list ? t('fleet.config.page.subtitle', { repo: options.repoName(repoId), branch: list.defaultBranch, sha: list.baseSha.slice(0, 12) }) : options.repoName(repoId)"
    >
      <template #actions>
        <Button v-if="canWork && list" variant="outline" :disabled="busy" data-testid="config-drift" @click="checkDrift()">
          {{ t('fleet.config.page.checkDrift') }}
        </Button>
        <Button v-if="canWork && list" :disabled="!canSave" data-testid="config-save" @click="prDialog = true">
          {{ t('fleet.config.page.save', { count: edits.length }) }}
        </Button>
      </template>
    </PageHeader>

    <p v-if="!canWork" class="rounded-md border border-border p-3 text-sm text-muted-foreground" data-testid="config-readonly-notice">
      {{ t('fleet.config.page.readOnly') }}
    </p>

    <div v-if="activeJob" class="rounded-md border border-border p-4 text-sm" data-testid="config-active-job">
      {{ t('fleet.config.page.activeJob') }}
      <NuxtLink :to="`/${slug}/fleet/jobs/${activeJob.id}`" class="font-medium text-primary underline-offset-4 hover:underline" data-testid="config-active-job-link">
        {{ t('fleet.config.page.openActiveJob') }}
      </NuxtLink>
    </div>

    <LoadingState v-if="pending" />
    <p v-else-if="unreachable" class="rounded-md border border-destructive p-4 text-sm" data-testid="config-unreachable">
      {{ t('fleet.config.page.unreachable', { message: unreachable }) }}
    </p>
    <ErrorState v-else-if="loadFailed || !list" @retry="load()" />
    <template v-else>
      <ul v-if="problems.length > 0" class="space-y-1 text-sm text-destructive" role="alert">
        <li v-for="p in problems" :key="`${p.path ?? ''}:${p.code}`" data-testid="config-problem">{{ problemText(p) }}</li>
      </ul>

      <div class="grid grid-cols-1 gap-6 md:grid-cols-[18rem_1fr]">
        <aside class="space-y-3">
          <Button v-if="canWork" variant="outline" size="sm" class="w-full" data-testid="config-new-file" @click="newFileDialog = true">
            {{ t('fleet.config.page.newFile') }}
          </Button>
          <EmptyState v-if="groups.length === 0" :message="t('fleet.config.page.noFiles')" />
          <NaxFileTree v-else :groups="groups" :selected="selected" @select="select($event)" />
        </aside>

        <section class="min-w-0 space-y-3">
          <p v-if="!selected" class="text-sm text-muted-foreground">{{ t('fleet.config.page.pickFile') }}</p>
          <template v-else>
            <div class="flex items-center gap-2">
              <span class="truncate font-mono text-sm">{{ selected }}</span>
              <Button
                v-if="canWork && selectedContent !== null"
                variant="ghost"
                size="sm"
                class="ml-auto"
                data-testid="config-delete-file"
                @click="onDelete()"
              >
                {{ t('fleet.config.page.deleteFile') }}
              </Button>
            </div>
            <p v-if="selectedDraft && selectedDraft.content === null" class="text-sm text-muted-foreground">{{ t('fleet.config.page.deletedNotice') }}</p>
            <NaxFileEditor
              v-else-if="selectedContent !== null || selectedTooLarge"
              :path="selected"
              :model-value="selectedContent ?? ''"
              :readonly="!canWork"
              :too-large="selectedTooLarge"
              @update:model-value="onEdit($event)"
            />
            <LoadingState v-else />
          </template>
        </section>
      </div>

      <NaxChangesPanel
        v-if="Object.keys(draft.files).length > 0"
        :draft="draft"
        :readonly="!canWork"
        @discard="draft = discardFile(draft, $event)"
        @discard-all="draft = discardAll(draft)"
        @resolve="draft = resolveConflict(draft, $event)"
      />
    </template>

    <ConfigPrDialog :open="prDialog" mode="edit" :busy="busy" @update:open="prDialog = $event" @submit="save($event)" />
    <NewNaxFileDialog :open="newFileDialog" :targets="targets" :existing="existingPaths" @update:open="newFileDialog = $event" @create="onCreate($event)" />
  </div>
</template>
```

- [ ] **Step 4: Add the locale keys** (inside `fleet.config`)

`en.json`:

```json
"page": {
  "title": "nax config",
  "subtitle": "{repo} @ {branch} ({sha})",
  "checkDrift": "Check drift",
  "save": "Open PR ({count})",
  "readOnly": "You can read this repo's nax files. Editing needs the Developer or Admin role in this project.",
  "activeJob": "A config job for this repo is already queued or running.",
  "openActiveJob": "Open it",
  "unreachable": "koda cannot read this repo right now: {message}",
  "newFile": "New file",
  "noFiles": "This repo has no editable nax files yet. Use New file to add one.",
  "pickFile": "Pick a file on the left.",
  "deleteFile": "Delete file",
  "deletedNotice": "This file will be deleted by the PR. Discard the change to keep it.",
  "leaveConfirm": "You have unsaved changes to nax files. Leave and lose them?"
},
"problem": {
  "json": "invalid JSON",
  "too_many": "More than 50 files changed; split the change into smaller PRs.",
  "file_too_large": "file is larger than 256 KiB",
  "total_too_large": "The changes add up to more than 1 MiB.",
  "conflict": "changed upstream; review it and mark it resolved"
}
```

`zh.json`:

```json
"page": {
  "title": "nax 配置",
  "subtitle": "{repo} @ {branch}（{sha}）",
  "checkDrift": "检查漂移",
  "save": "创建 PR（{count}）",
  "readOnly": "你可以查看此仓库的 nax 文件。编辑需要此项目的开发者或管理员角色。",
  "activeJob": "此仓库已有一个配置任务在排队或运行。",
  "openActiveJob": "打开",
  "unreachable": "koda 目前无法读取此仓库：{message}",
  "newFile": "新建文件",
  "noFiles": "此仓库还没有可编辑的 nax 文件。使用“新建文件”添加。",
  "pickFile": "请在左侧选择文件。",
  "deleteFile": "删除文件",
  "deletedNotice": "PR 将删除此文件。放弃此改动即可保留。",
  "leaveConfirm": "nax 文件有未保存的改动。确定离开并丢弃吗？"
},
"problem": {
  "json": "JSON 无效",
  "too_many": "改动超过 50 个文件，请拆分为更小的 PR。",
  "file_too_large": "文件超过 256 KiB",
  "total_too_large": "改动总量超过 1 MiB。",
  "conflict": "上游已改动，请检查后标记为已解决"
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/web && bunx jest tests/pages/fleet-repo-config-page.spec.ts tests/i18n`
Expected: PASS.

- [ ] **Step 6: Lint and type-check**

Run: `cd apps/web && bun run lint && bun run type-check`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add "apps/web/pages/[project]/fleet/repos/[id]/config.vue" apps/web/i18n/locales/en.json apps/web/i18n/locales/zh.json apps/web/tests/pages/fleet-repo-config-page.spec.ts
git commit -m "feat(web): repo nax config page with draft, diff, save and drift check (S3 §6)"
```

---

### Task C8: Repos card on the project fleet page

**Files:**
- Create: `apps/web/components/fleet/config/RepoConfigList.vue`
- Modify: `apps/web/pages/[project]/fleet/index.vue` (after `<FleetBudgetBanner ...>`, line 112)
- Modify: `apps/web/i18n/locales/en.json`, `zh.json` (`fleet.config.repos`)
- Test: `apps/web/tests/components/fleet-config-repo-list.spec.ts`, `apps/web/tests/pages/fleet-jobs-list.spec.ts` (append)

**Interfaces:**
- Consumes: `FleetRepo` (fleet-types); `useFleetDispatchOptions(slug).repos` (already loaded by the page from the
  member-readable `GET /projects/:slug/fleet/repos`; spec §6, no new endpoint).
- Produces: `RepoConfigList` props `{ slug: string; repos: FleetRepo[] }`; link test id `fleet-repo-config-link`.

The project fleet page (`pages/[project]/fleet/index.vue`, the page with the Dispatch button) already loads the
project's repos into `options.repos`; the card reuses them.

- [ ] **Step 1: Write the failing tests**

`apps/web/tests/components/fleet-config-repo-list.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'

const mount = (props: Record<string, unknown>) =>
  mountSfc(webFile('components', 'fleet', 'config', 'RepoConfigList.vue'), { props, components: uiStubs, globals: { useI18n: () => enI18n() } })
const repo = (id: string, owner: string, name: string) => ({ id, projectId: 'p', provider: 'github', owner, name, defaultBranch: 'main', githubInstallationId: '1', createdAt: '' })

describe('RepoConfigList', () => {
  test('one row per repo with a link to its config page, sorted by owner/name', () => {
    const app = mount({ slug: 'p', repos: [repo('r2', 'zeta', 'svc'), repo('r1', 'acme', 'app')] })
    const links = app.find('[data-testid="fleet-repo-config-link"]')
    expect(links.map((l) => l.props.to)).toEqual(['/p/fleet/repos/r1/config', '/p/fleet/repos/r2/config'])
    expect(app.text()).toContain('acme/app')
  })

  test('renders nothing when the project has no fleet repos', () => {
    expect(mount({ slug: 'p', repos: [] }).find('[data-testid="fleet-repo-config-card"]')).toHaveLength(0)
  })
})
```

Append to `apps/web/tests/pages/fleet-jobs-list.spec.ts`:

```ts
test('S3 §6: the fleet page shows the Repos card from the loaded dispatch options', () => {
  const list = readFileSync(path.join(__dirname, '../..', 'pages', '[project]', 'fleet', 'index.vue'), 'utf-8')
  expect(list).toContain("import RepoConfigList from '~/components/fleet/config/RepoConfigList.vue'")
  expect(list).toContain('<RepoConfigList :slug="slug" :repos="options.repos.value" />')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/web && bunx jest tests/components/fleet-config-repo-list.spec.ts tests/pages/fleet-jobs-list.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `RepoConfigList.vue`**

```vue
<script setup lang="ts">
import { computed } from 'vue'
import type { FleetRepo } from '~/lib/fleet-types'

const props = defineProps<{ slug: string; repos: FleetRepo[] }>()
const { t } = useI18n()

const sorted = computed(() => props.repos.slice().sort((a, b) => `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`)))
</script>

<template>
  <section v-if="sorted.length > 0" class="rounded-md border border-border p-4" data-testid="fleet-repo-config-card">
    <h2 class="text-sm font-medium">{{ t('fleet.config.repos.title') }}</h2>
    <ul class="mt-2 divide-y divide-border">
      <li v-for="repo in sorted" :key="repo.id" class="flex items-center justify-between gap-3 py-2 text-sm">
        <span class="truncate">{{ repo.owner }}/{{ repo.name }} <span class="text-muted-foreground">@ {{ repo.defaultBranch }}</span></span>
        <NuxtLink :to="`/${slug}/fleet/repos/${repo.id}/config`" class="shrink-0 text-primary underline-offset-4 hover:underline" data-testid="fleet-repo-config-link">
          {{ t('fleet.config.repos.open') }}
        </NuxtLink>
      </li>
    </ul>
  </section>
</template>
```

In `apps/web/pages/[project]/fleet/index.vue` add to the imports
`import RepoConfigList from '~/components/fleet/config/RepoConfigList.vue'` and, right after
`<FleetBudgetBanner ref="banner" :slug="slug" :repo-name="options.repoName" />`, add
`<RepoConfigList :slug="slug" :repos="options.repos.value" />`.

Locales (inside `fleet.config`): `en.json` `"repos": { "title": "Repos", "open": "nax config" }`; `zh.json`
`"repos": { "title": "仓库", "open": "nax 配置" }`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && bunx jest tests/components/fleet-config-repo-list.spec.ts tests/pages/fleet-jobs-list.spec.ts tests/i18n`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/fleet/config/RepoConfigList.vue "apps/web/pages/[project]/fleet/index.vue" apps/web/i18n/locales/en.json apps/web/i18n/locales/zh.json apps/web/tests/components/fleet-config-repo-list.spec.ts apps/web/tests/pages/fleet-jobs-list.spec.ts
git commit -m "feat(web): Repos card linking each fleet repo's nax config (S3 §6)"
```

---
### Task C9: Config job panel on the job page

**Files:**
- Create: `apps/web/components/fleet/config/ConfigJobPanel.vue`
- Modify: `apps/web/pages/[project]/fleet/jobs/[id]/index.vue` (script lines 1-90; template lines 229, 282-283, 288-289,
  294, 329)
- Modify: `apps/web/i18n/locales/en.json`, `zh.json` (`fleet.config.panel`)
- Test: `apps/web/tests/components/fleet-config-job-panel.spec.ts`, `apps/web/tests/pages/fleet-job-detail.spec.ts` (append)

**Interfaces:**
- Consumes: `FleetJobDto.configEdit` (C1), `isConfigJob`, `safePrUrl` (fleet-jobs), `useFleetRepoConfig().submitRegenerate`
  (C4), `ConfigPrDialog` (C6), the `?reopen=` query of the config page (C7).
- Produces: `ConfigJobPanel` props `{ job: FleetJobDto; slug: string; canWork: boolean }`, emits `regenerate()`. Test
  ids `fleet-config-panel`, `config-panel-outcome` (`data-outcome`), `config-panel-file`, `config-panel-result-file`,
  `config-panel-output`, `config-panel-reopen`, `config-panel-regenerate`, `config-panel-pr`.

For a config job the page drops what only a nax session produces (progress, story pipeline, cost and quality
analytics, bundle download, profiles, bash mode, finish result) and shows the panel instead (spec §6 "Job page, config
jobs"). Requeue and cancel stay: both are valid for config jobs (spec §5 lifecycle).

- [ ] **Step 1: Write the failing panel test** (`apps/web/tests/components/fleet-config-job-panel.spec.ts`)

```ts
import { describe, expect, test } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import type { FleetJobDto } from '~/lib/fleet-types'

const mount = (props: Record<string, unknown>) =>
  mountSfc(webFile('components', 'fleet', 'config', 'ConfigJobPanel.vue'), { props, components: uiStubs, globals: { useI18n: () => enI18n() } })
const job = (over: Partial<FleetJobDto>): FleetJobDto => ({
  id: 'j1', repoId: 'r1', command: 'CONFIG_EDIT', state: 'COMPLETED', resultPrUrl: null,
  configEdit: { mode: 'edit', files: ['.nax/context.md'], prTitle: 'Edit context', result: null },
  ...over,
} as FleetJobDto)

describe('ConfigJobPanel (S3 §6)', () => {
  test('ok: outcome, edited files and the PR link', () => {
    const app = mount({ slug: 'p', canWork: true, job: job({ resultPrUrl: 'https://github.com/acme/app/pull/9', configEdit: { mode: 'edit', files: ['.nax/context.md'], prTitle: 'Edit context', result: { outcome: 'ok', files: ['.nax/context.md', 'AGENTS.md'] } } }) })
    expect(app.one('[data-testid="config-panel-outcome"]')?.props['data-outcome']).toBe('ok')
    expect(app.find('[data-testid="config-panel-file"]').map((n) => app.textOf(n))).toEqual(['.nax/context.md'])
    expect(app.one('[data-testid="config-panel-pr"]')?.props.href).toBe('https://github.com/acme/app/pull/9')
    expect(app.one('[data-testid="config-panel-reopen"]')).toBeUndefined()
  })

  test('conflict and invalid offer Reopen edits to a DEVELOPER+; invalid shows the nax output', () => {
    const conflict = mount({ slug: 'p', canWork: true, job: job({ state: 'FAILED', configEdit: { mode: 'edit', files: ['.nax/context.md'], prTitle: 'T', result: { outcome: 'conflict', files: ['.nax/context.md'] } } }) })
    expect(conflict.one('[data-testid="config-panel-reopen"]')?.props.to).toBe('/p/fleet/repos/r1/config?reopen=j1')
    expect(conflict.find('[data-testid="config-panel-result-file"]').map((n) => conflict.textOf(n))).toEqual(['.nax/context.md'])
    const invalid = mount({ slug: 'p', canWork: true, job: job({ state: 'FAILED', configEdit: { mode: 'edit', files: ['.nax/rules/a.md'], prTitle: 'T', result: { outcome: 'invalid', output: 'rules lint: bad frontmatter in a.md' } } }) })
    expect(invalid.textOf(invalid.one('[data-testid="config-panel-output"]')!)).toContain('bad frontmatter')
    expect(invalid.one('[data-testid="config-panel-reopen"]')).toBeDefined()
    const viewer = mount({ slug: 'p', canWork: false, job: job({ state: 'FAILED', configEdit: { mode: 'edit', files: [], prTitle: 'T', result: { outcome: 'conflict', files: [] } } }) })
    expect(viewer.one('[data-testid="config-panel-reopen"]')).toBeUndefined()
  })

  test('drift with files offers a regenerate PR; drift without files says the repo is in sync', () => {
    const drift = mount({ slug: 'p', canWork: true, job: job({ command: 'CONFIG_DRIFT', configEdit: { mode: 'drift', files: [], prTitle: null, result: { outcome: 'drift', files: ['AGENTS.md', 'CLAUDE.md'] } } }) })
    expect(drift.find('[data-testid="config-panel-result-file"]')).toHaveLength(2)
    ;(drift.one('[data-testid="config-panel-regenerate"]')?.props.onClick as () => void)()
    expect(drift.emitted('regenerate')).toEqual([[]])
    const clean = mount({ slug: 'p', canWork: true, job: job({ command: 'CONFIG_DRIFT', configEdit: { mode: 'drift', files: [], prTitle: null, result: { outcome: 'drift', files: [] } } }) })
    expect(clean.one('[data-testid="config-panel-regenerate"]')).toBeUndefined()
    expect(clean.text()).toContain('in sync')
  })

  test('before a result arrives the panel says the job is still working', () => {
    const app = mount({ slug: 'p', canWork: true, job: job({ state: 'RUNNING' }) })
    expect(app.one('[data-testid="config-panel-outcome"]')).toBeUndefined()
    expect(app.text()).toContain('No result yet')
  })
})
```

- [ ] **Step 2: Write the failing page assertions** (append to `apps/web/tests/pages/fleet-job-detail.spec.ts`, using
the file's existing `detail` source string)

```ts
describe('config jobs (S3 §6)', () => {
  test('the page swaps nax-only sections for the config panel', () => {
    expect(detail).toContain("import ConfigJobPanel from '~/components/fleet/config/ConfigJobPanel.vue'")
    expect(detail).toContain('const configJob = computed(() => job.value !== null && isConfigJob(job.value))')
    expect(detail).toContain('<ConfigJobPanel v-if="configJob" :job="job" :slug="slug" :can-work="viewer.canWork" @regenerate="regenOpen = true" />')
    expect(detail).toContain('<FleetJobProgress v-if="!configJob" :job="job" />')
    expect(detail).toContain('<FleetJobPipeline v-if="!configJob" :job="job" />')
    expect(detail).toContain('<FleetJobAnalytics v-if="!configJob" :slug="slug" :job-id="jobId" :reload-key="analyticsReload" />')
    expect(detail).toMatch(/const showBundle = computed\(\(\) => job\.value !== null && !configJob\.value && mayHaveBundle\(job\.value\.state\)\)/)
  })

  test('regenerate submits for the job repo and opens the new job', () => {
    expect(detail).toContain('configApi.submitRegenerate(current.repoId, body)')
    expect(detail).toContain('await navigateTo(`/${slug}/fleet/jobs/${created.job.id}`)')
  })
})
```

- [ ] **Step 3: Run both to verify they fail**

Run: `cd apps/web && bunx jest tests/components/fleet-config-job-panel.spec.ts tests/pages/fleet-job-detail.spec.ts`
Expected: FAIL.

- [ ] **Step 4: Implement `ConfigJobPanel.vue`**

```vue
<script setup lang="ts">
import { computed } from 'vue'
import { safePrUrl } from '~/lib/fleet-jobs'
import type { FleetJobDto } from '~/lib/fleet-types'

const props = defineProps<{ job: FleetJobDto; slug: string; canWork: boolean }>()
const emit = defineEmits<{ (e: 'regenerate'): void }>()
const { t } = useI18n()

const config = computed(() => props.job.configEdit ?? null)
const result = computed(() => config.value?.result ?? null)
const outcome = computed(() => result.value?.outcome ?? null)
const prUrl = computed(() => safePrUrl(props.job.resultPrUrl))
const resultFiles = computed(() => result.value?.files ?? [])
const canReopen = computed(() => props.canWork && config.value?.mode === 'edit' && (outcome.value === 'conflict' || outcome.value === 'invalid'))
const canRegenerate = computed(() => props.canWork && outcome.value === 'drift' && resultFiles.value.length > 0)
const reopenHref = computed(() => `/${props.slug}/fleet/repos/${props.job.repoId}/config?reopen=${encodeURIComponent(props.job.id)}`)
/** Which list the result files are: conflict files, drifted files, or what the PR committed. */
const filesLabel = computed(() => (outcome.value === 'conflict' || outcome.value === 'drift' || outcome.value === 'ok' ? t(`fleet.config.panel.files.${outcome.value}`) : null))
</script>

<template>
  <section v-if="config" class="space-y-3 rounded-md border border-border p-4 text-sm" data-testid="fleet-config-panel">
    <div class="flex flex-wrap items-center gap-2">
      <span class="font-medium">{{ t(`fleet.config.panel.mode.${config.mode}`) }}</span>
      <span v-if="config.prTitle" class="text-muted-foreground">· {{ config.prTitle }}</span>
      <Badge v-if="outcome" :variant="job.state === 'FAILED' ? 'destructive' : 'outline'" data-testid="config-panel-outcome" :data-outcome="outcome">
        {{ t(`fleet.config.panel.outcome.${outcome}`) }}
      </Badge>
      <span v-else class="text-muted-foreground">{{ t('fleet.config.panel.pending') }}</span>
    </div>

    <div v-if="config.files.length > 0">
      <p class="text-muted-foreground">{{ t('fleet.config.panel.edited') }}</p>
      <ul class="mt-1 space-y-0.5 font-mono text-xs">
        <li v-for="file in config.files" :key="file" data-testid="config-panel-file">{{ file }}</li>
      </ul>
    </div>

    <p v-if="prUrl">
      <a :href="prUrl" target="_blank" rel="noopener noreferrer" class="break-all text-primary underline-offset-4 hover:underline" data-testid="config-panel-pr">{{ prUrl }}</a>
    </p>

    <div v-if="filesLabel && resultFiles.length > 0">
      <p class="text-muted-foreground">{{ filesLabel }}</p>
      <ul class="mt-1 space-y-0.5 font-mono text-xs">
        <li v-for="file in resultFiles" :key="file" data-testid="config-panel-result-file">{{ file }}</li>
      </ul>
    </div>
    <p v-if="outcome === 'drift' && resultFiles.length === 0" class="text-muted-foreground">{{ t('fleet.config.panel.noDrift') }}</p>

    <pre v-if="result?.output" class="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-3 font-mono text-xs" data-testid="config-panel-output">{{ result.output }}</pre>

    <div class="flex flex-wrap gap-2">
      <NuxtLink v-if="canReopen" :to="reopenHref" class="inline-flex h-9 items-center rounded-md border border-input px-3 hover:bg-muted" data-testid="config-panel-reopen">
        {{ t('fleet.config.panel.reopen') }}
      </NuxtLink>
      <Button v-if="canRegenerate" size="sm" data-testid="config-panel-regenerate" @click="emit('regenerate')">{{ t('fleet.config.panel.regenerate') }}</Button>
    </div>
  </section>
</template>
```

- [ ] **Step 5: Wire it into the job page** (`apps/web/pages/[project]/fleet/jobs/[id]/index.vue`)

Script, imports block (lines 1-23): change line 7 to also import `isConfigJob` from `~/lib/fleet-jobs`; add
`import { codeLabel } from '~/lib/fleet-i18n'`,
`import ConfigJobPanel from '~/components/fleet/config/ConfigJobPanel.vue'` and
`import ConfigPrDialog from '~/components/fleet/config/ConfigPrDialog.vue'`. Change line 31 to
`const { t, te } = useI18n()` and add after line 34 (`const people = ...`):

```ts
const configApi = useFleetRepoConfig(slug)
/** S3 §6: the open state of the "Open regenerate PR" dialog. */
const regenOpen = ref(false)
```

After the `viewer` computed (line 64), add:

```ts
/** S3 §6: config jobs run no nax session; the page shows the config panel instead of progress, stories and cost. */
const configJob = computed(() => job.value !== null && isConfigJob(job.value))
```

Replace line 75 with
`const showBundle = computed(() => job.value !== null && !configJob.value && mayHaveBundle(job.value.state))`.

After `downloadBundle` (before `formatTime`), add:

```ts
/** S3 §6: drift -> regenerate PR for the same repo; the new job page follows. */
const regenerate = (body: { prTitle: string; prBody: string }): Promise<void> => act(async () => {
  const current = job.value
  if (!current) return
  // S3 §4.2 (B1): `{ job, placement }`, like dispatch and requeue.
  const created = await configApi.submitRegenerate(current.repoId, body)
  regenOpen.value = false
  await navigateTo(`/${slug}/fleet/jobs/${created.job.id}`)
})
```

Template changes:
- line 229: `<PageHeader :title="configJob ? t('fleet.jobs.configFeature') : job.feature" :subtitle="`${codeLabel(t, te, 'fleet.command', job.command)} | ${options.repoName(job.repoId)} @ ${job.ref}`">`
- after the state row `</div>` that closes the badges block (the `<div class="flex flex-wrap items-center gap-3">`
  block ending before the approval callout), insert
  `<ConfigJobPanel v-if="configJob" :job="job" :slug="slug" :can-work="viewer.canWork" @regenerate="regenOpen = true" />`
- lines 282-283: `<FleetJobProgress v-if="!configJob" :job="job" />` and `<FleetJobPipeline v-if="!configJob" :job="job" />`
- lines 288-289 and 294: add `v-if="!configJob"` to the profiles, bash and finish-result `<div>`s
- line 329: `<FleetJobAnalytics v-if="!configJob" :slug="slug" :job-id="jobId" :reload-key="analyticsReload" />`
- before the cancel `<Dialog>`, add
  `<ConfigPrDialog :open="regenOpen" mode="regenerate" :busy="busy" @update:open="regenOpen = $event" @submit="regenerate($event)" />`

- [ ] **Step 6: Add the locale keys** (inside `fleet.config`)

`en.json`:

```json
"panel": {
  "mode": { "edit": "Config edit", "regenerate": "Regenerate agent files", "drift": "Drift check" },
  "outcome": {
    "ok": "PR opened",
    "no_changes": "No changes (the files already match)",
    "drift": "Checked",
    "conflict": "Conflict: files changed upstream",
    "invalid": "Rejected by nax validation",
    "push_failed": "Push failed",
    "pr_failed": "Branch pushed, but the PR could not be opened (open it by hand)",
    "timeout": "Timed out"
  },
  "files": { "ok": "Committed", "conflict": "Changed upstream since you loaded them", "drift": "Generated files that would change" },
  "edited": "Edited files",
  "pending": "No result yet",
  "noDrift": "The generated agent files are in sync with the context.",
  "reopen": "Reopen edits",
  "regenerate": "Open regenerate PR"
}
```

`zh.json`:

```json
"panel": {
  "mode": { "edit": "配置修改", "regenerate": "重新生成 agent 文件", "drift": "漂移检查" },
  "outcome": {
    "ok": "已创建 PR",
    "no_changes": "无改动（文件已一致）",
    "drift": "已检查",
    "conflict": "冲突：上游文件已改动",
    "invalid": "未通过 nax 校验",
    "push_failed": "推送失败",
    "pr_failed": "分支已推送，但无法创建 PR（请手动创建）",
    "timeout": "超时"
  },
  "files": { "ok": "已提交", "conflict": "加载后上游已改动", "drift": "将会改变的生成文件" },
  "edited": "修改的文件",
  "pending": "尚无结果",
  "noDrift": "生成的 agent 文件与上下文一致。",
  "reopen": "重新打开修改",
  "regenerate": "创建重新生成 PR"
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd apps/web && bunx jest tests/components/fleet-config-job-panel.spec.ts tests/pages/fleet-job-detail.spec.ts tests/i18n && bun run type-check`
Expected: PASS; type-check clean.

- [ ] **Step 8: Commit**

```bash
git add apps/web/components/fleet/config/ConfigJobPanel.vue "apps/web/pages/[project]/fleet/jobs/[id]/index.vue" apps/web/i18n/locales/en.json apps/web/i18n/locales/zh.json apps/web/tests/components/fleet-config-job-panel.spec.ts apps/web/tests/pages/fleet-job-detail.spec.ts
git commit -m "feat(web): config job panel with Reopen edits and regenerate PR (S3 §6)"
```

---

### Task C10: CLI `koda fleet nax-files` and `koda fleet drift-check`

**Files:**
- Create: `apps/cli/src/commands/fleet-config.ts`
- Modify: `apps/cli/src/commands/fleet.ts` (import + `registerFleetConfig(fleet)` after `registerFleetRepo(fleet)`, line 18)
- Test: `apps/cli/src/commands/fleet-config.spec.ts`

**Interfaces:**
- Consumes: the generated client from PR 2's `openapi.json`. PR 2 names the controller; with the contract's
  `project-repo-config.controller.ts` the generated functions are expected to be
  `projectRepoConfigControllerList` and `projectRepoConfigControllerSubmitDrift` (pattern:
  `projectFleetReposControllerList` for `ProjectFleetReposController.list`). Step 1 confirms the real names.
- Produces: `registerFleetConfig(fleet: Command): void`.

Config edits from the CLI are out of scope (spec §7).

- [ ] **Step 1: Regenerate the client and confirm the function names**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda && bun run generate
grep -n "NaxFiles\|DriftCheck\|SubmitDrift" apps/cli/src/generated/sdk.gen.ts | head
git status --short apps/cli/src/generated openapi.json
```

Expected: the list and drift functions exist; `git status` shows no change (PR 2 already committed the regenerated
client). If the names differ from the two above, use the real names everywhere in this task (code and test mocks).

- [ ] **Step 2: Write the failing test** (`apps/cli/src/commands/fleet-config.spec.ts`)

```ts
jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
const mockStore = { get: jest.fn(() => ''), set: jest.fn() };
jest.mock('conf', () => jest.fn(() => mockStore));
jest.mock('../generated', () => ({
  projectRepoConfigControllerList: jest.fn(),
  projectRepoConfigControllerSubmitDrift: jest.fn(),
}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));

import { Command } from 'commander';
import { fleetCommand } from './fleet';
import { projectRepoConfigControllerList, projectRepoConfigControllerSubmitDrift } from '../generated';
import { resolveContext } from '../config';
import { setJsonMode } from '../utils/json-mode';

const CTX = { apiKey: 'jwt', apiUrl: 'https://koda.example.com', projectSlug: 'web' };
const list = {
  baseSha: 'abc123def4567890', defaultBranch: 'main',
  files: [{ path: '.nax/context.md', size: 1200, blobSha: 'b1', group: 'context' }, { path: '.nax/rules/a.md', size: 80, blobSha: 'b2', group: 'rules' }],
};

describe('koda fleet nax-files / drift-check (S3 §7)', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  const run = (...args: string[]) => program.parseAsync(['node', 'koda', 'fleet', ...args]);

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    fleetCommand(program);
    (resolveContext as jest.Mock).mockResolvedValue(CTX);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    setJsonMode(false);
    jest.clearAllMocks();
  });

  it('nax-files lists the files of the repo in the context project', async () => {
    (projectRepoConfigControllerList as jest.Mock).mockResolvedValue({ ret: 0, data: list });
    await run('nax-files', 'fr1');
    expect(projectRepoConfigControllerList).toHaveBeenCalledWith({ path: { slug: 'web', repoId: 'fr1' } });
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('.nax/context.md');
    expect(out).toContain('main @ abc123def456');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('nax-files --json prints the raw list', async () => {
    (projectRepoConfigControllerList as jest.Mock).mockResolvedValue({ ret: 0, data: list });
    await run('nax-files', 'fr1', '--json');
    expect(JSON.parse(logSpy.mock.calls[0][0])).toEqual(list);
  });

  it('drift-check queues a job and prints its id', async () => {
    (projectRepoConfigControllerSubmitDrift as jest.Mock).mockResolvedValue({
      ret: 0, data: { job: { id: 'job-9', state: 'QUEUED' }, placement: { assigned: true, runnerId: 'rn1', misfits: [] } },
    });
    await run('drift-check', 'fr1', '--project', 'other');
    expect(projectRepoConfigControllerSubmitDrift).toHaveBeenCalledWith({ path: { slug: 'other', repoId: 'fr1' } });
    expect(logSpy.mock.calls[0][0]).toContain('job-9');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('drift-check surfaces a 409 (a config job is already active) as an API error, exit 1', async () => {
    (projectRepoConfigControllerSubmitDrift as jest.Mock).mockRejectedValue({ ret: 409, message: 'A config job is already active: job-1' });
    await run('drift-check', 'fr1');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/cli && bunx jest src/commands/fleet-config.spec.ts`
Expected: FAIL, unknown command `nax-files`.

- [ ] **Step 4: Implement `apps/cli/src/commands/fleet-config.ts`**

```ts
import { Command } from 'commander';
import { projectRepoConfigControllerList, projectRepoConfigControllerSubmitDrift, type DispatchResultDto } from '../generated';
import { unwrap } from '../utils/api';
import { withContext } from '../utils/context';
import { handleApiError } from '../utils/error';
import { table } from '../utils/output';

interface NaxFileList {
  baseSha: string;
  defaultBranch: string;
  files: Array<{ path: string; size: number; blobSha: string; group: string }>;
}

function registerNaxFiles(fleet: Command): void {
  fleet
    .command('nax-files <repoId>')
    .description("List a fleet repo's editable nax files on its default branch (S3)")
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--json', 'Output as JSON')
    .action(async (repoId: string, options: { project?: string; json?: boolean }) => {
      try {
        const ctx = await withContext({ projectSlug: options.project });
        const list = unwrap<NaxFileList>(await projectRepoConfigControllerList({ path: { slug: ctx.projectSlug, repoId } }));
        if (options.json) {
          console.log(JSON.stringify(list, null, 2));
        } else {
          console.log(`${list.defaultBranch} @ ${list.baseSha.slice(0, 12)}`);
          table(['Group', 'Path', 'Size'], list.files.map((f) => [f.group, f.path, String(f.size)]));
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Repo not found in this project: ${repoId}` });
      }
    });
}

function registerDriftCheck(fleet: Command): void {
  fleet
    .command('drift-check <repoId>')
    .description('Queue a drift check: would `nax generate` change the generated agent files? (DEVELOPER+)')
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--json', 'Output as JSON')
    .action(async (repoId: string, options: { project?: string; json?: boolean }) => {
      try {
        const ctx = await withContext({ projectSlug: options.project });
        // S3 §4.2 (B1): the submit answers like dispatch, `{ job, placement }`.
        const result = unwrap<DispatchResultDto>(await projectRepoConfigControllerSubmitDrift({ path: { slug: ctx.projectSlug, repoId } }));
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          const placed = result.placement.assigned ? `assigned to ${result.placement.runnerId}` : 'waiting for a runner';
          console.log(`Queued drift check ${result.job.id} (${result.job.state}, ${placed}); follow it with: koda fleet job show ${result.job.id}`);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Repo not found in this project: ${repoId}` });
      }
    });
}

export function registerFleetConfig(fleet: Command): void {
  registerNaxFiles(fleet);
  registerDriftCheck(fleet);
}
```

Before relying on `koda fleet job show`, check the sub-command name in `apps/cli/src/commands/fleet-job.ts`
(`grep -n "command('" apps/cli/src/commands/fleet-job.ts`) and use the real one in the hint.

In `apps/cli/src/commands/fleet.ts`, add `import { registerFleetConfig } from './fleet-config';` with the other
imports and `registerFleetConfig(fleet);` right after `registerFleetRepo(fleet);`.

- [ ] **Step 5: Run the CLI gates**

Run: `cd apps/cli && bunx jest src/commands/fleet-config.spec.ts src/commands/fleet.spec.ts && bun run lint && bun run type-check`
Expected: PASS and clean. (If `fleet.spec.ts` snapshots the sub-command list, add `nax-files` and `drift-check` to it.)

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/commands/fleet-config.ts apps/cli/src/commands/fleet-config.spec.ts apps/cli/src/commands/fleet.ts apps/cli/src/commands/fleet.spec.ts
git commit -m "feat(cli): koda fleet nax-files and drift-check (S3 §7)"
```

---
### Task C11: Test-only fake repo-files reader for E2E

**Files:**
- Create: `apps/api/src/fleet/repo-config/fake-fleet-repo-files.reader.ts`
- Create: `apps/api/src/fleet/repo-config/fleet-config-test-hooks.controller.ts`
- Modify: the module PR 2 created for `apps/api/src/fleet/repo-config/` (expected `repo-config.module.ts`; find it with
  `grep -rln "FLEET_REPO_FILES_READER" apps/api/src/fleet/repo-config/*.module.ts`)
- Modify: `apps/api/src/config/fleet.config.ts` (`IFleetConfig` near line 44, env class near line 79, factory near line 123)
- Modify: `apps/api/src/config/env.validation.ts` (next to `FLEET_TEST_HOOKS`, line 64)
- Modify: `apps/web/playwright.config.ts` (API `env` block, next to `FLEET_TEST_HOOKS: 'true'`, line 68)
- Test: `apps/api/src/fleet/repo-config/fake-fleet-repo-files.reader.spec.ts`

**Interfaces:**
- Consumes: `FleetRepoFilesReader`, `NaxFileList`, `NaxFileContent`, `FLEET_REPO_FILES_READER` and the GitHub/GitLab
  router class from `fleet-repo-files.router.ts` (PR 2; the contract does not name the router class — read it from the
  file, written below as `FleetRepoFilesRouter`); `FleetRepoRef` (`apps/api/src/fleet/jobs/domain/fleet-job.domain.ts:170`);
  `isAllowedNaxPath`, `naxPathGroup` (protocol).
- Produces: `FakeFleetRepoFilesReader` with `seed(repoId: string, files: Readonly<Record<string, string>>): { headSha: string }`;
  test-only route `PUT /fleet/test-hooks/repos/:repoId/nax-files` body `{ files: Record<path, content> }` (global ADMIN,
  404 unless `FLEET_TEST_HOOKS=true` AND `FLEET_TEST_FAKE_NAX_FILES=true` outside production, excluded from OpenAPI
  like the D213 hook); config `IFleetConfig.testFakeNaxFiles: boolean`.

Why: the E2E stack has no forge (`apps/api/prisma/seed-e2e.ts:46` registers `acme/e2e-app` without one), but the
config page, Reopen edits and regenerate all read files through `FleetRepoFilesReader` on the API. Stubbing the browser
requests would leave regenerate (which reads the head at submit, spec §4.2) and the job pages untested, so the API gets
a test-only reader, the same approach as the D213 schedule hook. The fake ignores `ref` and always serves the current
seeded files; that is enough for E2E, which changes "upstream" by re-seeding.

- [ ] **Step 1: Write the failing test** (`fake-fleet-repo-files.reader.spec.ts`)

```ts
import { FakeFleetRepoFilesReader } from './fake-fleet-repo-files.reader';
import type { FleetRepoRef } from '../jobs/domain/fleet-job.domain';

const repo: FleetRepoRef = { id: 'r1', projectId: 'p', provider: 'github', owner: 'acme', name: 'e2e-app', defaultBranch: 'main', githubInstallationId: null };

describe('FakeFleetRepoFilesReader (E2E only)', () => {
  it('serves seeded allowlisted files with git blob SHAs, sorted by path', async () => {
    const fake = new FakeFleetRepoFilesReader();
    const { headSha } = fake.seed('r1', { '.nax/rules/b.md': 'b', '.nax/context.md': 'hello\n', '.nax/profiles/x.env': 'SECRET=1', 'README.md': 'x' });
    const list = await fake.list(repo);
    expect(list.baseSha).toBe(headSha);
    expect(list.defaultBranch).toBe('main');
    expect(list.files.map((f) => [f.path, f.group])).toEqual([['.nax/context.md', 'context'], ['.nax/rules/b.md', 'rules']]);
    // `git hash-object` of "hello\n"
    expect(list.files[0].blobSha).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    expect(await fake.read(repo, '.nax/context.md', headSha)).toEqual({ path: '.nax/context.md', blobSha: 'ce013625030ba8dba906f756967f9e9ca394464a', content: 'hello\n' });
  });

  it('re-seeding changes the head and the blob SHA of a changed file; an unseeded repo is empty', async () => {
    const fake = new FakeFleetRepoFilesReader();
    const first = fake.seed('r1', { '.nax/context.md': 'a' });
    const second = fake.seed('r1', { '.nax/context.md': 'b' });
    expect(second.headSha).not.toBe(first.headSha);
    expect((await fake.list({ ...repo, id: 'other' })).files).toEqual([]);
  });

  it('reading a missing path is a not-found error', async () => {
    const fake = new FakeFleetRepoFilesReader();
    fake.seed('r1', {});
    await expect(fake.read(repo, '.nax/context.md', 'x')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bunx jest src/fleet/repo-config/fake-fleet-repo-files.reader.spec.ts`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement the fake reader**

```ts
import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { isAllowedNaxPath, naxPathGroup, type NaxPathGroup } from '@nathapp/fleet-protocol';
import type { FleetRepoRef } from '../jobs/domain/fleet-job.domain';
import type { FleetRepoFilesReader, NaxFileContent, NaxFileList } from './fleet-repo-files.reader';

/** The SHA `git hash-object` prints, so the runner-side staleness check would agree with it. */
const gitBlobSha = (content: string): string => {
  const body = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
};

interface FakeRepoState { headSha: string; files: ReadonlyMap<string, string> }

const EMPTY: FakeRepoState = { headSha: '0'.repeat(40), files: new Map() };

/**
 * TEST ONLY (S3 plan Task C11): an in-memory FleetRepoFilesReader for the web E2E stack, which has no forge. Bound only
 * when FLEET_TEST_HOOKS and FLEET_TEST_FAKE_NAX_FILES are both true outside production. Ignores `ref`.
 */
@Injectable()
export class FakeFleetRepoFilesReader implements FleetRepoFilesReader {
  private repos: ReadonlyMap<string, FakeRepoState> = new Map();

  seed(repoId: string, files: Readonly<Record<string, string>>): { headSha: string } {
    const allowed = Object.entries(files).filter(([path]) => isAllowedNaxPath(path));
    const headSha = createHash('sha1')
      .update(allowed.map(([path, content]) => `${path}:${gitBlobSha(content)}`).sort().join('\n'))
      .digest('hex');
    this.repos = new Map([...this.repos, [repoId, { headSha, files: new Map(allowed) }]]);
    return { headSha };
  }

  async list(repo: FleetRepoRef): Promise<NaxFileList> {
    const state = this.repos.get(repo.id) ?? EMPTY;
    const files = [...state.files]
      .map(([path, content]) => ({ path, size: Buffer.byteLength(content, 'utf8'), blobSha: gitBlobSha(content), group: naxPathGroup(path) as NaxPathGroup }))
      .sort((a, b) => a.path.localeCompare(b.path));
    return { baseSha: state.headSha, defaultBranch: repo.defaultBranch, files };
  }

  async read(repo: FleetRepoRef, path: string, _ref: string): Promise<NaxFileContent> {
    const content = (this.repos.get(repo.id) ?? EMPTY).files.get(path);
    if (content === undefined) throw new NotFoundAppException({}, 'fleet.repos');
    return { path, blobSha: gitBlobSha(content), content };
  }
}
```

- [ ] **Step 4: Add the config flag**

`apps/api/src/config/fleet.config.ts`:
- in `IFleetConfig`, after `testHooksEnabled: boolean;`:
  `/** S3 plan C11: serve repo nax files from FakeFleetRepoFilesReader (E2E only; needs testHooksEnabled). */ testFakeNaxFiles: boolean;`
- in the env class, after `FLEET_TEST_HOOKS`: `@IsOptional() @IsString() FLEET_TEST_FAKE_NAX_FILES: string;`
- in the factory, after `testHooksEnabled: ...`:
  `testFakeNaxFiles: (process.env['FLEET_TEST_FAKE_NAX_FILES'] ?? '').toLowerCase() === 'true' && process.env['NODE_ENV'] !== 'production',`

`apps/api/src/config/env.validation.ts`, after line 64:
`FLEET_TEST_FAKE_NAX_FILES: Joi.string().pattern(/^(true|false)$/i).optional(),`

(If a config spec snapshots the full `IFleetConfig` object, e.g. `config/fleet.config.spec.ts`, add
`testFakeNaxFiles: false` to its expected default.)

- [ ] **Step 5: Implement the test-hook controller**

```ts
import { Body, Controller, HttpCode, Inject, Param, Put } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { RequiredPermission } from '@nathapp/nestjs-auth';
import { JsonResponse, NotFoundAppException } from '@nathapp/nestjs-common';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { FakeFleetRepoFilesReader } from './fake-fleet-repo-files.reader';

/**
 * Test-only (S3 plan C11, same rules as D213): seeds the fake repo files the E2E config page reads. 404 unless
 * FLEET_TEST_HOOKS and FLEET_TEST_FAKE_NAX_FILES are true outside production; global ADMIN; not in openapi.json.
 */
// No @ApiTags/@ApiOperation (.nax/rules/api-controllers.md): excluded from OpenAPI on purpose, like FleetTestHooksController.
@ApiExcludeController()
@Controller('fleet/test-hooks/repos')
export class FleetConfigTestHooksController {
  constructor(
    private readonly fake: FakeFleetRepoFilesReader,
    @Inject(FLEET_CFG) private readonly fleetConfig: Pick<IFleetConfig, 'testHooksEnabled' | 'testFakeNaxFiles'>,
  ) {}

  @Put(':repoId/nax-files')
  @HttpCode(200)
  @RequiredPermission('ADMIN')
  seed(@Param('repoId') repoId: string, @Body() body: { files?: Record<string, string> }) {
    if (!this.fleetConfig.testHooksEnabled || !this.fleetConfig.testFakeNaxFiles) throw new NotFoundAppException({}, 'fleet.repos');
    const files = Object.fromEntries(Object.entries(body?.files ?? {}).filter(([, v]) => typeof v === 'string'));
    return JsonResponse.Ok(this.fake.seed(repoId, files));
  }
}
```

- [ ] **Step 6: Bind the reader by config in the repo-config module**

In the repo-config module, add `FakeFleetRepoFilesReader` to `providers` and `FleetConfigTestHooksController` to
`controllers`, and replace the existing `FLEET_REPO_FILES_READER` provider (PR 2 binds it to the router, e.g.
`{ provide: FLEET_REPO_FILES_READER, useExisting: FleetRepoFilesRouter }`) with:

```ts
{
  provide: FLEET_REPO_FILES_READER,
  inject: [FLEET_CFG, FleetRepoFilesRouter, FakeFleetRepoFilesReader],
  useFactory: (
    cfg: Pick<IFleetConfig, 'testHooksEnabled' | 'testFakeNaxFiles'>,
    router: FleetRepoFilesRouter,
    fake: FakeFleetRepoFilesReader,
  ): FleetRepoFilesReader => (cfg.testHooksEnabled && cfg.testFakeNaxFiles ? fake : router),
},
```

Use the router's real class name from `fleet-repo-files.router.ts`. If the module does not yet provide `FLEET_CFG`,
import it the way `apps/api/src/fleet/schedules/schedules.module.ts` does for `FleetTestHooksController`.

Add a module test case (in the repo-config module's existing spec, or `fleet.module.spec.ts`) asserting that with
`testHooksEnabled: false` the token resolves to the router and with both flags true to the fake:

```ts
it('binds the fake reader only when both test flags are on (S3 plan C11)', async () => {
  const build = async (flags: { testHooksEnabled: boolean; testFakeNaxFiles: boolean }) => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        FakeFleetRepoFilesReader,
        { provide: FleetRepoFilesRouter, useValue: { list: jest.fn(), read: jest.fn() } },
        { provide: FLEET_CFG, useValue: flags },
        {
          provide: FLEET_REPO_FILES_READER,
          inject: [FLEET_CFG, FleetRepoFilesRouter, FakeFleetRepoFilesReader],
          useFactory: (cfg: { testHooksEnabled: boolean; testFakeNaxFiles: boolean }, router: unknown, fake: unknown) =>
            (cfg.testHooksEnabled && cfg.testFakeNaxFiles ? fake : router),
        },
      ],
    }).compile();
    return moduleRef.get(FLEET_REPO_FILES_READER);
  };
  expect(await build({ testHooksEnabled: true, testFakeNaxFiles: true })).toBeInstanceOf(FakeFleetRepoFilesReader);
  expect(await build({ testHooksEnabled: true, testFakeNaxFiles: false })).not.toBeInstanceOf(FakeFleetRepoFilesReader);
});
```

(Better still, export the factory function from the module file as `selectRepoFilesReader(cfg, router, fake)` and
test that directly; then the module and the test share one implementation.)

- [ ] **Step 7: Turn it on for the web E2E API**

In `apps/web/playwright.config.ts`, in the API server `env`, after `FLEET_TEST_HOOKS: 'true',` add
`FLEET_TEST_FAKE_NAX_FILES: 'true',`.

- [ ] **Step 8: Run the API tests**

Run: `cd apps/api && bunx jest src/fleet/repo-config src/config && bun run lint && bun run type-check`
Expected: PASS and clean; `openapi.json` unchanged (`bun run api:export-spec && git diff --exit-code openapi.json`).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/fleet/repo-config apps/api/src/config/fleet.config.ts apps/api/src/config/env.validation.ts apps/web/playwright.config.ts
git commit -m "test(fleet): test-only fake repo-files reader and seed hook for the web E2E (S3)"
```

---

### Task C12: E2E for the config page and job panel

**Files:**
- Modify: `apps/web/tests/e2e/fixtures/scripted-runner.ts` (`enroll` options, a `getConfigEdit` method)
- Create: `apps/web/tests/e2e/fixtures/fleet-config-api.ts`
- Create: `apps/web/tests/e2e/fleet-config.e2e.spec.ts`

**Interfaces:**
- Consumes: Task C11 seed hook; `login`, `createUser`, `addProjectMember`, `E2E_ADMIN` (`fixtures/api-client.ts`);
  `webLogin`, `waitForHydration` (`fixtures/page-helpers.ts`); test ids from C5-C9.
- Produces: `ScriptedRunner.enroll(token, name, { configJobs: true })`; `runner.getConfigEdit(lease)`;
  `seedNaxFiles(token, repoId, files)`, `fleetE2eRepoId(token)`.

Only the runner enrolled by this spec reports `configJobs: true`, so placement can give config jobs to no other
scripted runner (S3 §3: runners without the capability get the permanent misfit `config_jobs`). Every test ends its
config job in a terminal state before the next starts, because only one config job can be active per repo (D465).

- [ ] **Step 1: Extend the scripted runner**

In `apps/web/tests/e2e/fixtures/scripted-runner.ts`, change the `enroll` signature and capabilities line to:

```ts
  static async enroll(adminToken: string, name: string, opts: { relay?: boolean; logs?: boolean; configJobs?: boolean } = {}): Promise<ScriptedRunner> {
    const protocolVersion = opts.logs ? 3 : opts.relay ? 2 : 1;
    const base = opts.relay ? { ...E2E_RUNNER_CAPABILITIES, approvals: { relay: true } } : E2E_RUNNER_CAPABILITIES;
    // S3 §3: only a runner reporting configJobs is offered CONFIG_EDIT / CONFIG_DRIFT jobs.
    const capabilities = opts.configJobs ? { ...base, configJobs: true } : base;
```

(keep the rest of `enroll` unchanged), and add after `uploadBundle`:

```ts
  /** S3 §3: the lease-fenced edit set a config job applies (`GET /fleet/runner/jobs/:id/config-edit?leaseEpoch=`). */
  async getConfigEdit(lease: Lease): Promise<{ mode: string; edits: Array<{ path: string; op: string; content?: string; baseSha: string | null }>; prTitle: string | null; baseSha: string }> {
    const res = await fetch(`${API_URL}/api/fleet/runner/jobs/${lease.jobId}/config-edit?leaseEpoch=${lease.leaseEpoch}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    const raw = await res.text();
    if (res.status !== 200) throw new Error(`config-edit fetch failed: ${res.status} ${raw}`);
    return (JSON.parse(raw) as { data: Awaited<ReturnType<ScriptedRunner['getConfigEdit']>> }).data;
  }
```

- [ ] **Step 2: Add the seed helper** (`apps/web/tests/e2e/fixtures/fleet-config-api.ts`)

```ts
const API_URL = process.env['E2E_API_URL'] ?? 'http://localhost:3102';

/** The seeded fleet repo acme/e2e-app of project fleet-e2e (prisma/seed-e2e.ts). */
export async function fleetE2eRepoId(token: string): Promise<string> {
  const res = await fetch(`${API_URL}/api/projects/fleet-e2e/fleet/repos?size=100`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`List repos failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { data: { records: Array<{ id: string; owner: string; name: string }> } };
  const repo = body.data.records.find((r) => r.owner === 'acme' && r.name === 'e2e-app');
  if (!repo) throw new Error('acme/e2e-app is not seeded');
  return repo.id;
}

/** S3 plan C11: replaces the repo's "upstream" nax files served by the API's fake reader; returns the new head. */
export async function seedNaxFiles(token: string, repoId: string, files: Record<string, string>): Promise<string> {
  const res = await fetch(`${API_URL}/api/fleet/test-hooks/repos/${repoId}/nax-files`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ files }),
  });
  if (!res.ok) throw new Error(`Seed nax files failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { data: { headSha: string } }).data.headSha;
}
```

- [ ] **Step 3: Write the E2E spec** (`apps/web/tests/e2e/fleet-config.e2e.spec.ts`)

```ts
import { test, expect, type Page } from '@playwright/test';
import { addProjectMember, createUser, login, E2E_ADMIN } from './fixtures/api-client';
import { fleetE2eRepoId, seedNaxFiles } from './fixtures/fleet-config-api';
import { waitForHydration, webLogin } from './fixtures/page-helpers';
import { ScriptedRunner, type Lease } from './fixtures/scripted-runner';

/**
 * S3 §8 E2E: browse + edit + save -> job page; conflict -> Reopen edits; drift -> regenerate; VIEWER read-only.
 * Files come from the API's test-only fake reader (plan C11); the runner is scripted over the real sync protocol.
 */
const SLUG = 'fleet-e2e';
const FILES = {
  '.nax/context.md': '# App\n\nOriginal context.\n',
  '.nax/config.json': '{\n  "name": "e2e-app"\n}\n',
  '.nax/rules/style.md': '# Style\n\nUse tabs.\n',
};

async function expectState(page: Page, state: string): Promise<void> {
  await expect(page.getByTestId('fleet-job-state').first()).toHaveAttribute('data-state', state, { timeout: 10_000 });
}

/** RUNNING -> final snapshot -> UPLOADING -> terminal, the config-job sequence of S3 §3 / D476. */
async function finish(runner: ScriptedRunner, lease: Lease, snapshot: Record<string, unknown>, to: 'COMPLETED' | 'FAILED', reason: string): Promise<void> {
  await runner.report(lease, [{ type: 'state', payload: { to: 'RUNNING' } }]);
  await runner.report(lease, [
    { type: 'snapshot', payload: { heartbeatAt: new Date().toISOString(), ...snapshot } },
    { type: 'state', payload: { to: 'UPLOADING' } },
    { type: 'state', payload: { to, reason } },
  ]);
}

async function openConfig(page: Page, repoId: string): Promise<void> {
  await page.goto(`/${SLUG}/fleet/repos/${repoId}/config`);
  await waitForHydration(page);
  await expect(page.getByTestId('nax-file-tree')).toBeVisible();
}

async function editContext(page: Page, text: string): Promise<void> {
  await page.locator('[data-testid="nax-file"][data-path=".nax/context.md"]').click();
  const editor = page.getByRole('textbox', { name: '.nax/context.md' });
  await editor.fill(text);
  await expect(page.locator('[data-testid="nax-file"][data-path=".nax/context.md"]')).toHaveAttribute('data-status', 'modified');
}

async function submitPr(page: Page, title: string): Promise<string> {
  await page.getByTestId('config-save').click();
  await page.getByTestId('config-pr-title').fill(title);
  await page.getByTestId('config-pr-submit').click();
  await page.waitForURL(new RegExp(`/${SLUG}/fleet/jobs/[^/]+$`));
  await waitForHydration(page);
  return page.url().split('/').pop() ?? '';
}

test.describe('Fleet repo config (S3)', () => {
  let runner: ScriptedRunner;
  let token: string;
  let repoId: string;
  const suffix = Date.now().toString().slice(-6);

  test.beforeAll(async () => {
    ({ token } = await login(E2E_ADMIN.email, E2E_ADMIN.password));
    runner = await ScriptedRunner.enroll(token, `e2e-config-runner-${suffix}`, { configJobs: true });
    repoId = await fleetE2eRepoId(token);
  });

  test.beforeEach(async () => {
    await seedNaxFiles(token, repoId, FILES);
    await runner.heartbeat();
  });

  test('browse from the Repos card, edit, review the diff, save -> CONFIG_EDIT job -> PR opened', async ({ page }) => {
    test.setTimeout(90_000);
    await webLogin(page);
    await page.goto(`/${SLUG}/fleet`);
    await waitForHydration(page);
    await page.getByTestId('fleet-repo-config-link').first().click();
    await waitForHydration(page);
    await expect(page.locator('[data-testid="nax-file-group"]')).toHaveCount(3);

    await editContext(page, '# App\n\nEdited context.\n');
    await expect(page.locator('[data-testid="nax-diff-line"][data-kind="add"]')).toContainText('Edited context.');
    const jobId = await submitPr(page, `Edit context ${suffix}`);

    const lease = await runner.acceptAssign(jobId);
    const edit = await runner.getConfigEdit(lease);
    expect(edit.edits).toEqual([expect.objectContaining({ path: '.nax/context.md', op: 'put', content: '# App\n\nEdited context.\n' })]);
    await finish(runner, lease, {
      resultBranch: `nax-config/${jobId}`, resultSha: 'abcdef1234567', resultPrUrl: 'https://github.com/acme/e2e-app/pull/41',
      configResult: { outcome: 'ok', files: ['.nax/context.md', 'AGENTS.md'] },
    }, 'COMPLETED', 'ok');

    await expectState(page, 'COMPLETED');
    await expect(page.getByTestId('config-panel-outcome')).toHaveAttribute('data-outcome', 'ok');
    await expect(page.getByTestId('config-panel-pr')).toHaveAttribute('href', 'https://github.com/acme/e2e-app/pull/41');
    await expect(page.getByTestId('fleet-job-bundle')).toHaveCount(0);
  });

  test('conflict -> Reopen edits shows both versions and blocks save until resolved', async ({ page }) => {
    test.setTimeout(90_000);
    await webLogin(page);
    await openConfig(page, repoId);
    await editContext(page, '# App\n\nMy edit.\n');
    const jobId = await submitPr(page, `Conflicting edit ${suffix}`);

    // Upstream moves on, then the runner finds the base changed.
    await seedNaxFiles(token, repoId, { ...FILES, '.nax/context.md': '# App\n\nSomeone else changed this.\n' });
    const lease = await runner.acceptAssign(jobId);
    await finish(runner, lease, { configResult: { outcome: 'conflict', files: ['.nax/context.md'] } }, 'FAILED', 'conflict');
    await expectState(page, 'FAILED');
    await expect(page.getByTestId('config-panel-outcome')).toHaveAttribute('data-outcome', 'conflict');

    await page.getByTestId('config-panel-reopen').click();
    await page.waitForURL(new RegExp(`/repos/${repoId}/config\\?reopen=${jobId}`));
    await waitForHydration(page);
    await expect(page.getByTestId('nax-change-conflict')).toBeVisible();
    await expect(page.locator('[data-testid="nax-diff-line"][data-kind="del"]')).toContainText('Someone else changed this.');
    await expect(page.locator('[data-testid="nax-diff-line"][data-kind="add"]')).toContainText('My edit.');
    await expect(page.getByTestId('config-save')).toBeDisabled();
    await page.getByTestId('nax-change-resolve').click();
    await expect(page.getByTestId('config-save')).toBeEnabled();
    await page.getByTestId('nax-changes-discard-all').click(); // leave nothing behind for the next test
  });

  test('drift check -> drifted files -> Open regenerate PR queues a regenerate job', async ({ page }) => {
    test.setTimeout(90_000);
    await webLogin(page);
    await openConfig(page, repoId);
    await page.getByTestId('config-drift').click();
    await page.waitForURL(new RegExp(`/${SLUG}/fleet/jobs/[^/]+$`));
    await waitForHydration(page);
    const driftJobId = page.url().split('/').pop() ?? '';

    const lease = await runner.acceptAssign(driftJobId);
    await finish(runner, lease, { configResult: { outcome: 'drift', files: ['AGENTS.md', 'CLAUDE.md'] } }, 'COMPLETED', 'drift');
    await expectState(page, 'COMPLETED');
    await expect(page.getByTestId('config-panel-result-file')).toHaveCount(2);

    await page.getByTestId('config-panel-regenerate').click();
    await page.getByTestId('config-pr-title').fill(`Regenerate agent files ${suffix}`);
    await page.getByTestId('config-pr-submit').click();
    await page.waitForURL((url) => /\/fleet\/jobs\/[^/]+$/.test(url.pathname) && !url.pathname.endsWith(`/${driftJobId}`));
    await waitForHydration(page);
    const regenJobId = page.url().split('/').pop() ?? '';
    await expect(page.getByTestId('fleet-config-panel')).toContainText('Regenerate agent files');

    // End the regenerate job so no config job stays active for the repo (D465).
    const regenLease = await runner.acceptAssign(regenJobId);
    const regenEdit = await runner.getConfigEdit(regenLease);
    expect(regenEdit.mode).toBe('regenerate');
    expect(regenEdit.edits).toEqual([]);
    await finish(runner, regenLease, { configResult: { outcome: 'no_changes' } }, 'COMPLETED', 'no_changes');
    await expectState(page, 'COMPLETED');
  });

  test('a project VIEWER can read the files but gets no edit, save or drift controls', async ({ page }) => {
    const viewer = { email: `config-viewer-${suffix}@koda-e2e.test`, name: 'Config Viewer', password: 'Passw0rd!e2e' };
    await createUser(token, viewer);
    await addProjectMember(token, SLUG, viewer.email, 'VIEWER');
    await webLogin(page, viewer.email, viewer.password);
    await openConfig(page, repoId);
    await expect(page.getByTestId('config-readonly-notice')).toBeVisible();
    await expect(page.getByTestId('config-save')).toHaveCount(0);
    await expect(page.getByTestId('config-drift')).toHaveCount(0);
    await expect(page.getByTestId('config-new-file')).toHaveCount(0);
    await page.locator('[data-testid="nax-file"][data-path=".nax/rules/style.md"]').click();
    await expect(page.getByTestId('nax-editor-readonly')).toContainText('Use tabs.');
  });
});
```

(If `MarkdownEditor`'s textarea is not reachable by role and name because `aria-label` lands on the Textarea wrapper,
use `page.getByTestId('nax-editor').locator('textarea').first()` in `editContext`.)

- [ ] **Step 4: Run the E2E**

Run: `cd apps/web && bunx playwright test tests/e2e/fleet-config.e2e.spec.ts`
(The E2E Postgres at `E2E_DATABASE_URL`, default `localhost:5433`, must be up as for the other fleet E2E groups; the
API web server in `playwright.config.ts` resets and seeds it itself.)
Expected: 4 passed. Then run the fleet groups to catch regressions from the widened types and the new capability:
`bunx playwright test tests/e2e/fleet-` — Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/tests/e2e/fixtures/scripted-runner.ts apps/web/tests/e2e/fixtures/fleet-config-api.ts apps/web/tests/e2e/fleet-config.e2e.spec.ts
git commit -m "test(web): E2E for the repo config page, conflict reopen, drift regenerate and viewer (S3 §8)"
```

---

### Task C13: Gates and PR 3

**Files:** none new.

- [ ] **Step 1: Run every gate from the repo root**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda
bun run lint && bun run type-check && bun run test
bun run generate && git diff --exit-code openapi.json apps/cli/src/generated
```

Expected: all green; no diff in `openapi.json` or the generated client (PR 3 adds no public API; the C11 hook is
excluded from OpenAPI).

- [ ] **Step 2: Re-run the fleet E2E groups against a production web build** (dev-mode E2E can hide hydration bugs)

```bash
cd apps/web && E2E_WEB_MODE=build bunx playwright test tests/e2e/fleet-
```

Expected: all pass.

- [ ] **Step 3: Request the final code review** (superpowers:requesting-code-review), fix CRITICAL/HIGH findings, re-run
Step 1.

- [ ] **Step 4: Push and open PR 3** (only after the user approves opening the PR)

```bash
git push -u origin feat/fleet-s3-3-config-web
gh pr create --base main --title "feat(fleet): S3 web config page, job panel and CLI (PR 3 of 3)" --body "$(cat <<'BODY'
## Summary
- Repo nax config page: allowlisted file tree, Markdown/JSON editors, local draft with per-file diff, save -> CONFIG_EDIT, Check drift -> CONFIG_DRIFT (spec §6)
- Config job panel on the job page: outcome, PR link, Reopen edits (conflict/invalid), Open regenerate PR (drift)
- Repos card on the project fleet page; command labels for config jobs
- CLI: `koda fleet nax-files`, `koda fleet drift-check` (spec §7)
- Test-only fake repo-files reader + seed hook for the web E2E (no forge in E2E)

Spec: docs/superpowers/specs/2026-10-07-fleet-s3-repo-config-and-credential-board-design.md

## Test plan
- [ ] web unit + component + page tests
- [ ] CLI tests
- [ ] E2E `fleet-config.e2e.spec.ts` (4 cases) and the fleet E2E groups, dev and build mode
- [ ] Live check on koda-wk after merge (plan Task C14)
BODY
)"
```

---

### Task C14: Deploy to koda-wk and run the live check (human-run, after PR 3 merges)

No LLM spend: config jobs run `git`, `nax generate`, `nax rules lint` and `nax config` only (spec §8). Every step that
changes koda-wk, the runner or GitHub needs the user's go-ahead at that moment.

**Files:** none in the repo. Record results in the design doc (`projects/koda/koda-fleet-platform-design-2026-09-13.md`,
new §9.x) and memory.

- [ ] **Step 1: Build and deploy the merged main**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda && git switch main && git pull --ff-only
MAIN=$(git rev-parse --short=8 HEAD)
~/koda-wk/scripts/build-images.sh "$MAIN"     # pins KODA_IMAGE_TAG in ~/koda-wk/.env
~/koda-wk/deploy.sh                           # backup -> migrate (PR 2's fleet_config_jobs) -> up -> proxy restart -> health
```

Expected: `Healthy: http://127.0.0.1:8030 (koda <sha8>)`. If the web build is OOM-killed (exit 137), raise the Docker
Desktop VM memory (koda-wk trap, 10-05) and rerun.

- [ ] **Step 2: Restart the runner on the new code**

The launchd service `dev.koda.runner` runs `apps/runner/src/main.ts` from this checkout and keeps the code it started
with. With the checkout on the merged `main`:

```bash
pgrep -f "apps/runner/src/main.ts" | xargs kill     # launchd (KeepAlive) relaunches it via ~/.koda-runner/run-service.sh
sleep 20; tail -n 20 ~/.koda-runner/runner.log
```

Then confirm the runner reports the capability (admin API or psql in the postgres container):

```bash
cd ~/koda-wk && docker compose exec -T postgres psql -U koda -d koda -c \
  "select name, \"lastSeenAt\", capabilities->'configJobs' as config_jobs from \"Runner\";"
```

Expected: `wk-mac` with a fresh `lastSeenAt` and `config_jobs = true`.

- [ ] **Step 3: Live check (spec §8) on `nathapp-io/koda-fleet-sandbox`** — in the web UI at
`http://127.0.0.1:8030/<project>/fleet` -> Repos card -> the sandbox repo's "nax config":

1. Edit one rule under `.nax/rules/` and `.nax/context.md`, save with a title. Expect the job COMPLETED (`ok`) and a PR
   on GitHub whose diff holds both edits **plus** the regenerated agent files (AGENTS.md / CLAUDE.md), opened by
   `koda-fleet[bot]`, with the attribution comment from `PrAttributionService`. Merge or close it.
2. Add a rule with broken frontmatter (for example an unterminated `---` block), save. Expect FAILED `invalid`, the
   `nax rules lint` output in the panel, and **no** branch or PR on GitHub.
3. Open the editor, change `.nax/context.md` in the draft but do not save; on GitHub, commit a change to the same file
   on `main`; now save. Expect FAILED `conflict` naming `.nax/context.md`. Click Reopen edits: both versions shown,
   save blocked until "Mark resolved". Discard.
4. On GitHub, hand-edit `.nax/context.md` on `main` without regenerating. Click Check drift. Expect COMPLETED with the
   drifted generated files listed. Click Open regenerate PR; expect a PR containing only regenerated agent files.
5. Admin board (`/admin/fleet/credentials`, PR 1): the `wk-mac` column matches
   `nax auth list --json` run on the runner host (providers, kinds, expiry).

- [ ] **Step 4: Clean up** — close or merge the live-check PRs, delete their `nax-config/<jobId>` branches on GitHub,
and delete any local branch the runner left in `~/.koda-runner/workspace/nathapp-io/koda-fleet-sandbox`
(`git update-ref -d refs/remotes/origin/<branch>` for stale remote refs; koda-wk trap).

- [ ] **Step 5: Record** the outcome (pass/fail per check, job ids, PR numbers, deployed sha) in the design doc §9.x
and the koda memory entries; file issues for any failure.
