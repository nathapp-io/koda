# Recovery and deployment PRD fidelity review

**Verdict** — Ready.  
**Phases run** — 1 of 9 (--phase 9: phases 1-8 skipped by request)  
**Summary** — Phase 9 compared the reviewed spec with the native-codex-ds PRD at repository baseline `37b396c49`. All 21 spec criteria map to behavioral checks in the six stories. The audit found zero blockers, zero majors and two minor observations.

## Acceptance criteria

Each row lists the PRD criterion numbers in spec criterion order. For example, the first group in each row is the destination of that story’s spec AC-1. Numbers are one-based within the story.

| Story | PRD destinations by spec criterion | Behavior retained |
|---|---|---|
| US-001 | 1–2 / 3–4 / 5–6 / 7–9 | Generic response and one real delivery, attributed SENT row and token hash, preference controls, nullable principal with retries disabled |
| US-002 | 1 / 2–5 | Exact rendered API values in both manifests, optional omission and isolation from other services |
| US-003 | 1–2 / 3–9 | Disabled timer leaves the queue untouched, enabled timer closes before claiming, one-shot rows stay closed, destruction stops claims |
| US-004 | 1–2 / 3–4 / 5–9 | Fifth and sixth attempts fail, first attempt backs off, settlement failures are logged and the next recipient gets mail |
| US-005 | 1–3 / 4–5 / 6–7 / 8–10 / 11–12 | Private modes from creation, full-stream verification, partial cleanup, host ownership and archive/dump contents |
| US-006 | 1 / 2–3 / 4–5 / 6–7 / 8–10 | Restored snapshot and retained original, existing-target refusal, SQL/gzip failure, verified cutover, reversal and baseline mismatch |

US-004 criterion 10 covers the spec’s capped persistence error. US-006 criterion 11 covers its requirement to keep writers stopped and the original database selected after failure. Neither introduces a new runtime contract.

## Findings

- **Minor, US-002 criterion 6.** The planner adds a negative test that omits JWT_SECRET. Both manifests already require the variable. The spec asks for a positive render control and optional mail settings, so this adds test work without changing deployment behavior.
- **Minor, all six stories.** The planner adds 12 read-context entries across the stories, including the schedule repository for US-004. All exist and support the planned work. The 17 declared read entries, 15 story-specific modification entries with reasons and three new test paths retain their intended roles.

## Evidence

The reset integration suite already checks the exact response body. The reset service calls the existing six-parameter dispatcher method, with the principal in position four and the retry flag in position six. Scheduled dispatch calls close before claim, builds each claimed row and sends the recipient through the injected notify service. The repository accepts the stated failure and retry arguments and caps the persisted error. The work to change timer gating and exhausted build settlement remains assigned to the corresponding stories.

The story descriptions retain the earlier corrections for detached delivery and test actor context, isolated Compose environments, restart handling, repository failure isolation, host-created private archives and executable restore checks. The restore story exercises the marked commands and verifies the client’s selected database on cutover and reversal. No criterion substitutes text matching for these behaviors.

Both dependency edges match the spec (US-004 requires US-003 and US-006 requires US-005). All four feature exclusions match verbatim and agree with story scope. The spec declares no terminal cleanup story. No conflicting forward-reference spelling or missing architectural constraint was identified.
