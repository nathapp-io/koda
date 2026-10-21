# PRD Fidelity Report — permissions-p1-enforce-integrations

**Spec:** `.nax/features/permissions-p1-enforce-integrations/spec.md` (`d0810c74`)
**PRD:** `.nax/features/permissions-p1-enforce-integrations/prd.json` (`7e94a95c`, `nax plan --profile native-codex`)
**Date:** 2026-10-21
**Phase:** 9 (PRD fidelity)
**Verdict:** PASS. There are no blockers or majors, and there is 1 minor.

## Summary

| Check | Examined | Result |
|:--|:--|:--|
| 1. Spec AC to PRD AC mapping | 80 spec ACs, 80 PRD ACs | 80/80 map 1:1, in order. 76 are near-verbatim (similarity ≥ 0.93). 4 were reworded to be self-contained (below). |
| 2. Behavioural fidelity and signature reality | 80 ACs | 0 degraded. None was rewritten into a file-content check. Every asserted call shape matches the real signature (`ProjectMembershipGuard.canActivate`, `SkillsService.createSource(input, principal)`, `ContextBuilderService.getProjectContext(query)`). |
| 3. Orphan PRD ACs | 80 | 0. No `suggestedCriteria` were emitted. |
| 3b. Dependency fidelity | 6 stories | 6/6 sets match: US-001 `[]`, US-002 `[US-001]`, US-003 `[]`, US-004 `[US-001]`, US-005 `[US-001]`, US-006 `[US-001..US-005]`. |
| 4a. `Creates` to `expectedFiles` | 0 creates | n/a. The spec's `Creates` is None and no story has `expectedFiles`. |
| 4b. `Context Files` to `contextFiles` | 29 spec entries | 0 dropped. All exist on disk. |
| 4c. Upstream-produced reads | 0 | n/a. No story reads a file another story creates. |
| 4d. Planner additions | 1 | Minor: US-003 gained `apps/api/src/projects/project-membership.guard.ts`. It exists and is useful context, because US-003 adds that guard to the context routes. |
| 5. Meta-AC survival | 0 meta-ACs | n/a |
| 5b. Correction survival | 6 review corrections | 6/6 reach a `description` or an AC, never only `analysis` (the PRD has no `analysis` field): `body?: unknown` (US-001); the `ProjectAccessModule` wiring (US-002 to US-006); the target signatures of `indexCommit` (US-002), `getContext` (US-003) and `rotateWebhookSecret` (US-004); the unused-`@Principal()` drop (US-004). |
| 5c. PRD-AC satisfiability (invocation ACs) | 3 | 3/3 reachable. US-003 AC 9: `GET /context/:slug` reaches `contextBuilderService.getProjectContext` (`context.controller.ts:78`). US-006 AC 5 and AC 6: `SkillsService.createSource` reaches `catalog.createSource` with `createdById` (`skills.service.ts:49`). |
| 6. Out-of-scope preservation | 11 spec bullets | 11/11 are present verbatim in `prd.outOfScope`, in order. None was inverted into an AC, none is contradicted by a story, and there are no orphan exclusions. |
| 7. Terminal-cleanup story | n/a | The spec has no cleanup story; the deletions belong to `permissions-p1-cleanup`. |
| 8. `Modifies` to `modifiedFiles` | 17 spec paths | 17/17 are their own entries under the owning story. Every reason is carried verbatim, and none opens with a comma. |
| 9. Forward-reference drift | 101 identifiers in PRD ACs | 0 drifted. Every identifier appears in the spec. |

## Reworded ACs (not findings)

The planner turned each back-reference into a self-contained criterion. The meaning is unchanged, and the criteria read better for a story session that never sees the neighbouring AC.

- **US-001 AC 10, 11 and 12:** "on that handler" became "on a handler decorated `@ProjectSlugFrom('body', 'projectSlug')`, for a request with no `params.slug` or query slug". The inputs and outcomes are the same: a 404 `projects` for an unknown body slug, and pass-through with no `projectContext` for an empty body or a numeric slug.
- **US-005 AC 2:** "with that body" became the literal body `{ url: 'https://93.184.215.14/hook', events: ['STATUS_CHANGE'] }`.

## Findings

### Minor

- **4d:** the planner added a context file to US-003, `apps/api/src/projects/project-membership.guard.ts`. It exists and is relevant, so no action is needed.

## Gate

The PRD is fit for `nax run -f permissions-p1-enforce-integrations`. Run `bun run test:db:up` in `apps/api` first.
