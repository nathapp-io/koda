import * as z from 'zod'
import type { FleetRunnerSummary } from '~/lib/fleet-types'
import type { ChatThreadKind, ThreadBackend } from '~/lib/thread-types'
import { FEATURE_RE } from '~/lib/fleet-dispatch'

type Translate = (key: string) => string

export interface ThreadCreateValues {
  kind: ChatThreadKind
  repoId: string
  baseRef: string
  feature: string
  title: string
  maxCostUsd: string | number
  model: string
  effort: string
}

type NativeBackend = ThreadBackend & { kind: 'native' }

/**
 * The create request body, discriminated by `kind` exactly as the API reads it: a PROJECT thread
 * carries no repository fields at all (a stale value in a hidden form field must never leak).
 */
export type CreateThreadBody =
  | { kind: 'REPO'; repoId: string; feature: string; title: string; maxCostUsd: number; backend: NativeBackend; baseRef?: string }
  | { kind: 'PROJECT'; title: string; maxCostUsd: number; backend: NativeBackend }

export function buildThreadCreateSchema(t: Translate) {
  const required = t('fleet.threads.new.validation.required')
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
    model: z.string().min(1, required),
    effort: z.enum(['', 'low', 'medium', 'high', 'xhigh']),
  }).superRefine((values, ctx) => {
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
  const effort = values.effort.trim()
  const backend: NativeBackend = { kind: 'native', model: values.model, ...(effort ? { effort } : {}) }
  const title = values.title
  const maxCostUsd = Number(values.maxCostUsd)
  // A PROJECT body has no repository keys at all, so a REPO value left in a hidden field cannot leak.
  if (values.kind === 'PROJECT') return { kind: 'PROJECT', title, maxCostUsd, backend }
  return {
    kind: 'REPO',
    repoId: values.repoId,
    feature: values.feature,
    title,
    maxCostUsd,
    backend,
    ...(baseRef ? { baseRef } : {}),
  }
}

/** The one scope capability a runner must advertise to host a thread of this kind (S5b). */
function scopeCapability(runner: FleetRunnerSummary, kind: ChatThreadKind): boolean {
  if (kind === 'PROJECT') return runner.projectThreads
  // A WORKSPACE thread runs with no checkout, so only a runner advertising it may offer a model;
  // REPO needs no extra capability.
  if (kind === 'WORKSPACE') return runner.workspaceThreads
  return true
}

/** The models offered by the eligible runners of one scope: union, deduplicated and sorted. */
export function eligibleModels(runners: readonly FleetRunnerSummary[], kind: ChatThreadKind): string[] {
  return [...new Set(runners
    .filter(runner => runner.online && runner.enabled && scopeCapability(runner, kind))
    .flatMap(runner => runner.threadBackends?.native ?? []))]
    .sort((a, b) => a.localeCompare(b))
}
