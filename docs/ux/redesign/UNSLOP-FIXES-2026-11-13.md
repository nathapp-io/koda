# Unslop follow-up resolution — 13 November 2026

All nine findings in the [page-by-page audit](UNSLOP-AUDIT-2026-11-13.md) are resolved on `style/koda-unslop-page-audit`. The established slate/indigo palette, system font, routes and API workflows remain the design constraints.

| Finding | Resolution | Verification |
|:--|:--|:--|
| U01 | Dispatch fields have explicit label, help and error associations. Native placement radios replace nested interactive controls. | RUN/PLAN/REVIEW/FIX axe scans, arrow-key placement navigation, conditional fields and submission regression tests. |
| U02 | Labels creation stacks below `sm`; the name field has usable width. Inline editing also stacks on narrow screens. | Creation and editing at 320/390/768px in both themes, no document overflow; mobile axe scans. |
| U03 | Normalized 404/410 errors show an invalid invitation; other preview failures show persistent retry. No account form until preview succeeds. Acceptance handles 409 and expired/removed links. | Real valid/invalid/expired preview requests; regression tests for pending, retry, normalized and HTTP errors, signed-in visitors and submission. |
| U04 | Interior headings use sentence case, 12px/500 and muted text. Permission groups are humanized; permission keys stay intact. | Ticket, populated role editor and assignee menu checked in both themes; config-tree source reviewed and existing component tests pass. |
| U05 | Comment type badges use neutral surfaces and semantic border tokens. | Populated ticket in both themes, axe and existing comment tests. |
| U06 | Login, registration and invitation forms use 28px/500 headings; auth grouping is consistent. Registration and invitation have translated titles. | Login, closed/open registration and valid invitation checked in both themes. |
| U07 | Passed stories and pipeline stages use outlined badges. Active/failure variants retain their meaning. | Completed graph and pipeline checked in both themes; existing story/graph state tests pass. |
| U08 | Approval count uses a static neutral chip, a semantic amber dot and plain tabular count. | A real pending request in the disposable DB renders in both themes; computed animation is `none`. |
| U09 | Similarity levels are localized, use medium weight and semantic tokens. Verdict cards use neutral surfaces with semantic dots. | Populated high/medium/low results and all three verdicts in both themes; English/Chinese switching and axe checks. |

## Verification

- Full web Jest suite (`bunx jest --maxWorkers=2`) and `bun run test:real-sanitizer`: **469 suites, 5,599 tests passed**, plus 17 real sanitizer checks and the DOM form-submission harness.
- Nuxt typecheck passed; the existing module-type warning remains. Changed-file ESLint passed with zero warnings.
- **18/18 focused browser groups passed**: nine groups in each theme. [Machine-readable results](unslop-2026-11-13/fixes/verification.json).
- Focused axe scans found no WCAG A/AA violations in the checked Dispatch variants, mobile Labels, populated ticket, invitation states and knowledge verdicts.
- A default-worker rerun hit three existing job-detail test timeouts under local load. The complete suite was repeated with two workers; no test timeout or assertion was changed.
- Independent review found no blocking defects. Its suggested HTTP 409 and post-preview 404/410 acceptance cases were added to the regression suite.
- `git diff --check` passed before commit.

Browser checks used the local app/API and a dedicated disposable database. No jobs were dispatched, approval decisions made, schedules enabled or invitations accepted. Registration-open and knowledge-search results used synthetic API responses to exercise conditional rendering; these checks do not validate remote providers or semantic search quality. The existing default Playwright reset setup was not run. This focused follow-up complements the original 156 route/view checks; it is not a new exhaustive permission or interaction audit.

## After screenshots

[Mobile Labels](unslop-2026-11-13/fixes/labels-dark.png), [ticket](unslop-2026-11-13/fixes/ticket-dark.png), [completed job](unslop-2026-11-13/fixes/job-dark.png), [pending approval](unslop-2026-11-13/fixes/approval-dark.png), [valid invitation](unslop-2026-11-13/fixes/invite-valid-dark.png), [open registration](unslop-2026-11-13/fixes/register-open-dark.png), [knowledge results](unslop-2026-11-13/fixes/kb-dark.png). Corresponding light-theme captures are in the same directory.

Uses unslop by [Damir Sokolovsky (@heydamir)](https://x.com/heydamir), CC BY 4.0, adapted to Koda's established design system.
