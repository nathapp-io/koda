/**
 * D7: the nax phases and workflow steps the job page knows how to name.
 *
 * nax reports its phase as an identifier (`branch-review`, `execution`, …). The four places the web shows a phase
 * render a known one through `fleet.jobs.phases.<phase>` and anything else raw, so a nax value this app has never
 * seen still reaches the reader instead of disappearing (R4).
 */

/** The nax pipeline stages (the phase of a pipeline-mode RUN). */
const PIPELINE_STAGES = [
  'queue-check', 'routing', 'constitution', 'context', 'prompt', 'optimizer', 'execution', 'completion', 'workflow',
] as const

/** D6: the phases a nax workflow RUN reports as its current phase. */
const WORKFLOW_PHASES = [
  'implement', 'gates', 'review', 'rereview', 'suite', 'residual', 'fix', 'closed',
] as const

/** D6: the workflow steps that arrive as `postRun.workflowStep` and, in workflow mode, as the job phase. */
const FEATURE_STEPS = [
  'repo-gates', 'branch-review', 'branch-fix', 'branch-rereview', 'adjudicate',
  'final-gates', 'gate-repair', 'publish', 'done',
] as const

/**
 * Every phase the web names; `review`, `gates` and `publish` are both a workflow phase and a step, so the three
 * lists are de-duplicated. The locale files carry one label per entry, in en and zh (pinned by
 * `tests/lib/fleet-phase.spec.ts` and the fleet locale parity test).
 */
export const KNOWN_PHASES: readonly string[] = [...new Set<string>([...PIPELINE_STAGES, ...WORKFLOW_PHASES, ...FEATURE_STEPS])]

/** D7/R4: the translation key of a known phase, or null when the phase is nax text the web does not know. */
export function phaseLabelKey(phase: string): string | null {
  return KNOWN_PHASES.includes(phase) ? `fleet.jobs.phases.${phase}` : null
}
