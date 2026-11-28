# Phase 9 PRD fidelity review

**Verdict** — Ready for implementation. All three findings from the generated PRD are resolved.

Reviewed November 28, 2026 against Koda at `d4538dd4e`. [Reviewed spec](../../../../docs/specs/SPEC-review-1128-remediation.md) · [Generated PRD](prd.json)

**Phases run:** 1 of 9 (--phase 9: phases 1-8 skipped by request)

## Summary

Phase 9 matched 33 source criteria to 108 PRD criteria in 11 stories. All 11 dependency arrays preserve the explicitly empty sets. All 37 source context entries and 38 modification paths survived with the correct roles and populated modification reasons. The PRD adds three existing context files for the merge repository, daemon directory cleanup and root patch declarations. There are zero created files, new exported forward references, meta-criteria or terminal cleanup stories. All seven exclusions survived in order and no generated criterion introduces an excluded change.

## Resolved findings

- **US-006** now has 14 criteria under the configured limit of 15. AC-1a requires both retention and zero signals after inspection failure. AC-4a exercises each of the three indeterminate production-probe outcomes. AC-4b covers a definitively absent PID.
- **US-010 and US-011** now explicitly use the repository root (`.`) for release and deployment work. Both entries record the spec as the source of the workdir. US-009 continues to use Nax’s root fallback.

## Criterion mapping

Labels on the right are local to the same generated story. Each row names the complete set of generated assertions covering that source criterion.

| Story | Source criterion | Generated criteria |
| --- | --- | --- |
| US-001 | AC-1 | AC-1a, AC-1b, AC-1c |
| US-001 | AC-2 | AC-2a, AC-2b |
| US-001 | AC-3 | AC-3a, AC-3b, AC-3c |
| US-001 | AC-4 | AC-4a, AC-4b, AC-4c, AC-4d |
| US-002 | AC-1 | AC-1a, AC-1b, AC-1c |
| US-002 | AC-2 | AC-2a, AC-2b, AC-2c |
| US-002 | AC-3 | AC-3a, AC-3b, AC-3c, AC-3d |
| US-003 | AC-1 | AC-1a, AC-1b, AC-1c, AC-1d, AC-1e |
| US-003 | AC-2 | AC-2a, AC-2b, AC-2c |
| US-003 | AC-3 | AC-3a, AC-3b, AC-3c |
| US-004 | AC-1 | AC-1a, AC-1b, AC-1c |
| US-004 | AC-2 | AC-2a, AC-2b, AC-2c, AC-2d |
| US-004 | AC-3 | AC-3a, AC-3b, AC-3c, AC-3d, AC-3e |
| US-005 | AC-1 | AC-1a, AC-1b |
| US-005 | AC-2 | AC-2a, AC-2b, AC-2c |
| US-005 | AC-3 | AC-3a, AC-3b, AC-3c, AC-3d, AC-3e |
| US-006 | AC-1 | AC-1a, AC-1b |
| US-006 | AC-2 | AC-2a, AC-2b, AC-2c, AC-2d |
| US-006 | AC-3 | AC-3a, AC-3b, AC-3c, AC-3d, AC-3e, AC-3f |
| US-006 | AC-4 | AC-4a, AC-4b |
| US-007 | AC-1 | AC-1a, AC-1b, AC-1c |
| US-007 | AC-2 | AC-2a, AC-2b, AC-2c |
| US-007 | AC-3 | AC-3a, AC-3b |
| US-008 | AC-1 | AC-1a, AC-1b, AC-1c |
| US-008 | AC-2 | AC-2a, AC-2b |
| US-008 | AC-3 | AC-3a, AC-3b, AC-3c, AC-3d, AC-3e |
| US-009 | AC-1 | AC-1a, AC-1b, AC-1c, AC-1d |
| US-009 | AC-2 | AC-2a, AC-2b |
| US-010 | AC-1 | AC-1a, AC-1b, AC-1c |
| US-010 | AC-2 | AC-2a, AC-2b, AC-2c, AC-2d |
| US-010 | AC-3 | AC-3a, AC-3b |
| US-011 | AC-1 | AC-1a, AC-1b, AC-1c |
| US-011 | AC-2 | AC-2a, AC-2b, AC-2c |

## Behavioral review

The generated criteria preserve the reviewed corrections in implementer-visible criteria or descriptions. They cover initializer call targets and JSDoc, exactly-once merge auditing, ticket label project IDs and resolved Git links, lease-shared directory retention, current versus recorded host identity, production process-probe failures, and the older stable patch on the same minor. The invocation checks preserve the existing CLI SDK request mapping, thread refusal paths and release channel step. Splitting the criteria added no material feature scope.

This report covers the revised PRD. The mappings record specification fidelity, not results of running the proposed implementation tests.

Reviewed PRD SHA-256: `28e708fcb2f2f3433c94e48c19b729afa315b3b5053c9354e6f9e462308c6939`.
