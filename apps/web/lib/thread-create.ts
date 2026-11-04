import * as z from 'zod'
import type { FleetRunnerSummary } from '~/lib/fleet-types'
import type { ChatThreadKind, ThreadAcpOffer, ThreadAgent, ThreadBackend, ThreadMode } from '~/lib/thread-types'
import { FEATURE_RE } from '~/lib/fleet-dispatch'

type Translate = (key: string) => string

export interface ThreadCreateValues {
  kind: ChatThreadKind
  repoId: string
  baseRef: string
  feature: string
  title: string
  maxCostUsd: string | number
  /** The chosen agent: `native` or one ACP agent (thread-agents-modes US-011). */
  agent: AgentChoiceKey
  /** REPO threads only: PROJECT and WORKSPACE threads are always `read`. */
  mode: ThreadMode
  model: string
  effort: string
}

/**
 * The create request body, discriminated by `kind` exactly as the API reads it: a PROJECT thread
 * carries no repository fields at all (a stale value in a hidden form field must never leak), and
 * only a REPO thread carries `mode` (thread-agents-modes US-011).
 */
export type CreateThreadBody =
  | { kind: 'REPO'; repoId: string; feature: string; title: string; maxCostUsd: number; backend: ThreadBackend; mode: ThreadMode; baseRef?: string }
  | { kind: 'PROJECT'; title: string; maxCostUsd: number; backend: ThreadBackend }

// ── Agents (thread-agents-modes US-011) ──────────────────────────────────────────────────────────

/** What the agent select offers: the runner's own backend, or one ACP agent. */
export type AgentChoiceKey = 'native' | ThreadAgent

/** Why an agent cannot be picked; each one has its own `fleet.threads.new.agent.reason.*` copy. */
export type AgentUnavailableReason = 'notInstalled' | 'notLoggedIn'

/** One option of the agent select, with the models and efforts the chosen agent offers. */
export interface AgentChoice {
  agent: AgentChoiceKey
  available: boolean
  /** Set only while the agent is unavailable, so a caller never reads a stale reason. */
  reason: AgentUnavailableReason | null
  models: string[]
  efforts: string[]
}

/** The select's options, in the order the form renders them. */
export const AGENT_CHOICE_KEYS: readonly AgentChoiceKey[] = ['native', 'claude', 'codex', 'cursor']

/** The native effort ids the API accepts for a native backend (`NATIVE_EFFORT_RE` there). */
const NATIVE_EFFORT_VALUES: readonly string[] = ['', 'low', 'medium', 'high', 'xhigh']

/**
 * Mirrors of `ACP_MODEL_ID_RE` / `ACP_EFFORT_RE` in packages/fleet-protocol/src/threads.ts (which the
 * API mirrors in thread-jobs.ts): an ACP model may carry nax's `[...]` option suffix, and an ACP
 * effort is any short lowercase id the agent advertises.
 */
const ACP_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@=,[\]-]{0,127}$/
const ACP_EFFORT_RE = /^[a-z0-9_-]{1,32}$/

const ACP_AGENTS: readonly ThreadAgent[] = ['claude', 'codex', 'cursor']

/** True for a value the agent select can produce (`native` included). */
export function isAgentChoiceKey(value: unknown): value is AgentChoiceKey {
  return value === 'native' || ACP_AGENTS.includes(value as ThreadAgent)
}

/** The i18n key of an agent's label ("Claude Code"). */
export function agentLabelKey(agent: AgentChoiceKey): string {
  return `fleet.threads.new.agent.${agent}`
}

/** The i18n key of an unavailable agent's reason ("Not logged in"). */
export function agentReasonKey(reason: AgentUnavailableReason): string {
  return `fleet.threads.new.agent.reason.${reason}`
}

/** A native effort id is translated; an ACP agent's own effort ids (`minimal`, say) are shown raw. */
export function effortLabel(effort: string, t: Translate): string {
  return NATIVE_EFFORT_VALUES.includes(effort) ? t(`fleet.threads.new.effort.${effort}`) : effort
}

/** The modes the project REPO form offers: Read is always allowed, the others follow their key. */
export function threadModeChoices(can: (key: string) => boolean): ThreadMode[] {
  return [
    'read',
    ...(can('thread.mode.ask') ? ['ask' as const] : []),
    ...(can('thread.mode.full') ? ['full' as const] : []),
  ]
}

const sortedUnion = (lists: ReadonlyArray<readonly string[]>): string[] =>
  [...new Set(lists.flat())].sort((a, b) => a.localeCompare(b))

/**
 * The agents the new-thread form can offer for one scope, each with the models and efforts it adds to
 * the picker. Eligibility keeps the online/enabled/scope-capability filters the model list has always
 * used, and an agent is disabled only when no eligible runner can start it:
 *
 * - `notInstalled` — no eligible runner reports it launchable,
 * - `notLoggedIn` — every launchable offer reports `loggedIn: false` (`null` means "not probed", so it
 *   never counts as a logged-out runner).
 *
 * A runner that sends no `acpOffers` falls back to its `acp` list, which is its own "launchable and
 * logged in" answer (protocol US-001); its models are then unknown and the form shows none.
 */
export function eligibleAgents(runners: readonly FleetRunnerSummary[], kind: ChatThreadKind): AgentChoice[] {
  const eligible = runners.filter(runner => runner.online && runner.enabled && scopeCapability(runner, kind))
  const offersFor = (agent: ThreadAgent): ThreadAcpOffer[] =>
    eligible.flatMap(runner => runner.threadBackends?.acpOffers?.filter(offer => offer.agent === agent) ?? [])

  return AGENT_CHOICE_KEYS.map((agent) => {
    if (agent === 'native') {
      const models = sortedUnion(eligible.map(runner => runner.threadBackends?.native ?? []))
      return {
        agent,
        available: models.length > 0,
        reason: models.length > 0 ? null : 'notInstalled',
        models,
        efforts: [...NATIVE_EFFORT_VALUES].filter(effort => effort !== ''),
      }
    }
    const offers = offersFor(agent)
    const launchable = offers.filter(offer => offer.launchable)
    // Legacy report (no discovery detail): `acp` lists exactly the agents a runner can start and is logged in for.
    const ready = launchable.length === 0 && offers.length === 0
      && eligible.some(runner => (runner.threadBackends?.acp ?? []).includes(agent))
    const usable = launchable.filter(offer => offer.loggedIn !== false)
    const available = launchable.length === 0 ? ready : usable.length > 0
    const reason: AgentUnavailableReason | null = available
      ? null
      : launchable.length > 0 ? 'notLoggedIn' : 'notInstalled'
    return {
      agent,
      available,
      reason,
      models: available ? sortedUnion(usable.map(offer => offer.models)) : [],
      efforts: available ? sortedUnion(usable.map(offer => offer.efforts)) : [],
    }
  })
}

/** One form-field problem of the backend block; a `superRefine` turns each into a zod issue. */
export interface BackendFieldIssue { path: 'model' | 'effort'; message: string }

/**
 * The backend rules, shared by the project and the workspace form: a native backend needs a model id
 * and one of the fixed efforts; an ACP backend may omit either (an agent can advertise none) but a
 * value it does send has to match the agent's wider grammar.
 */
export function backendFieldIssues(
  values: { agent?: string; model?: string; effort?: string },
  t: Translate,
): BackendFieldIssue[] {
  const model = (values.model ?? '').trim()
  const effort = (values.effort ?? '').trim()
  const agent = isAgentChoiceKey(values.agent) ? values.agent : 'native'
  if (agent === 'native') {
    const issues: BackendFieldIssue[] = []
    if (model.length === 0) issues.push({ path: 'model', message: t('fleet.threads.new.validation.required') })
    if (!NATIVE_EFFORT_VALUES.includes(effort)) issues.push({ path: 'effort', message: t('fleet.threads.new.validation.invalid') })
    return issues
  }
  const issues: BackendFieldIssue[] = []
  if (model.length > 0 && !ACP_MODEL_ID_RE.test(model)) issues.push({ path: 'model', message: t('fleet.threads.new.validation.invalid') })
  if (effort.length > 0 && !ACP_EFFORT_RE.test(effort)) issues.push({ path: 'effort', message: t('fleet.threads.new.validation.invalid') })
  return issues
}

/** The backend the chosen agent produces: native, or `acp` with the agent and its own model/effort. */
export function toThreadBackend(values: { agent?: string; model: string; effort: string }): ThreadBackend {
  const model = values.model.trim()
  const effort = values.effort.trim()
  const agent = isAgentChoiceKey(values.agent) ? values.agent : 'native'
  if (agent === 'native') {
    return { kind: 'native', ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
  }
  return { kind: 'acp', agent, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
}

export function buildThreadCreateSchema(t: Translate) {
  const invalid = t('fleet.threads.new.validation.invalid')
  return z.object({
    kind: z.enum(['REPO', 'PROJECT']).default('REPO'),
    // The scope decides which of these are required; a PROJECT form leaves them empty (or stale).
    repoId: z.string().default(''),
    baseRef: z.string().default(''),
    feature: z.string().default(''),
    title: z.string().min(1, t('fleet.threads.new.validation.title')).max(200, t('fleet.threads.new.validation.title'))
      .refine(value => !Array.from(value).some(character => {
        const code = character.charCodeAt(0)
        return code <= 0x1f || code === 0x7f
      }), t('fleet.threads.new.validation.title')),
    maxCostUsd: z.coerce.number().gt(0, invalid).max(10_000, invalid)
      .refine(value => Math.abs(value * 10_000 - Math.round(value * 10_000)) < 1e-6, invalid),
    // The chosen agent decides which backend the body carries and which model/effort rules apply.
    agent: z.enum(['native', 'claude', 'codex', 'cursor']).default('native'),
    mode: z.enum(['read', 'ask', 'full']).default('read'),
    // Length caps keep a pasted value bounded; `backendFieldIssues` decides what each agent accepts.
    model: z.string().max(128).default(''),
    effort: z.string().max(32).default(''),
  }).superRefine((values, ctx) => {
    for (const issue of backendFieldIssues(values, t)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [issue.path], message: issue.message })
    }
    // A PROJECT thread has no repository, base ref or feature: those rules run only for REPO
    // (S5b 1a-R4), and each issue lands on the field so the form shows it there.
    if (values.kind !== 'REPO') return
    if (values.repoId.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['repoId'], message: t('fleet.threads.new.validation.repoRequired') })
    }
    if (values.baseRef.length > 255) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['baseRef'], message: t('fleet.threads.new.validation.baseRef') })
    }
    if (!FEATURE_RE.test(values.feature) || values.feature.includes('..')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['feature'], message: t('fleet.threads.new.validation.feature') })
    }
  })
}

export type ThreadCreateFormValues = z.infer<ReturnType<typeof buildThreadCreateSchema>>

/**
 * US-007: the shared message-input schema for the thread composer and the question-card answer.
 * Trimmed text, non-empty, at most 32768 UTF-8 bytes (the API's limit, `THREAD_LIMITS.messageMaxBytes`).
 * A bare `z.string()` schema (not an object wrapper): `useField` validates the field value itself.
 */
export function buildThreadMessageSchema(t: Translate) {
  return z.string()
    .trim()
    .min(1, t('fleet.threads.message.required'))
    .refine(value => new TextEncoder().encode(value).byteLength <= 32768, t('fleet.threads.message.tooLong'))
}

export function toCreateThreadBody(values: ThreadCreateValues): CreateThreadBody {
  const baseRef = values.baseRef.trim()
  const backend = toThreadBackend(values)
  const title = values.title
  const maxCostUsd = Number(values.maxCostUsd)
  // A PROJECT body has no repository keys at all, so a REPO value left in a hidden field cannot leak;
  // it carries no mode either — a PROJECT thread is always `read` (thread-agents-modes US-011).
  if (values.kind === 'PROJECT') return { kind: 'PROJECT', title, maxCostUsd, backend }
  return {
    kind: 'REPO',
    repoId: values.repoId,
    feature: values.feature,
    title,
    maxCostUsd,
    backend,
    mode: threadModeOf(values.mode),
    ...(baseRef ? { baseRef } : {}),
  }
}

/** The mode a REPO create body carries; anything the form did not set is the default `read`. */
function threadModeOf(value: unknown): ThreadMode {
  return value === 'ask' || value === 'full' ? value : 'read'
}

/** The one scope capability a runner must advertise to host a thread of this kind (S5b). */
function scopeCapability(runner: FleetRunnerSummary, kind: ChatThreadKind): boolean {
  if (kind === 'PROJECT') return runner.projectThreads
  // A WORKSPACE thread runs with no checkout, so only a runner advertising it may offer a model;
  // REPO needs no extra capability.
  if (kind === 'WORKSPACE') return runner.workspaceThreads
  return true
}

/**
 * The native models offered by the eligible runners of one scope: union, deduplicated and sorted.
 * This is the agent select's `native` option (US-011); the ACP agents offer their own lists.
 */
export function eligibleModels(runners: readonly FleetRunnerSummary[], kind: ChatThreadKind): string[] {
  return eligibleAgents(runners, kind).find(choice => choice.agent === 'native')?.models ?? []
}
