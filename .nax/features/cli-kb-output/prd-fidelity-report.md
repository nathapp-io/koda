# Spec Review — CLI knowledge-base list and add output

**Reviewed against** Koda at `bdd9e2083` on 2026-11-25, using the [reviewed spec](../../../docs/specs/SPEC-cli-kb-output.md) and the [generated PRD](prd.json). The recorded routing profile is `native-codex-ds`.

**Phases run** 1 of 9 (--phase 9: phases 1-8 skipped by request)

**Verdict** Ready for implementation.

## Summary

Phase 9 matched all 11 spec criteria against 14 PRD criteria. Three additional regression criteria trace to the spec's failure-handling paragraph. The single story, its empty dependency set, its workdir, all five context paths, all three modification paths and reasons, and all four exclusions match. Both review corrections survived in executable criteria. There are zero created files, forward-referenced symbols, meta-criteria or terminal-cleanup stories to carry over. Findings: 0 blockers, 0 majors, 0 minors.

## Acceptance criteria

Numbers denote one-based positions in US-001. The spec criteria occupy lines 89–99. The PRD criteria occupy lines 13–26.

| Spec | PRD | Assertion preserved |
| --- | --- | --- |
| 1 | 1 | An empty array prints the ID, Source and Created headings followed by `Shown: 0`. |
| 2 | 2 | The two IDs appear in their original order, `doc-B` then `doc-A`. |
| 3 | 3 | The final stdout line for that partial result is `Shown: 2`. |
| 4 | 4 | The row shows `doc-B`, source type `manual`, and UTC date `2026-01-10` for the supplied offset timestamp. |
| 5 | 5 | The 100-row response ends with `Shown: 100`. |
| 6 | 6 | Both empty and populated human lists exit 0. |
| 7 | 7 | Empty and populated JSON lists retain the full array, every row field, two-space indentation and the final newline. |
| 8 | 8 | Input `example.md` and indexed response source ID `stored.md` produce the single line `Indexed stored.md.` |
| 9 | 9 | The same distinct names with an unindexed result produce the single line `Not indexed: stored.md.` |
| 10 | 10 | Both executed add outcomes exit 0. |
| 11 | 11 | Both JSON add outcomes return the exact unwrapped object with two-space indentation and the final newline. |

PRD criteria 12–14 elaborate spec line 40. Criteria 12 and 13 supply an HTTP 400 add rejection and an HTTP 503 list rejection with distinct diagnostic messages. Criterion 14 supplies the existing approval-pending error and expects exit 5. Both registered commands catch rejected generated operations through the shared error handler. The existing handler emits the supplied messages and recognizes the pending exception. All three assert observable behavior within the existing error contract. No criterion requires a new status, retry, permission or error mapping. [Command actions](../../../apps/cli/src/commands/kb.ts) · [Error handling](../../../apps/cli/src/utils/error.ts)

## Story and scope

- `US-001` retains its ID, title, explicit empty dependency set and `apps/cli` workdir. All 14 criteria concern observable command output or exit status. None introduces a new invocation signature or an asserted call to a new symbol.
- All five context files exist and match the spec list. The PRD authorizes each of the three existing files separately with its original reason. It requests zero new files and introduces zero extra file-role entries.
- All four feature exclusions match verbatim. The story preserves the exclusions around API and storage behavior, pagination, error and approval policy, and other commands and shared CLI facilities.
- PRD AC 3 carries the earlier two-row count correction. ACs 8 and 9 distinguish the returned source ID from the input filename on both outcomes. These assertions reach the implementation session directly.
