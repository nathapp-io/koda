import * as z from 'zod'
import type { FleetRunnerSummary } from '~/lib/fleet-types'
import type { ThreadBackend } from '~/lib/thread-types'
import { FEATURE_RE } from '~/lib/fleet-dispatch'

type Translate = (key: string) => string

export interface ThreadCreateValues {
  repoId: string
  baseRef: string
  feature: string
  title: string
  maxCostUsd: string | number
  model: string
  effort: string
}

export interface CreateThreadBody {
  repoId: string
  feature: string
  title: string
  maxCostUsd: number
  backend: ThreadBackend & { kind: 'native' }
  baseRef?: string
}

export function buildThreadCreateSchema(t: Translate) {
  const required = t('fleet.threads.new.validation.required')
  const invalid = t('fleet.threads.new.validation.invalid')
  return z.object({
    repoId: z.string().min(1, t('fleet.threads.new.validation.repoRequired')),
    baseRef: z.string().max(255, t('fleet.threads.new.validation.baseRef')),
    feature: z.string().regex(FEATURE_RE, t('fleet.threads.new.validation.feature'))
      .refine(value => !value.includes('..'), t('fleet.threads.new.validation.feature')),
    title: z.string().min(1, t('fleet.threads.new.validation.title')).max(200, t('fleet.threads.new.validation.title'))
      .refine(value => !Array.from(value).some(character => {
        const code = character.charCodeAt(0)
        return code <= 0x1f || code === 0x7f
      }), t('fleet.threads.new.validation.title')),
    maxCostUsd: z.coerce.number().gt(0, invalid).max(10_000, invalid)
      .refine(value => Math.abs(value * 10_000 - Math.round(value * 10_000)) < 1e-6, invalid),
    model: z.string().min(1, required),
    effort: z.enum(['', 'low', 'medium', 'high', 'xhigh']),
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
  return {
    repoId: values.repoId,
    feature: values.feature,
    title: values.title,
    maxCostUsd: Number(values.maxCostUsd),
    backend: { kind: 'native', model: values.model, ...(effort ? { effort } : {}) },
    ...(baseRef ? { baseRef } : {}),
  }
}

export function eligibleModels(runners: readonly FleetRunnerSummary[]): string[] {
  return [...new Set(runners
    .filter(runner => runner.online && runner.enabled)
    .flatMap(runner => runner.threadBackends?.native ?? []))]
    .sort((a, b) => a.localeCompare(b))
}
