# Spec Review — Phase 9 (PRD fidelity) — `api-i18n-zh-completion`

**Reviewed against:** `/Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda` at `7a45bec86`
**Date:** 2026-11-16
**Phases run:** 1 of 9 (`--phase 9`: phases 1-8 skipped by request)
**PRD:** `.nax/features/api-i18n-zh-completion/prd.json` (routingProfile `native-ds-m3-flash`, 3 stories)
**Verdict:** ✅ ready — one major finding fixed in place (US-002 `contextFiles`)

## Summary

| Check | Evidence | Result |
|:--|:--|:--|
| Spec AC → PRD AC mapping | 19 spec ACs examined against 33 PRD ACs (5 / 18 / 10) | 19/19 mapped, no behavioural drift |
| Dependency fidelity | US-001 `[]`, US-002 `["US-001"]`, US-003 `["US-001"]` | exact set match |
| `Creates` → `expectedFiles` | 2 spec `Creates` paths | 2/2 in `expectedFiles`, none in `contextFiles` |
| `Context Files` → `contextFiles` | 14 spec entries across 3 stories | 14/14 after the fix; 1 had been dropped |
| `Modifies` → `modifiedFiles` | 4 spec paths (2 US-001, 2 US-003) | 4/4 entries, one path per entry, reasons populated |
| Out-of-scope preservation | 12 spec bullets vs 12 `prd.outOfScope` | 12/12, order preserved, none inverted into an AC |
| Correction survival | round-1 spec-review corrections | all present in `description`/ACs, none only in `analysis` |
| Forward-reference drift | `diffCatalogs`, `flattenCatalog`, `placeholders`, `ALLOWED_IDENTICAL`, `date.*` keys | no drift |
| Orphan PRD ACs | 33 PRD ACs | 0 material orphans |
| Signature reality | new helper signatures, HTTP bodies vs DTOs | matches |
| PRD-AC satisfiability | invocation-shaped ACs (both endpoints existing) | none in this PRD |
| Terminal cleanup | no cleanup story in the spec | n/a |

## Spec AC → PRD AC mapping

### US-001

| Spec AC | PRD ACs | Result |
|:--|:--|:--|
| 1 — eight validation values exact | 1 | behavioural, exact |
| 2 — four errors values exact | 2 | behavioural, exact |
| 3 — `validation.min`/`max` repaired, nothing else | 3, 5 | behavioural; AC 5 restates the `{value}` token already named in AC 3 |
| 4 — diff is only the 14 values, en untouched, 386 = 386 | 4 | review AC, mechanism preserved |

### US-002

| Spec AC | PRD ACs | Result |
|:--|:--|:--|
| 1 — real catalogs produce six empty arrays | 1 | behavioural, six fields named |
| 2 — `flattenCatalog` nests to `a.b` | 2 | behavioural, exact |
| 3 — non-string leaf throws naming `a.b` | 3 | behavioural, exact |
| 4 — non-object root / array throws | 4, 5, 6 | split atomically, no loss |
| 5 — `placeholders` token extraction | 7, 8 | split atomically, exact |
| 6 — missing/extra key reporting | 9, 10 | split atomically, `namespace.key` form preserved |
| 7 — untranslated vs allow-list | 11, 12 | split atomically, both branches pinned |
| 8 — placeholder mismatch (dropped/renamed/extra) | 13, 14, 15 | split atomically, all three cases |
| 9 — missing/extra namespace file | 16, 17 | split atomically |
| 10 — allow-list is exactly five `date.*` keys | 18 | exact list preserved, typo `dateTimeFromatWithDay` intact |

### US-003

| Spec AC | PRD ACs | Result |
|:--|:--|:--|
| 1 — zh reset-request 400, message and `errors.email` | 1, 2, 3 | split into status/message/field; array shape preserved |
| 2 — en reset-request message unchanged | 4 | behavioural |
| 3 — zh confirm 400, message and `errors.newPassword` bound | 5, 6, 7 | split into status/message/field; interpolation preserved |
| 4 — en confirm message unchanged | 8 | behavioural |
| 5 — neither zh body contains `$t(` | 9, 10 | one AC per route |

No PRD AC was rewritten into a file-content or grep assertion, and no asserted argument was dropped.

## Findings

### Major — US-002 `contextFiles` dropped `apps/api/src/i18n/zh/date.json`

**Spec reference:** `### Context Files`, US-002 (six entries).
**PRD reality:** five entries; `nax plan` logged `dropped apps/api/src/i18n/zh/date.json`
("not backfilled") and its description compensated in prose ("Also read … omitted only to respect the
five-file limit").
**Why it matters:** the file exists on disk and the spec lists it as a read; the structural read hint was
lost even though the description named it.
**Fix applied:** restored `apps/api/src/i18n/zh/date.json` to US-002 `contextFiles` in place (structural
field only; no story description or AC changed). The PRD now carries all 14 spec context entries.

No other findings.

## Notes

- US-002's `suggestedCriteria` (inert planner suggestions) add five fixture cases — duplicate tokens in
  order, identical multiset in a different order, an allow-listed key that still has a placeholder
  mismatch, and an array leaf throwing — all derivable from the spec's Design and not material scope.
- US-003's description corrects the spec's Design shorthand ("`errors.email` is `必须…`") to the
  one-element array the spec AC already requires. The PRD AC matches the AC, not the shorthand.
- The PRD's story descriptions preserve the round-1 corrections: dotted `${namespace}.${key}` diff
  tokens, the `validation.*` dead-catalog wording, `flattenCatalog` input classes, six-array empty diff,
  one-exclusion-per-bullet out-of-scope, and the No-test note on US-001.

## Recommendation

No further edits. Commit the spec and PRD, then `nax run`.
