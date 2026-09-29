# Deep Code Review: Track 3 Slice 6 — Web & CLI Hygiene (`feat/track3-web-cli-hygiene`)

**Date:** 2026-09-29
**Reviewer:** Subrina (AI)
**Branch:** `feat/track3-web-cli-hygiene` vs `main` @ `8589f872` (13 commits, Task 14 Step 3 gate)
**Files:** 90 (web 31, api 21, cli 33, ci 1, ~1010 LOC added / ~405 removed, excluding the committed plan doc)
**Baseline checks run during this review:** web jest 116 suites / 2079 tests PASS; cli jest 38 suites / 553 tests PASS; api scoped jest (5 directly affected suites) 91 tests PASS; `turbo type-check` 3/3 PASS; `turbo lint` 3/3 PASS; working tree clean (`openapi.json` untouched).

---

## Overall Grade: A (93/100)

The branch does exactly what the Slice 6 plan specifies, and the five "Review Focus" risks from the plan are each handled and tested: the code-intel symbol id stays one encoded segment (`api-path.spec.ts` uses a real-shaped `proj1:repo1:src/app/main.ts::fn:boot` id), empty values throw instead of building `//`, stdin secrets are trimmed of the trailing newline and reject empty input, Ctrl+C in the hidden prompt restores raw mode and exits 130, and `config set` has no `KODA_API_KEY` fallback (`API_KEY_SECRET` names no env var — verified in source and by the plan's smoke matrix). Every `$api` call site in components, composables, and pages moved to `apiPath`; greps confirm no hand-rolled `encodeURIComponent` and no concatenation-built API roots remain in the guarded dirs, and the guard spec self-tests its patterns for vacuousness. The API cleanup removes only genuinely dead code (`findAll`, seven unused `@Principal()` params, the unreachable slug fallback) with the route surface unchanged; the comment ownership query now returns the comment so `update`/`delete` do one read, with 404/403 semantics preserved. All new exit paths `return` right after `process.exit` per the test convention, and breaking exit-code changes (SIGTERM 143, `ticket delete` 3→1) are documented in the plan's PR requirements. Two LOW findings below; neither blocks the PR.

---

## Findings

### 🔴 CRITICAL / 🟡 MEDIUM

None.

### 🟢 LOW

#### ENH-1: CLI `agent create` help text still advertises the removed slug fallback
**Severity:** LOW | **Category:** Enhancement / UX
`apps/cli/src/commands/agent.ts:126` — `.option('--slug <slug>', 'Agent slug (defaults to a slugified name)')`, and the action passes `slug: options.slug` straight through. Task 6 deleted the API-side derivation and the new DTO test proves `CreateAgentDto` rejects a create without a slug, so `koda agent create --name X` without `--slug` now fails at the API with a validation error while the help text promises the old behavior.
**Risk:** Misleads script authors; the failure surfaces as an API 400 instead of a local hint.
**Fix:** Change the help text to "Agent slug (required by the API)" or promote the option to `requiredOption`. Effort S.
**Status:** Fixed in `0ebcf986` (help text now "Agent slug (required by the API)"; pinned by a commander-option test in `agent.spec.ts`).

#### ENH-2: `promptHidden` has no stdin `error` path, so a mid-prompt I/O error leaves raw mode on
**Severity:** LOW | **Category:** Reliability
`apps/cli/src/utils/secret-input.ts` — `promptHidden` resolves on Enter/Ctrl+D and exits on Ctrl+C (terminal restored in both), but attaches no `error` listener. If stdin errors while the prompt is open (e.g. terminal detached over SSH), Node raises an unhandled `'error'` on the stream; `index.ts`'s `uncaughtException` handler exits 1 without restoring raw mode — the exact broken-echo state Review Focus 4 guards against for Ctrl+C.
**Risk:** Rare, but a user whose connection drops mid-prompt keeps a non-echoing terminal.
**Fix:** Add `stdin.on('error', () => { finish(); io.exit(EXIT_SIGINT); })` (or reject with `SecretInputError`) inside `promptHidden`. Effort S.
**Status:** Fixed in `0a5f2ca7` (`promptHidden` now attaches an `error` listener that restores the terminal and rejects with `SecretInputError`, so callers use their normal error path; covered by a test in `secret-input.spec.ts`).

### Reviewed and sound (notes, no action)

- **apiPath encoding** (`apps/web/lib/api-path.ts`): `encodeURIComponent` per value; literals untouched; throws on `''`/`undefined`/`null`. `useProjectMembers`' `base + apiPath\`/${userId}\`` split is correct — both halves are apiPath-produced.
- **Guard coverage**: `RAW_TEMPLATE` lookbehind correctly exempts tagged templates; the offender scan is line-based, so a template whose `${...}` sits on a later line than the opening backtick could evade it — none exist today (grep-verified).
- **#145 API cleanup**: `ProjectMembershipGuard` is class-level in both controllers, so dropping the seven `@Principal()` params changes no authorization; the `no-principal-params.spec.ts` non-vacuousness check passes. `findOwningProjectAndTicket`'s `include` change preserves the 404-on-missing → no-existence-leak ordering, and the CASL check now reads the same single fetch.
- **CLI secrets**: literal values warn on stderr without echoing the secret (asserted in tests); `login`/`init`/`config set`/`profile add`/`vcs connect` env-fallback scoping matches the spec exactly, including no env fallback for `config set`.
- **config.spec hygiene**: the new env-mutating tests sit inside `describe('env var overrides')`, whose `afterEach` deletes `KODA_ENV_VARS` — no leak.

---

## Priority Fix Order

| Priority | ID | Effort | Description |
|:---|:---|:---|:---|
| P2 | ENH-1 | S | Update `agent create` `--slug` help text (or make it required) to match the API contract |
| P2 | ENH-2 | S | Handle stdin `error` in `promptHidden` so raw mode is always restored |

Both findings were fixed before push (see Status lines above); the Task 14 Step 3 gate is fully satisfied.

---

## Verification Evidence (run during this review)

```text
apps/web  jest      : 116 suites, 2079 tests PASS
apps/cli  jest      :  38 suites,  553 tests PASS
apps/api  test:scoped:   5 suites,    91 tests PASS
  (no-principal-params, projects.service, create-agent.dto,
   find-user-project-roles, comments.service)
turbo type-check    : 3/3 successful
turbo lint          : 3/3 successful
git status          : clean — openapi.json unchanged by the branch
```
